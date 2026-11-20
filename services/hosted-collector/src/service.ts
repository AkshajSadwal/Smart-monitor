import Fastify from 'fastify';
import Database from 'better-sqlite3';
import {createHash,createCipheriv,createDecipheriv,randomBytes,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {unknownMetrics,type Candidate} from '../../../packages/contracts/index';
import {hostedEvent,hostedStatus,topicsSchema,type Delivery} from '../../../packages/collection-core/hosted';
import {normalizeResponse,responseSchema} from '../../../packages/collection-core/x-protocol';
import {resetTime} from '../../../packages/collection-core/http';

const HOUR=3_600_000;
const safeHash=(data:string)=>createHash('sha256').update(data).digest('hex');
const tokenRx=/^[A-Za-z0-9_-]{43}$/;
const integer=(v:unknown)=>z.coerce.number().int().nonnegative().safe().parse(v);
type Topic={topic:string;checkpoint:string|null;due:number;state:string;attempt:number};
type Cursor={start:number;end:number;token?:string;done:boolean};
type ProviderPage={posts:Candidate[];cursor:Cursor;gap?:string};
type HostedOptions={
  mode:Delivery;clock?:()=>number;intervalMs?:number;retainMs?:number;topicLimit?:number;
  transport?:typeof fetch;permission?:string;bearer?:string;dailyRequests?:number;dailyResources?:number;
};

export class HostedStore {
  readonly db:Database.Database;
  constructor(path:string) {
    this.db=new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 3000');
    this.db.pragma('secure_delete = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS clients(id TEXT PRIMARY KEY,token_hash TEXT UNIQUE NOT NULL,label TEXT NOT NULL,seen INTEGER NOT NULL,delivered INTEGER NOT NULL DEFAULT 0,revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS topics(topic TEXT PRIMARY KEY,checkpoint TEXT,due INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL DEFAULT 'Queued',attempt INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS memberships(client TEXT REFERENCES clients ON DELETE CASCADE,topic TEXT REFERENCES topics ON DELETE CASCADE,after_id INTEGER NOT NULL,PRIMARY KEY(client,topic));
      CREATE TABLE IF NOT EXISTS delivery(client TEXT PRIMARY KEY REFERENCES clients ON DELETE CASCADE,last_sent INTEGER NOT NULL,offered_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,topic TEXT REFERENCES topics ON DELETE CASCADE,observed INTEGER NOT NULL,post_key TEXT NOT NULL,payload TEXT NOT NULL,UNIQUE(topic,post_key));
      CREATE INDEX IF NOT EXISTS events_topic_id ON events(topic,id);
      CREATE INDEX IF NOT EXISTS membership_topic ON memberships(topic);
      CREATE TABLE IF NOT EXISTS audit(at INTEGER NOT NULL,action TEXT NOT NULL,object_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS secret(name TEXT PRIMARY KEY,cipher TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS usage(day TEXT PRIMARY KEY,requests INTEGER NOT NULL,resources INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS upstream(key TEXT PRIMARY KEY,value INTEGER NOT NULL);
    `);
  }
  issue(label:string,now=Date.now()) {
    const id=randomUUID(),token=randomBytes(32).toString('base64url');
    this.db.transaction(()=>{
      if(Number((this.db.prepare('SELECT count(*) n FROM clients WHERE revoked=0').get() as {n:number}).n)>=500)throw new Error('Client cap reached');
      this.db.prepare('INSERT INTO clients(id,token_hash,label,seen) VALUES (?,?,?,?)').run(id,safeHash(token),z.string().trim().min(1).max(80).parse(label),now);
      this.db.prepare('INSERT INTO audit VALUES (?,?,?)').run(now,'client-issued',id);
    })();
    return {id,token};
  }
  revoke(id:string,now=Date.now()) {
    this.db.transaction(()=>{
      this.db.prepare('UPDATE clients SET revoked=1 WHERE id=?').run(id);
      this.db.prepare('DELETE FROM memberships WHERE client=?').run(id);
      this.db.prepare('INSERT INTO audit VALUES (?,?,?)').run(now,'client-revoked',id);
      this.pruneTopics();
    })();
  }
  authenticate(header:string|undefined) {
    const token=header?.slice(7);
    if(!header?.startsWith('Bearer ')||!token||!tokenRx.test(token))return;
    return (this.db.prepare('SELECT id FROM clients WHERE token_hash=? AND revoked=0').get(safeHash(token)) as {id:string}|undefined)?.id;
  }
  replace(client:string,topics:string[],now:number,limit:number) {
    return this.db.transaction(()=>{
      const existing=this.current(client).map(row=>row.topic);
      const candidate=topics.filter(topic=>!existing.includes(topic));
      for(const removed of existing.filter(topic=>!topics.includes(topic)))this.db.prepare('DELETE FROM memberships WHERE client=? AND topic=?').run(client,removed);
      this.pruneTopics();
      const max=this.maxEvent();
      for(const topic of candidate){
        this.db.prepare('INSERT OR IGNORE INTO topics(topic,due) VALUES (?,?)').run(topic,now);
        this.db.prepare('INSERT INTO memberships VALUES (?,?,?)').run(client,topic,max);
      }
      const count=(this.db.prepare('SELECT count(*) n FROM topics').get() as {n:number}).n;
      if(count>limit)return false;
      this.db.prepare('UPDATE clients SET seen=? WHERE id=?').run(now,client);
      return true;
    });
  }
  current(client:string) {
    return this.db.prepare('SELECT t.topic,t.state FROM topics t JOIN memberships m ON m.topic=t.topic WHERE m.client=? ORDER BY t.topic').all(client) as {topic:string;state:string}[];
  }
  maxEvent() {return (this.db.prepare("SELECT coalesce((SELECT seq FROM sqlite_sequence WHERE name='events'),0) n").get() as {n:number}).n;}
  pruneTopics() {this.db.prepare('DELETE FROM topics WHERE NOT EXISTS (SELECT 1 FROM memberships WHERE memberships.topic=topics.topic)').run();}
  cleanup(now:number,retain:number) {
    this.db.transaction(()=>{
      this.db.prepare('DELETE FROM memberships WHERE EXISTS (SELECT 1 FROM clients c WHERE c.id=memberships.client AND c.seen<?)').run(now-2*HOUR);
      this.pruneTopics();
      const dropped=this.db.prepare('SELECT max(id) n FROM events WHERE observed<? OR id<=?').get(now-retain,this.maxEvent()-20_000) as {n:number|null};
      if(dropped.n!==null)this.db.prepare("INSERT INTO upstream VALUES ('replay-floor',?) ON CONFLICT(key) DO UPDATE SET value=max(value,excluded.value)").run(dropped.n);
      this.db.prepare('DELETE FROM events WHERE observed<? OR id<=?').run(now-retain,this.maxEvent()-20_000);
      this.db.prepare('DELETE FROM usage WHERE day<?').run(new Date(now-30*24*HOUR).toISOString().slice(0,10));
      this.db.prepare('DELETE FROM audit WHERE at<?').run(now-90*24*HOUR);
    })();
  }
  setBearer(raw:string,key:Buffer,now=Date.now()){
    if(key.length!==32||!raw.trim()||raw.length>4096)throw new Error('Invalid server credential or encryption key');
    const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
    cipher.setAAD(Buffer.from('smart-monitor-hosted:x-bearer:v1'));
    const body=Buffer.concat([cipher.update(raw.trim(),'utf8'),cipher.final()]);
    const sealed=Buffer.concat([iv,cipher.getAuthTag(),body]).toString('base64url');
    this.db.transaction(()=>{
      this.db.prepare("INSERT OR REPLACE INTO secret VALUES ('x-bearer',?)").run(sealed);
      this.db.prepare('INSERT INTO audit VALUES (?,?,?)').run(now,'credential-set','x-bearer');
      this.db.prepare("DELETE FROM upstream WHERE key='hold'").run();
    })();
  }
  getBearer(key:Buffer){
    const row=this.db.prepare("SELECT cipher FROM secret WHERE name='x-bearer'").get() as {cipher:string}|undefined;
    if(!row||key.length!==32)throw new Error('Server X credential is not configured');
    const data=Buffer.from(row.cipher,'base64url');
    const decipher=createDecipheriv('aes-256-gcm',key,data.subarray(0,12));
    decipher.setAAD(Buffer.from('smart-monitor-hosted:x-bearer:v1'));
    decipher.setAuthTag(data.subarray(12,28));
    return Buffer.concat([decipher.update(data.subarray(28)),decipher.final()]).toString('utf8');
  }
}

class UpstreamError extends Error {
  constructor(message:string,readonly retry?:number,readonly hold=false){super(message);}
}
export function createHostedService(store:HostedStore,options:HostedOptions) {
  const mode=options.mode,clock=options.clock??Date.now,interval=options.intervalMs??300_000;
  const retention=options.retainMs??24*HOUR,topicLimit=options.topicLimit??200;
  const live=mode==='ids'||mode==='approved-public';
  if(live&&(!options.permission?.trim()||!options.bearer||!options.dailyRequests||!options.dailyResources))throw new Error('Live publication requires a permission reference, operator credential and positive budgets');
  store.db.prepare("DELETE FROM events WHERE json_extract(payload,'$.delivery')<>?").run(mode);
  const transport=options.transport??fetch;
  const app=Fastify({logger:false,bodyLimit:8192,forceCloseConnections:true});
  const clients=new WeakMap<object,string>();
  const rate=new Map<string,{count:number;ends:number}>();
  const connections=new Map<string,()=>void>();
  let timer:ReturnType<typeof setInterval>|undefined,flight:Promise<void>|undefined,abort:AbortController|undefined,cleanupAt=0;
  const readState=(key:string)=>(store.db.prepare('SELECT value FROM upstream WHERE key=?').get(key) as {value:number}|undefined)?.value??0;
  const writeState=(key:string,value:number)=>store.db.prepare('INSERT OR REPLACE INTO upstream VALUES (?,?)').run(key,value);
  const response=(id:string)=>hostedStatus.parse({delivery:mode,serverTime:clock(),topics:store.current(id)});
  app.setErrorHandler((error,_req,reply)=>{
    const status=error instanceof z.ZodError?400:Number((error as {statusCode?:number}).statusCode)||500;
    void reply.code(status).send({error:status<500?'Request rejected':'Hosted service unavailable'});
  });
  app.addHook('onRequest',async(req,reply)=>{
    reply.header('Cache-Control','no-store');
    if(req.routeOptions.url==='/health')return;
    const id=store.authenticate(req.headers.authorization);
    const now=clock();
    const key=id??'unauthenticated';
    let meter=rate.get(key);
    if(!meter||meter.ends<=now){meter={count:0,ends:now+60_000};rate.set(key,meter);}
    if(++meter.count>(id?60:240))return reply.header('Retry-After','60').code(429).send({error:'Rate limited'});
    if(!id)return reply.code(401).send({error:'Client credential required'});
    clients.set(req,id);
    store.db.prepare('UPDATE clients SET seen=? WHERE id=? AND seen<?').run(now,id,now-60_000);
  });
  app.get('/health',()=>({service:'smart-monitor-hosted',version:1}));
  app.get('/v1/status',req=>response(clients.get(req)!));
  app.put('/v1/subscriptions',(req,reply)=>{
    const {topics}=z.strictObject({topics:topicsSchema}).parse(req.body);
    const id=clients.get(req)!;
    if(mode==='disabled'&&topics.length)return reply.code(409).send({error:'Live publication is disabled'});
    const sync=store.replace(id,topics,clock(),topicLimit);
    try {store.db.transaction(()=>{if(!sync())throw new Error('cap');})();}
    catch {return reply.code(409).send({error:'Server topic capacity reached'});}
    return response(id);
  });
  app.get('/v1/events',(req,reply)=>{
    const id=clients.get(req)!;
    let cursor=integer(z.object({after:z.unknown().optional()}).parse(req.query).after??0);
    if(cursor>store.maxEvent())return reply.code(409).send({error:'Invalid delivery cursor'});
    connections.get(id)?.();
    if(connections.size>=100)return reply.code(429).header('Retry-After','60').send({error:'Connection cap reached'});
    reply.hijack();
    reply.raw.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','X-Accel-Buffering':'no'});
    if(cursor>0&&cursor<readState('replay-floor'))reply.raw.write('event: gap\ndata: {"reason":"expired"}\n\n');
    let closed=false,beat=0;
    const stop=()=>{
      if(closed)return;
      closed=true;clearInterval(streamTimer);
      if(connections.get(id)===stop)connections.delete(id);
      if(!reply.raw.writableEnded)reply.raw.end();
    };
    const send=()=>{
      if(!store.authenticate(req.headers.authorization)){stop();return;}
      const rows=store.db.prepare(`SELECT e.id,e.payload FROM events e JOIN memberships m ON m.topic=e.topic
        WHERE m.client=? AND e.id>? AND e.id>m.after_id ORDER BY e.id LIMIT 25`).all(id,cursor) as {id:number;payload:string}[];
      for(const row of rows){
        if(!reply.raw.write(`id: ${row.id}\nevent: post\ndata: ${row.payload}\n\n`)){stop();return;}
        cursor=row.id;
      }
      if(rows.length)store.db.prepare('INSERT INTO delivery VALUES (?,?,?) ON CONFLICT(client) DO UPDATE SET last_sent=max(last_sent,excluded.last_sent),offered_at=excluded.offered_at').run(id,cursor,clock());
      if(++beat%5===1&&!reply.raw.write(`event: heartbeat\ndata: ${JSON.stringify(response(id))}\n\n`))stop();
    };
    store.db.prepare('UPDATE clients SET delivered=max(delivered,?) WHERE id=?').run(cursor,id);
    const streamTimer=setInterval(send,1000);
    streamTimer.unref();
    reply.raw.once('close',stop);
    connections.set(id,stop);
    send();
  });
  function reserve(now:number) {
    const date=new Date(now).toISOString().slice(0,10);
    store.db.transaction(()=>{
      const used=store.db.prepare('SELECT requests,resources FROM usage WHERE day=?').get(date) as {requests:number;resources:number}|undefined;
      if((used?.requests??0)+1>(options.dailyRequests??0)||(used?.resources??0)+20>(options.dailyResources??0))
        throw new UpstreamError('Budget paused',Date.parse(date)+24*HOUR);
      store.db.prepare('INSERT INTO usage VALUES (?,1,20) ON CONFLICT(day) DO UPDATE SET requests=requests+1,resources=resources+20').run(date);
    })();
  }
  async function page(topic:Topic,now:number,signal:AbortSignal):Promise<ProviderPage> {
    const old=topic.checkpoint?JSON.parse(topic.checkpoint) as Cursor:null;
    const end=Math.floor((now-40_000)/1000)*1000;
    const start=old?.end??end-10*60_000;
    const cursor=old&&!old.done&&old.start>=end-HOUR?old:{start:Math.max(start,end-HOUR),end,done:false};
    const gap=start<end-HOUR||!!(old&&!old.done&&old.start<end-HOUR)?'Older coverage exceeded the one-hour recovery window.':undefined;
    if(mode==='simulated'){
      const id='hosted-'+safeHash(`${topic.topic}:${Math.floor(now/interval)}`).slice(0,24);
      return {cursor:{...cursor,done:true},posts:[{namespace:'mock',id,canonicalId:id,text:`Simulated update about ${topic.topic}.`,
        authorId:'hosted-demo',handle:'hosted_demo',displayName:'Hosted simulation',language:'en',createdAt:now,kind:'original',
        metrics:{...unknownMetrics,likes:20},observedAt:now,observation:id}]};
    }
    if(!live||cursor.start>=cursor.end)return {posts:[],cursor:{...cursor,done:true},gap};
    reserve(now);
    const params=new URLSearchParams({query:`"${topic.topic}"`,start_time:new Date(cursor.start).toISOString().replace('.000Z','Z'),
      end_time:new Date(cursor.end).toISOString().replace('.000Z','Z'),max_results:'10',sort_order:'recency',
      'tweet.fields':'author_id,created_at,lang,public_metrics,referenced_tweets,edit_history_tweet_ids',expansions:'author_id','user.fields':'username,name'});
    if(cursor.token)params.set('next_token',cursor.token);
    const res=await transport('https://api.x.com/2/tweets/search/recent?'+params,{
      signal:AbortSignal.any([signal,AbortSignal.timeout(20_000)]),redirect:'error',headers:{Authorization:'Bearer '+options.bearer},
    });
    if(res.status===429)throw new UpstreamError('Rate limited',resetTime(res.headers,now,60_000));
    if([401,402,403].includes(res.status))throw new UpstreamError('Upstream access or credit denied',undefined,true);
    if(res.status===400&&cursor.token)return {cursor:{...cursor,token:undefined},posts:[],gap:'Cursor expired. Resuming the saved window.'};
    if(res.status===400)throw new UpstreamError('Upstream rejected query',now+24*HOUR);
    if(!res.ok)throw new UpstreamError('Upstream unavailable');
    const body=responseSchema.parse(await res.json());
    const posts=normalizeResponse(body,now,`hosted:${cursor.start}:${cursor.end}`);
    const next=body.meta?.next_token;
    if(next&&next===cursor.token)return {cursor:{...cursor,token:undefined},posts,gap:'Repeated cursor. Resuming the saved window.'};
    return {posts,cursor:{...cursor,token:next,done:!next},gap:body.errors?.length?'Upstream returned partial results.':gap};
  }
  async function collect(signal:AbortSignal) {
    const now=clock();
    if(now>=cleanupAt){store.cleanup(now,retention);cleanupAt=now+60_000;for(const [key,v] of rate)if(v.ends<=now)rate.delete(key);}
    if(mode==='disabled'||readState('hold')||readState('retry')>now)return;
    const jobs=store.db.prepare('SELECT * FROM topics WHERE due<=? ORDER BY due,topic LIMIT 4').all(now) as Topic[];
    for(const topic of jobs){
      if(signal.aborted)return;
      try{
        const result=await page(topic,now,signal);
        if(signal.aborted)return;
        store.db.transaction(()=>{
          if(!store.db.prepare('SELECT 1 FROM topics WHERE topic=?').get(topic.topic))return;
          for(const post of result.posts){
            const permitted=mode==='ids'?{...post,text:'',authorId:null,handle:null,displayName:null,language:null,createdAt:null,
              kind:'unknown' as const,metrics:unknownMetrics}:post;
            const event=hostedEvent.parse({topic:topic.topic,delivery:mode,post:permitted});
            store.db.prepare('INSERT OR IGNORE INTO events(topic,observed,post_key,payload) VALUES (?,?,?,?)')
              .run(topic.topic,now,permitted.namespace+':'+permitted.id+':'+permitted.observation,JSON.stringify(event));
          }
          store.db.prepare('UPDATE topics SET checkpoint=?,state=?,due=?,attempt=0 WHERE topic=?')
            .run(JSON.stringify(result.cursor),result.gap??(result.cursor.done?'Polling':'Paging · checkpoint saved'),
              now+(result.cursor.done?interval:Math.min(interval,30_000)),topic.topic);
        })();
      }catch(error){
        if(signal.aborted)return;
        const issue=error instanceof UpstreamError?error:new UpstreamError('Temporary upstream or response error');
        const due=issue.retry??now+Math.min(30*60_000,30_000*2**Math.min(topic.attempt,6));
        store.db.prepare('UPDATE topics SET state=?,due=?,attempt=attempt+1 WHERE topic=?').run(issue.message,due,topic.topic);
        if(issue.hold){writeState('hold',1);store.db.prepare("UPDATE topics SET state='Upstream access or credit denied'").run();return;}
        if(issue.message==='Rate limited'||issue.message==='Budget paused'){writeState('retry',due);store.db.prepare('UPDATE topics SET state=?').run(issue.message);return;}
      }
    }
  }
  const tick=()=>{
    if(!flight){
      abort=new AbortController();
      flight=collect(abort.signal).finally(()=>{flight=undefined;abort=undefined;});
    }
    return flight;
  };
  app.addHook('onClose',async()=>{clearInterval(timer);abort?.abort();await flight;});
  return {
    app,tick,
    start(){if(!timer){timer=setInterval(()=>void tick().catch(()=>{}),5000);timer.unref();void tick().catch(()=>{});}},
    async close(){for(const stop of connections.values())stop();await app.close();},
  };
}
