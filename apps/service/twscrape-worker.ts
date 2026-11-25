import {execFile} from 'node:child_process';
import {join} from 'node:path';
import {z} from 'zod';
import {postMediaSchema} from '../../packages/contracts/index';
import {collectedPost} from '../../packages/collection-core/collector';

const workerPost=collectedPost.safeExtend({namespace:z.literal('x'),media:z.array(postMediaSchema).max(10).nullable()});
const postBatch=z.array(workerPost).min(1).max(50);
const statusReply=z.discriminatedUnion('status',[
  z.object({status:z.literal('Ready'),version:z.string(),limits:z.object({hour:z.number().int().positive(),day:z.number().int().positive()})}),
  z.object({status:z.enum(['Package missing','Package version mismatch','Unavailable'])}),
]);
const envelope=z.union([z.strictObject({result:z.unknown()}),z.strictObject({error:z.enum(['Invalid request','Worker unavailable'])})]);
const xId=z.string().regex(/^\d{1,25}$/);
const liveReply=z.strictObject({status:z.union([z.literal(200),z.literal(401),z.literal(403),z.literal(428),z.literal(429),z.literal(503)]),
  retryAt:z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),id:xId.optional(),handle:z.string().max(15).optional(),
  following:z.array(xId).max(100).optional(),items:z.array(workerPost).max(40).optional()});
export type LiveReply=z.infer<typeof liveReply>;

export class TwscrapeWorker {
  private probe?:{expires:number;result:Promise<z.infer<typeof statusReply>>};
  private networkActive=false;

  constructor(private readonly python:string,private readonly directory:string){}

  status(){
    if(!this.probe||Date.now()>=this.probe.expires){
      const result=this.run({action:'status'},AbortSignal.timeout(4000)).then(reply=>statusReply.parse(reply))
        .catch(()=>({status:'Unavailable' as const}));
      this.probe={expires:Date.now()+30_000,result};
    }
    return this.probe.result;
  }

  async normalize(text:string,now:number,signal:AbortSignal){
    return postBatch.parse(await this.run({action:'normalize',text,now},signal));
  }

  async live(operation:string,db:string,credentials:{handle:string;authToken:string;csrfToken:string},options:object,signal:AbortSignal):Promise<LiveReply>{
    signal.throwIfAborted();
    if(this.networkActive)return {status:503 as const};
    this.networkActive=true;
    const released=()=>{this.networkActive=false;};
    return liveReply.parse(await this.run({...options,action:'live',operation,db,credentials},signal,released));
  }

  private run(request:object,signal:AbortSignal,release?:()=>void):Promise<unknown>{
    return new Promise((resolve,reject)=>{
      if(signal.aborted){release?.();reject(signal.reason);return;}
      const child=execFile(this.python,['-I','-B','-X','utf8',join(this.directory,'twscrape_worker.py')],{
        signal,timeout:release?18_000:5000,windowsHide:true,maxBuffer:512*1024,
      },(error,stdout)=>{
        if(signal.aborted){reject(signal.reason);return;}
        if(error){reject(new Error('Worker unavailable'));return;}
        try{
          const reply=envelope.parse(JSON.parse(stdout));
          if('error' in reply)throw new Error(reply.error);
          resolve(reply.result);
        }catch(error){reject(error);}
      });
      if(release)child.once('close',release);
      child.stdin?.on('error',()=>{});
      child.stdin?.end(JSON.stringify(request));
    });
  }
}
