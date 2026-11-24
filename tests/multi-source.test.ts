import {strict as assert} from 'node:assert';
import test from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {defaults,unknownMetrics,watchlist,type Candidate} from '../packages/contracts/index';
import {lines} from '../packages/collection-core/http';
import type {Collector} from '../packages/collection-core/collector';
import {HostedStore,createHostedService} from '../services/hosted-collector/src/service';
import {HostedClient,hostedOrigin,publicIp} from '../apps/service/hosted-client';
import {Store} from '../apps/service/storage';
import {Monitor} from '../apps/service/monitor';
import {XApi,type Vault} from '../apps/service/x-api';

const fixtureNow=Date.parse('2026-01-12T12:00:00Z');
const settings={...defaults,consoleBudgetConfirmed:true,dailyRequests:60,dailyResources:2000,dailyUsdCents:5000,maxResourceUsdMicros:10000,nativeNotifications:false};
const rule=watchlist.parse({name:'sqlite',terms:[{direction:'include',kind:'word',text:'SQLite'}],standard:0,immediate:0,cooldownSeconds:0});
const json=(value:unknown,status=200,headers:HeadersInit={})=>new Response(JSON.stringify(value),{status,headers});
const item:Candidate={namespace:'x',id:'110000000000000001',canonicalId:'110000000000000001',text:'SQLite update',authorId:'42',
  handle:'releases',displayName:'Releases',language:'en',createdAt:fixtureNow-5000,observedAt:fixtureNow,kind:'original',metrics:unknownMetrics,observation:'obs'};
const vault=()=>{
  const saved=new Map<string,string>();
  const driver:Vault={get:async key=>saved.get(key)??null,set:async(key,value)=>{saved.set(key,value);},remove:async key=>{saved.delete(key);}};
  return {saved,driver};
};
const select=(store:Store,id:string)=>{
  store.db.transaction(()=>{
    store.run('UPDATE data_sources SET active=0 WHERE active=1');
    store.run('UPDATE data_sources SET active=1 WHERE id=?',id);
  })();
};

test('switching collectors preserves one post, local score, preferences and canonical alert',async()=>{
  const store=new Store(':memory:');
  try{
    let now=fixtureNow;
    const source=(id:Collector['id']):Collector=>({id,capabilities:[],async collect(_lists,_now,signal,commit){
      signal.throwIfAborted();
      commit([{...item,observedAt:now,observation:id}],false,'cursor:'+id,1);
      return true;
    }});
    const list=store.saveList(rule,now);
    store.set('preferences',settings);
    const monitor=new Monitor(store,()=>now,async()=> 'submitted',undefined,source('x'),source('session'),source('hosted'));
    const seen=[];
    for(const id of ['x','session','hosted']){
      select(store,id);
      monitor.pause(false);
      await monitor.tick();
      seen.push(store.matches('x',item.id)[0].score);
      now+=60_000;
    }
    assert.deepEqual(seen,[80,80,80]);
    assert.equal(store.count('SELECT count(*) n FROM posts'),1);
    assert.equal(store.count('SELECT count(*) n FROM post_sources'),3);
    assert.equal(store.count('SELECT count(*) n FROM notifications'),1);
    assert.equal(store.lists[0].id,list.id);
    store.run("INSERT INTO feedback VALUES ('x',?,'useful',1,?)",item.id,now);
    monitor.rerank('x',item.id,item.authorId);
    assert.ok(store.matches('x',item.id)[0].score>seen[0]);
    assert.equal(store.count('SELECT count(*) n FROM notifications'),1);
  }finally{store.close();}
});

test('Local X Account is authorized through PKCE, restores the vault credential and reports expiry',async()=>{
  const store=new Store(':memory:'),{saved,driver}=vault();
  const origin='http://127.0.0.1:43123',lists=[store.saveList(rule,fixtureNow)];
  store.set('preferences',settings);
  const requested:string[]=[];
  const transport:typeof fetch=async (input,init)=>{
    const path=new URL(String(input)).pathname;
    requested.push(path);
    if(path==='/2/oauth2/token'){
      assert.ok(new URLSearchParams(String(init?.body)).has('code_verifier'));
      return json({access_token:'fixture-session-token',scope:'tweet.read users.read',expires_in:120});
    }
    const auth=new Headers(init?.headers).get('authorization');
    assert.equal(auth,'Bearer fixture-session-token');
    if(path==='/2/users/me')return json({data:{id:'42',username:'fixture'}});
    if(path==='/2/tweets/search/recent')return json({data:[{id:item.id,text:item.text}]});
    throw new Error('Unexpected fixture request');
  };
  try{
    const first=new XApi(store,driver,transport,()=>{},'session');
    const {url}=await first.authorize({clientId:'fixture-app',following:false,likes:false,refresh:false},origin);
    const auth=new URL(url);
    assert.equal(auth.searchParams.get('redirect_uri'),origin+'/api/v1/oauth/session/callback');
    const callback='/api/v1/oauth/session/callback?'+new URLSearchParams({state:auth.searchParams.get('state')!,code:'fixture-code'});
    await first.callback(callback,origin);
    await assert.rejects(()=>first.callback(callback,origin),/expired or was declined/);
    assert.equal(store.active.id,'mock');
    assert.equal(first.account?.username,'fixture');
    assert.equal(saved.get('access'),'fixture-session-token');
    assert.equal(store.count("SELECT count(*) n FROM settings WHERE value_json LIKE '%fixture-session-token%'"),0);
    select(store,'session');
    const restored=new XApi(store,driver,transport,()=>{},'session');
    const signal=new AbortController().signal;
    const posts:Candidate[]=[];
    assert.equal(await restored.collect(lists,restored.account!.expiresAt-60_000,signal,items=>posts.push(...items)),true);
    assert.equal(posts[0].id,item.id);
    assert.equal(await restored.collect(lists,restored.account!.expiresAt+60_000,signal,()=>{}),false);
    assert.equal(store.active.error_code,'SESSION_EXPIRED');
    assert.equal(requested.filter(path=>path.endsWith('/recent')).length,1);
    await restored.disconnect();
    assert.equal(saved.size,0);
    assert.equal(restored.account,null);
  }finally{store.close();}
});

test('official stream normalizes frames without a polling interval and stops on entitlement denial',async()=>{
  const store=new Store(':memory:');
  try{
    store.set('preferences',settings);
    select(store,'x');
    store.run("UPDATE data_sources SET configured=1 WHERE id='x'");
    let denied=false,calls=0;
    const transport:typeof fetch=async input=>{
      assert.equal(new URL(String(input)).pathname,'/2/tweets/search/stream');
      calls++;
      if(denied)return json({},403);
      return new Response('\r\n'+JSON.stringify({data:{id:item.id,text:item.text}})+'\r\n');
    };
    const x=new XApi(store,{...vault().driver,get:async()=> 'fixture-bearer'},transport);
    x.configure({pages:2,pageSize:10,recoveryHours:1,stream:true,streamBudgetConfirmed:true});
    const posts:Candidate[]=[];
    const signal=new AbortController().signal;
    await x.stream([],signal,items=>posts.push(...items));
    assert.equal(posts[0].id,item.id);
    denied=true;
    x.configure(x.settings);
    await x.stream([],signal,()=>{});
    await x.stream([],signal,()=>{});
    assert.equal(calls,2);
    assert.equal(store.active.error_code,'STREAM_UNAVAILABLE');
  }finally{store.close();}
});

test('hosted origin rejects private DNS results and non-origin URLs',()=>{
  for(const host of ['https://127.0.0.1','https://test.local','https://a.example.com:8443','https://a.example.com/relay','http://a.example.com','https://user@a.example.com'])
    assert.throws(()=>hostedOrigin(host));
  assert.equal(hostedOrigin('https://a.example.com:443/'),'https://a.example.com');
  for(const ip of ['127.0.0.1','10.0.0.1','169.254.169.254','100.64.1.1','::ffff:127.0.0.1','fd00::1','2001:db8::1'])
    assert.equal(publicIp(ip),false);
  assert.equal(publicIp('8.8.8.8'),true);
  assert.equal(publicIp('2606:4700:4700::1111'),true);
});

test('hosted client sends only consented public topics and commits resumable frames',async()=>{
  const store=new Store(':memory:'),{driver}=vault();
  let requests:unknown[]=[];
  const modes:string[]=[];
  store.saveList(rule,fixtureNow);
  store.saveList(watchlist.parse({name:'Private projects',terms:[{direction:'include',kind:'word',text:'Unapproved'}]}),fixtureNow);
  const token='A'.repeat(43), origin='https://monitor.example.com';
  const host=new HostedClient(store,driver,async (server,path,supplied,_signal,body)=>{
    assert.equal(server,origin);
    assert.equal(supplied,token);
    modes.push(path);
    if(body!==undefined)requests.push(body);
    if(path.startsWith('/v1/events'))return new Response(
      'id: 1\nevent: post\ndata: '+JSON.stringify({topic:'unapproved',delivery:'approved-public',post:item})+'\n\n'+
      'id: 2\nevent: post\ndata: '+JSON.stringify({topic:'sqlite',delivery:'approved-public',post:item})+'\n\n',
      {headers:{'Content-Type':'text/event-stream'}});
    return json({delivery:'approved-public',serverTime:Date.now(),topics:[{topic:'sqlite',state:'Polling'}]});
  });
  try{
    await assert.rejects(()=>host.credential(token),/Approve/);
    await assert.rejects(()=>host.configure({origin,topics:['sqlite'],consent:false}));
    assert.equal(await host.collect(store.lists,fixtureNow,new AbortController().signal),false);
    assert.equal(modes.length,0);
    await host.configure({origin,topics:['sqlite'],consent:true});
    await host.credential(token);
    const signal=new AbortController().signal;
    assert.equal(await host.collect(store.lists,fixtureNow,signal),true);
    const received:Candidate[]=[];
    await host.stream(store.lists,signal,(posts,_historical,key,value)=>{received.push(...posts);store.set(key,value);});
    assert.deepEqual(requests,[{topics:['sqlite']}]);
    assert.equal(received.length,1);
    assert.equal(store.get<{value_json:string}>("SELECT value_json FROM settings WHERE key LIKE 'hosted:cursor:%'")?.value_json,'2');
    requests=[];
    await host.disconnect();
    assert.deepEqual(requests,[{topics:[]}]);
    assert.equal(host.config,null);
  }finally{store.close();}
});

test('hosted SSE shares topics, isolates memberships and replays only authorized events',async()=>{
  const store=new HostedStore(':memory:');
  let now=fixtureNow;
  const service=createHostedService(store,{mode:'simulated',clock:()=>now,intervalMs:60_000});
  const alice=store.issue('Alice',now),bob=store.issue('Bob',now),outsider=store.issue('Carol',now);
  const headers=(token:string)=>({Authorization:'Bearer '+token});
  try{
    const origin=await service.app.listen({host:'127.0.0.1',port:0});
    const update=(token:string,topics:string[])=>service.app.inject({method:'PUT',url:'/v1/subscriptions',headers:headers(token),payload:{topics}});
    assert.equal((await update(alice.token,['SQLite','Private Alice'])).statusCode,200);
    assert.equal((await update(bob.token,[' sqlite '])).statusCode,200);
    assert.equal((await update(outsider.token,['Bob-only'])).statusCode,200);
    assert.equal((store.db.prepare("SELECT count(*) n FROM topics WHERE topic='sqlite'").get() as {n:number}).n,1);
    assert.equal((await service.app.inject({url:'/v1/status'})).statusCode,401);
    assert.equal((await service.app.inject({url:'/admin',headers:headers(alice.token)})).statusCode,404);
    await service.tick();
    const read=async(token:string,after:number)=>{
      const signal=new AbortController();
      try{
        const response=await fetch(origin+'/v1/events?after='+after,{headers:headers(token),signal:signal.signal});
        assert.equal(response.status,200);
        let id=0;
        const stream=lines(response.body!);
        for await(const line of stream){
          if(line.startsWith('id: '))id=+line.slice(4);
          if(line.startsWith('data: ')){
            const result=JSON.parse(line.slice(6));
            if(result.topic)return {id,result};
          }
        }
        throw new Error('Expected event');
      }finally{signal.abort();}
    };
    const first=await read(bob.token,0);
    assert.equal(first.result.topic,'sqlite');
    now+=60_000;
    await service.tick();
    const resumed=await read(bob.token,first.id);
    assert.ok(resumed.id>first.id);
    assert.equal(resumed.result.topic,'sqlite');
    await update(alice.token,[]);
    assert.deepEqual(store.current(alice.id),[]);
    assert.equal((store.db.prepare("SELECT count(*) n FROM topics WHERE topic='sqlite'").get() as {n:number}).n,1);
    store.revoke(bob.id,now);
    assert.equal((await service.app.inject({url:'/v1/status',headers:headers(bob.token)})).statusCode,401);
    assert.equal((store.db.prepare("SELECT count(*) n FROM topics WHERE topic='sqlite'").get() as {n:number}).n,0);
    await delay(10);
  }finally{await service.close();store.db.close();}
});

test('hosted live publication fails closed, encrypts credentials, and strips restricted fields',async()=>{
  const store=new HostedStore(':memory:');
  const key=Buffer.alloc(32,7);
  try{
    assert.throws(()=>createHostedService(store,{mode:'approved-public'}),/permission reference/);
    store.setBearer('operator-fixture-secret',key,fixtureNow);
    assert.equal(store.getBearer(key),'operator-fixture-secret');
    assert.throws(()=>store.getBearer(Buffer.alloc(32,8)));
    const encrypted=(store.db.prepare('SELECT cipher FROM secret').get() as {cipher:string}).cipher;
    assert.ok(!encrypted.includes('operator-fixture-secret'));
    const support=store.issue('fixture',fixtureNow);
    const x=createHostedService(store,{mode:'ids',clock:()=>fixtureNow,permission:'fixture',bearer:store.getBearer(key),dailyRequests:5,dailyResources:100,dailyUsdCents:5000,maxResourceUsdMicros:10000,
      transport:async()=>json({data:[{id:item.id,text:'restricted-body',author_id:'1',public_metrics:{like_count:55}}],includes:{users:[{id:'1',name:'External'}]}})});
    try{
      assert.equal((await x.app.inject({method:'PUT',url:'/v1/subscriptions',headers:{Authorization:'Bearer '+support.token},payload:{topics:['sqlite'],liveTermsAccepted:true}})).statusCode,200);
      await x.tick();
      const payload=(store.db.prepare('SELECT payload FROM events').get() as {payload:string}).payload;
      assert.ok(!payload.includes('restricted-body'));
      assert.equal(JSON.parse(payload).post.metrics.likes,null);
    }finally{await x.close();}
  }finally{store.db.close();}
});

test('live loopback VM stream reaches the same local ranking and action pipeline',async()=>{
  const serverStore=new HostedStore(':memory:');
  const local=new Store(':memory:');
  const service=createHostedService(serverStore,{mode:'simulated'});
  const {driver}=vault();
  let monitor:Monitor|undefined;
  try{
    const origin=await service.app.listen({host:'127.0.0.1',port:0});
    const vmClient=serverStore.issue('Desktop fixture');
    const hosted=new HostedClient(local,driver,async(_configured,path,token,signal,body)=>{
      const headers={Authorization:'Bearer '+token,...(body===undefined?{}:{'Content-Type':'application/json'})};
      return fetch(origin+path,{headers,signal,...(body===undefined?{}:{method:'PUT',body:JSON.stringify(body)})});
    });
    local.saveList(rule,Date.now());
    local.set('preferences',settings);
    await hosted.configure({origin:'https://monitor.example.com',topics:['sqlite'],consent:true});
    await hosted.credential(vmClient.token);
    select(local,'hosted');
    monitor=new Monitor(local,Date.now,async()=> 'submitted',undefined,hosted);
    monitor.pause(false);
    monitor.start();
    await monitor.tick();
    await service.tick();
    const deadline=Date.now()+5000;
    while(local.count('SELECT count(*) n FROM notifications')===0&&Date.now()<deadline)await delay(50);
    assert.equal(local.count("SELECT count(*) n FROM post_sources WHERE collector='hosted'"),1);
    assert.equal(local.count("SELECT count(*) n FROM notifications WHERE collector='hosted'"),1);
    assert.equal(local.count('SELECT count(*) n FROM scores'),1);
    assert.ok(local.get("SELECT 1 FROM settings WHERE key LIKE 'hosted:cursor:%'"));
  }finally{await monitor?.stop();await service.close();local.close();serverStore.db.close();}
});
