import {lookup} from 'node:dns/promises';
import {request} from 'node:https';
import {BlockList,isIP} from 'node:net';
import {Readable} from 'node:stream';
import {z} from 'zod';
import {normalize,type Watchlist} from '../../packages/contracts/index';
import type {Collector,CommitPage} from '../../packages/collection-core/collector';
import {hostedEvent,hostedStatus,topicSchema,topicsSchema,type Delivery} from '../../packages/collection-core/hosted';
import {lines,resetTime} from '../../packages/collection-core/http';
import {ApiError} from './api';
import {hash,type Store} from './storage';
import type {Vault} from './x-api';

const denied=new BlockList();
for(const [ip,prefix] of [
  ['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],
  ['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],
  ['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4],
] as const)denied.addSubnet(ip,prefix);
const v6public=new BlockList();v6public.addSubnet('2000::',3,'ipv6');
for(const [ip,bits] of [['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]] as const)denied.addSubnet(ip,bits,'ipv6');
export const publicIp=(address:string)=>{
  const family=isIP(address);
  return family===4?!denied.check(address):family===6&&v6public.check(address,'ipv6')&&!denied.check(address,'ipv6');
};
export function hostedOrigin(input:string) {
  let url:URL;
  try {url=new URL(input);}
  catch {throw new ApiError(400,'HOST_INVALID','Enter an HTTPS origin for your hosted service.');}
  if(url.protocol!=='https:'||url.port||url.username||url.password||url.pathname!=='/'||url.search||url.hash||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(url.hostname)||
    /(?:^|\.)(localhost|local|internal|test|invalid|onion|home|lan|arpa)$/.test(url.hostname))throw new ApiError(400,'HOST_INVALID','Enter a public HTTPS hostname on port 443.');
  return url.origin;
}
type Route='/v1/status'|'/v1/subscriptions'|`/v1/events?after=${number}`;
type Transport=(origin:string,path:Route,token:string,signal:AbortSignal,body?:unknown)=>Promise<Response>;
const hostedTransport:Transport=async(origin,path,token,signal,body)=>{
  const url=new URL(hostedOrigin(origin));
  const addresses=await lookup(url.hostname,{all:true,verbatim:true});
  if(!addresses.length||addresses.some(reply=>!publicIp(reply.address)))throw new ApiError(403,'HOST_RESTRICTED','The hosted hostname resolved to a restricted address.');
  signal.throwIfAborted();
  const address=addresses.find(reply=>reply.family===4)??addresses[0];
  const payload=body===undefined?undefined:JSON.stringify(body);
  return new Promise((resolve,reject)=>{
    const req=request(url,{
      path,method:payload===undefined?'GET':'PUT',hostname:address.address,family:address.family,servername:url.hostname,
      agent:false,signal,headers:{Host:url.host,Authorization:'Bearer '+token,
        Accept:path.startsWith('/v1/events')?'text/event-stream':'application/json',
        ...(payload===undefined?{}:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)})},
    },res=>{
      const status=res.statusCode??502;
      const headers=new Headers();
      for(const [name,value] of Object.entries(res.headers))if(value!==undefined)headers.set(name,Array.isArray(value)?value.join(', '):value);
      if(status>=300&&status<400){res.destroy();reject(new ApiError(403,'HOST_REDIRECT','Hosted service redirects are disabled.'));return;}
      if([204,205,304].includes(status)){res.resume();resolve(new Response(null,{status,headers}));return;}
      resolve(new Response(Readable.toWeb(res) as ReadableStream<Uint8Array>,{status,headers}));
    });
    req.once('error',reject);
    req.end(payload);
  });
};

type Config={origin:string;topics:string[];consent:boolean};
type Telemetry={topics:string[];latencyMs:number|null;delivery:Delivery;coverage:string|null};
const inputSchema=z.strictObject({origin:z.string().trim().min(1).max(255),topics:topicsSchema,consent:z.literal(true)});
export class HostedClient implements Collector {
  readonly id='hosted';
  readonly capabilities=['Consent-based topic subscriptions','Authenticated SSE and checkpoint replay','Ranking and alerts run locally'];
  private streamAfter=0;
  private streamFailures=0;
  private eligible=false;
  private subscriptionQueue=Promise.resolve<unknown>(undefined);
  private cleanupConfirmed=true;
  constructor(readonly store:Store,readonly vault:Vault,private readonly transport:Transport=hostedTransport,private readonly changed:()=>void=()=>{}){}
  get config(){return this.store.value<Config|null>('hosted:config',null);}
  private get row(){return this.store.sources.find(source=>source.id==='hosted')!;}
  private key(origin:string){return 'hosted-'+hash(origin).slice(0,24);}
  get diagnostics(){
    const config=this.config;
    if(!config)return undefined;
    const t=this.store.value<Telemetry|null>('hosted:telemetry',null);
    return {origin:config.origin,topics:t?.topics??[],approvedTopics:config.topics,latencyMs:t?.latencyMs??null,delivery:t?.delivery??'unknown',consent:config.consent};
  }
  private setStatus(state:string,error:string|null=null,gap:string|null=null){
    this.store.run("UPDATE data_sources SET status=?,error_code=?,gap=? WHERE id='hosted'",state,error,gap);
    this.changed();
  }
  private subscription<T>(work:()=>Promise<T>){
    const next=this.subscriptionQueue.then(work);
    this.subscriptionQueue=next.catch(()=>{});
    return next;
  }
  allowedTopics(lists:Watchlist[],config:Config){
    const candidates=new Set(lists.filter(l=>l.enabled).flatMap(l=>l.terms.filter(t=>t.direction==='include').flatMap(t=>{
      const result=topicSchema.safeParse(t.kind==='hashtag'?'#'+normalize(t.text).replace(/^#/,''):t.text);
      return result.success?[result.data]:[];
    })));
    return config.topics.filter(topic=>candidates.has(topic));
  }
  async configure(input:unknown) {
    const form=inputSchema.parse(input),origin=hostedOrigin(form.origin);
    if(!form.topics.length)throw new ApiError(400,'TOPIC_REQUIRED','Approve at least one public search topic.');
    const config=this.config;
    const selected=this.allowedTopics(this.store.lists,{...form,origin});
    if(selected.length!==form.topics.length)throw new ApiError(400,'TOPIC_INVALID','Select topics from enabled watchlists.');
    if(config&&config.origin!==origin)await this.disconnect();
    const credential=await this.vault.get(this.key(origin));
    this.store.set('hosted:config',{...form,origin});
    this.store.set('next:hosted',0);
    this.streamAfter=0;
    this.eligible=false;
    this.store.run("UPDATE data_sources SET configured=?,generation=generation+1 WHERE id='hosted'",+!!credential);
    this.setStatus(credential?'Configured':'Client credential required');
    return this.diagnostics;
  }
  async credential(value:string){
    const config=this.config;
    if(!config?.consent)throw new ApiError(409,'CONSENT_REQUIRED','Approve a hosted service and public topics before saving a token.');
    if(!/^[\w-]{43}$/.test(value))throw new ApiError(400,'INVALID_TOKEN','Enter the 43-character client token issued by the VM administrator.');
    await this.vault.set(this.key(config.origin),value);
    this.store.run("UPDATE data_sources SET configured=1,vault_ref='client-token',generation=generation+1 WHERE id='hosted'");
    this.store.set('next:hosted',0);
    this.streamAfter=0;
    this.setStatus('Configured');
  }
  private async call(config:Config,path:Route,signal:AbortSignal,body?:unknown){
    const token=await this.vault.get(this.key(config.origin));
    if(!token)throw new ApiError(409,'CLIENT_CREDENTIAL_REQUIRED','Save the hosted service client credential first.');
    signal.throwIfAborted();
    const response=await this.transport(config.origin,path,token,signal,body);
    if(response.status===429){
      const next=resetTime(response.headers,Date.now(),60_000);
      this.store.set('next:hosted',next);this.streamAfter=next;
      await response.body?.cancel();
      throw new ApiError(429,'HOST_RATE_LIMIT','The hosted service is rate limited.');
    }
    if(!response.ok){
      await response.body?.cancel();
      throw new ApiError(response.status,[401,403].includes(response.status)?'HOST_ACCESS_DENIED':response.status===409?'HOST_CONFLICT':'HOST_UNAVAILABLE','Hosted request rejected.');
    }
    return response;
  }
  private async statusResponse(response:Response){
    if(!response.body)throw new Error('Empty hosted status');
    let data='';
    for await(const line of lines(response.body,16384)){
      data+=line;
      if(data.length>16384)throw new Error('Hosted status too large');
    }
    return hostedStatus.parse(JSON.parse(data));
  }
  private telemetry(value:z.infer<typeof hostedStatus>,started:number){
    const coverage=value.topics.find(topic=>!/^(?:Queued|Polling)$/.test(topic.state))?.state??null;
    const t:Telemetry={topics:value.topics.map(topic=>topic.topic),delivery:value.delivery,latencyMs:Date.now()-started,coverage};
    this.store.set('hosted:telemetry',t);
    return t;
  }
  async check(){
    const config=this.config;
    if(!config?.consent)throw new ApiError(409,'CONSENT_REQUIRED','Approve the hosted service first.');
    const now=Date.now(),signal=AbortSignal.timeout(10_000);
    try {
      const result=await this.statusResponse(await this.call(config,'/v1/status',signal));
      this.telemetry(result,now);
      this.streamAfter=0;
      this.store.set('next:hosted',0);
      this.setStatus(result.delivery==='disabled'?'Publication unavailable':'Connected',result.delivery==='disabled'?'PUBLICATION_DISABLED':null);
    }catch(error){this.failure(error);throw new ApiError(503,'HOST_CHECK_FAILED','The hosted service check failed. See connection diagnostics.');}
  }
  async collect(lists:Watchlist[],_now:number,signal:AbortSignal){
    const config=this.config;
    if(!config?.consent||!this.row.configured)return false;
    const topics=this.allowedTopics(lists,config),started=Date.now();
    try{
      const result=await this.subscription(()=>this.call(config,'/v1/subscriptions',AbortSignal.any([signal,AbortSignal.timeout(12_000)]),{topics}).then(r=>this.statusResponse(r)));
      if(signal.aborted)return false;
      const t=this.telemetry(result,started);
      this.eligible=result.delivery!=='disabled'&&t.topics.length>0;
      this.setStatus(this.eligible?(this.row.status==='Streaming'?'Streaming':'Connected'):result.delivery==='disabled'?'Publication unavailable':'No approved active topics',
        result.delivery==='disabled'?'PUBLICATION_DISABLED':null,t.coverage);
      return this.eligible;
    }catch(error){if(!signal.aborted)this.failure(error);return false;}
  }
  async stream(lists:Watchlist[],signal:AbortSignal,commit:CommitPage){
    const config=this.config;
    if(!config?.consent||!this.eligible||Date.now()<this.streamAfter)return;
    const accepted=new Set(this.allowedTopics(lists,config));
    const key='hosted:cursor:'+hash(config.origin);
    let cursor=this.store.value(key,0);
    const run=new AbortController();
    let watchdog:ReturnType<typeof setTimeout>|undefined,event='',data='',id=0;
    const renew=()=>{clearTimeout(watchdog);watchdog=setTimeout(()=>run.abort(),20_000);watchdog.unref();};
    try {
      renew();
      const stream=await this.call(config,`/v1/events?after=${cursor}`,AbortSignal.any([signal,run.signal]));
      if(!stream.body||!stream.headers.get('content-type')?.startsWith('text/event-stream'))throw new Error('Invalid stream');
      this.setStatus('Streaming');
      for await(const line of lines(stream.body,524288)){
        if(signal.aborted)break;
        renew();
        if(line.startsWith('event: ')){event=line.slice(7);continue;}
        if(line.startsWith('id: ')){id=Number(line.slice(4));continue;}
        if(line.startsWith('data: ')){
          data+=(data?'\n':'')+line.slice(6);
          if(data.length>524288)throw new Error('Oversized event');
          continue;
        }
        if(line||!data)continue;
        const parsed:unknown=JSON.parse(data);
        if(event==='heartbeat'){
          const status=hostedStatus.parse(parsed);
          const t=this.telemetry(status,Math.min(Date.now(),status.serverTime));
          this.setStatus('Streaming',null,t.coverage);
          this.streamFailures=0;
        }
        if(event==='gap')this.setStatus('Streaming',null,'Some hosted events expired before they could be resumed.');
        if(event==='post'&&Number.isSafeInteger(id)&&id>cursor){
          const packet=hostedEvent.parse(parsed);
          const now=Date.now();
          if(accepted.has(packet.topic))commit([{...packet.post,observedAt:Math.min(now,packet.post.observedAt),observation:'hosted:'+packet.post.observation}],
            packet.post.observedAt<now-10*60_000,key,id);
          else commit([],true,key,id);
          cursor=id;
        }
        event='';data='';id=0;
      }
      if(!signal.aborted)throw new Error('Hosted connection ended');
    }catch(error){
      if(!signal.aborted){
        if(error instanceof ApiError&&error.code==='HOST_CONFLICT'&&cursor>0){
          commit([],true,key,0);
          this.streamAfter=Date.now()+5000;
          this.store.set('next:hosted',this.streamAfter);
          this.setStatus('Reconnecting',null,'The hosted delivery checkpoint was reset. Some events may be unavailable.');
        } else this.failure(error);
      }
    }
    finally{clearTimeout(watchdog);run.abort();}
  }
  private failure(error:unknown){
    this.eligible=false;
    const code=error instanceof ApiError?error.code:'HOST_UNAVAILABLE';
    if(code==='HOST_ACCESS_DENIED'||code==='CLIENT_CREDENTIAL_REQUIRED'){
      this.streamAfter=Number.MAX_SAFE_INTEGER;
      this.store.set('next:hosted',this.streamAfter);
      this.setStatus('Authentication required',code);
      return;
    }
    if(code!=='HOST_RATE_LIMIT'){
      this.streamAfter=Date.now()+Math.min(300_000,5000*2**Math.min(6,this.streamFailures++));
      this.store.set('next:hosted',this.streamAfter);
    }
    this.setStatus(code==='HOST_RATE_LIMIT'?'Rate limited':'Temporarily unavailable',code);
  }
  async pause(){
    const config=this.config;
    this.eligible=false;
    this.cleanupConfirmed=true;
    if(!config?.consent||!this.row.configured)return;
    try{
      const now=Date.now();
      const result=await this.subscription(()=>this.call(config,'/v1/subscriptions',AbortSignal.timeout(8000),{topics:[]}).then(r=>this.statusResponse(r)));
      this.telemetry(result,now);
    }catch{
      this.cleanupConfirmed=false;
      this.setStatus('Paused locally','REMOTE_CLEANUP_UNCONFIRMED','Hosted subscriptions expire after the VM lease.');
    }
  }
  async disconnect(){
    const config=this.config;
    await this.pause();
    this.store.db.transaction(()=>{
      if(this.row.active){
        this.store.run("UPDATE data_sources SET active=0 WHERE id='hosted'");
        this.store.run("UPDATE data_sources SET active=1 WHERE id='mock'");
        this.store.set('paused',true);
      }
      this.store.run("UPDATE data_sources SET configured=0,generation=generation+1 WHERE id='hosted'");
      this.store.run("DELETE FROM monitoring_jobs WHERE collector='hosted'");
    })();
    if(config)await this.vault.remove(this.key(config.origin));
    this.store.run("DELETE FROM settings WHERE key LIKE 'hosted:%' OR key='next:hosted'");
    this.store.run("UPDATE data_sources SET vault_ref=NULL WHERE id='hosted'");
    this.setStatus('Disconnected',this.cleanupConfirmed?null:'REMOTE_CLEANUP_UNCONFIRMED',
      this.cleanupConfirmed?null:'Hosted subscriptions expire after the VM lease.');
  }
}
