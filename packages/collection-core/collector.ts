import {z} from 'zod';
import {kindSchema,metricsSchema,namespaceSchema,type Candidate,type CollectorId,type Watchlist} from '../contracts/index';

const id=z.string().regex(/^[\w-]{1,100}$/);
const xPostId=z.string().regex(/^\d{1,25}$/);
export const collectedPost=z.strictObject({
  namespace:namespaceSchema,id,canonicalId:id,text:z.string().max(100_000),
  authorId:z.string().max(100).nullable(),handle:z.string().max(30).nullable(),
  displayName:z.string().max(200).nullable(),language:z.string().max(35).nullable(),createdAt:z.number().int().nonnegative().nullable(),
  kind:kindSchema,metrics:metricsSchema,observedAt:z.number().int().nonnegative(),observation:z.string().max(200),
}).refine(post=>post.namespace==='mock'||[post.id,post.canonicalId].every(id=>xPostId.safeParse(id).success));

export type CommitPage = (posts:Candidate[],historical:boolean,key:string,state:unknown)=>void;
export interface Collector {
  readonly id:CollectorId;
  readonly capabilities:readonly string[];
  collect(lists:Watchlist[],now:number,signal:AbortSignal,commit:CommitPage):Promise<boolean>;
  lookup?(posts:Candidate[],now:number,signal:AbortSignal,attempts?:Map<string,number>):Promise<{posts:Candidate[];removed:string[]}>;
  refreshSignals?(now:number,signal:AbortSignal):Promise<void>;
  disconnect?():Promise<void>;
}

export class SourceManager {
  private readonly sources=new Map<CollectorId,Collector>();
  constructor(...collectors:Collector[]) {
    for (const collector of collectors) {
      if(this.sources.has(collector.id))throw new Error('Duplicate collector');
      this.sources.set(collector.id,collector);
    }
  }
  get(id:CollectorId) {return this.sources.get(id);}
}
