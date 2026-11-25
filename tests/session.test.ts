import assert from 'node:assert/strict';
import test from 'node:test';
import {createApi} from '../apps/service/api';
import {type Vault} from '../apps/service/credential-store';
import {Monitor} from '../apps/service/monitor';
import {Store} from '../apps/service/storage';
import {twscrapeDriver} from '../apps/service/twscrape-driver';
import {WebsiteSession,type AuthorizedWebsiteDriver} from '../apps/service/website-session';
import {unknownMetrics,watchlist,type BrowserAccount,type Candidate,type SourceInfo} from '../packages/contracts/index';

const initial=Date.parse('2026-11-24T12:00:00Z'),host='127.0.0.1:43123',origin='http://'+host;
const signal=new AbortController().signal;
const candidate:Candidate={namespace:'x',id:'110000000000000001',canonicalId:'110000000000000001',text:'SQLite release candidate',authorId:'42',
  handle:'fixture',displayName:null,language:'en',createdAt:initial-1000,kind:'original',metrics:{...unknownMetrics,likes:12},observedAt:initial,observation:'fixture'};
const response=(body:unknown,status=200,headers?:HeadersInit)=>new Response(JSON.stringify(body),{status,headers});
function credentials(){
  const values=new Map<string,string>();
  const vault:Vault={get:async k=>values.get(k)??null,set:async(k,v)=>{values.set(k,v);},remove:async k=>{values.delete(k);}};
  return {vault,values};
}

test('twscrape binds the confirmed account, ingests search, and schedules following and engagement independently',async()=>{
  const store=new Store(':memory:'),{vault,values}=credentials();
  let now=initial,fingerprint='a'.repeat(64);
  const operations:string[]=[];
  const driver=twscrapeDriver({async live(operation,_db,account,options){
    operations.push(operation);
    assert.equal(account.handle,'fixture');
    switch(operation){
      case 'profile':return {status:200,id:'56',handle:'fixture'};
      case 'search':
        assert.equal((options as {query:string}).query,'sqlite OR "release candidate"');
        return {status:200,items:[{...candidate,namespace:'x',media:null}]};
      case 'following':
        assert.equal((options as {accountId:string}).accountId,'56');
        return {status:200,following:['42']};
      case 'lookup':return {status:200,items:[{...candidate,namespace:'x',metrics:{...candidate.metrics,likes:81},media:null}]};
      default:throw new Error(operation);
    }
  }},'fixture',async()=>({status:'Connected',handle:'fixture',expiresAt:initial+86_400_000,fingerprint,authToken:'fixture-token',csrfToken:'fixture-csrf'}));
  const connection=new WebsiteSession(store,vault,driver,()=>now);
  const monitor=new Monitor(store,()=>now,async()=>'submitted',undefined,connection);
  store.saveList(watchlist.parse({name:'SQLite',terms:[{kind:'word',text:'SQLite',direction:'include'},
    {kind:'phrase',text:'release candidate',direction:'include'}]}),now);
  try{
    await connection.connect(signal);
    assert.doesNotMatch(values.get('website-grant')??'',/fixture-token|fixture-csrf/);
    store.run('UPDATE data_sources SET active=0 WHERE active=1');
    store.run("UPDATE data_sources SET active=1 WHERE id='session'");
    monitor.pause(false);
    await monitor.tick();
    assert.deepEqual(operations,['profile','search','following']);
    assert.equal(store.count("SELECT count(*) n FROM account_relationships WHERE account_id='56' AND author_id='42'"),1);
    assert.equal(store.matches('x',candidate.id).length,1);
    await connection.refreshSignals(now+1,signal);
    assert.equal(await connection.collect(store.lists,now+119_999,signal,()=>assert.fail()),false);
    assert.equal(operations.length,3);
    now+=15*60_000;
    assert.equal((await connection.lookup!([candidate],now,signal)).posts[0].metrics.likes,81);
    assert.equal((await connection.lookup!([candidate],now+1,signal)).posts.length,0);
    fingerprint='b'.repeat(64);
    assert.equal(await connection.collect(store.lists,now,signal,()=>assert.fail()),false);
    assert.equal(connection.state.status,'Session expired');
    assert.deepEqual(operations,['profile','search','following','lookup']);
  }finally{await monitor.stop();store.close();}
});

test('an authorized session fixture persists the cursor and dispatches through the actual monitor',async()=>{
  const store=new Store(':memory:'),{vault,values}=credentials();
  let time=initial,dispatches=0,handle='fixture';
  const cursors:(string|null)[]=[];
  const driver:AuthorizedWebsiteDriver={
    authorizationReference:'fixture-only',
    authorizeInteractively:async()=>({handle,opaqueGrant:'test-local-grant',expiresAt:time+3_600_000}),
    async search(grant,lists,cursor){
      assert.equal(grant,'test-local-grant');
      assert.deepEqual(lists[0].terms.map(term=>term.text),['SQLite','release candidate']);
      cursors.push(cursor);
      if(cursors.length===2)return response({},429,{'retry-after':'120'});
      if(cursors.length===3)return response({},401);
      if(cursors.length===4)return response({items:[{...candidate,metrics:'invalid'}],next:'discard'});
      return response({items:[{...candidate,observedAt:time,observation:String(time)}],next:'next-page'});
    },
  };
  try {
    const unavailable=new WebsiteSession(store,vault);
    assert.equal(unavailable.state.status,'Unsupported');
    await assert.rejects(()=>unavailable.connect(signal),/approved X integration/);
    assert.equal(await unavailable.collect([],time,signal,()=>assert.fail()),false);
    let account=new WebsiteSession(store,vault,driver,()=>time);
    await account.connect(signal);
    assert.equal(values.get('website-grant'),'test-local-grant');
    assert.equal(store.count("SELECT count(*) n FROM settings WHERE value_json LIKE '%test-local-grant%'"),0);
    store.saveList(watchlist.parse({name:'SQLite',mode:'ALL',terms:[
      {kind:'word',text:'SQLite',direction:'include'},{kind:'phrase',text:'release candidate',direction:'include'},
    ],standard:20,immediate:30}),time);
    store.run('UPDATE data_sources SET active=0 WHERE active=1');
    store.run("UPDATE data_sources SET active=1 WHERE id='session'");
    const monitor=()=>new Monitor(store,()=>time,async()=>{dispatches++;return 'submitted';},undefined,account);
    let app=monitor();
    app.pause(false);
    await app.tick();
    assert.equal(store.matches('x',candidate.id).length,1);
    assert.equal(store.candidate(store.row('x',candidate.id)!).metrics.views,null);
    assert.equal(dispatches,1);
    account=new WebsiteSession(store,vault,driver,()=>time);
    app=monitor();
    time+=300_000;
    await app.tick();
    assert.equal(account.state.status,'Rate limited');
    assert.equal(store.value('next:session',0),time+120_000);
    time+=119_000;
    await app.tick();
    assert.equal(cursors.length,2);
    time+=1000;
    await app.tick();
    assert.equal(account.state.status,'Session expired');
    time+=300_000;
    await app.tick();
    assert.equal(cursors.length,3);
    await account.connect(signal);
    await app.tick();
    assert.equal(account.state.status,'Temporarily unavailable');
    time+=60_000;
    await app.tick();
    assert.deepEqual(cursors,[null,'next-page','next-page','next-page','next-page']);
    assert.equal(account.state.status,'Temporarily unavailable','repeated cursor cannot be committed');
    handle='different_account';
    await account.connect(signal);
    await app.tick();
    assert.equal(cursors.at(-1),null);
    assert.equal(dispatches,1);
    assert.equal(store.count('SELECT count(*) n FROM posts'),1);
    await account.disconnect();
    assert.equal(account.state.status,'Authentication required');
    assert.equal(values.size,0);
    assert.equal(store.active.id,'mock');
    assert.equal(store.paused,true);
  } finally {store.close();}
});

test('session check classifies verification, restrictions and unexpected network failures',async()=>{
  const store=new Store(':memory:'),{vault}=credentials();
  let status=428,time=initial;
  const account=new WebsiteSession(store,vault,{
    authorizationReference:'fixture-only',
    authorizeInteractively:async()=>({handle:'fixture',opaqueGrant:'saved-on-device',expiresAt:time+600_000}),
    async search(){
      if(status===500)throw new Error('fixture private transport payload');
      return response({},status);
    },
  },()=>time);
  try {
    for(const [code,expected] of [[428,'Verification required'],[403,'Restricted'],[500,'Temporarily unavailable']] as const){
      status=code;
      await account.connect(signal);
      assert.equal(await account.collect([],time,signal,()=>assert.fail()),false);
      assert.equal(account.state.status,expected);
      assert.equal(store.count("SELECT count(*) n FROM settings WHERE value_json LIKE '%private transport%'"),0);
      time+=60_000;
    }
  } finally {store.close();}
});

test('desktop sign-in returns metadata only and leaves session collection unsupported',async()=>{
  const store=new Store(':memory:'),monitor=new Monitor(store);
  store.set('session:browser',{status:'Connected',persistent:true,handle:'old_unbound'});
  let report:BrowserAccount={status:'Disconnected',persistent:false};
  const {api,setOrigin}=createApi(monitor,{profile:'fixture',controlToken:'fixture-control',stop:()=>{},erase:async()=>{},
    website:new WebsiteSession(store,credentials().vault),
    browserAccount:async action=>{
      if(action.action==='open')report={status:'Authentication required',persistent:action.remember};
      if(action.action==='confirm')report={status:'Connected',persistent:true,handle:'fixture_user'};
      if(action.action==='disconnect')report={status:'Disconnected',persistent:false};
      return report;
    },
  });
  setOrigin(origin);
  try {
    const bootstrap=await api.inject({method:'POST',url:'/api/control/bootstrap',headers:{host,'x-monitor-control':'fixture-control'}});
    const session=await api.inject({method:'POST',url:'/api/v1/session',headers:{host,origin},payload:{nonce:new URL(bootstrap.json().url).hash.slice(6)}});
    const headers={host,origin,cookie:String(session.headers['set-cookie']).split(';')[0],'x-monitor-csrf':session.json().csrf};
    const url='/api/v1/sources/session/browser';
    const send=(payload:unknown)=>api.inject({method:'POST',url,headers,payload:payload as object});
    const restored=(await api.inject({url:'/api/v1/sources',headers})).json<SourceInfo[]>().find(source=>source.id==='session')!;
    assert.equal(restored.account,null);
    assert.equal(restored.browser?.status,'Check required');
    assert.deepEqual(store.value('session:browser',null),{persistent:true});
    assert.equal((await api.inject({method:'POST',url,headers:{host,origin},payload:{action:'check'}})).statusCode,401);
    assert.equal((await send({action:'open',remember:true,cookies:'rejected'})).statusCode,400);
    assert.deepEqual((await send({action:'open',remember:true})).json(),{status:'Authentication required',persistent:true});
    report={status:'Profile confirmation required',persistent:true};
    assert.deepEqual((await send({action:'check'})).json(),report);
    assert.equal((await send({action:'confirm',handle:'user_input'})).statusCode,400);
    assert.deepEqual((await send({action:'confirm'})).json(),{status:'Connected',persistent:true,handle:'fixture_user'});
    const sources=(await api.inject({url:'/api/v1/sources',headers})).json<SourceInfo[]>();
    assert.equal(sources.find(source=>source.id==='session')?.status,'Unsupported');
    const collection=await api.inject({method:'POST',url:'/api/v1/sources/session/connect',headers});
    assert.equal(collection.statusCode,403);
    assert.equal(collection.json().error.code,'WEBSITE_PERMISSION_REQUIRED');
    assert.equal(sources.find(source=>source.id==='session')?.account,'fixture_user');
    assert.deepEqual(store.value('session:browser',null),{persistent:true});
    store.run("UPDATE data_sources SET configured=1 WHERE id='session'");
    const stale=(await api.inject({url:'/api/v1/sources',headers})).json<SourceInfo[]>().find(source=>source.id==='session')!;
    assert.equal(stale.configured,false);
    assert.equal((await api.inject({method:'PUT',url:'/api/v1/sources/session/active',headers})).statusCode,409);
    assert.deepEqual((await send({action:'disconnect'})).json(),{status:'Disconnected',persistent:false});
  } finally {await api.close();store.close();}
});


test('rate-limit deadline survives resume and rescheduling; expired cursors restart safely',async()=>{
  const store=new Store(':memory:'),{vault}=credentials();
  let time=initial;
  const cursors:(string|null)[]=[];
  const account=new WebsiteSession(store,vault,{
    authorizationReference:'fixture-only',
    authorizeInteractively:async()=>({handle:'fixture',opaqueGrant:'local-test',expiresAt:initial+3_600_000}),
    async search(_grant,_lists,cursor){
      cursors.push(cursor);
      if(cursors.length===1)return response({items:[candidate],next:'expired-cursor'});
      if(cursors.length===2)return response({},429,{'retry-after':'120'});
      if(cursors.length===3)return response({},410);
      return response({items:[candidate],next:null});
    },
  },()=>time);
  try{
    await account.connect(signal);
    store.saveList(watchlist.parse({name:'SQLite',terms:[{kind:'word',text:'SQLite',direction:'include'}]}),time);
    store.run("UPDATE data_sources SET active=0 WHERE id='mock'");
    store.run("UPDATE data_sources SET active=1 WHERE id='session'");
    const app=new Monitor(store,()=>time,async()=> 'submitted',undefined,account);
    app.pause(false);
    await app.tick();
    time+=300_000;
    await app.tick();
    const deadline=time+120_000;
    app.pause(true);
    app.pause(false);
    store.set('next:session',time); // watchlist or interval edit
    assert.equal(app.status.nextDue,deadline);
    await app.tick();
    assert.equal(cursors.length,2);
    time=deadline;
    await app.tick();
    assert.equal(account.state.status,'Temporarily unavailable');
    time+=60_000;
    await app.tick();
    assert.deepEqual(cursors,[null,'expired-cursor','expired-cursor',null]);
    assert.equal(store.count('SELECT count(*) n FROM posts'),1);
    time=initial+3_600_000;
    assert.equal(app.status.status,'Session expired');
    assert.equal(app.status.nextDue,null);
    await app.tick();
    assert.equal(cursors.length,4);
  }finally{store.close();}
});

test('aborting a stalled session response cannot commit posts or a cursor',async()=>{
  const store=new Store(':memory:'),{vault}=credentials();
  const controller=new AbortController();
  let entered!:()=>void;
  const started=new Promise<void>(resolve=>{entered=resolve;});
  const account=new WebsiteSession(store,vault,{
    authorizationReference:'fixture-only',
    authorizeInteractively:async()=>({handle:'fixture',opaqueGrant:'local-test',expiresAt:initial+600_000}),
    async search(){return new Response(new ReadableStream<Uint8Array>({pull(){entered();}}));},
  },()=>initial);
  try{
    await account.connect(signal);
    const collection=account.collect([],initial,controller.signal,()=>assert.fail('Aborted page was committed'));
    await started;
    controller.abort();
    assert.equal(await collection,false);
    assert.equal(account.state.status,'Connected');
    assert.equal(store.count("SELECT count(*) n FROM settings WHERE key LIKE 'website:cursor:%'"),0);
  }finally{store.close();}
});
