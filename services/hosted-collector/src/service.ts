import Fastify from 'fastify';
import Database from 'better-sqlite3';
import {createHash,createCipheriv,createDecipheriv,randomBytes,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {hostedStatus,topicsSchema,type Delivery} from '../../../packages/collection-core/hosted';
import {officialProvider,simulation,UpstreamError,type Cursor,type HostedProvider} from './provider';
import {publication} from './publication';

const HOUR=3_600_000;
const safeHash=(data:string)=>createHash('sha256').update(data).digest('hex');
const tokenRx=/^[A-Za-z0-9_-]{43}$/;
const integer=(v:unknown)=>z.coerce.number().int().nonnegative().safe().parse(v);
type Topic={topic:string;checkpoint:string|null;due:number;state:string;attempt:number};
type HostedOptions={
  mode:Delivery;clock?:()=>number;intervalMs?:number;retainMs?:number;topicLimit?:number;
  transport?:typeof fetch;permission?:string;licenseConfirmed?:boolean;bearer?:string;dailyRequests?:number;dailyResources?:number;provider?:HostedProvider;
  dailyUsdCents?:number;maxResourceUsdMicros?:number;
};
export const identityName=z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);
const secretName=(identity:string)=>identityName.parse(identity)==='default'?'x-bearer':'x-bearer:'+identity;
const healthKey=(identity:string,key:string)=>identity==='default'?key:identity+':'+key;

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
      CREATE TABLE IF NOT EXISTS client_expiration(client TEXT PRIMARY KEY REFERENCES clients ON DELETE CASCADE,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS client_agreement(client TEXT PRIMARY KEY REFERENCES clients ON DELETE CASCADE,accepted INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS replay_floors(topic TEXT PRIMARY KEY REFERENCES topics ON DELETE CASCADE,through INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS blocked_posts(id_hash TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS publication_usage(day TEXT PRIMARY KEY,delivered INTEGER NOT NULL);
    `);
  }
  issue(label:string,now=Date.now(),limit=500,ttl=30*24*HOUR) {
    const id=randomUUID(),token=randomBytes(32).toString('base64url');
    this.db.transaction(()=>{
      if(Number((this.db.prepare('SELECT count(*) n FROM clients c LEFT JOIN client_expiration e ON e.client=c.id WHERE c.revoked=0 AND coalesce(e.expires,?)>?').get(now+1,now) as {n:number}).n)>=limit)throw new Error('Client cap reached');
      this.db.prepare('INSERT INTO clients(id,token_hash,label,seen) VALUES (?,?,?,?)').run(id,safeHash(token),z.string().trim().min(1).max(80).parse(label),now);
      this.db.prepare('INSERT INTO audit VALUES (?,?,?)').run(now,'client-issued',id);
      this.db.prepare('INSERT INTO client_expiration VALUES (?,?)').run(id,now+ttl);
    })();
    return {id,token,expiresAt:now+ttl};
  }
  revoke(id:string,now=Date.now()) {
    this.db.transaction(()=>{
      this.db.prepare('UPDATE clients SET revoked=1 WHERE id=?').run(id);
      this.db.prepare('DELETE FROM memberships WHERE client=?').run(id);
      this.db.prepare('INSERT INTO audit VALUES (?,?,?)').run(now,'client-revoked',id);
      this.pruneTopics();
    })();
  }
  authenticate(header:string|undefined,now=Date.now()) {
    const token=header?.slice(7);
    if(!header?.startsWith('Bearer ')||!token||!tokenRx.test(token))return;
    const row=this.db.prepare('SELECT c.id,e.expires FROM clients c LEFT JOIN client_expiration e ON e.client=c.id WHERE c.token_hash=? AND c.revoked=0')
      .get(safeHash(token)) as {id:string;expires:number|null}|undefined;
    return row?{id:row.id,expired:row.expires!==null&&row.expires<=now}:null;
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
  purgePost(id:string,now=Date.now()){
    this.db.transaction(()=>{
      this.db.prepare('INSERT OR IGNORE INTO blocked_posts VALUES (?)').run(safeHash(id));
      this.db.prepare("DELETE FROM events WHERE json_extract(payload,'$.post.namespace')='x' AND (json_extract(payload,'$.post.id')=? OR json_extract(payload,'$.post.canonicalId')=?)").run(id,id);
      this.db.prepare('INSERT INTO audit VALUES (?,?,?)').run(now,'post-unavailable',safeHash(id));
    })();
  }
  isBlocked(id:string){return !!this.db.prepare('SELECT 1 FROM blocked_posts WHERE id_hash=?').get(safeHash(id));}
  maxEvent() {return (this.db.prepare("SELECT coalesce((SELECT seq FROM sqlite_sequence WHERE name='events'),0) n").get() as {n:number}).n;}
  pruneTopics() {this.db.prepare('DELETE FROM topics WHERE NOT EXISTS (SELECT 1 FROM memberships WHERE memberships.topic=topics.topic)').run();}
  cleanup(now:number,retain:number) {
    this.db.transaction(()=>{
      this.db.prepare('DELETE FROM memberships WHERE EXISTS (SELECT 1 FROM clients c WHERE c.id=memberships.client AND c.seen<?)').run(now-2*HOUR);
      this.db.prepare('DELETE FROM memberships WHERE client IN (SELECT client FROM client_expiration WHERE expires<=?)').run(now);
      this.pruneTopics();
      this.db.prepare('INSERT INTO replay_floors SELECT topic,max(id) FROM events WHERE observed<? OR id<=? GROUP BY topic ON CONFLICT(topic) DO UPDATE SET through=max(through,excluded.through)')
        .run(now-retain,this.maxEvent()-20_000);
      this.db.prepare('DELETE FROM events WHERE observed<? OR id<=?').run(now-retain,this.maxEvent()-20_000);
      this.db.prepare('DELETE FROM usage WHERE day<?').run(new Date(now-30*24*HOUR).toISOString().slice(0,10));
      this.db.prepare('DELETE FROM publication_usage WHERE day<?').run(new Date(now-30*24*HOUR).toISOString().slice(0,10));
      this.db.prepare('DELETE FROM audit WHERE at<?').run(now-90*24*HOUR);
    })();
  }
  setBearer(raw:string,key:Buffer,now=Date.now(),identity='default'){
    if(key.length!==32||!raw.trim()||raw.length>4096)throw new Error('Invalid server credential or encryption key');
    const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
    const name=secretName(identity);
    cipher.setAAD(Buffer.from('smart-monitor-hosted:'+name+':v1'));
    const body=Buffer.concat([cipher.update(raw.trim(),'utf8'),cipher.final()]);
    const sealed=Buffer.concat([iv,cipher.getAuthTag(),body]).toString('base64url');
    this.db.transaction(()=>{
      this.db.prepare('INSERT OR REPLACE INTO secret VALUES (?,?)').run(name,sealed);
      this.db.prepare('INSERT INTO audit VALUES (?,?,?)').run(now,'credential-set',name);
      this.db.prepare('DELETE FROM upstream WHERE key IN (?,?)').run(healthKey(identity,'hold'),healthKey(identity,'healthy'));
    })();
  }
  private bearerRow(identity:string){
    return this.db.prepare('SELECT cipher FROM secret WHERE name=?').get(secretName(identity)) as {cipher:string}|undefined;
  }
  identityVersion(identity:string){const row=this.bearerRow(identity);return row?safeHash(row.cipher):null;}
  identityStatus(identity:string,now=Date.now()){
    const state=(name:string)=>(this.db.prepare('SELECT value FROM upstream WHERE key=?').get(healthKey(identity,name)) as {value:number}|undefined)?.value??0;
    const configured=!!this.bearerRow(identity),retryAt=state('retry'),lastSuccess=state('healthy');
    return {identity,provider:'official-api',configured,
      status:!configured?'Credential required':state('hold')?'Upstream access or credit denied':retryAt>now?'Backoff':lastSuccess?'Verified':'Configured · unverified',
      retryAt:retryAt>now?retryAt:null,lastSuccess:lastSuccess||null};
  }
  revokeBearer(identity:string,now=Date.now()){
    const name=secretName(identity);
    this.db.transaction(()=>{
      this.db.prepare('DELETE FROM secret WHERE name=?').run(name);
      this.db.prepare('DELETE FROM upstream WHERE key IN (?,?)').run(healthKey(identity,'hold'),healthKey(identity,'healthy'));
      this.db.prepare('INSERT INTO audit VALUES (?,?,?)').run(now,'credential-revoked',name);
    })();
  }
  getBearer(key:Buffer,identity='default'){
    const row=this.bearerRow(identity);
    if(!row||key.length!==32)throw new Error('Server X credential is not configured');
    const data=Buffer.from(row.cipher,'base64url');
    const decipher=createDecipheriv('aes-256-gcm',key,data.subarray(0,12));
    decipher.setAAD(Buffer.from('smart-monitor-hosted:'+secretName(identity)+':v1'));
    decipher.setAuthTag(data.subarray(12,28));
    return Buffer.concat([decipher.update(data.subarray(28)),decipher.final()]).toString('utf8');
  }
}

export function createHostedService(store:HostedStore,options:HostedOptions) {
  const mode=options.mode,clock=options.clock??Date.now,interval=options.intervalMs??300_000;
  const live=mode==='ids'||mode==='metadata'||mode==='approved-public';
  const retention=Math.min(options.retainMs??24*HOUR,mode==='metadata'||mode==='approved-public'?HOUR:Infinity),topicLimit=options.topicLimit??200;
  const provider=options.provider??(mode==='simulated'?simulation(interval):
    live&&options.bearer?officialProvider('default',()=>options.bearer!,options.transport):null);
  if(live&&(!options.permission?.trim()||provider?.kind!=='official-api'||!options.dailyRequests||!options.dailyResources||
    !options.dailyUsdCents||!options.maxResourceUsdMicros||((mode==='metadata'||mode==='approved-public')&&!options.licenseConfirmed)))
    throw new Error('Live publication requires a permission reference, operator credential and positive budgets');
  if(mode==='simulated'&&provider?.kind!=='simulation')throw new Error('Simulated mode requires the simulation provider');
  const providerKind=provider?.kind??'disabled';
  store.db.prepare("DELETE FROM events WHERE json_extract(payload,'$.delivery')<>?").run(mode);
  const app=Fastify({logger:false,bodyLimit:8192,forceCloseConnections:true});
  const clients=new WeakMap<object,string>();
  const rate=new Map<string,{count:number;ends:number}>();
  const connections=new Map<string,()=>void>();
  let timer:ReturnType<typeof setInterval>|undefined,flight:Promise<void>|undefined,abort:AbortController|undefined,cleanupAt=0;
  const readState=(key:string)=>(store.db.prepare('SELECT value FROM upstream WHERE key=?').get(key) as {value:number}|undefined)?.value??0;
  const writeState=(key:string,value:number)=>store.db.prepare('INSERT OR REPLACE INTO upstream VALUES (?,?)').run(key,value);
  const response=(id:string)=>hostedStatus.parse({delivery:mode,provider:providerKind,serverTime:clock(),topics:store.current(id)});
  app.setErrorHandler((error,_req,reply)=>{
    const status=error instanceof z.ZodError?400:Number((error as {statusCode?:number}).statusCode)||500;
    void reply.code(status).send({error:status<500?'Request rejected':'Hosted service unavailable'});
  });
  app.addHook('onRequest',async(req,reply)=>{
    reply.header('Cache-Control','no-store');
    if(req.routeOptions.url==='/health')return;
    const now=clock();
    const access=store.authenticate(req.headers.authorization,now),id=access?.expired?null:access?.id;
    const key=id??'unauthenticated';
    let meter=rate.get(key);
    if(!meter||meter.ends<=now){meter={count:0,ends:now+60_000};rate.set(key,meter);}
    if(++meter.count>(id?60:240))return reply.header('Retry-After','60').code(429).send({error:'Rate limited'});
    if(!id)return reply.code(401).send({error:access?.expired?'Client credential expired':'Client credential required',code:access?.expired?'TOKEN_EXPIRED':'CLIENT_CREDENTIAL_REQUIRED'});
    clients.set(req,id);
    store.db.prepare('UPDATE clients SET seen=? WHERE id=? AND seen<?').run(now,id,now-60_000);
  });
  app.get('/health',()=>({service:'smart-monitor-hosted',version:1}));
  app.get('/v1/status',req=>response(clients.get(req)!));
  app.put('/v1/subscriptions',(req,reply)=>{
    const {topics,liveTermsAccepted}=z.strictObject({topics:topicsSchema,liveTermsAccepted:z.literal(true).optional()}).parse(req.body);
    const id=clients.get(req)!;
    if(mode==='disabled'&&topics.length)return reply.code(409).send({error:'Live publication is disabled'});
    if(live&&topics.length&&!liveTermsAccepted)return reply.code(403).send({error:'Accept X terms before subscribing to live topics',code:'LIVE_TERMS_REQUIRED'});
    const sync=store.replace(id,topics,clock(),topicLimit);
    try {store.db.transaction(()=>{
      if(!sync())throw new Error('cap');
      if(live&&liveTermsAccepted)store.db.prepare('INSERT OR REPLACE INTO client_agreement VALUES (?,?)').run(id,clock());
    })();}
    catch {return reply.code(409).send({error:'Server topic capacity reached'});}
    return response(id);
  });
  app.get('/v1/events',(req,reply)=>{
    const id=clients.get(req)!;
    if(live&&!store.db.prepare('SELECT 1 FROM client_agreement WHERE client=?').get(id))return reply.code(403).send({error:'X terms acknowledgement required',code:'LIVE_TERMS_REQUIRED'});
    const after=z.object({after:z.unknown().optional()}).parse(req.query).after;
    const header=req.headers['last-event-id'];
    if(after!==undefined&&header!==undefined&&integer(after)!==integer(header))return reply.code(400).send({error:'Replay positions disagree'});
    let cursor=integer(after??header??0);
    if(cursor>store.maxEvent())return reply.code(409).send({error:'Invalid delivery cursor'});
    connections.get(id)?.();
    if(connections.size>=100)return reply.code(429).header('Retry-After','60').send({error:'Connection cap reached'});
    reply.hijack();
    reply.raw.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','X-Accel-Buffering':'no'});
    if(cursor>0&&store.db.prepare('SELECT 1 FROM replay_floors f JOIN memberships m ON m.topic=f.topic WHERE m.client=? AND f.through>max(?,m.after_id) LIMIT 1').get(id,cursor))
      reply.raw.write('event: gap\ndata: {"reason":"expired"}\n\n');
    let closed=false,beat=0,limitReported=false;
    const stop=()=>{
      if(closed)return;
      closed=true;clearInterval(streamTimer);
      if(connections.get(id)===stop)connections.delete(id);
      if(!reply.raw.writableEnded)reply.raw.end();
    };
    const send=()=>{
      const access=store.authenticate(req.headers.authorization,clock());
      if(!access||access.expired){stop();return;}
      store.db.prepare('UPDATE clients SET seen=? WHERE id=? AND seen<?').run(clock(),id,clock()-60_000);
      const rows=store.db.prepare(`SELECT e.id,e.payload FROM events e JOIN memberships m ON m.topic=e.topic
        WHERE m.client=? AND e.id>? AND e.id>m.after_id ORDER BY e.id LIMIT 25`).all(id,cursor) as {id:number;payload:string}[];
      const deliveryCount=live&&rows.length?reservePublication(clock(),rows.length):rows.length;
      if(deliveryCount<rows.length&&!limitReported){
        limitReported=true;
        if(!reply.raw.write('event: gap\ndata: {"reason":"delivery-cap"}\n\n')){stop();return;}
      }
      for(const row of rows.slice(0,deliveryCount)){
        if(!reply.raw.write(`id: ${row.id}\nevent: post\ndata: ${row.payload}\n\n`)){stop();return;}
        cursor=row.id;
      }
      if(deliveryCount)store.db.prepare('INSERT INTO delivery VALUES (?,?,?) ON CONFLICT(client) DO UPDATE SET last_sent=max(last_sent,excluded.last_sent),offered_at=excluded.offered_at').run(id,cursor,clock());
      if(++beat%5===1&&!reply.raw.write(`event: heartbeat\ndata: ${JSON.stringify(response(id))}\n\n`))stop();
    };
    store.db.prepare('UPDATE clients SET delivered=max(delivered,?) WHERE id=?').run(cursor,id);
    const safeSend=()=>{try{send();}catch{stop();}};
    const streamTimer=setInterval(safeSend,1000);
    streamTimer.unref();
    reply.raw.once('close',stop);
    connections.set(id,stop);
    safeSend();
  });
  function reservePublication(now:number,requested:number) {
    const day=new Date(now).toISOString().slice(0,10);
    const oldest=new Date(now-30*24*HOUR).toISOString().slice(0,10);
    return store.db.transaction(()=>{
      const {used}=store.db.prepare('SELECT coalesce(sum(delivered),0) used FROM publication_usage WHERE day>=?').get(oldest) as {used:number};
      const allowed=Math.max(0,Math.min(requested,1_500_000-used));
      if(allowed)store.db.prepare('INSERT INTO publication_usage VALUES (?,?) ON CONFLICT(day) DO UPDATE SET delivered=delivered+excluded.delivered').run(day,allowed);
      return allowed;
    })();
  }
  function reserve(now:number) {
    const date=new Date(now).toISOString().slice(0,10);
    store.db.transaction(()=>{
      const used=store.db.prepare('SELECT requests,resources FROM usage WHERE day=?').get(date) as {requests:number;resources:number}|undefined;
      const key='cost:'+date;
      const prior=readState(key)||(used?.resources??0)*(options.maxResourceUsdMicros??0);
      const projected=prior+20*(options.maxResourceUsdMicros??0);
      if((used?.requests??0)+1>(options.dailyRequests??0)||(used?.resources??0)+20>(options.dailyResources??0)||projected>(options.dailyUsdCents??0)*10_000)
        throw new UpstreamError('Budget paused',Date.parse(date)+24*HOUR);
      store.db.prepare('INSERT INTO usage VALUES (?,1,20) ON CONFLICT(day) DO UPDATE SET requests=requests+1,resources=resources+20').run(date);
      writeState(key,projected);
    })();
  }
  function windowFor(topic:Topic,now:number) {
    const old=topic.checkpoint?JSON.parse(topic.checkpoint) as Cursor:null;
    const end=Math.floor((now-40_000)/1000)*1000;
    const start=old?(old.done?old.end:old.start):end-10*60_000;
    const cursor=old&&!old.done&&old.start>=end-HOUR?old:{start:Math.max(start,end-HOUR),end,done:false};
    const gap=start<end-HOUR||!!(old&&!old.done&&old.start<end-HOUR)?'Older coverage exceeded the one-hour recovery window.':undefined;
    return {cursor,gap};
  }
  async function collect(signal:AbortSignal) {
    const now=clock();
    if(now>=cleanupAt){store.cleanup(now,retention);cleanupAt=now+60_000;for(const [key,v] of rate)if(v.ends<=now)rate.delete(key);}
    if(mode==='disabled'||!provider)return;
    if(provider.isCurrent?.()===false){
      store.db.prepare("UPDATE topics SET state='Operator credential changed. Restart required.'").run();
      return;
    }
    const hold=healthKey(provider.identity,'hold'),retry=healthKey(provider.identity,'retry');
    if(live&&(readState(hold)||readState(retry)>now))return;
    const jobs=store.db.prepare('SELECT * FROM topics WHERE due<=? ORDER BY due,topic LIMIT 4').all(now) as Topic[];
    for(const topic of jobs){
      if(signal.aborted)return;
      try{
        const {cursor,gap}=windowFor(topic,now);
        const frozen=JSON.stringify(cursor);
        store.db.prepare('UPDATE topics SET checkpoint=? WHERE topic=?').run(frozen,topic.topic);
        const result=await provider.collect(topic.topic,cursor,now,signal,()=>reserve(now));
        if(signal.aborted||provider.isCurrent?.()===false)return;
        store.db.transaction(()=>{
          if(!store.db.prepare('SELECT 1 FROM topics WHERE topic=? AND checkpoint=?').get(topic.topic,frozen))return;
          if(live)writeState(healthKey(provider.identity,'healthy'),now);
          for(const post of result.posts){
            if(post.namespace==='x'&&(store.isBlocked(post.id)||store.isBlocked(post.canonicalId)))continue;
            const event=publication(mode,topic.topic,post);
            if(!event)continue;
            const permitted=event.post;
            // Older v1 clients only accept the original simulated event shape.
            const wire=mode==='simulated'?{topic:event.topic,delivery:event.delivery,post:permitted}:event;
            store.db.prepare('INSERT OR IGNORE INTO events(topic,observed,post_key,payload) VALUES (?,?,?,?)')
              .run(topic.topic,now,permitted.namespace+':'+permitted.id+':'+permitted.observation,JSON.stringify(wire));
          }
          store.db.prepare('UPDATE topics SET checkpoint=?,state=?,due=?,attempt=0 WHERE topic=?')
            .run(JSON.stringify(result.cursor),result.gap??gap??(result.cursor.done?'Polling':'Paging · checkpoint saved'),
              now+(result.cursor.done?interval:Math.min(interval,30_000)),topic.topic);
        })();
      }catch(error){
        if(signal.aborted||provider.isCurrent?.()===false)return;
        const issue=error instanceof UpstreamError?error:new UpstreamError('Temporary upstream or response error');
        const due=issue.retry??now+Math.min(30*60_000,30_000*2**Math.min(topic.attempt,6));
        store.db.prepare('UPDATE topics SET state=?,due=?,attempt=attempt+1 WHERE topic=?').run(issue.message,due,topic.topic);
        if(issue.hold){writeState(hold,1);store.db.prepare("UPDATE topics SET state='Upstream access or credit denied'").run();return;}
        if(issue.message==='Rate limited'||issue.message==='Budget paused'){writeState(retry,due);store.db.prepare('UPDATE topics SET state=?').run(issue.message);return;}
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
