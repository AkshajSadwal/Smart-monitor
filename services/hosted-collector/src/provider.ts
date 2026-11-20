import {createHash} from 'node:crypto';
import {unknownMetrics,type Candidate} from '../../../packages/contracts/index';
import {normalizeResponse,searchResponseSchema} from '../../../packages/collection-core/x-protocol';
import {resetTime} from '../../../packages/collection-core/http';

const hour=3_600_000;
export type Cursor={start:number;end:number;token?:string;done:boolean};
export type ProviderPage={posts:Candidate[];cursor:Cursor;gap?:string};
export interface HostedProvider {
  readonly kind:'simulation'|'official-api';
  readonly identity:string;
  isCurrent?():boolean;
  collect(topic:string,cursor:Cursor,now:number,signal:AbortSignal,reserve:()=>void):Promise<ProviderPage>;
}
export class UpstreamError extends Error {
  constructor(message:string,readonly retry?:number,readonly hold=false){super(message);}
}
export function simulation(interval:number):HostedProvider {
  return {kind:'simulation',identity:'default',async collect(topic,cursor,now){
    const id='hosted-'+createHash('sha256').update(`${topic}:${Math.floor(now/interval)}`).digest('hex').slice(0,24);
    return {cursor:{...cursor,done:true},posts:[{namespace:'mock',id,canonicalId:id,text:`Simulated update about ${topic}.`,
      authorId:'hosted-demo',handle:'hosted_demo',displayName:'Hosted simulation',language:'en',createdAt:now,kind:'original',
      metrics:{...unknownMetrics,likes:20},observedAt:now,observation:id}]};
  }};
}
export function officialProvider(identity:string,credential:()=>string,transport:typeof fetch=fetch,isCurrent?:()=>boolean):HostedProvider {
  return {kind:'official-api',identity,isCurrent,async collect(topic,cursor,now,signal,reserve){
    if(cursor.start>=cursor.end)return {posts:[],cursor:{...cursor,done:true}};
    const bearer=credential();
    reserve();
    const date=(value:number)=>new Date(value).toISOString().replace('.000Z','Z');
    const params=new URLSearchParams({query:`"${topic}"`,start_time:date(cursor.start),end_time:date(cursor.end),max_results:'10',sort_order:'recency',
      'tweet.fields':'author_id,created_at,lang,public_metrics,referenced_tweets,edit_history_tweet_ids',expansions:'author_id','user.fields':'username,name'});
    if(cursor.token)params.set('next_token',cursor.token);
    const res=await transport('https://api.x.com/2/tweets/search/recent?'+params,{
      signal:AbortSignal.any([signal,AbortSignal.timeout(20_000)]),redirect:'error',headers:{Authorization:'Bearer '+bearer},
    });
    if(!res.ok)await res.body?.cancel().catch(()=>{});
    if(res.status===429)throw new UpstreamError('Rate limited',resetTime(res.headers,now,60_000));
    if([401,402,403].includes(res.status))throw new UpstreamError('Upstream access or credit denied',undefined,true);
    if(res.status===400&&cursor.token)return {cursor:{...cursor,token:undefined},posts:[],gap:'Cursor expired. Resuming the saved window.'};
    if(res.status===400)throw new UpstreamError('Upstream rejected query',now+24*hour);
    if(!res.ok)throw new UpstreamError('Upstream unavailable');
    const body=searchResponseSchema.parse(await res.json());
    const posts=normalizeResponse(body,now,`hosted:${cursor.start}:${cursor.end}`);
    const next=body.meta?.next_token;
    if(next&&next===cursor.token)return {cursor:{...cursor,token:undefined},posts,gap:'Repeated cursor. Resuming the saved window.'};
    const partial=!!body.errors?.length||posts.length!==(body.data?.length??0);
    return {posts,cursor:{...cursor,token:next,done:!next},gap:partial?'Upstream returned partial results.':undefined};
  }};
}
