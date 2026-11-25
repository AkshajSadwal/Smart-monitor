import {strict as assert} from 'node:assert';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {defaults,watchlist,type Watchlist} from '../packages/contracts/index';
import {scorePost,quietNow} from '../apps/service/rank';
import {Store} from '../apps/service/storage';
import {Monitor} from '../apps/service/monitor';
import {createApi} from '../apps/service/api';
import {simulatedLookup,simulatedPage} from '../fixtures/simulated';

const origin='http://127.0.0.1:43123';
const host='127.0.0.1:43123';
const now=Date.parse('2026-01-12T12:00:00Z');
const basic=watchlist.parse({name:'SQLite',terms:[{text:'SQLite',direction:'include',kind:'word'}],cooldownSeconds:0});
const strict=watchlist.parse({...basic,mode:'ALL',language:'en',terms:[
  {kind:'word',direction:'include',text:'SQLite',important:true},
  {kind:'phrase',direction:'include',text:'release candidate'},
  {kind:'word',direction:'exclude',text:'hiring'},
]});
const fake=async()=> 'submitted' as const;

test('Unicode terms, literal hashtags, exact phrases, exclusions and required attributes',()=>{
  const post=simulatedPage(0,now).posts[2];
  assert.equal(scorePost(post,strict,defaults).result?.score,100);
  assert.equal(scorePost({...post,text:'SQLITE release   CANDIDATE HIRING'},strict,defaults).reason,'Excluded term');
  assert.equal(scorePost({...post,text:'ＳＱＬｉｔｅ release    candidate'},strict,defaults).result?.score,100);
  assert.equal(scorePost({...post,text:'SQLite release lovely candidate'},strict,defaults).result,null);
  assert.equal(scorePost({...post,language:null},strict,defaults).result,null);
  const tag=watchlist.parse({name:'AI',terms:[{kind:'hashtag',direction:'include',text:'AI'}]});
  assert.equal(scorePost({...post,text:'a paid report about AI'},tag,defaults).result,null);
  assert.ok(scorePost({...post,text:'a report about #ai.'},tag,defaults).result);
  assert.equal(scorePost({...post,text:'SQLite',handle:null},{...basic,allowedAuthors:['releasewatch']},defaults).result,null);
  assert.ok(scorePost(post,{...basic,minEngagement:2},defaults).unresolved);
});

test('golden 65 to 83, unavailable signals, normalized score and feedback',()=>{
  const [p1,p2,p3]=simulatedPage(0,now).posts;
  const first=scorePost(p1,basic,defaults).result!;
  assert.equal(first.score,65);
  const later=simulatedLookup(p1,1,now+900_000);
  const measured=scorePost(later,basic,defaults,{previous:{collectedAt:now,metrics:p1.metrics}}).result!;
  assert.equal(measured.score,83);
  assert.equal(measured.signals.find(s=>s.key==='velocity')?.detail,'Measured growth per hour');
  assert.equal(scorePost(p2,basic,defaults).result?.score,80);
  assert.ok(!scorePost({...later,metrics:{...later.metrics,likes:0}},basic,defaults,{previous:{collectedAt:now,metrics:p1.metrics}}).result?.signals.some(s=>s.key==='velocity'));
  const scores=scorePost({...p3,metrics:{...p3.metrics,likes:Math.round(Math.sqrt(501)-1)}},strict,defaults,{favorite:true}).result!;
  assert.equal(scores.score,85);
  assert.ok(scorePost(p1,basic,defaults,{feedback:1}).result!.score>first.score);
  assert.equal(scorePost(p1,basic,defaults,{muted:true}).result,null);
  assert.equal(quietNow(Date.parse('2026-11-01T06:30:00Z'),{enabled:true,start:'22:00',end:'08:00',zone:'America/New_York'}),true);
});

test('persisted pipeline, coalescing, delayed growth, restart, and deletion isolation',async()=>{
  const folder=mkdtempSync(join(process.cwd(),'.state-test-')),db=join(folder,'test.sqlite');
  let clock=now,store=new Store(db,clock);
  try {
    const simple=store.saveList(basic,now),all=store.saveList(strict,now);
    store.set('preferences',{...defaults,nativeNotifications:false});
    let monitor=new Monitor(store,()=>clock,fake);
    monitor.pause(false);
    await monitor.tick();
    assert.equal(store.matches('mock','demo-01')[0].score,65);
    assert.equal(store.count("SELECT count(*) n FROM notifications WHERE canonical_id='demo-03'"),1);
    assert.equal(store.count("SELECT count(*) n FROM notifications WHERE canonical_id='demo-01'"),0);
    clock+=60_000;
    await monitor.tick();
    assert.equal(store.count("SELECT count(*) n FROM notifications WHERE canonical_id='demo-02'"),1);
    clock=now+900_000;
    await monitor.tick();
    assert.equal(store.matches('mock','demo-01')[0].score,83);
    assert.equal(store.get<{kind:string}>("SELECT kind FROM notifications WHERE canonical_id='demo-01'")?.kind,'delayed');
    assert.equal(store.matches('mock','demo-03').length,2);
    store.run('DELETE FROM watchlists WHERE id=?',all.id);
    assert.deepEqual(store.matches('mock','demo-03').map(m=>m.listId),[simple.id]);
    store.run("UPDATE notifications SET dispatch_state='started' WHERE canonical_id='demo-01'");
    store.close();
    store=new Store(db,clock);
    monitor=new Monitor(store,()=>clock,fake);
    await monitor.tick();
    assert.equal(store.count("SELECT count(*) n FROM notifications WHERE canonical_id='demo-01' AND dispatch_state='unknown'"),1);
    assert.equal(store.count("SELECT count(*) n FROM schema_migrations"),5);
    assert.equal(store.paused,false);
  } finally {if(store.db.open)store.close();rmSync(folder,{recursive:true,force:true});}
});

test('local API protects host, nonce, origin, CSRF, conflicts and data validation',async()=>{
  const store=new Store(':memory:');
  const monitor=new Monitor(store,()=>now,fake);
  const controlToken='opaque-control-token';
  const service=createApi(monitor,{profile:'test',controlToken,stop:()=>{},erase:async()=>{}});
  service.setOrigin(origin);
  const {api}=service;
  try {
    assert.equal((await api.inject({url:'/api/v1/overview',headers:{host}})).statusCode,401);
    assert.equal((await api.inject({url:'/api/v1/health',headers:{host:'unknown'}})).statusCode,403);
    const made=await api.inject({method:'POST',url:'/api/control/bootstrap',headers:{host,'x-monitor-control':controlToken},payload:{}});
    assert.equal(made.statusCode,200);
    const nonce=new URL(made.json().url).hash.slice(6);
    const exchange=()=>api.inject({method:'POST',url:'/api/v1/session',headers:{host,origin},payload:{nonce}});
    const session=await exchange();
    assert.equal(session.statusCode,200);
    assert.equal((await exchange()).statusCode,403);
    const cookie=String(session.headers['set-cookie']).split(';')[0];
    const headers={host,origin,cookie,'x-monitor-csrf':session.json().csrf};
    assert.equal((await api.inject({method:'POST',url:'/api/v1/watchlists',headers:{host,origin,cookie},payload:basic})).statusCode,403);
    assert.equal((await api.inject({method:'POST',url:'/api/v1/watchlists',headers:{...headers,origin:'https://example.invalid'},payload:basic})).statusCode,403);
    assert.equal((await api.inject({method:'POST',url:'/api/v1/watchlists',headers,payload:{...basic,standard:90,immediate:85}})).statusCode,400);
    const response=await api.inject({method:'POST',url:'/api/v1/watchlists',headers,payload:basic});
    assert.equal(response.statusCode,201);
    const list=response.json<Watchlist>();
    assert.equal((await api.inject({method:'PATCH',url:'/api/v1/watchlists/'+list.id,headers:{...headers,'if-match':'0'},payload:{enabled:false}})).statusCode,409);
    assert.equal((await api.inject({method:'PUT',url:'/api/v1/monitor',headers,payload:{paused:false}})).statusCode,200);
    await monitor.tick();
    const feed=await api.inject({url:'/api/v1/posts?source=mock&limit=1',headers:{host,cookie}});
    assert.equal(feed.statusCode,200);
    assert.equal(feed.json().items.length,1);
    assert.equal((await api.inject({url:'/api/v1/posts?sort=score&cursor='+feed.json().cursor,headers:{host,cookie}})).statusCode,400);
    assert.equal((await api.inject({method:'PUT',url:'/api/v1/sources/session/active',headers})).statusCode,409);
  } finally {await api.close();store.close();}
});

test('quiet hours and the daily cap suppress immediate alerts without replay',async()=>{
  const store=new Store(':memory:');
  try {
    let time=now;
    const monitor=new Monitor(store,()=>time,fake);
    store.saveList(strict,time);
    store.set('preferences',{...defaults,dailyCap:1,nativeNotifications:false,quiet:{...defaults.quiet,zone:'UTC',enabled:true,start:'11:00',end:'13:00'}});
    monitor.pause(false);
    await monitor.tick();
    assert.equal(store.matches('mock','demo-03')[0].suppression,'Quiet hours');
    time=now+2*3600_000;
    await monitor.tick();
    assert.equal(store.count('SELECT count(*) n FROM notifications'),0);
    store.set('preferences',{...defaults,dailyCap:0,nativeNotifications:false});
    const p={...simulatedPage(0,time).posts[2],id:'new-immediate',canonicalId:'new-immediate'};
    store.db.transaction(()=>monitor.ingest(p,store.lists,time,false,false))();
    await monitor.tick();
    assert.equal(store.matches('mock',p.id)[0].suppression,'Daily alert limit');
  } finally {store.close();}
});

test('a previous SQLite version upgrades in place and a newer version fails closed',()=>{
  const folder=mkdtempSync(join(process.cwd(),'.state-test-'));
  const path=join(folder,'previous.sqlite');
  try {
    const current=new Store(path,now);
    const list=current.saveList(basic,now);
    const sample=simulatedPage(0,now).posts[0];
    current.db.transaction(()=>current.persist(sample,now))();
    current.close();
    const previous=new Database(path);
    previous.exec(`DROP TABLE post_sources; DROP INDEX jobs_collector; DROP INDEX notifications_collector;
      ALTER TABLE monitoring_jobs DROP COLUMN collector; ALTER TABLE notifications DROP COLUMN collector;
      DELETE FROM data_sources WHERE id IN ('session','hosted'); DROP INDEX canonical_history;
      DELETE FROM schema_migrations WHERE version>=4;`);
    previous.close();
    const upgraded=new Store(path,now);
    assert.equal(upgraded.lists[0].id,list.id);
    assert.equal(upgraded.count('SELECT count(*) n FROM schema_migrations'),5);
    assert.equal(upgraded.post(upgraded.row('mock',sample.id)!).collector,'mock');
    upgraded.run("INSERT INTO schema_migrations VALUES (999,'future',0)");
    upgraded.close();
    assert.throws(()=>new Store(path,now),/Unsupported or modified database schema/);
  } finally {rmSync(folder,{recursive:true,force:true});}
});
