import {createHash} from 'node:crypto';
import {unknownMetrics,type Candidate} from '../../../packages/contracts/index';

export type Cursor={start:number;end:number;token?:string;done:boolean};
export type ProviderPage={posts:Candidate[];cursor:Cursor;gap?:string};
export interface HostedProvider {
  readonly kind:'simulation'|'website-session';
  readonly identity:string;
  isCurrent?():boolean;
  collect(topic:string,cursor:Cursor,now:number,signal:AbortSignal):Promise<ProviderPage>;
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
