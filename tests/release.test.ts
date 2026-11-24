import assert from 'node:assert/strict';
import test from 'node:test';
import {ApiError,createApi} from '../apps/service/api';
import {Monitor} from '../apps/service/monitor';
import {Store} from '../apps/service/storage';
import {XApi,type Vault} from '../apps/service/x-api';
import {defaults,unknownMetrics,watchlist,type Candidate} from '../packages/contracts/index';
import {hostedEvent} from '../packages/collection-core/hosted';
import {publication} from '../services/hosted-collector/src/publication';
import {createHostedService,HostedStore} from '../services/hosted-collector/src/service';
import type {Collector} from '../packages/collection-core/collector';

const now=Date.now();
const rule=watchlist.parse({name:'OpenAI',terms:[{direction:'include',kind:'word',text:'OpenAI'}],standard:40,immediate:50});
const settings={...defaults,dailyRequests:30,dailyResources:1000,dailyUsdCents:500,maxResourceUsdMicros:10_000,consoleBudgetConfirmed:true};
const candidate:Candidate={namespace:'x',id:'12345678',canonicalId:'12345678',createdAt:now-60_000,observedAt:now,observation:'fixture',
  text:'OpenAI public fixture',authorId:'77',handle:'fixture_account',displayName:'Fixture',language:'en',kind:'original',metrics:{...unknownMetrics,likes:20}};
const json=(body:unknown,status=200,headers:HeadersInit={})=>new Response(JSON.stringify(body),{status,headers});
const issue=(code:string)=>(error:unknown)=>error instanceof ApiError&&error.code===code;
function vault(){
  const entries=new Map<string,string>();
  const vault:Vault={get:async key=>entries.get(key)??null,set:async(key,value)=>{entries.set(key,value);},remove:async key=>{entries.delete(key);}};
  return vault;
}

test('connection probe distinguishes credential, entitlement, network, endpoint, budget and response failures',async()=>{
  const store=new Store(':memory:'),secrets=vault();
  let calls=0,outcome='ok';
  const transport:typeof fetch=async (request,init)=>{
    calls++;
    assert.equal(new URL(String(request)).searchParams.get('max_results'),'10');
    assert.equal(new Headers(init?.headers).get('authorization'),'Bearer fixture-bearer');
    if(outcome==='network')throw new Error('Fixture network down');
    if(outcome==='bad')return json({meta:{result_count:1}});
    if(outcome!=='ok')return json({},Number(outcome),{'Retry-After':'60'});
    return json({data:[{id:candidate.id,text:candidate.text}],meta:{next_token:'fixture-cursor',result_count:1}});
  };
  const x=new XApi(store,secrets,transport);
  try{
    store.saveList(rule,now);
    await assert.rejects(()=>x.check(),issue('CREDENTIAL_REQUIRED'));
    await x.credential('fixture-bearer');
    await assert.rejects(()=>x.check(),issue('BUDGET_EXHAUSTED'));
    store.set('preferences',{...settings,dailyUsdCents:19});
    await assert.rejects(()=>x.check(),issue('BUDGET_EXHAUSTED'));
    store.set('preferences',settings);
    await assert.rejects(()=>x.check(19),issue('BUDGET_EXHAUSTED'));
    assert.equal(calls,0);
    assert.equal((await x.check(20)).normalizedPosts,1);
    assert.equal(store.value('x:probe-checkpoint',{next:''}).next,'fixture-cursor');
    const day=new Date().toISOString().slice(0,10);
    assert.equal(store.value('usage:cost:'+day,0),200_000);
    for(const [result,code] of [['401','INVALID_CREDENTIALS'],['403','ACCESS_DENIED'],['404','ENDPOINT_UNAVAILABLE'],['network','NETWORK'],['bad','UPSTREAM_INVALID'],['429','RATE_LIMIT']]){
      outcome=result;
      await assert.rejects(()=>x.check(),issue(code));
    }
    assert.equal(store.active.id,'mock');
    assert.equal(calls,7);
  }finally{store.close();}
});

test('OAuth code rejection and failed refresh clear relationship access without exposing tokens',async()=>{
  const store=new Store(':memory:'),secrets=vault();
  let codeAccepted=false,refreshes=0,reads=0;
  const transport:typeof fetch=async(input,init)=>{
    const path=new URL(String(input)).pathname;
    if(path.endsWith('/token')){
      const form=new URLSearchParams(String(init?.body));
      if(form.get('grant_type')==='refresh_token'){refreshes++;return json({error:'invalid_grant',error_description:'fixture-private'},400);}
      if(!codeAccepted)return json({error:'invalid_grant',error_description:'fixture-private'},400);
      return json({access_token:'fixture-access',refresh_token:'fixture-refresh',scope:'tweet.read users.read follows.read offline.access'});
    }
    if(path.endsWith('/me'))return json({data:{id:'77',username:'fixture_account'}});
    if(path.endsWith('/following'))return json({data:[{id:'88'}]});
    reads++;
    return json({},401);
  };
  const origin='http://127.0.0.1:32221';
  const x=new XApi(store,secrets,transport,()=>{},'session');
  const authorize=async()=>{
    const url=new URL((await x.authorize({clientId:'fixture-client',following:true,likes:false,refresh:true},origin)).url);
    return '/api/v1/oauth/session/callback?code=expired-or-valid&state='+url.searchParams.get('state');
  };
  try{
    store.set('preferences',settings);
    store.saveList(rule,now);
    const expired=await authorize();
    await assert.rejects(()=>x.callback(expired,origin),issue('OAUTH_CODE_REJECTED'));
    await assert.rejects(()=>x.callback(expired,origin),issue('OAUTH_STATE'));
    assert.equal(await secrets.get('access'),null);
    codeAccepted=true;
    await x.callback(await authorize(),origin);
    assert.equal(store.count('SELECT count(*) n FROM account_relationships'),1);
    assert.equal(await secrets.get('access'),'fixture-access');
    await assert.rejects(()=>x.check(),issue('SESSION_EXPIRED'));
    assert.equal(refreshes,1);
    assert.equal(reads,1);
    assert.equal(store.count('SELECT count(*) n FROM account_relationships'),0);
    await x.disconnect();
    assert.equal(await secrets.get('access'),null);
    assert.equal(await secrets.get('oauth-refresh'),null);
  }finally{store.close();}
});

test('both official search modes normalize, rank, store and dispatch only newly collected X results',async()=>{
  for(const source of ['x','session'] as const){
    const store=new Store(':memory:'),secrets=vault();
    let time=Date.now(),searches=0;
    const transport:typeof fetch=async(input,init)=>{
      const path=new URL(String(input)).pathname;
      if(path.endsWith('/token'))return json({access_token:'fixture-session',scope:'tweet.read users.read'});
      if(path.endsWith('/me'))return json({data:{id:'77',username:'fixture'}});
      assert.match(path,/search\/recent$/);
      assert.equal(new Headers(init?.headers).get('authorization'),source==='x'?'Bearer fixture-app-only':'Bearer fixture-session');
      searches++;
      return json({data:[{id:String(800+searches),text:'OpenAI new fixture',created_at:new Date(time-60_000).toISOString(),public_metrics:{like_count:100}}]});
    };
    const x=new XApi(store,secrets,transport,()=>{},source);
    let delivered=0;
    const monitor=new Monitor(store,()=>time,async()=>{delivered++;return 'submitted';},undefined,x);
    try{
      store.set('preferences',settings);
      store.saveList(rule,time);
      if(source==='x')await x.credential('fixture-app-only');
      else{
        const origin='http://127.0.0.1:32221';
        const authorization=new URL((await x.authorize({clientId:'fixture-app',following:false,likes:false},origin)).url);
        await x.callback('/api/v1/oauth/session/callback?code=fixture&state='+authorization.searchParams.get('state'),origin);
      }
      store.run("UPDATE data_sources SET active=0 WHERE id='mock'");
      store.run('UPDATE data_sources SET active=1 WHERE id=?',source);
      monitor.pause(false);
      await monitor.tick();
      assert.ok(store.matches('x','801').length);
      assert.equal(delivered,0);
      time+=300_000;
      await monitor.tick();
      assert.equal(store.count('SELECT count(*) n FROM notifications'),1);
      assert.equal(delivered,1);
      assert.equal(store.post(store.row('x','802')!,true).metrics.likes,100);
    }finally{store.close();}
  }
});

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
    const options={mode:'approved-public' as const,clock:()=>now,bearer:'fixture-bearer',permission:'review-record',dailyRequests:4,dailyResources:200,dailyUsdCents:500,maxResourceUsdMicros:10_000,
      transport:async()=>json({data:[{id:candidate.id,text:candidate.text}]})};
    assert.throws(()=>createHostedService(store,options),/permission reference/);
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

test('hosted IDs stay unscored until authorized local lookup and never duplicate the alert',async()=>{
  const store=new Store(':memory:'),secrets=vault();
  let time=now,calls=0,fail=false;
  const transport:typeof fetch=async input=>{
    calls++;
    const url=new URL(String(input));
    assert.equal(url.pathname,'/2/tweets');
    if(fail)return json({},403);
    return json({data:[{id:candidate.id,text:candidate.text,public_metrics:{like_count:20}}]});
  };
  const x=new XApi(store,secrets,transport);
  const hosted:Collector={id:'hosted',capabilities:[],async collect(){return true;}};
  const monitor=new Monitor(store,()=>time,async()=> 'submitted',undefined,x,hosted);
  const notifyCount=()=>store.count('SELECT count(*) n FROM notifications');
  try{
    const list=store.saveList(rule,time);
    store.set('preferences',settings);
    await x.credential('fixture-bearer');
    store.run("UPDATE data_sources SET active=0 WHERE id='mock'");
    store.run("UPDATE data_sources SET active=1,configured=1 WHERE id='hosted'");
    monitor.pause(false);
    const idOnly=publication('ids','openai',candidate)!.post;
    monitor.ingest({...idOnly,collector:'hosted'},[list],time,false,false);
    await monitor.tick();
    assert.equal(calls,0);
    assert.equal(notifyCount(),0);
    store.set('preferences',{...settings,hydrateHosted:true});
    time+=300_000;
    await monitor.tick();
    assert.equal(calls,1);
    assert.equal(notifyCount(),1);
    assert.equal(store.count("SELECT count(*) n FROM post_sources WHERE collector='x'"),1);
    monitor.ingest({...idOnly,collector:'hosted',observation:'duplicate'},[list],time,false,false);
    fail=true;
    time+=300_000;
    const unresolved={...idOnly,id:'12345679',canonicalId:'12345679',observation:'second',observedAt:time};
    monitor.ingest({...unresolved,collector:'hosted'},[list],time,false,false);
    await monitor.tick();
    assert.equal(calls,2);
    assert.equal(notifyCount(),1);
    assert.match(store.post(store.row('x',unresolved.id)!,true).hydration??'',/denied/);
    store.removeX(candidate.id);
    assert.equal(store.row('x',candidate.id),undefined);
    assert.equal(store.persist(candidate,time),false);
    assert.equal(notifyCount(),1);
  }finally{store.close();}
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
