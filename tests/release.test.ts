import assert from 'node:assert/strict';
import test from 'node:test';
import {createApi} from '../apps/service/api';
import {Monitor} from '../apps/service/monitor';
import {Store} from '../apps/service/storage';
import {defaults,unknownMetrics,watchlist,type Candidate} from '../packages/contracts/index';
import {hostedEvent} from '../packages/collection-core/hosted';
import {publication} from '../services/hosted-collector/src/publication';
import {createHostedService,HostedStore} from '../services/hosted-collector/src/service';

const now=Date.now();
const rule=watchlist.parse({name:'OpenAI',terms:[{direction:'include',kind:'word',text:'OpenAI'}],standard:40,immediate:50});
const candidate:Candidate={namespace:'x',id:'12345678',canonicalId:'12345678',createdAt:now-60_000,observedAt:now,observation:'fixture',
  text:'OpenAI public fixture',authorId:'77',handle:'fixture_account',displayName:'Fixture',language:'en',kind:'original',metrics:{...unknownMetrics,likes:20}};
test('publication modes enforce their field boundaries and confirmed deletion prevents replay',async()=>{
  assert.equal(publication('disabled','openai',candidate),null);
  const ids=publication('ids','openai',candidate)!;
  assert.equal(ids.resolution,'unresolved');
  assert.equal(ids.post.text,'');
  assert.deepEqual(ids.post.metrics,unknownMetrics);
  assert.equal(ids.post.authorId,null);
  assert.equal(ids.post.createdAt,null);
  const metadata=publication('metadata','openai',candidate)!;
  assert.equal(metadata.resolution,'unresolved');
  assert.equal(metadata.post.createdAt,candidate.createdAt);
  assert.equal(metadata.post.metrics.likes,20);
  assert.equal(metadata.post.handle,null);
  assert.equal(hostedEvent.safeParse({...metadata,post:candidate}).success,false);
  assert.equal(publication('approved-public','openai',candidate)?.post.text,candidate.text);
  assert.equal(publication('simulated','openai',{...candidate,namespace:'mock'})?.resolution,'resolved');
  const store=new HostedStore(':memory:');
  try{
    const provider={kind:'website-session' as const,identity:'fixture',collect:async(_topic:string,cursor:import('../services/hosted-collector/src/provider').Cursor)=>({
      cursor:{...cursor,done:true},posts:[candidate],
    })};
    const options={mode:'approved-public' as const,clock:()=>now,permission:'fixture-review-record',provider};
    assert.throws(()=>createHostedService(store,{...options,provider:undefined}),/authorized session provider/);
    assert.throws(()=>createHostedService(store,options),/publication permission/);
    const server=createHostedService(store,{...options,licenseConfirmed:true});
    const token=store.issue('fixture',now).token;
    const headers={Authorization:'Bearer '+token},request={method:'PUT' as const,url:'/v1/subscriptions',headers};
    try{
      assert.equal((await server.app.inject({...request,payload:{topics:['openai']}})).statusCode,403);
      assert.equal((await server.app.inject({...request,payload:{topics:['openai'],liveTermsAccepted:true}})).statusCode,200);
      await server.tick();
      assert.equal((store.db.prepare('SELECT count(*) n FROM events').get() as {n:number}).n,1);
      store.purgePost(candidate.id,now);
      assert.equal((store.db.prepare('SELECT count(*) n FROM events').get() as {n:number}).n,0);
      assert.equal(store.isBlocked(candidate.id),true);
    }finally{await server.close();}
  }finally{store.db.close();}
});

test('explicit retired credential cleanup preserves unrelated hosted data',()=>{
  const store=new HostedStore(':memory:');
  try{
    store.db.exec(`CREATE TABLE secret(name TEXT PRIMARY KEY,cipher TEXT NOT NULL);
      INSERT INTO secret VALUES ('x-bearer','old'),('x-bearer:operator','old'),('unrelated','other');`);
    const client=store.issue('Existing client',now);
    assert.ok(store.db.prepare("SELECT 1 FROM secret WHERE name='x-bearer'").get());
    store.removeRetiredCredentials();
    store.removeRetiredCredentials();
    assert.deepEqual(store.db.prepare('SELECT name FROM secret').all(),[{name:'unrelated'}]);
    assert.equal(store.authenticate('Bearer '+client.token,now)?.id,client.id);
  }finally{store.db.close();}
});

test('native simulated alerts require opt-in and an X notification click opens the canonical link',async()=>{
  const store=new Store(':memory:');
  let time=now;
  const notices:{title:string;onClick?:()=>void}[]=[],opened:string[]=[];
  const monitor=new Monitor(store,()=>time,async notice=>{notices.push(notice);return 'submitted';},(_source,_id,url)=>{if(url)opened.push(url);});
  try{
    const list=store.saveList({...rule,cooldownSeconds:0},time);
    monitor.pause(false);
    store.set('next:mock',time+60_000);
    const demo={...candidate,namespace:'mock' as const,id:'simulated-1',canonicalId:'simulated-1'};
    monitor.ingest(demo,[list],time,false,false);
    await monitor.tick();
    assert.equal(notices.length,0);
    assert.equal(store.count("SELECT count(*) n FROM notifications WHERE dispatch_state='disabled'"),1);
    store.set('preferences',{...defaults,simulatedNotifications:true});
    time++;
    monitor.ingest({...demo,id:'simulated-2',canonicalId:'simulated-2'},[list],time,false,false);
    await monitor.tick();
    assert.equal(notices.length,1);
    assert.match(notices[0].title,/Simulated/);
    monitor.ingest(candidate,[list],time,false,false);
    await monitor.tick();
    assert.equal(notices.length,2);
    notices[1].onClick?.();
    assert.deepEqual(opened,['https://x.com/i/web/status/'+candidate.id]);
  }finally{store.close();}
});

test('official widgets are gated, sandboxed and confined to valid X identifiers',async()=>{
  const store=new Store(':memory:'),monitor=new Monitor(store,()=>now);
  const {api,setOrigin}=createApi(monitor,{profile:'fixture',controlToken:'fixture-control',stop:()=>{},erase:async()=>{}});
  const host='127.0.0.1:43890',origin='http://'+host;
  setOrigin(origin);
  try{
    store.persist(candidate,now);
    const boot=await api.inject({method:'POST',url:'/api/control/bootstrap',headers:{host,'x-monitor-control':'fixture-control'},payload:{}});
    const session=await api.inject({method:'POST',url:'/api/v1/session',headers:{host,origin},payload:{nonce:new URL(boot.json().url).hash.slice(6)}});
    const headers={host,cookie:String(session.headers['set-cookie']).split(';')[0],'sec-fetch-dest':'iframe'};
    const url='/api/v1/embed/x/'+candidate.id;
    assert.equal((await api.inject({url,headers})).statusCode,404);
    store.set('preferences',{...defaults,officialEmbeds:true});
    const response=await api.inject({url,headers});
    assert.equal(response.statusCode,200);
    assert.match(response.body,/https:\/\/platform.twitter.com\/widgets.js/);
    assert.match(String(response.headers['content-security-policy']),/sandbox allow-scripts/);
    assert.doesNotMatch(response.body,/fixture_account|fixture-control/);
    assert.equal((await api.inject({url:'/api/v1/embed/x/untrusted',headers})).statusCode,400);
  }finally{await api.close();store.close();}
});
