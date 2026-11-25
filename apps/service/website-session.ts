import {z} from 'zod';
import {unknownMetrics,type Candidate,type Watchlist} from '../../packages/contracts/index';
import {collectedPost,type Collector,type CommitPage} from '../../packages/collection-core/collector';
import {lines,resetTime} from '../../packages/collection-core/http';
import {ApiError} from './api';
import {hash,type Store} from './storage';
import type {Vault} from './credential-store';

const grantSchema=z.strictObject({
  handle:z.string().regex(/^[\w]{1,30}$/),expiresAt:z.number().int().positive(),opaqueGrant:z.string().min(1).max(8192),
});
const pageSchema=z.strictObject({items:z.array(collectedPost).max(100),next:z.string().min(1).max(4096).nullable()});
type SessionStatus='Connected'|'Collecting'|'Session expired'|'Authentication required'|'Verification required'|'Rate limited'|'Restricted'|'Temporarily unavailable'|'Disconnected'|'Unsupported';
type SessionState={status:SessionStatus;expiresAt?:number;handle?:string;retryAt?:number};

export interface AuthorizedWebsiteDriver {
  readonly authorizationReference:string;
  authorizeInteractively(signal:AbortSignal):Promise<unknown>;
  search(grant:string,lists:Watchlist[],cursor:string|null,signal:AbortSignal):Promise<Response>;
  disconnect?(grant:string):Promise<void>;
}

export class WebsiteSession implements Collector {
  readonly id='session';
  private generation=0;
  private credentials=Promise.resolve<unknown>(undefined);
  constructor(private readonly store:Store,private readonly vault:Vault,private readonly driver?:AuthorizedWebsiteDriver,private readonly clock=Date.now){}
  get capabilities(){return this.driver?.authorizationReference?['Session search and cursor replay']:[];}
  private change<T>(work:()=>Promise<T>):Promise<T>{
    this.generation++;
    const result=this.credentials.then(work);
    this.credentials=result.catch(()=>{});
    return result;
  }
  get state():SessionState {
    if(!this.driver?.authorizationReference)return {status:'Unsupported'};
    const saved=this.store.value<SessionState>('website:state',{status:'Authentication required'});
    if(saved.expiresAt&&saved.expiresAt<=this.clock())return {...saved,status:'Session expired'};
    return saved;
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
  connect(signal:AbortSignal){
    return this.change(async()=>{
      if(!this.driver?.authorizationReference)throw new ApiError(403,'WEBSITE_PERMISSION_REQUIRED','Session search requires an approved X integration.');
      const grant=grantSchema.parse(await this.driver.authorizeInteractively(signal));
      signal.throwIfAborted();
      if(grant.expiresAt<=this.clock())throw new ApiError(401,'WEBSITE_SESSION_EXPIRED','The website-session authorization expired.');
      const previous=await this.vault.get('website-grant');
      signal.throwIfAborted();
      await this.vault.set('website-grant',grant.opaqueGrant);
      try {
        signal.throwIfAborted();
        this.store.db.transaction(()=>{
          if(this.state.handle!==grant.handle)
            this.store.run("DELETE FROM settings WHERE key LIKE 'website:cursor:%'");
          this.setState({status:'Connected',handle:grant.handle,expiresAt:grant.expiresAt});
          this.store.run("UPDATE data_sources SET configured=1,generation=generation+1 WHERE id='session'");
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
    if(!this.driver?.authorizationReference)return false;
    if(!state.expiresAt||['Restricted','Session expired','Authentication required','Verification required'].includes(state.status)){
      this.hold(state);
      return false;
    }
    if((state.retryAt??0)>now)return false;
    const current=()=>!signal.aborted&&generation===this.generation;
    const key='website:cursor:'+hash(JSON.stringify(lists.map(list=>[list.id,list.revision])));
    const cursor=this.store.value<string|null>(key,null);
    try {
      const grant=await this.vault.get('website-grant');
      if(!current())return false;
      if(!grant){this.hold({status:'Authentication required'});return false;}
      this.setState({...state,status:'Collecting'});
      const response=await this.driver.search(grant,lists,cursor,AbortSignal.any([signal,AbortSignal.timeout(20_000)]));
      if(!current()){await response.body?.cancel();return false;}
      if(!response.ok){
        const status:SessionStatus=response.status===401?'Session expired':response.status===403?'Restricted':
          response.status===428?'Verification required':response.status===429?'Rate limited':'Temporarily unavailable';
        const retryAt=response.status===429?resetTime(response.headers,now,60_000):status==='Temporarily unavailable'?now+60_000:undefined;
        await response.body?.cancel().catch(()=>{});
        if(!current())return false;
        if(retryAt){
          this.setState({...state,status,retryAt});
          this.store.set('next:session',retryAt);
        }else this.hold({...state,status,retryAt:undefined});
        return false;
      }
      if(!response.body)throw new Error('Empty session page');
      let data='';
      for await(const line of lines(response.body,2_000_000)){
        data+=line;
        if(data.length>2_000_000)throw new Error('Oversized session page');
      }
      const page=pageSchema.parse(JSON.parse(data));
      if(!current())return false;
      if(page.next&&page.next===cursor)throw new Error('Repeated session cursor');
      const posts=page.items.filter(post=>post.namespace==='x')
        .map(post=>({...post,observedAt:Math.min(post.observedAt,now),observation:'website:'+post.observation}));
      this.store.db.transaction(()=>{
        commit(posts,false,key,page.next);
        this.setState({...state,status:'Connected',retryAt:undefined});
      })();
      return true;
    } catch {
      if(current()){
        this.setState({...state,status:'Temporarily unavailable',retryAt:now+60_000});
        this.store.set('next:session',now+60_000);
      }
      return false;
    } finally {
      if(signal.aborted&&generation===this.generation&&this.state.status==='Collecting')this.setState(state);
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

const sharedPostSchema=z.strictObject({url:z.url().max(600),excerpt:z.string().trim().min(1).max(5000),consent:z.literal(true)});
export function selectedPost(input:unknown,now:number):Candidate {
  const shared=sharedPostSchema.parse(input);
  const url=new URL(shared.url);
  if(url.protocol!=='https:'||!['x.com','www.x.com','twitter.com','www.twitter.com'].includes(url.hostname)||url.port||url.username||url.password)
    throw new ApiError(400,'INVALID_POST_LINK','Paste an HTTPS link to the selected X post.');
  const match=url.pathname.match(/^\/(?:i\/web|[A-Za-z0-9_]{1,30})\/status\/(\d{1,25})\/?$/);
  if(!match)throw new ApiError(400,'INVALID_POST_LINK','Paste a direct X post permalink.');
  return {namespace:'x',id:match[1],canonicalId:match[1],text:shared.excerpt,authorId:null,handle:null,displayName:null,language:null,
    createdAt:null,kind:'unknown',metrics:unknownMetrics,observedAt:now,
    observation:'user-shared:'+hash(shared.excerpt),collector:'session'};
}
