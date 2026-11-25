import assert from 'node:assert/strict';
import test from 'node:test';
import {createApi} from '../apps/service/api';
import {type Vault} from '../apps/service/credential-store';
import {Monitor} from '../apps/service/monitor';
import {Store} from '../apps/service/storage';
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
    assert.equal(sources.find(source=>source.id==='session')?.account,'fixture_user');
    assert.deepEqual(store.value('session:browser',null),{persistent:true});
    assert.equal((await api.inject({method:'PUT',url:'/api/v1/sources/session/active',headers})).statusCode,409);
    assert.deepEqual((await send({action:'disconnect'})).json(),{status:'Disconnected',persistent:false});
  } finally {await api.close();store.close();}
});

