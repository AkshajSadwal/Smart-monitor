import {strict as assert} from 'node:assert';
import test from 'node:test';
import {Store} from '../apps/service/storage';
import {XApi,queryGroups,type Vault} from '../apps/service/x-api';
import {defaults,watchlist} from '../packages/contracts/index';

const now=Date.parse('2026-01-12T12:00:00Z');
const fixtureBearer='fixture-token-only';
const vault:Vault={get:async()=>fixtureBearer,set:async()=>{},remove:async()=>{}};
const json=(data:unknown,status=200,headers:HeadersInit={})=>new Response(JSON.stringify(data),{status,headers});

function setup() {
  const store=new Store(':memory:');
  const rule=store.saveList(watchlist.parse({name:'Releases',terms:[{direction:'include',kind:'phrase',text:'SQLite release candidate'}]}),now);
  store.run("UPDATE data_sources SET active=0 WHERE id='mock'");
  store.run("UPDATE data_sources SET active=1, configured=1 WHERE id='x'");
  const commit=(posts:Parameters<XApi['lookup']>[0],_historical:boolean,key:string,state:unknown)=>{
    store.db.transaction(()=>{for(const post of posts)store.persist(post,now);store.set(key,state);})();
  };
  return {store,rule,commit};
}

test('safe queries, no paid request without a budget, and resource reservation',async()=>{
  const {store,rule,commit}=setup();
  let calls=0;
  const transport:typeof fetch=async (input,init)=>{
    calls++;
    const url=new URL(String(input));
    assert.equal(url.origin,'https://api.x.com');
    assert.equal(url.searchParams.get('query'),'"sqlite release candidate"');
    assert.equal(new Headers(init?.headers).get('authorization'),'Bearer '+fixtureBearer);
    return json({data:[{id:'90071992547409931',text:'SQLite release candidate',author_id:'5',created_at:'2026-01-12T11:58:01Z',public_metrics:{like_count:0}}]});
  };
  try {
    const collector=new XApi(store,vault,transport);
    assert.deepEqual(queryGroups({...rule,terms:[{direction:'include',kind:'phrase',text:'" OR from:someone',important:false}]}),[]);
    assert.equal(await collector.collect([rule],now,new AbortController().signal,commit),false);
    assert.equal(calls,0);
    store.set('preferences',{...defaults,consoleBudgetConfirmed:true,dailyRequests:1,dailyResources:20});
    assert.equal(await collector.collect([rule],now,new AbortController().signal,commit),true);
    const row=store.row('x','90071992547409931')!;
    assert.equal(store.post(row).metrics.likes,0);
    assert.equal(store.post(row).metrics.views,null);
    assert.equal(store.post(row).text,null);
    assert.equal(store.get<{resources:number}>('SELECT resources FROM usage_buckets')?.resources,20);
    assert.equal(await collector.collect([rule],now+300_000,new AbortController().signal,commit),false);
    assert.equal(calls,1);
    assert.equal(store.active.error_code,'BUDGET_EXHAUSTED');
  } finally {store.close();}
});

test('partial frozen pages survive a rate reset and preserve numeric IDs as strings',async()=>{
  const {store,rule,commit}=setup();
  store.set('preferences',{...defaults,consoleBudgetConfirmed:true,dailyRequests:10,dailyResources:200});
  const requests:URL[]=[];
  const transport:typeof fetch=async input=>{
    requests.push(new URL(String(input)));
    if(requests.length===1)return json({data:[{id:'100000000000000001',text:'first'}],meta:{next_token:'next'}});
    if(requests.length===2)return json({},429,{'Retry-After':'120','x-rate-limit-reset':String((now+180_000)/1000)});
    return json({data:[{id:'100000000000000002',text:'second'}]});
  };
  try {
    const collector=new XApi(store,vault,transport);
    const signal=new AbortController().signal;
    assert.equal(await collector.collect([rule],now,signal,commit),false);
    assert.equal(store.active.error_code,'RATE_LIMIT');
    assert.ok(store.value('next:x',0)>=now+180_000);
    await collector.collect([rule],now+60_000,signal,commit);
    assert.equal(requests.length,2);
    assert.equal(await collector.collect([rule],now+240_000,signal,commit),true);
    assert.equal(requests[0].searchParams.get('end_time'),requests[2].searchParams.get('end_time'));
    assert.equal(requests[2].searchParams.get('next_token'),'next');
    assert.equal(store.count('SELECT count(*) n FROM posts'),2);
  } finally {store.close();}
});

test('terminal denial, bad OAuth state, and capability cleanup',async()=>{
  const {store,rule,commit}=setup();
  let removed=false;
  store.set('preferences',{...defaults,consoleBudgetConfirmed:true,dailyRequests:10,dailyResources:200});
  store.run("UPDATE data_sources SET vault_ref='bearer' WHERE id='x'");
  const collector=new XApi(store,{...vault,remove:async()=>{removed=true;}},async()=>json({},403));
  try {
    assert.equal(await collector.collect([rule],now,new AbortController().signal,commit),false);
    assert.equal(store.active.error_code,'ACCESS_DENIED');
    assert.equal(store.value('next:x',0),Number.MAX_SAFE_INTEGER);
    await assert.rejects(()=>collector.callback('/api/v1/oauth/callback?state=wrong&code=fake','http://127.0.0.1:43123'),/expired or was declined/);
    await collector.disconnect();
    assert.ok(removed);
    assert.equal(store.active.id,'mock');
    assert.equal(store.sources.find(s=>s.id==='x')?.vault_ref,null);
  } finally {store.close();}
});

test('OAuth consent uses PKCE and stores only optional refresh credentials in the vault',async()=>{
  const {store}=setup();
  const memory=new Map<string,string>();
  const calls:string[]=[];
  const transport:typeof fetch=async(input,init)=>{
    const url=new URL(String(input));
    calls.push(url.pathname);
    if(url.pathname==='/2/oauth2/token'){
      assert.equal(init?.method,'POST');
      const body=new URLSearchParams(String(init?.body));
      assert.ok(body.has('code_verifier'));
      return json({access_token:'fixture-access',refresh_token:'fixture-refresh',scope:'tweet.read users.read follows.read like.read offline.access'});
    }
    if(url.pathname==='/2/users/me')return json({data:{id:'42'}});
    if(url.pathname==='/2/users/42/following')return json({data:[{id:'123'}]});
    if(url.pathname==='/2/users/42/liked_tweets')return json({data:[{id:'9',author_id:'321'}]});
    throw new Error('Unexpected fixture URL');
  };
  store.set('preferences',{...defaults,consoleBudgetConfirmed:true,dailyRequests:10,dailyResources:200});
  const client=new XApi(store,{get:async key=>memory.get(key)??null,set:async(key,value)=>{memory.set(key,value);},remove:async key=>{memory.delete(key);}},transport);
  try {
    const origin='http://127.0.0.1:12345';
    const {url}=await client.authorize({clientId:'fixture-app',following:true,likes:true,refresh:true},origin);
    const consent=new URL(url);
    assert.equal(consent.searchParams.get('code_challenge_method'),'S256');
    assert.equal(consent.searchParams.get('redirect_uri'),origin+'/api/v1/oauth/callback');
    await client.callback('/api/v1/oauth/callback?'+new URLSearchParams({code:'fixture-code',state:consent.searchParams.get('state')!}),origin);
    assert.equal(store.active.account_id,'42');
    assert.equal(store.count("SELECT count(*) n FROM account_relationships WHERE value=1"),2);
    assert.equal(store.value<{followingComplete:boolean}>('x:signals',{followingComplete:false}).followingComplete,true);
    assert.equal(memory.get('oauth-refresh'),'fixture-refresh');
    assert.equal(calls.length,4);
    assert.equal(store.count("SELECT count(*) n FROM settings WHERE value_json LIKE '%fixture-refresh%'"),0);
  } finally {store.close();}
});
