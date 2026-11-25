import {strict as assert} from 'node:assert';
import test from 'node:test';
import {createApi} from '../apps/service/api';
import {Monitor} from '../apps/service/monitor';
import {Store} from '../apps/service/storage';
import {defaults,unknownMetrics,watchlist,type Candidate,type SourceInfo} from '../packages/contracts/index';
import type {Collector} from '../packages/collection-core/collector';

const now=Date.parse('2026-11-20T12:00:00Z');
const rule=watchlist.parse({name:'SQLite',terms:[{direction:'include',kind:'word',text:'SQLite'}]});
const fixture:Candidate={namespace:'x',id:'42',canonicalId:'42',text:'SQLite release',createdAt:now-60_000,observedAt:now,
  authorId:'9',displayName:'Fixture',handle:'example',language:'en',kind:'original',observation:'initial',metrics:{...unknownMetrics,likes:2}};
test('protected local share, source capabilities, ID-only filtering and immediate score changes',async()=>{
  const store=new Store(':memory:'),monitor=new Monitor(store,()=>now);
  store.saveList(rule,now);
  const {api,setOrigin}=createApi(monitor,{profile:'test',controlToken:'fixture-control',stop:()=>{},erase:async()=>{}});
  const host='127.0.0.1:43123',origin='http://'+host;
  setOrigin(origin);
  try{
    const boot=await api.inject({method:'POST',url:'/api/control/bootstrap',headers:{host,'x-monitor-control':'fixture-control'},payload:{}});
    const session=await api.inject({method:'POST',url:'/api/v1/session',headers:{host,origin},payload:{nonce:new URL(boot.json().url).hash.slice(6)}});
    const headers={host,origin,cookie:String(session.headers['set-cookie']).split(';')[0],'x-monitor-csrf':session.json().csrf};
    const sources=(await api.inject({url:'/api/v1/sources',headers})).json<SourceInfo[]>();
    assert.deepEqual(sources.map(source=>source.id).sort(),['hosted','mock','session']);
    assert.equal(sources.find(source=>source.id==='session')?.status,'Unsupported');
    assert.equal(sources.find(source=>source.id==='session')?.browser?.available,false);
    assert.equal((await api.inject({method:'PUT',url:'/api/v1/sources/x/active',headers})).statusCode,400);
    const share=(url:string,consent=true)=>api.inject({method:'POST',url:'/api/v1/posts/share',headers,payload:{url,excerpt:'Selected SQLite excerpt',consent}});
    assert.equal((await share('https://127.0.0.1/example/status/42')).statusCode,400);
    assert.equal((await share('https://x.com/example/status/42',false)).statusCode,400);
    monitor.ingest({...fixture,text:'',collector:'hosted'},store.lists,now,false,false);
    const unresolved=(await api.inject({url:'/api/v1/posts?collector=hosted',headers})).json().items[0];
    assert.equal(unresolved.preview,'unresolved');
    assert.equal(unresolved.matches.length,0);
    const shared=await share('https://x.com/example/status/42');
    assert.equal(shared.statusCode,201);
    assert.equal(shared.json().preview,'user-shared');
    assert.equal(shared.json().matches.length,0);
    assert.equal((await api.inject({url:'/api/v1/posts?collector=session&q=Excerpt',headers})).json().items[0].id,'42');
    assert.equal(store.row('x','42')?.text,null);
    monitor.ingest({...fixture,collector:'session',observation:'fixture'},store.lists,now,false,true);
    const weightBefore=store.matches('x','42')[0].score;
    const patch=await api.inject({method:'PATCH',url:'/api/v1/settings',headers:{...headers,'if-match':'0'},
      payload:{weights:{...defaults.weights,term:100,popularity:0}}});
    assert.equal(patch.statusCode,200);
    assert.notEqual(store.matches('x','42')[0].score,weightBefore);
    const detail=(await api.inject({url:'/api/v1/posts/x/42',headers})).json();
    assert.deepEqual(new Set(detail.provenance),new Set(['hosted','session']));
    assert.equal(detail.text,'Selected SQLite excerpt');
    assert.equal(store.count('SELECT count(*) n FROM notifications'),0);
  }finally{await api.close();store.close();}
});

test('author-relative likes use five comparable posts and leave missing metrics unknown',()=>{
  const store=new Store(':memory:'),monitor=new Monitor(store,()=>now);
  const list=store.saveList(rule,now);
  try{
    let target={...fixture,observation:'before'};
    const details=()=>store.matches('x','42')[0].signals.find(s=>s.key==='popularity')?.detail;
    monitor.ingest(target,[list],now,false,true);
    assert.equal(details(),undefined);
    for(let i=0;i<5;i++){
      const id=String(i+100);
      monitor.ingest({...fixture,id,canonicalId:id,observation:id,text:`SQLite example ${i}`,metrics:{...unknownMetrics,likes:i+1}},[list],now,false,true);
    }
    target={...target,observedAt:now+1000,observation:'after'};
    monitor.ingest(target,[list],now+1000,false,true);
    assert.match(details()??'',/Comparable median: 3/);
    assert.equal(store.candidate(store.row('x','42')!).metrics.views,null);
  }finally{store.close();}
});

test('switching the running monitor aborts an in-flight collection before it can publish',async()=>{
  const store=new Store(':memory:');
  let entered!: (signal:AbortSignal)=>void,release!: ()=>void;
  const started=new Promise<AbortSignal>(resolve=>{entered=resolve;});
  const released=new Promise<void>(resolve=>{release=resolve;});
  const manual:Collector={id:'session',capabilities:[],async collect(_lists,_time,signal,commit){
    entered(signal);
    await released;
    commit([fixture],false,'old-collector-checkpoint',true);
    return true;
  }};
  store.saveList(rule,now);
  store.set('preferences',{...defaults,nativeNotifications:false});
  store.run("UPDATE data_sources SET active=0 WHERE id='mock'");
  store.run("UPDATE data_sources SET active=1,configured=1 WHERE id='session'");
  const monitor=new Monitor(store,()=>now,undefined,undefined,manual);
  const controlToken='fixture-control',host='127.0.0.1:43123',origin='http://'+host;
  const {api,setOrigin}=createApi(monitor,{profile:'test',controlToken,stop:()=>{},erase:async()=>{}});
  setOrigin(origin);
  monitor.pause(false);
  const first=monitor.tick();
  try{
    const activeSignal=await started;
    const boot=await api.inject({method:'POST',url:'/api/control/bootstrap',headers:{host,'x-monitor-control':controlToken},payload:{}});
    const session=await api.inject({method:'POST',url:'/api/v1/session',headers:{host,origin},payload:{nonce:new URL(boot.json().url).hash.slice(6)}});
    const headers={host,origin,cookie:String(session.headers['set-cookie']).split(';')[0],'x-monitor-csrf':session.json().csrf};
    assert.equal((await api.inject({method:'PUT',url:'/api/v1/sources/mock/active',headers})).statusCode,200);
    assert.equal(activeSignal.aborted,true);
    release();
    await first;
    assert.equal(store.row('x','42'),undefined);
    assert.equal(store.revision('old-collector-checkpoint'),0);
    assert.equal(store.count("SELECT count(*) n FROM notifications WHERE namespace='x'"),0);
    await monitor.tick();
    assert.ok(store.count("SELECT count(*) n FROM posts WHERE namespace='mock'")>0);
  }finally{release();await first;await api.close();store.close();}
});
