import {strict as assert} from 'node:assert';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {resolve} from 'node:path';
import test from 'node:test';
import {createApi} from '../apps/service/api';
import {Monitor} from '../apps/service/monitor';
import {Store} from '../apps/service/storage';
import {WebsiteSession,type AuthorizedWebsiteDriver} from '../apps/service/website-session';
import {XApi,type Vault} from '../apps/service/x-api';
import {defaults,unknownMetrics,watchlist,type Candidate,type SourceInfo} from '../packages/contracts/index';
import {HostedStore,createHostedService} from '../services/hosted-collector/src/service';
import {officialProvider} from '../services/hosted-collector/src/provider';
import {lines} from '../packages/collection-core/http';
import type {Collector} from '../packages/collection-core/collector';

const now=Date.parse('2026-11-20T12:00:00Z');
const rule=watchlist.parse({name:'SQLite',terms:[{direction:'include',kind:'word',text:'SQLite'}]});
const fixture:Candidate={namespace:'x',id:'42',canonicalId:'42',text:'SQLite release',createdAt:now-60_000,observedAt:now,
  authorId:'9',displayName:'Fixture',handle:'example',language:'en',kind:'original',observation:'initial',metrics:{...unknownMetrics,likes:2}};
const budget={...defaults,consoleBudgetConfirmed:true,dailyRequests:40,dailyResources:1200,dailyUsdCents:5000,maxResourceUsdMicros:10000};
const signal=new AbortController().signal;
const json=(value:unknown,status=200,headers:HeadersInit={})=>new Response(JSON.stringify(value),{status,headers});
function memoryVault(){
  const values=new Map<string,string>();
  const vault:Vault={get:async k=>values.get(k)??null,set:async(k,v)=>{values.set(k,v);},remove:async k=>{values.delete(k);}};
  return {vault,values};
}

test('website permission, vault-only grant, saved cursor, expiry and reconnect',async()=>{
  const store=new Store(':memory:'),{vault,values}=memoryVault();
  const list=store.saveList({...rule,standard:40,immediate:50,cooldownSeconds:0},now);
  let calls=0;
  let dispatched=0;
  const monitor=new Monitor(store,()=>now,async()=>{dispatched++;return 'submitted';});
  const driver:AuthorizedWebsiteDriver={authorizationReference:'fixture-only',
    authorizeInteractively:async()=>({opaqueGrant:'local-fixture-session',handle:'fixture',expiresAt:Date.now()+60_000}),
    async search(grant,_lists,cursor){
      assert.equal(grant,'local-fixture-session');
      if(++calls===1){assert.equal(cursor,null);return json({items:[fixture],next:'first-cursor'});}
      assert.equal(cursor,'first-cursor');
      if(calls===2)return json({},401);
      return json({items:[{...fixture,id:'43',canonicalId:'43',text:'SQLite follow-up benchmark'}],next:null});
    },
  };
  try{
    const blocked=new WebsiteSession(store,vault);
    assert.equal(blocked.state.status,'Permission required');
    await assert.rejects(()=>blocked.connect(signal),/approved X integration/);
    assert.equal(await blocked.search([list],signal,()=>assert.fail()),false);
    let site=new WebsiteSession(store,vault,driver);
    await site.connect(signal);
    assert.equal(site.state.status,'Connected');
    assert.equal(values.get('website-grant'),'local-fixture-session');
    assert.equal(store.count("SELECT count(*) n FROM settings WHERE value_json LIKE '%local-fixture-session%'"),0);
    const received:Candidate[]=[];
    store.run("UPDATE data_sources SET active=0 WHERE id='mock'");
    store.run("UPDATE data_sources SET active=1,configured=1 WHERE id='session'");
    monitor.pause(false);
    const commit=(posts:Candidate[])=>{
      for(const post of posts)monitor.ingest(post,[list],now,false,false);
      received.push(...posts);
    };
    assert.equal(await site.search([list],signal,commit),true);
    await monitor.tick();
    assert.equal(dispatched,1);
    site=new WebsiteSession(store,vault,driver);
    assert.equal(await site.search([list],signal,()=>assert.fail()),false);
    assert.equal(site.state.status,'Session expired');
    assert.equal(await site.search([list],signal,()=>assert.fail()),false);
    await site.connect(signal);
    assert.equal(await site.search([list],signal,commit),true);
    await monitor.tick();
    assert.equal(dispatched,2);
    assert.deepEqual(received.map(p=>[p.id,p.collector,p.metrics.likes]),[['42','session',2],['43','session',2]]);
    await site.disconnect();
    assert.equal(site.state.status,'Authentication required');
    assert.equal(values.size,0);
    assert.equal(store.count("SELECT count(*) n FROM settings WHERE key LIKE 'website:%'"),0);
  }finally{store.close();}
});

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
    assert.equal(sources.find(s=>s.id==='x')?.features?.find(f=>f.label==='App-only recent search')?.state,'Authentication required');
    assert.equal(sources.find(s=>s.id==='session')?.features?.find(f=>f.label.startsWith('Authenticated website'))?.state,'Permission required');
    assert.equal(sources.find(s=>s.id==='mock')?.features?.at(0)?.state,'Available');
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
    monitor.ingest({...fixture,collector:'x',observation:'official'},store.lists,now,false,true);
    const weightBefore=store.matches('x','42')[0].score;
    const patch=await api.inject({method:'PATCH',url:'/api/v1/settings',headers:{...headers,'if-match':'0'},
      payload:{weights:{...defaults.weights,term:100,popularity:0}}});
    assert.equal(patch.statusCode,200);
    assert.notEqual(store.matches('x','42')[0].score,weightBefore);
    const detail=(await api.inject({url:'/api/v1/posts/x/42',headers})).json();
    assert.deepEqual(new Set(detail.provenance),new Set(['hosted','session','x']));
    assert.equal(detail.text,'Selected SQLite excerpt');
    assert.equal(store.count('SELECT count(*) n FROM notifications'),0);
  }finally{await api.close();store.close();}
});

test('first failed search keeps a frozen window and salvages malformed optional fields after recovery',async()=>{
  const store=new Store(':memory:'),{vault}=memoryVault(),list=store.saveList(rule,now);
  const requests:URL[]=[];
  store.set('preferences',budget);
  store.run("UPDATE data_sources SET active=0 WHERE id='mock'");
  store.run("UPDATE data_sources SET active=1,configured=1 WHERE id='x'");
  await vault.set('bearer','fixture-bearer');
  let check=false;
  const transport:typeof fetch=async url=>{
    if(check)return json({errors:[{type:'https://fixture.invalid/unavailable'}]});
    requests.push(new URL(String(url)));
    if(requests.length===1)return json({},503);
    return json({data:[{id:'42',text:'SQLite',public_metrics:{like_count:0,reply_count:'invalid',impression_count:12}},null],
      errors:[{value:'non-numeric resource description'}],meta:{result_count:2}});
  };
  const commit:Parameters<XApi['collect']>[3]=(posts,_historical,key,state)=>{
    for(const post of posts)store.persist(post,post.observedAt);
    store.set(key,state);
  };
  try{
    assert.equal(await new XApi(store,vault,transport).collect([list],now,signal,commit),false);
    assert.match(store.active.gap??'',/checkpoint/);
    assert.equal(await new XApi(store,vault,transport).collect([list],now+300_000,signal,commit),true);
    for(const field of ['start_time','end_time'])assert.equal(requests[0].searchParams.get(field),requests[1].searchParams.get(field));
    assert.equal(store.coverage('x').posts,1);
    assert.equal(store.coverage('x').pages,1);
    assert.equal(store.coverage('x').oldest,null);
    assert.match(store.active.gap??'',/partial/);
    assert.deepEqual(store.candidate(store.row('x','42')!).metrics,{likes:0,views:12,reposts:null,replies:null});
    check=true;
    await assert.rejects(()=>new XApi(store,vault,transport).check(),/invalid response/);
    assert.equal(store.active.error_code,'UPSTREAM_INVALID');
  }finally{store.close();}
});

test('an expired cursor replays the saved search window without duplicating posts',async()=>{
  const store=new Store(':memory:'),{vault}=memoryVault(),list=store.saveList(rule,now);
  store.set('preferences',budget);
  store.run("UPDATE data_sources SET active=0 WHERE id='mock'");
  store.run("UPDATE data_sources SET active=1,configured=1 WHERE id='x'");
  await vault.set('bearer','fixture-bearer');
  const requests:URL[]=[];
  const transport:typeof fetch=async input=>{
    const url=new URL(String(input));
    requests.push(url);
    if(url.searchParams.has('next_token'))return json({},400);
    return requests.length===1?json({data:[{id:'42',text:'SQLite'}],meta:{next_token:'expired'}}):
      json({data:[{id:'42',text:'SQLite'},{id:'43',text:'SQLite'}]});
  };
  const monitor=new Monitor(store,()=>now);
  const collector=new XApi(store,vault,transport);
  const commit:Parameters<XApi['collect']>[3]=(posts,historical,key,state)=>{
    for(const post of posts)monitor.ingest(post,[list],post.observedAt,false,historical);
    store.set(key,state);
  };
  try{
    await collector.collect([list],now,signal,commit);
    assert.match(store.active.gap??'',/invalid cursor/);
    assert.equal(await collector.collect([list],now+240_000,signal,commit),true);
    assert.equal(requests[1].searchParams.get('next_token'),'expired');
    assert.equal(requests[2].searchParams.get('next_token'),null);
    assert.equal(requests[0].searchParams.get('end_time'),requests[2].searchParams.get('end_time'));
    assert.equal(store.count('SELECT count(*) n FROM posts'),2);
    assert.equal(store.count('SELECT count(*) n FROM engagement_snapshots'),2);
    assert.equal(store.coverage('x').pages,1);
    assert.ok(store.coverage('x').newest);
  }finally{store.close();}
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
  const manual:Collector={id:'x',capabilities:[],async collect(_lists,_time,signal,commit){
    entered(signal);
    await released;
    commit([fixture],false,'old-collector-checkpoint',true);
    return true;
  }};
  store.saveList(rule,now);
  store.set('preferences',{...budget,nativeNotifications:false});
  store.run("UPDATE data_sources SET active=0 WHERE id='mock'");
  store.run("UPDATE data_sources SET active=1,configured=1 WHERE id='x'");
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

test('OAuth refresh resumes paging and removes relationships when consent is dropped',async()=>{
  const store=new Store(':memory:'),{vault}=memoryVault();
  const calls:string[]=[];
  let phase=0;
  store.set('preferences',budget);
  const baseScope='tweet.read users.read offline.access';
  const transport:typeof fetch=async input=>{
    const url=new URL(String(input));
    if(url.pathname.endsWith('/token'))return json({access_token:'fixture-access',refresh_token:'fixture-refresh',scope:baseScope+(phase<2?' follows.read':'')});
    if(url.pathname.endsWith('/me'))return json({data:{id:'9',username:'example'}});
    const cursor=url.searchParams.get('pagination_token')??'initial';
    calls.push(cursor);
    if(cursor==='initial')return json({data:[{id:'10'}],meta:{next_token:'p1'}});
    if(cursor==='p1')return json({data:[{id:'11'}],meta:{next_token:'p2'}});
    return json({data:[{id:'12'}]});
  };
  try{
    let x=new XApi(store,vault,transport,()=>{},'session');
    const origin='http://127.0.0.1:43123';
    const auth=new URL((await x.authorize({clientId:'fixture-app',following:true,likes:false,refresh:true},origin)).url);
    await x.callback('/api/v1/oauth/session/callback?code=test&state='+auth.searchParams.get('state'),origin);
    store.run("UPDATE data_sources SET active=0 WHERE id='mock'");
    store.run("UPDATE data_sources SET active=1 WHERE id='session'");
    let progress=store.value<{next:number}>('session:oauth',{next:0});
    assert.equal(store.value('session:signals',{syncing:false}).syncing,true);
    assert.equal(store.count('SELECT count(*) n FROM account_relationships'),2);
    phase=1;
    x=new XApi(store,vault,transport,()=>{},'session');
    await x.refreshSignals(progress.next,signal);
    assert.deepEqual(calls,['initial','p1','p2']);
    assert.equal(store.value('session:signals',{followingComplete:false}).followingComplete,true);
    assert.equal(store.count('SELECT count(*) n FROM account_relationships'),3);
    phase=2;
    progress=store.value('session:oauth',progress);
    await x.refreshSignals(progress.next,signal);
    assert.equal(store.count('SELECT count(*) n FROM account_relationships'),0);
    assert.equal(store.value('session:signals',{followingComplete:true}).followingComplete,false);
  }finally{store.close();}
});

test('hosted restart preserves cursor and authorized replay with isolated identities and revocation',async()=>{
  mkdirSync(resolve('.local'),{recursive:true});
  const folder=mkdtempSync(resolve('.local','hosted-restart-')),path=resolve(folder,'vm.sqlite');
  const encryptionKey=Buffer.alloc(32,8);
  let store=new HostedStore(path),time=now,requests=0;
  const firstId=fixture.id;
  const headers=(token:string)=>({Authorization:'Bearer '+token});
  const create=()=>{
    const version=store.identityVersion('alpha'),bearer=store.getBearer(encryptionKey,'alpha');
    const provider=officialProvider('alpha',()=>bearer,async input=>{
      requests++;
      const cursor=new URL(String(input)).searchParams.get('next_token');
      if(requests===1)return json({data:[{id:firstId,text:fixture.text}],meta:{next_token:'p2'}});
      assert.equal(cursor,'p2');
      if(requests===2)return json({},429,{'Retry-After':'60'});
      return json({data:[{id:'44',text:fixture.text}]});
    },()=>store.identityVersion('alpha')===version);
    return createHostedService(store,{provider,mode:'ids',clock:()=>time,permission:'fixture',dailyRequests:8,dailyResources:200,dailyUsdCents:5000,maxResourceUsdMicros:10000,topicLimit:1});
  };
  store.setBearer('fixture-alpha',encryptionKey,now,'alpha');
  store.setBearer('fixture-beta',encryptionKey,now,'beta');
  const alice=store.issue('A',now,2),bob=store.issue('B',now,2);
  assert.throws(()=>store.issue('C',now,2),/Client cap/);
  let service=create();
  try{
    for(const person of [alice,bob])assert.equal((await service.app.inject({method:'PUT',url:'/v1/subscriptions',headers:headers(person.token),payload:{topics:['sqlite'],liveTermsAccepted:true}})).statusCode,200);
    assert.equal((await service.app.inject({method:'PUT',url:'/v1/subscriptions',headers:headers(bob.token),payload:{topics:['other'],liveTermsAccepted:true}})).statusCode,409);
    await service.tick();
    assert.equal(store.identityStatus('alpha',time).status,'Verified');
    assert.equal(store.identityStatus('beta',time).status,'Configured · unverified');
    const cursor=store.maxEvent();
    time+=30_000;
    await service.tick();
    assert.equal(store.identityStatus('alpha',time).status,'Backoff');
    await service.close();store.db.close();
    store=new HostedStore(path);
    service=create();
    await service.tick();
    assert.equal(requests,2);
    time+=90_000;
    await service.tick();
    const origin=await service.app.listen({host:'127.0.0.1',port:0});
    const response=await fetch(`${origin}/v1/events?after=${cursor}`,{headers:headers(alice.token),signal:AbortSignal.timeout(3000)});
    for await(const line of lines(response.body!)){
      if(line.startsWith('data: ')&&line.includes('"topic"')){
        assert.equal(JSON.parse(line.slice(6)).post.id,'44');
        assert.equal(JSON.parse(line.slice(6)).post.text,'');
        break;
      }
    }
    store.revoke(bob.id,time);
    assert.equal((await service.app.inject({url:'/v1/status',headers:headers(bob.token)})).statusCode,401);
    store.revokeBearer('alpha',time);
    assert.equal(store.identityStatus('alpha',time).status,'Credential required');
    assert.equal(store.getBearer(encryptionKey,'beta'),'fixture-beta');
    time+=300_000;
    await service.tick();
    assert.equal(requests,3);
  }finally{await service.close();store.db.close();rmSync(folder,{recursive:true,force:true});}
});
