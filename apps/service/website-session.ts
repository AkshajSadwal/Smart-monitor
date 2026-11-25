import {z} from 'zod';
import {type Candidate,type Watchlist} from '../../packages/contracts/index';
import {collectedPost,type Collector,type CommitPage} from '../../packages/collection-core/collector';
import {abortable,readJson,resetTime} from '../../packages/collection-core/http';
import {ApiError} from './api';
import {hash,type Store} from './storage';
import type {Vault} from './credential-store';

const grantSchema=z.strictObject({
  handle:z.string().regex(/^[\w]{1,30}$/),expiresAt:z.number().int().positive(),opaqueGrant:z.string().min(1).max(8192),
  accountId:z.string().regex(/^\d{1,25}$/).optional(),
});
const pageSchema=z.strictObject({items:z.array(collectedPost).max(100),next:z.string().min(1).max(4096).nullable()});
const followingSchema=z.strictObject({following:z.array(z.string().regex(/^\d{1,25}$/)).max(100)});
const hour=3_600_000;
const day=24*hour;
type SessionStatus='Connected'|'Collecting'|'Session expired'|'Authentication required'|'Verification required'|'Rate limited'|'Restricted'|'Temporarily unavailable'|'Disconnected'|'Unsupported';
type SessionState={status:SessionStatus;expiresAt?:number;handle?:string;retryAt?:number};

export interface AuthorizedWebsiteDriver {
  readonly authorizationReference:string;
  readonly capabilities?:readonly string[];
  readonly minPollMs?:number;
  authorizeInteractively(signal:AbortSignal):Promise<unknown>;
  search(grant:string,lists:Watchlist[],cursor:string|null,signal:AbortSignal):Promise<Response>;
  lookup?(grant:string,posts:Candidate[],signal:AbortSignal):Promise<Response>;
  following?(grant:string,signal:AbortSignal):Promise<Response>;
  disconnect?(grant:string):Promise<void>;
}

export class WebsiteSession implements Collector {
  readonly id='session';
  private generation=0;
  private pendingChanges=0;
  private collecting=false;
  private credentials=Promise.resolve<unknown>(undefined);
  constructor(private readonly store:Store,private readonly vault:Vault,private readonly driver?:AuthorizedWebsiteDriver,private readonly clock=Date.now){}
  get capabilities() {
    return this.driver?.authorizationReference
      ? this.driver.capabilities??['Session search and pagination']
      : [];
  }
  get availabilityStatus(){return this.state.status;}
  get nextAllowedAt(){
    const state=this.state;
    if(this.pendingChanges||!state.expiresAt||!['Connected','Collecting','Rate limited','Temporarily unavailable'].includes(state.status))return Infinity;
    return state.retryAt??0;
  }
  get nextPollAt(){return this.driver?.minPollMs?this.store.value('twscrape:search-next',0):0;}
  private change<T>(work:()=>Promise<T>):Promise<T>{
    this.generation++;
    this.pendingChanges++;
    const result=this.credentials.then(work).finally(()=>{this.pendingChanges--;});
    this.credentials=result.catch(()=>{});
    return result;
  }
  get state():SessionState {
    if(!this.driver?.authorizationReference)return {status:'Unsupported'};
    const saved=this.store.value<SessionState>('website:state',{status:'Authentication required'});
    if(saved.expiresAt&&saved.expiresAt<=this.clock())return {...saved,status:'Session expired'};
    const hold=this.driver.minPollMs?this.store.value('twscrape:hold',0):0;
    if(hold>this.clock()&&['Connected','Collecting','Rate limited','Temporarily unavailable'].includes(saved.status))
      return {...saved,status:'Rate limited',retryAt:Math.max(hold,saved.retryAt??0)};
    return saved.status==='Collecting'&&!this.collecting?{...saved,status:'Connected'}:saved;
  }
  private setState(state:SessionState) {
    this.store.set('website:state',state);
    this.store.run("UPDATE data_sources SET status=?,error_code=? WHERE id='session'",state.status,
      ['Connected','Collecting','Disconnected'].includes(state.status)?null:state.status);
  }
  private hold(state:SessionState) {
    this.setState(state);
    this.store.set('next:session',Number.MAX_SAFE_INTEGER);
  }
  private failed(state:SessionState,statusCode:number,headers=new Headers()){
    const status:SessionStatus=statusCode===401?'Session expired':statusCode===403?'Restricted':
      statusCode===428?'Verification required':statusCode===429?'Rate limited':'Temporarily unavailable';
    const now=this.clock();
    const retryAt=statusCode===429?resetTime(headers,now,60_000):status==='Temporarily unavailable'?now+60_000:undefined;
    if(retryAt){
      this.setState({...state,status,retryAt});
      this.store.set('next:session',Math.max(this.store.value('next:session',0),retryAt));
    }else this.hold({...state,status,retryAt:undefined});
  }
  connect(signal:AbortSignal){
    return this.change(async()=>{
      if(!this.driver?.authorizationReference)throw new ApiError(403,'WEBSITE_PERMISSION_REQUIRED','Session search requires an approved X integration.');
      const parsed=grantSchema.safeParse(await abortable(this.driver.authorizeInteractively(signal),signal));
      if(!parsed.success)throw new ApiError(503,'INVALID_COLLECTION_GRANT','The desktop returned an invalid collection grant.');
      const grant=parsed.data;
      signal.throwIfAborted();
      if(grant.expiresAt<=this.clock())throw new ApiError(401,'WEBSITE_SESSION_EXPIRED','The website-session authorization expired.');
      const previous=await this.vault.get('website-grant');
      signal.throwIfAborted();
      await this.vault.set('website-grant',grant.opaqueGrant);
      try {
        signal.throwIfAborted();
        this.store.db.transaction(()=>{
          if(this.state.handle!==grant.handle)
            this.store.run("DELETE FROM settings WHERE key LIKE 'website:cursor:%' OR key='website:following-next'");
          this.setState({status:'Connected',handle:grant.handle,expiresAt:grant.expiresAt});
          this.store.run("UPDATE data_sources SET configured=1,generation=generation+1,account_id=? WHERE id='session'",grant.accountId??null);
          this.store.set('next:session',0);
        })();
      } catch(error) {
        if(previous)await this.vault.set('website-grant',previous);
        else await this.vault.remove('website-grant');
        throw error;
      }
    });
  }
  async collect(lists:Watchlist[],now:number,signal:AbortSignal,commit:CommitPage) {
    const state=this.state, generation=this.generation;
    if(!this.driver?.authorizationReference||this.pendingChanges)return false;
    if(!state.expiresAt||!['Connected','Collecting','Rate limited','Temporarily unavailable'].includes(state.status)){
      this.hold(state);
      return false;
    }
    if((state.retryAt??0)>now){this.store.set('next:session',state.retryAt);return false;}
    const minPoll=this.driver.minPollMs;
    const searchKey='twscrape:search-next';
    if(minPoll&&this.nextPollAt>now){
      this.store.set('next:session',this.nextPollAt);
      return false;
    }
    const current=()=>!signal.aborted&&generation===this.generation;
    const key='website:cursor:'+hash(JSON.stringify(lists.map(list=>[list.id,list.revision])));
    const cursor=this.store.value<string|null>(key,null);
    try {
      const grant=await this.vault.get('website-grant');
      if(!current())return false;
      if(!grant){this.hold({status:'Authentication required'});return false;}
      if(minPoll)this.store.set(searchKey,now+minPoll);
      this.collecting=true;
      this.setState({...state,status:'Collecting'});
      const requestSignal=AbortSignal.any([signal,AbortSignal.timeout(20_000)]);
      const request=this.driver.search(grant,lists,cursor,requestSignal).then(response=>{
        if(requestSignal.aborted)void response.body?.cancel().catch(()=>{});
        return response;
      });
      const response=await abortable(request,requestSignal);
      if(!current()){void response.body?.cancel().catch(()=>{});return false;}
      if(!response.ok){
        void response.body?.cancel().catch(()=>{});
        if(!current())return false;
        // Only explicit cursor rejection (410) resets pagination; generic 400 errors
        // may indicate an invalid query and must not silently discard the checkpoint.
        if(response.status===410&&cursor!==null){
          const receivedAt=this.clock();
          this.store.db.transaction(()=>{
            this.store.set(key,null);
            this.store.set('next:session',receivedAt+60_000);
            this.setState({...state,status:'Temporarily unavailable',retryAt:receivedAt+60_000});
          })();
          return false;
        }
        this.failed(state,response.status,response.headers);
        return false;
      }
      if(!response.body)throw new Error('Empty session page');
      const page=pageSchema.parse(await readJson(response.body,requestSignal));
      requestSignal.throwIfAborted();
      if(!current())return false;
      if(state.expiresAt<=this.clock()){this.hold({...state,status:'Session expired'});return false;}
      if(page.next&&page.next===cursor)throw new Error('Repeated session cursor');
      const posts=[...new Map(page.items.filter(post=>post.namespace==='x')
        .map(post=>[post.canonicalId,{...post,observedAt:Math.min(post.observedAt,now),observation:'website:'+post.observation}])).values()];
      this.store.db.transaction(()=>{
        commit(posts,false,key,page.next);
        this.setState({...state,status:'Connected',retryAt:undefined});
      })();
      return true;
    } catch {
      if(current())this.failed(state,503);
      return false;
    } finally {
      if(signal.aborted&&generation===this.generation&&this.state.status==='Collecting')this.setState(state);
      this.collecting=false;
    }
  }
  get nextLookupAt(){return this.store.value('twscrape:lookup-next',0);}
  get lookup(){
    const driver=this.driver;
    if(!driver?.lookup)return undefined;
    return async(posts:Candidate[],now:number,signal:AbortSignal)=>{
      const empty={posts:[],removed:[]};
      if(!posts.length||now<this.nextLookupAt)return empty;
      this.store.set('twscrape:lookup-next',now+15*60_000);
      const result=await this.readOperation(signal,(grant,request)=>driver.lookup!(grant,posts,request));
      if(!result)return empty;
      const page=pageSchema.safeParse(result);
      const ids=new Set(posts.map(post=>post.id));
      return {posts:page.success?page.data.items.filter(post=>post.namespace==='x'&&ids.has(post.id))
        .map(post=>({...post,observedAt:Math.min(now,post.observedAt),observation:'website:'+post.observation})):[],removed:[]};
    };
  }
  async refreshSignals(now:number,signal:AbortSignal){
    const driver=this.driver;
    const account=this.store.sources.find(source=>source.id==='session')?.account_id;
    const next='website:following-next';
    if(!driver?.following||!account||now<this.store.value(next,0))return;
    this.store.set(next,now+hour);
    const result=await this.readOperation(signal,(grant,request)=>driver.following!(grant,request));
    if(!result||signal.aborted)return;
    const parsed=followingSchema.safeParse(result);
    if(!parsed.success)return;
    this.store.db.transaction(()=>{
      this.store.run("DELETE FROM account_relationships WHERE source_id='session' AND account_id=? AND kind='following'",account);
      for(const id of new Set(parsed.data.following))this.store.run("INSERT INTO account_relationships VALUES ('session',?,?,'following',1,?)",account,id,now+2*day);
      this.store.set(next,now+day);
      this.store.set('session:signals',{account,at:now});
    })();
  }
  private async readOperation(signal:AbortSignal,run:(grant:string,signal:AbortSignal)=>Promise<Response>){
    if(this.clock()<this.nextAllowedAt||signal.aborted)return;
    const generation=this.generation,state=this.state;
    const request=AbortSignal.any([signal,AbortSignal.timeout(20_000)]);
    const current=()=>!signal.aborted&&this.generation===generation;
    try {
      const grant=await this.vault.get('website-grant');
      if(!current())return;
      if(!grant){this.hold({status:'Authentication required'});return;}
      const response=await abortable(run(grant,request),request);
      if(!current()||!response.ok){
        void response.body?.cancel().catch(()=>{});
        if(current())this.failed(state,response.status,response.headers);
        return;
      }
      if(!response.body)throw new Error('Empty collection response');
      const result=await readJson(response.body,request);
      if(current()&&state.expiresAt&&state.expiresAt>this.clock())return result;
    }catch{
      if(current())this.failed(state,503);
    }
  }
  disconnect(){
    return this.change(async()=>{
      if(!this.store.value('website:state',null))return;
      this.store.db.transaction(()=>{
        this.setState({status:'Disconnected'});
        this.store.deactivate('session');
        this.store.run("UPDATE data_sources SET account_id=NULL WHERE id='session'");
      })();
      try {
        const grant=this.driver?.disconnect?await this.vault.get('website-grant'):null;
        if(grant)await this.driver?.disconnect?.(grant);
      } finally {
        await this.vault.remove('website-grant');
        this.store.run("DELETE FROM settings WHERE key LIKE 'website:%'");
      }
    });
  }
}
