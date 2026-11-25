import {termKey,type Candidate,type Watchlist} from '../../packages/contracts/index';
import {z} from 'zod';
import {ApiError} from './api';
import type {CollectionCredentials} from './desktop-ipc';
import {hash} from './storage';
import type {LiveReply,TwscrapeWorker} from './twscrape-worker';
import type {AuthorizedWebsiteDriver} from './website-session';

const binding=z.tuple([z.string().regex(/^[a-f0-9]{64}$/),z.string().regex(/^\d{1,25}$/)]);
const failures:Partial<Record<CollectionCredentials['status'],LiveReply['status']>>={
  'Verification required':428,'Rate limited':429,Restricted:403,'Temporarily unavailable':503,
};

function queryBatches(lists:Watchlist[]){
  const terms=new Set(lists.flatMap(list=>list.terms.filter(term=>term.direction==='include').map(term=>{
    const value=termKey(term);
    return term.kind==='phrase'?`"${value.replace(/["\\]/g,' ')}"`:value;
  })));
  const queries:string[]=[];
  for(const term of terms){
    const current=queries.at(-1);
    if(current&&current.length+term.length+4<=450)queries[queries.length-1]=`${current} OR ${term}`;
    else queries.push(term);
  }
  return queries;
}

function candidate(item:Candidate,now=Date.now()){
  const {namespace,id,canonicalId,text,authorId,handle,displayName,language,createdAt,kind,metrics,media}=item;
  const post={namespace,id,canonicalId,text,authorId,handle,displayName,language,createdAt,kind,metrics,...(media?{media}:{})};
  return {...post,observedAt:now,observation:'twscrape:'+hash(JSON.stringify(post))};
}

type Credentials=(signal:AbortSignal)=>Promise<CollectionCredentials>;
export function twscrapeDriver(worker:Pick<TwscrapeWorker,'live'>,db:string,credentials:Credentials):AuthorizedWebsiteDriver{
  async function run(operation:string,options:object,signal:AbortSignal,grant:string):Promise<LiveReply>{
    const session=await credentials(signal);
    if(session.status!=='Connected')return {status:failures[session.status]??401};
    if(!grant.startsWith('['))return {status:401};
    const parsed=binding.safeParse(JSON.parse(grant));
    if(!parsed.success||parsed.data[0]!==session.fingerprint)return {status:401};
    const {handle,authToken,csrfToken}=session;
    return worker.live(operation,db,{handle,authToken,csrfToken},
      {...options,accountId:parsed.data[1]},signal);
  }
  function response(result:{status:number;retryAt?:number},body?:object){
    const headers=result.retryAt?{'x-rate-limit-reset':String(Math.ceil(result.retryAt/1000))}:undefined;
    return body?Response.json(body,{status:result.status,headers}):new Response(null,{status:result.status,headers});
  }
  return {
    // The launcher checks the local opt-in. It does not issue or verify X permission.
    authorizationReference:'MONITOR_TWSCRAPE_LIVE',
    minPollMs:120_000,
    capabilities:['Latest search','Search pagination','Post engagement refresh','Following (up to 100 accounts)'],
    async authorizeInteractively(signal){
      const session=await credentials(signal);
      if(session.status!=='Connected')throw new ApiError(failures[session.status]??401,'X_SESSION_REQUIRED','Check your authenticated X session and try again.');
      const {handle,fingerprint,authToken,csrfToken,expiresAt}=session;
      const profile=await worker.live('profile',db,{handle,authToken,csrfToken},{},signal);
      if(profile.status!==200||!profile.id||profile.handle?.toLowerCase()!==handle.toLowerCase())
        throw new ApiError(profile.status===200?401:profile.status,'X_SESSION_UNAVAILABLE',
          profile.retryAt?`Collection is paused until ${new Date(profile.retryAt).toISOString()}.`:'X did not validate this collection session. Check the X account window.');
      return {handle,expiresAt,accountId:profile.id,opaqueGrant:JSON.stringify([fingerprint,profile.id])};
    },
    async search(grant,lists,cursor,signal){
      const queries=queryBatches(lists);
      if(!queries.length)return Response.json({items:[],next:null});
      const index=cursor!==null&&/^\d{1,6}$/.test(cursor)&&+cursor<queries.length?+cursor:0;
      const result=await run('search',{query:queries[index]},signal,grant);
      if(result.status!==200||!result.items)return response(result.status===200?{status:503}:result);
      const next=queries.length>1?String((index+1)%queries.length):null;
      return response(result,{items:result.items.map(post=>candidate(post)),next});
    },
    async lookup(grant,posts,signal){
      const result=await run('lookup',{ids:posts.slice(0,3).map(post=>post.id)},signal,grant);
      if(result.status!==200||!result.items)return response(result.status===200?{status:503}:result);
      return response(result,{items:result.items.map(post=>candidate(post)),next:null});
    },
    async following(grant,signal){
      const result=await run('following',{},signal,grant);
      if(result.status!==200||!result.following)return response(result.status===200?{status:503}:result);
      return response(result,{following:result.following});
    },
  };
}
