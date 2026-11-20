import Fastify,{type FastifyRequest} from 'fastify';
import staticFiles from '@fastify/static';
import { existsSync } from 'node:fs';
import { randomBytes,timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { collectorSchema,defaults,feedbackSchema,kindSchema,namespaceSchema,normalize,preferencesSchema,settingsSchema,unknownMetrics,watchlist,type Candidate,type Settings } from '../../packages/contracts/index';
import {topicSchema} from '../../packages/collection-core/hosted';
import {queryGroups} from '../../packages/collection-core/x-protocol';
import { localTime,scorePost } from './rank';
import { hash,postSelect,type PostRow } from './storage';
import type { Monitor } from './monitor';
import type {XApi} from './x-api';
import type {HostedClient} from './hosted-client';

const nonce=()=>randomBytes(32).toString('base64url');
const sessionLife=2*60*60_000;
type Session={csrf:string;expires:number;erase?:{nonce:string;expires:number}};
export class ApiError extends Error {
  constructor(readonly statusCode:number,readonly code:string,message:string) {super(message);}
}
const missing=()=>new ApiError(404,'NOT_FOUND','That item is unavailable.');
const denied=()=>new ApiError(403,'FORBIDDEN','This local request is forbidden.');
const choice=z.strictObject({id:collectorSchema});
const itemParams=z.strictObject({id:z.string().regex(/^[\w-]{1,100}$/),namespace:namespaceSchema});
const idParam=z.strictObject({id:z.uuid()});

export function createApi(monitor:Monitor,options:{
  webRoot?:string;profile:string;controlToken:string;stop:()=>void;
  credential?:(value:string|null)=>Promise<void>;
  disconnect?:()=>Promise<void>;
  clearSignals?:()=>Promise<void>;
  authorize?:(input:unknown,origin:string)=>Promise<{url:string}>;
  callback?:(url:string,origin:string)=>Promise<void>;
  check?:()=>Promise<void>;
  official?:XApi;
  localAccount?:XApi;
  hosted?:HostedClient;
  erase:()=>Promise<void>;
}) {
  const {store}=monitor;
  const api=Fastify({logger:false,bodyLimit:65536,forceCloseConnections:true});
  let origin='';
  const bootstrap=new Map<string,number>();
  const sessions=new Map<string,Session>();
  const attached=new WeakMap<FastifyRequest,Session>();
  const epoch=nonce().slice(0,12);
  const cookieName=`monitor_${epoch}`;
  let sequence=0;
  const buffer:{id:string;type:string}[]=[];
  const subscribers=new Set<(id:string,type:string)=>void>();
  const onChange=(type:string)=>{
    const id=`${epoch}-${++sequence}`;
    buffer.push({id,type});
    if (buffer.length>128) buffer.shift();
    for (const send of subscribers) send(id,type);
  };
  monitor.events.on('change',onChange);
  api.addHook('onClose',async()=>{monitor.events.off('change',onChange);});
  api.addHook('onRequest',async(req,res)=>{
    if (!origin || req.headers.host!==new URL(origin).host) throw denied();
    const originHeader=req.headers.origin;
    if (originHeader && originHeader!==origin) throw denied();
    const path=req.url.split('?')[0];
    const writes=!['GET','HEAD','OPTIONS'].includes(req.method);
    res.header('Referrer-Policy','no-referrer').header('X-Content-Type-Options','nosniff').header('X-Frame-Options','DENY');
    res.header('Content-Security-Policy',"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (!path.startsWith('/api/')) return;
    res.header('Cache-Control','no-store');
    if (path.startsWith('/api/control/')) {
      const secret=req.headers['x-monitor-control'];
      if (typeof secret!=='string' || secret.length!==options.controlToken.length ||
          !timingSafeEqual(Buffer.from(hash(secret)),Buffer.from(hash(options.controlToken))) || originHeader || req.headers['sec-fetch-site']) throw denied();
      return;
    }
    if (writes && originHeader!==origin) throw denied();
    if (path==='/api/v1/health' || (path==='/api/v1/session' && req.method==='POST') || ['/api/v1/oauth/callback','/api/v1/oauth/session/callback'].includes(path)) return;
    const cookie=req.headers.cookie?.split(/;\s*/).find(entry=>entry.startsWith(cookieName+'='))?.slice(cookieName.length+1);
    const session=cookie?sessions.get(cookie):undefined;
    if (!session || session.expires<Date.now()) {
      if (cookie) sessions.delete(cookie);
      throw new ApiError(401,'SESSION_REQUIRED','Open Smart Monitor from the local launcher.');
    }
    if (writes && req.headers['x-monitor-csrf']!==session.csrf) throw denied();
    session.expires=Date.now()+sessionLife;
    attached.set(req,session);
  });
  api.setErrorHandler((error,req,res)=>{
    if (error instanceof z.ZodError) {
      const issue=error.issues[0];
      void res.status(400).send({error:{code:issue?.path[0]==='immediate'?'INVALID_THRESHOLD':'INVALID_INPUT',field:issue?.path.join('.'),message:issue?.message??'Invalid request'}});
      return;
    }
    if (error instanceof ApiError) {
      void res.status(error.statusCode).send({error:{code:error.code,message:error.message}});
      return;
    }
    const status=typeof error==='object'&&error!==null&&'statusCode' in error?Number(error.statusCode):500;
    void res.status(status>=400&&status<500?status:500).send({error:{code:'REQUEST_FAILED',message:status===500?'Local service could not complete this request.':'The request could not be accepted.'}});
  });
  api.get('/api/v1/health',()=>({ok:true,protocol:1}));
  api.get('/api/control/status',()=>monitor.status);
  api.post('/api/control/stop',(_req,res)=>{setTimeout(options.stop,20);return res.status(202).send({stopping:true});});
  api.post('/api/control/pause',req=>monitor.pause(z.strictObject({paused:z.boolean()}).parse(req.body).paused));
  api.post('/api/control/bootstrap',req=>{
    const {post,source}=z.strictObject({post:z.string().regex(/^[\w-]{1,100}$/).optional(),source:namespaceSchema.optional()}).parse(req.body??{});
    const fragment=nonce(),now=Date.now();
    for (const [key,expires] of bootstrap) if (expires<now) bootstrap.delete(key);
    for (const [key,session] of sessions) if (session.expires<now) sessions.delete(key);
    bootstrap.set(fragment,now+60_000);
    const path=post?`/feed/?post=${encodeURIComponent(post)}&source=${source??'mock'}`:'/';
    return {url:`${origin}${path}#open=${fragment}`};
  });
  api.post('/api/control/credentials',async req=>{
    const {value}=z.strictObject({value:z.string().trim().min(10).max(4096).nullable()}).parse(req.body);
    if (!options.credential) throw new ApiError(503,'VAULT_UNAVAILABLE','The OS credential store is unavailable.');
    await options.credential(value);
    return {updated:true};
  });
  api.post('/api/control/hosted-credential',async req=>{
    if(!options.hosted)throw missing();
    const {value}=z.strictObject({value:z.string().length(43)}).parse(req.body);
    monitor.invalidate();
    await options.hosted.credential(value);
    return {updated:true};
  });
  api.post('/api/v1/session',(req,res)=>{
    const {nonce:key}=z.strictObject({nonce:z.string().length(43)}).parse(req.body);
    const expires=bootstrap.get(key);
    bootstrap.delete(key);
    if (!expires || expires<Date.now()) throw denied();
    const id=nonce(),csrf=nonce();
    sessions.set(id,{csrf,expires:Date.now()+sessionLife});
    res.header('Set-Cookie',`${cookieName}=${id}; HttpOnly; SameSite=Strict; Path=/api/; Max-Age=7200`);
    return {csrf};
  });
  api.get('/api/v1/session',req=>({csrf:attached.get(req)!.csrf}));
  api.get('/api/v1/monitor',()=>monitor.status);
  api.put('/api/v1/monitor',req=>monitor.pause(z.strictObject({paused:z.boolean()}).parse(req.body).paused));
  api.get('/api/v1/overview',()=>{
    const {source}=monitor.status;
    const day=localTime(monitor.clock(),store.settings.quiet.zone).day;
    const rows=store.all<{first_seen_at:number;priority:number}>(`SELECT p.first_seen_at,max(w.enabled=1 AND s.score>=json_extract(w.rule_json,'$.immediate')) priority
      FROM posts p JOIN scores s ON s.namespace=p.namespace AND s.post_id=p.id JOIN watchlists w ON w.id=s.list_id
      WHERE EXISTS(SELECT 1 FROM post_sources o WHERE o.namespace=p.namespace AND o.post_id=p.id AND o.collector=?) AND p.first_seen_at>=? GROUP BY p.namespace,p.id`,source,monitor.clock()-26*3600_000)
      .filter(row=>localTime(row.first_seen_at,store.settings.quiet.zone).day===day);
    return {today:rows.length,priority:rows.filter(row=>row.priority).length,lists:store.lists.filter(l=>l.enabled).length,
      unread:store.count('SELECT count(*) n FROM notifications WHERE collector=? AND read_at IS NULL',source),status:monitor.status};
  });
  const listChanged=()=>{
    store.set('next:'+store.active.id,monitor.clock());
    monitor.invalidate();
    monitor.signal('watchlists.changed','overview.changed');
  };
  const currentList=(req:FastifyRequest)=>{
    const {id}=idParam.parse(req.params);
    const previous=store.lists.find(l=>l.id===id);
    if (!previous) throw missing();
    return previous;
  };
  const revision=(req:FastifyRequest,value:number)=>{
    if (req.headers['if-match']!==String(value) && req.headers['if-match']!==`"${value}"`) throw new ApiError(409,'REVISION_CONFLICT',`Current revision is ${value}. Reload and try again.`);
  };
  api.get('/api/v1/watchlists',()=>store.lists);
  api.get('/api/v1/watchlists/:id',currentList);
  api.post('/api/v1/watchlists',(req,res)=>{
    if (store.lists.length>=100) throw new ApiError(409,'LIST_LIMIT','The profile already has 100 watchlists.');
    const saved=store.saveList(watchlist.parse(req.body),monitor.clock());
    listChanged();
    return res.status(201).send(saved);
  });
  api.patch('/api/v1/watchlists/:id',req=>{
    const previous=currentList(req);
    revision(req,previous.revision);
    const rule=Object.fromEntries(Object.entries(previous).filter(([key])=>!['id','revision','createdAt','updatedAt','matches'].includes(key)));
    const patch=z.record(z.string(),z.unknown()).parse(req.body);
    const saved=store.saveList(watchlist.parse({...rule,...patch}),monitor.clock(),previous);
    listChanged();
    return saved;
  });
  api.delete('/api/v1/watchlists/:id',(req,res)=>{
    const previous=currentList(req);
    revision(req,previous.revision);
    store.run('DELETE FROM watchlists WHERE id=?',previous.id);
    listChanged();
    return res.status(204).send();
  });
  api.post('/api/v1/watchlists/preview',req=>{
    const {rule,sample}=z.strictObject({rule:watchlist,sample:z.strictObject({text:z.string().min(1).max(5000),language:z.string().max(50).nullable().default('en'),handle:z.string().max(30).nullable().default(null)})}).parse(req.body);
    const post:Candidate={id:'preview',canonicalId:'preview',namespace:'mock',text:sample.text,language:sample.language,handle:sample.handle,
      authorId:null,displayName:null,createdAt:null,kind:'original',metrics:unknownMetrics,observedAt:monitor.clock(),observation:'preview'};
    return scorePost(post,rule,store.settings);
  });
  api.get('/api/v1/posts',req=>{
    const query=z.strictObject({q:z.string().max(200).default(''),source:namespaceSchema.optional(),collector:collectorSchema.optional(),listId:z.uuid().optional(),
      priority:z.enum(['silent','standard','immediate','delayed']).optional(),kind:kindSchema.optional(),sort:z.enum(['recent','score']).default('recent'),
      limit:z.coerce.number().int().min(1).max(100).default(30),cursor:z.string().max(500).optional()}).parse(req.query);
    const collector=query.collector??(query.source?undefined:store.active.id);
    const key=hash(JSON.stringify({...query,collector,cursor:undefined,limit:undefined})).slice(0,24);
    const checks:string[]=[],values:unknown[]=[];
    if(query.source){checks.push('p.namespace=?');values.push(query.source);}
    if(collector){checks.push('EXISTS(SELECT 1 FROM post_sources o WHERE o.namespace=p.namespace AND o.post_id=p.id AND o.collector=?)');values.push(collector);}
    if (query.q.trim()) {
      checks.push("(instr(p.id,?)>0 OR (p.namespace='mock' AND (instr(lower(p.text),lower(?))>0 OR instr(lower(a.handle),lower(?))>0)))");
      values.push(query.q.trim(),query.q.trim(),query.q.trim());
    }
    if (query.kind) {checks.push('p.kind=?');values.push(query.kind);}
    const matchChecks=['s.namespace=p.namespace','s.post_id=p.id'];
    if (query.listId) {matchChecks.push('s.list_id=?');values.push(query.listId);}
    if (query.priority) {matchChecks.push("json_extract(s.explanation,'$.classification')=?");values.push(query.priority);}
    const matches=`EXISTS(SELECT 1 FROM scores s WHERE ${matchChecks.join(' AND ')})`;
    checks.push(collector==='hosted'&&!query.listId&&!query.priority?`(${matches} OR (p.namespace='x' AND p.text IS NULL))`:matches);
    const sort=query.sort==='score'?'coalesce((SELECT max(score) FROM scores ss WHERE ss.namespace=p.namespace AND ss.post_id=p.id),-1)':'coalesce(p.created_at,p.first_seen_at)';
    if (query.cursor) {
      let cursor: {key:string;value:number;id:string};
      try { cursor=z.strictObject({key:z.literal(key),value:z.number().int(),id:z.string().max(100)}).parse(JSON.parse(Buffer.from(query.cursor,'base64url').toString())); }
      catch {throw new ApiError(400,'INVALID_CURSOR','This cursor does not match the feed filters.');}
      checks.push(`(${sort},p.id)<(?,?)`);values.push(cursor.value,cursor.id);
    }
    const rows=store.all<PostRow & {sort_value:number}>(`${postSelect.replace('SELECT p.*,','SELECT p.*,'+sort+' AS sort_value,')} WHERE ${checks.join(' AND ')} ORDER BY sort_value DESC,p.id DESC LIMIT ?`,...values,query.limit+1);
    const page=rows.slice(0,query.limit),last=page.at(-1);
    return {items:page.map(row=>store.post(row)),cursor:rows.length>query.limit&&last?Buffer.from(JSON.stringify({key,value:last.sort_value,id:last.id})).toString('base64url'):null};
  });
  api.get('/api/v1/posts/:namespace/:id',req=>{
    const {namespace,id}=itemParams.parse(req.params);
    const row=store.row(namespace,id);
    if (!row) throw missing();
    return store.post(row,true);
  });
  api.put('/api/v1/posts/:namespace/:id/feedback',req=>{
    const {namespace,id}=itemParams.parse(req.params);
    const input=feedbackSchema.parse(req.body);
    const saved=store.row(namespace,id);
    if(!saved)throw missing();
    store.run('INSERT INTO feedback VALUES (?,?,?,?,?) ON CONFLICT(namespace,post_id) DO UPDATE SET rating=excluded.rating,favorite=excluded.favorite,updated_at=excluded.updated_at',namespace,id,input.rating,+input.favorite,monitor.clock());
    monitor.rerank(namespace,id,saved.author_id);
    monitor.signal('posts.changed');
    return input;
  });
  api.get('/api/v1/authors/preferences',()=>store.all<{namespace:string;author_id:string;muted:number;favorite:number;handle:string|null}>(
    'SELECT f.*,a.handle FROM author_preferences f LEFT JOIN authors a ON f.namespace=a.namespace AND f.author_id=a.id WHERE f.muted=1 OR f.favorite=1')
    .map(row=>({namespace:row.namespace,id:row.author_id,handle:row.namespace==='mock'?row.handle:null,muted:!!row.muted,favorite:!!row.favorite})));
  api.put('/api/v1/authors/:namespace/:id/preferences',req=>{
    const {namespace,id}=itemParams.parse(req.params), prefs=preferencesSchema.parse(req.body);
    store.db.transaction(()=>{
      store.run('INSERT INTO author_preferences VALUES (?,?,?,?,?) ON CONFLICT(namespace,author_id) DO UPDATE SET muted=excluded.muted,favorite=excluded.favorite,updated_at=excluded.updated_at',namespace,id,+prefs.muted,+prefs.favorite,monitor.clock());
      if (prefs.muted) store.run("DELETE FROM monitoring_jobs WHERE namespace=? AND type='alert' AND post_id IN (SELECT id FROM posts WHERE namespace=? AND author_id=?)",namespace,namespace,id);
    })();
    monitor.rerank(namespace,'',id);
    monitor.signal('posts.changed','settings.changed');
    return prefs;
  });
  api.get('/api/v1/notifications',req=>{
    const {source,collector,unread,limit,before,beforeId}=z.strictObject({
      source:namespaceSchema.optional(),collector:collectorSchema.optional(),unread:z.enum(['true','false']).optional(),
      limit:z.coerce.number().int().min(1).max(100).default(50),
      before:z.coerce.number().int().nonnegative().optional(),beforeId:z.uuid().optional(),
    }).refine(v=>!v.beforeId||v.before!==undefined).parse(req.query);
    const rows=store.all<Parameters<typeof store.alert>[0]>(`SELECT * FROM notifications
      WHERE ${source&&!collector?'namespace':'collector'}=? AND (decision_at,id)<(?,?) ${unread==='true'?'AND read_at IS NULL':''}
      ORDER BY decision_at DESC,id DESC LIMIT ?`,collector??source??store.active.id,before??Number.MAX_SAFE_INTEGER,beforeId??'',limit+1);
    const page=rows.slice(0,limit),last=page.at(-1);
    return {items:page.map(row=>store.alert(row)),cursor:rows.length>limit&&last?{before:last.decision_at,beforeId:last.id}:null};
  });
  api.put('/api/v1/notifications/:id/read',req=>{
    const {id}=idParam.parse(req.params),{read}=z.strictObject({read:z.boolean()}).parse(req.body);
    if (!store.run('UPDATE notifications SET read_at=? WHERE id=?',read?monitor.clock():null,id).changes) throw missing();
    monitor.signal('notifications.changed','overview.changed');
    return {read};
  });
  api.post('/api/v1/notifications/read-all',req=>{
    const {source,collector,cutoff}=z.strictObject({source:namespaceSchema.optional(),collector:collectorSchema.optional(),cutoff:z.number().int().nonnegative()}).parse(req.body);
    const result=store.run(`UPDATE notifications SET read_at=? WHERE read_at IS NULL AND ${source&&!collector?'namespace':'collector'}=? AND decision_at<=?`,monitor.clock(),collector??source??store.active.id,cutoff);
    monitor.signal('notifications.changed','overview.changed');
    return {updated:result.changes};
  });
  api.post('/api/v1/notifications/test',async()=>({result:await monitor.notify({title:'Smart Monitor · Test',message:'Your local notification channel is available.'})}));
  api.get('/api/v1/settings',()=>({...store.settings,revision:store.revision('preferences')}));
  api.patch('/api/v1/settings',req=>{
    revision(req,store.revision('preferences'));
    const patch=z.record(z.string(),z.unknown()).parse(req.body);
    const previous=store.settings;
    const preferences=settingsSchema.parse({...previous,...patch});
    store.db.transaction(()=>{
      if (previous.quiet.zone!==preferences.quiet.zone) {
        const now=monitor.clock();
        const oldDay=localTime(now,previous.quiet.zone).day;
        const newDay=localTime(now,preferences.quiet.zone).day;
        if (oldDay!==newDay) {
          const admitted=store.count('SELECT count(*) n FROM notifications WHERE local_day=?',oldDay);
          const oldCarry=store.get<{value:number}>('SELECT value FROM notification_limits WHERE key=?','cap:'+oldDay)?.value??0;
          const current=store.count('SELECT count(*) n FROM notifications WHERE local_day=?',newDay);
          const existing=store.get<{value:number}>('SELECT value FROM notification_limits WHERE key=?','cap:'+newDay)?.value??0;
          store.run('INSERT INTO notification_limits VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
            'cap:'+newDay,Math.max(existing,admitted+oldCarry-current));
        }
      }
      store.set('preferences',preferences);
    })();
    store.set('next:'+store.active.id,monitor.clock()+preferences.intervalSeconds*1000);
    monitor.invalidate();
    monitor.signal('settings.changed','overview.changed','source.changed');
    return {...preferences,revision:store.revision('preferences')};
  });
  api.get('/api/v1/sources',()=>{
    const now=monitor.clock(), day=new Date(now).toISOString().slice(0,10);
    const usage=store.get<{requests:number;resources:number}>('SELECT requests,resources FROM usage_buckets WHERE day=?',day);
    const enabled=store.lists.filter(list=>list.enabled);
    const publicTopics=[...new Set(enabled.flatMap(list=>list.terms.filter(term=>term.direction==='include').flatMap(term=>{
      const result=topicSchema.safeParse(term.kind==='hashtag'?'#'+normalize(term.text).replace(/^#/,''):term.text);
      return result.success?[result.data]:[];
    })))].sort();
    const groupCount=new Set(enabled.flatMap(queryGroups)).size;
    return store.sources.map(row=>{
      const x=row.id==='x'?options.official:row.id==='session'?options.localAccount:undefined;
      const signals=store.value<{verified:string[];expires:number;syncing?:boolean}|null>(row.id+':signals',null);
      const session=row.id==='session'?options.localAccount?.account:undefined;
      return {id:row.id,active:!!row.active,configured:!!row.configured,
        status:session&&session.expiresAt<=now&&!session.renewable?'Session expired':row.status,error:row.error_code,
        gap:row.gap??(row.id==='x'?store.value<string|null>('x:stream-note',null):null),
        capabilities:[...(monitor.sources.get(row.id)?.capabilities??[]),
          ...(signals&&signals.expires>now?signals.verified.map(s=>s==='following'?'Following signals available':'Liked-author signals available'):[])],
        ...(x?{options:x.settings,syncing:signals?.syncing??false}:{}),
        ...(session?{account:session.username,expiresAt:session.expiresAt}:{}),
        ...(row.id==='hosted'?{hosted:options.hosted?.diagnostics,publicTopics}:{}),
        projectedRequests:x?Math.ceil(86400/store.settings.intervalSeconds)*Math.min(12,groupCount)*x.settings.pages:0,
        requests:x?usage?.requests??0:0,resources:x?usage?.resources??0:0,resetAt:Date.parse(day)+86_400_000};
    });
  });
  api.put('/api/v1/sources/:id/active',async req=>{
    const {id}=choice.parse(req.params);
    if (id===store.active.id) return monitor.status;
    if(!store.sources.find(s=>s.id===id)?.configured||!monitor.sources.get(id))throw new ApiError(409,'SOURCE_NOT_READY','Configure and authorize this source before selecting it.');
    if ((id==='x'||id==='session')&&!paid(store.settings)) throw new ApiError(409,'BUDGET_REQUIRED','Confirm positive X API budgets in Settings.');
    if(id==='hosted'&&!options.hosted?.config?.consent)throw new ApiError(409,'CONSENT_REQUIRED','Approve the hosted server and selected topics first.');
    const previous=monitor.sources.get(store.active.id);
    monitor.invalidate();
    store.db.transaction(()=>{
      store.run('UPDATE data_sources SET active=0 WHERE active=1');
      store.run('UPDATE data_sources SET active=1,generation=generation+1 WHERE id=?',id);
      store.run("DELETE FROM monitoring_jobs WHERE type='alert'");
      store.set(`next:${id}`,monitor.clock());
    })();
    await previous?.pause?.();
    monitor.wake();
    monitor.signal('source.changed','posts.changed','overview.changed');
    return monitor.status;
  });
  api.post('/api/v1/sources/:id/check',async(req,res)=>{
    const {id}=choice.parse(req.params);
    if (id==='x') {
      if (store.active.id!=='x' || !paid(store.settings) || !options.check) throw new ApiError(409,'SOURCE_NOT_READY','Activate the configured and budgeted X source first.');
      await options.check();
    }
    if(id==='session'){
      if(store.active.id!=='session'||!options.localAccount)throw new ApiError(409,'SOURCE_NOT_READY','Select and authorize Local X Account first.');
      await options.localAccount.check();
    }
    if(id==='hosted'){
      if(!options.hosted)throw missing();
      await options.hosted.check();
    }
    return res.status(202).send(monitor.status);
  });
  api.post('/api/v1/sources/mock/replay',()=>{
    if(store.active.id!=='mock')throw new ApiError(409,'SOURCE_NOT_READY','Select the simulated source before replaying.');
    store.db.transaction(()=>{
      store.set('cursor:mock',0);
      store.set('run:mock',store.value('run:mock',0)+1);
      store.set('next:mock',monitor.clock());
    })();
    monitor.invalidate();
    monitor.signal('source.changed','overview.changed');
    return monitor.status;
  });
  api.post('/api/v1/sources/:id/disconnect',async req=>{
    const {id}=choice.parse(req.params);
    if(id==='x'&&options.disconnect)await options.disconnect();
    else {
      const source=monitor.sources.get(id);
      if(!source?.disconnect)throw missing();
      monitor.invalidate();
      await source.disconnect();
    }
    return monitor.status;
  });
  api.post('/api/v1/sources/x/authorize',async req=>{
    if (!options.authorize) throw new ApiError(503,'OAUTH_UNAVAILABLE','OAuth is unavailable.');
    return options.authorize(req.body,origin);
  });
  api.post('/api/v1/sources/session/authorize',async req=>{
    if(!options.localAccount)throw missing();
    return options.localAccount.authorize(req.body,origin);
  });
  api.get('/api/v1/oauth/session/callback',async(req,res)=>{
    if(!options.localAccount)throw missing();
    await options.localAccount.callback(req.url,origin);
    return res.type('text/plain').send('Local X Account connected. Return to Smart Monitor to select the source.');
  });
  api.put('/api/v1/sources/:id/options',async req=>{
    const {id}=choice.parse(req.params);
    const source=id==='x'?options.official:id==='session'?options.localAccount:undefined;
    if(!source)throw missing();
    return source.configure(req.body);
  });
  api.put('/api/v1/sources/hosted/config',async req=>{
    if(!options.hosted)throw missing();
    monitor.invalidate();
    const configured=await options.hosted.configure(req.body);
    monitor.wake();
    return configured;
  });
  api.delete('/api/v1/sources/x/signals',async(_req,res)=>{
    if(!options.clearSignals)throw missing();
    await options.clearSignals();
    return res.status(204).send();
  });
  api.get('/api/v1/oauth/callback',async(req,res)=>{
    if (!options.callback) throw missing();
    await options.callback(req.url,origin);
    return res.type('text/plain').send('Connection processed. You can close this tab and return to Smart Monitor.');
  });
  api.post('/api/v1/data/erase-preview',req=>{
    const key=nonce();
    attached.get(req)!.erase={nonce:key,expires:Date.now()+60_000};
    return {nonce:key,profile:options.profile,posts:store.count('SELECT count(*) n FROM posts'),lists:store.lists.length};
  });
  api.post('/api/v1/data/erase',async(req,res)=>{
    const {nonce:key}=z.strictObject({nonce:z.string().length(43),confirm:z.literal('ERASE')}).parse(req.body);
    const session=attached.get(req)!;
    if (session.erase?.nonce!==key || session.erase.expires<Date.now()) throw denied();
    delete session.erase;
    await options.erase();
    sessions.clear();bootstrap.clear();
    return res.status(204).send();
  });
  api.get('/api/v1/events',(req,res)=>{
    const session=attached.get(req)!;
    res.hijack();
    res.raw.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','Connection':'keep-alive','X-Accel-Buffering':'no'});
    const send=(id:string,type:string)=>{
      if (session.expires<Date.now()) {res.raw.end();return;}
      if (!res.raw.write(`id: ${id}\ndata: ${JSON.stringify({type})}\n\n`)) res.raw.end();
    };
    const last=req.headers['last-event-id'];
    const index=buffer.findIndex(event=>event.id===last);
    if (index<0) send(`${epoch}-${sequence}`,'reset');
    else for (const event of buffer.slice(index+1)) send(event.id,event.type);
    subscribers.add(send);
    const heartbeat=setInterval(()=>{
      if (session.expires<Date.now()) res.raw.end();
      else res.raw.write(': heartbeat\n\n');
    },20_000);
    res.raw.once('close',()=>{clearInterval(heartbeat);subscribers.delete(send);});
  });
  if (options.webRoot && existsSync(options.webRoot)) void api.register(staticFiles,{root:options.webRoot,index:['index.html']});
  else api.get('/',(_req,res)=>res.type('text/plain').send('Smart Monitor runs locally. Build the web app to open the dashboard.'));
  return {api,setOrigin:(value:string)=>{origin=value;},clearSessions:()=>{sessions.clear();bootstrap.clear();}};
}

export const paid=(s:Settings)=>s.consoleBudgetConfirmed&&s.dailyRequests>0&&s.dailyResources>0;
export {defaults};
