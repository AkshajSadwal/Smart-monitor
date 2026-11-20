import {z} from 'zod';
import {unknownMetrics,type Candidate,type Watchlist} from '../../packages/contracts/index';
import {hostedPost} from '../../packages/collection-core/hosted';
import {resetTime} from '../../packages/collection-core/http';
import {ApiError} from './api';
import {hash,type Store} from './storage';
import type {Vault} from './x-api';

export const sharedPostSchema=z.strictObject({url:z.url().max(600),excerpt:z.string().trim().min(1).max(5000),consent:z.literal(true)});
export function selectedPost(input:unknown,now:number):Candidate {
  const shared=sharedPostSchema.parse(input);
  const url=new URL(shared.url);
  if(url.protocol!=='https:'||!['x.com','www.x.com','twitter.com','www.twitter.com'].includes(url.hostname)||url.port||url.username||url.password)
    throw new ApiError(400,'INVALID_POST_LINK','Paste an HTTPS link to the selected X post.');
  const match=url.pathname.match(/^\/(?:i\/web|[A-Za-z0-9_]{1,30})\/status\/(\d{1,25})\/?$/);
  if(!match)throw new ApiError(400,'INVALID_POST_LINK','Paste a direct X post permalink.');
  return {namespace:'x',id:match[1],canonicalId:match[1],text:shared.excerpt,authorId:null,handle:null,displayName:null,language:null,
    createdAt:null,kind:'unknown',metrics:unknownMetrics,observedAt:now,observation:'user-shared:'+hash(shared.excerpt),collector:'session'};
}

const grantSchema=z.strictObject({handle:z.string().max(30),expiresAt:z.number().int().positive(),opaqueGrant:z.string().min(1).max(8192)});
const pageSchema=z.strictObject({items:z.array(hostedPost).max(100),next:z.string().min(1).max(4096).nullable()});
type Grant=z.infer<typeof grantSchema>;
type SessionState={status:'Connected'|'Session expired'|'Permission required'|'Rate limited'|'Authentication required'|'Collection error';expiresAt?:number;handle?:string;retryAt?:number};

// A future approved driver owns the interactive user experience and the documented
// read operation. The shipped app has no such driver or browser-cookie bridge.
export interface AuthorizedWebsiteDriver {
  readonly authorizationReference:string;
  authorizeInteractively(signal:AbortSignal):Promise<unknown>;
  search(grant:string,lists:Watchlist[],cursor:string|null,signal:AbortSignal):Promise<Response>;
  disconnect?(grant:string):Promise<void>;
}
export class WebsiteSession {
  private generation=0;
  private credentials=Promise.resolve<unknown>(undefined);
  constructor(private store:Store,private vault:Vault,private driver?:AuthorizedWebsiteDriver){}
  private change<T>(work:()=>Promise<T>):Promise<T>{
    this.generation++;
    const result=this.credentials.then(work);
    this.credentials=result.catch(()=>{});
    return result;
  }
  get state():SessionState {
    if(!this.driver?.authorizationReference)return {status:'Permission required'};
    const saved=this.store.value<SessionState>('website:state',{status:'Authentication required'});
    if(saved.expiresAt&&saved.expiresAt<=Date.now())return {...saved,status:'Session expired'};
    return saved;
  }
  connect(signal:AbortSignal){
    return this.change(async()=>{
      if(!this.driver?.authorizationReference)throw new ApiError(403,'WEBSITE_PERMISSION_REQUIRED','Website-session access requires an approved X integration.');
      const grant:Grant=grantSchema.parse(await this.driver.authorizeInteractively(signal));
      signal.throwIfAborted();
      if(grant.expiresAt<=Date.now())throw new ApiError(401,'WEBSITE_SESSION_EXPIRED','The website-session authorization expired.');
      await this.vault.set('website-grant',grant.opaqueGrant);
      this.store.db.transaction(()=>{
        if(this.state.handle!==grant.handle)this.store.run("DELETE FROM settings WHERE key LIKE 'website:cursor:%'");
        this.store.set('website:state',{status:'Connected',handle:grant.handle,expiresAt:grant.expiresAt});
      })();
    });
  }
  async search(lists:Watchlist[],signal:AbortSignal,commit:(posts:Candidate[])=>void) {
    const state=this.state;
    const generation=this.generation;
    if(!this.driver?.authorizationReference||!state.expiresAt||
      ['Permission required','Session expired','Authentication required'].includes(state.status)||(state.retryAt??0)>Date.now())return false;
    const key='website:cursor:'+hash(JSON.stringify(lists.map(list=>[list.id,list.revision])));
    const cursor=this.store.value<string|null>(key,null);
    try{
      const grant=await this.vault.get('website-grant');
      if(generation!==this.generation||signal.aborted)return false;
      if(!grant){this.store.set('website:state',{status:'Authentication required'});return false;}
      const response=await this.driver.search(grant,lists,cursor,signal);
      signal.throwIfAborted();
      if(generation!==this.generation){await response.body?.cancel();return false;}
      if(response.status===401||response.status===403||response.status===429){
        this.store.set('website:state',{...state,status:response.status===401?'Session expired':response.status===403?'Permission required':'Rate limited',
          ...(response.status===429?{retryAt:resetTime(response.headers,Date.now(),60_000)}:{})});
        await response.body?.cancel();
        return false;
      }
      if(!response.ok){await response.body?.cancel();throw new Error('Provider error');}
      const page=pageSchema.parse(await response.json());
      signal.throwIfAborted();
      if(generation!==this.generation)return false;
      if(page.next&&page.next===cursor)throw new Error('Repeated website cursor');
      this.store.db.transaction(()=>{
        commit(page.items.filter(post=>post.namespace==='x').map(post=>({...post,collector:'session',observation:'website:'+post.observation})));
        this.store.set(key,page.next);
        this.store.set('website:state',{...state,status:'Connected',retryAt:undefined});
      })();
      return true;
    }catch{
      if(!signal.aborted&&generation===this.generation)this.store.set('website:state',{...state,status:'Collection error',retryAt:Date.now()+60_000});
      return false;
    }
  }
  disconnect(){
    return this.change(async()=>{
      if(!this.store.value('website:state',null))return;
      this.store.set('website:state',{status:'Authentication required'});
      try{
        const grant=this.driver?.disconnect?await this.vault.get('website-grant'):null;
        if(grant)await this.driver?.disconnect?.(grant);
      }finally{
        await this.vault.remove('website-grant');
        this.store.run("DELETE FROM settings WHERE key LIKE 'website:%'");
      }
    });
  }
}
