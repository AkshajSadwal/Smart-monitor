import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {resolve} from 'node:path';
import {performance} from 'node:perf_hooks';
import test from 'node:test';
import {createHostedService,HostedStore} from '../services/hosted-collector/src/service';
import {lines} from '../packages/collection-core/http';
import {hostedEvent} from '../packages/collection-core/hosted';
import {Monitor} from '../apps/service/monitor';
import {Store} from '../apps/service/storage';
import {watchlist} from '../packages/contracts/index';

test('real SSE clients share OpenAI and isolate NVIDIA/Microsoft through restart, expiry, and revocation',async t=>{
  mkdirSync(resolve('.local'),{recursive:true});
  const folder=mkdtempSync(resolve('.local','hosted-multi-'));
  const database=resolve(folder,'hosted.sqlite');
  const local=new Store(':memory:');
  let now=Date.now(),store=new HostedStore(database);
  const create=()=>createHostedService(store,{mode:'simulated',intervalMs:60_000,retainMs:90_000,clock:()=>now});
  let server=create();
  let origin=await server.app.listen({host:'127.0.0.1',port:0});
  const a=store.issue('Fixture A',now),b=store.issue('Fixture B',now,500,175_000),dormant=store.issue('Dormant',now);
  const headers=(token:string)=>({Authorization:'Bearer '+token});
  const subscribe=(token:string,topics:string[])=>fetch(origin+'/v1/subscriptions',{method:'PUT',
    headers:{...headers(token),'content-type':'application/json'},body:JSON.stringify({topics}),signal:AbortSignal.timeout(5000)});
  const read=async(token:string,after:number,count:number)=>{
    const abort=new AbortController();
    const frames:{id:number;event:ReturnType<typeof hostedEvent.parse>}[]=[];
    let id=0,gap=false;
    try{
      const result=await fetch(origin+'/v1/events',{headers:{...headers(token),'Last-Event-ID':String(after)},signal:AbortSignal.any([abort.signal,AbortSignal.timeout(5000)])});
      assert.equal(result.status,200);
      for await(const line of lines(result.body!)){
        if(line==='event: gap')gap=true;
        if(line.startsWith('id: '))id=Number(line.slice(4));
        if(!line.startsWith('data: '))continue;
        const packet=hostedEvent.safeParse(JSON.parse(line.slice(6)));
        if(packet.success)frames.push({id,event:packet.data});
        if(frames.length===count)return {frames,gap};
      }
      throw new Error('SSE ended before all fixture frames arrived');
    }finally{abort.abort();}
  };
  try{
    assert.equal((await fetch(origin+'/v1/events',{signal:AbortSignal.timeout(3000)})).status,401);
    assert.equal((await subscribe(a.token,['OpenAI','NVIDIA'])).status,200);
    assert.equal((await subscribe(b.token,['OpenAI','Microsoft'])).status,200);
    assert.equal((await subscribe(dormant.token,['dormant'])).status,200);
    await server.tick();
    assert.equal((store.db.prepare("SELECT count(*) AS n FROM events WHERE topic='openai'").get() as {n:number}).n,1);
    const [firstA,firstB]=await Promise.all([read(a.token,0,2),read(b.token,0,2)]);
    const topics=(value:typeof firstA)=>value.frames.map(frame=>frame.event.topic).sort();
    assert.deepEqual(topics(firstA),['nvidia','openai']);
    assert.deepEqual(topics(firstB),['microsoft','openai']);
    assert.ok(firstA.frames.every(frame=>frame.event.resolution===undefined));
    const openai=(value:typeof firstA)=>value.frames.find(frame=>frame.event.topic==='openai')!;
    assert.equal(openai(firstA).id,openai(firstB).id);
    const list=local.saveList(watchlist.parse({name:'OpenAI',terms:[{direction:'include',kind:'word',text:'OpenAI'}],standard:45,immediate:50}),now);
    local.run("UPDATE data_sources SET active=0 WHERE id='mock'");
    local.run("UPDATE data_sources SET active=1,configured=1 WHERE id='hosted'");
    const monitor=new Monitor(local,()=>now);
    monitor.pause(false);
    for(const batch of [firstA,firstB]){
      monitor.ingest({...openai(batch).event.post,collector:'hosted'},[list],now,false,false);
      await monitor.tick();
    }
    assert.equal(local.count('SELECT count(*) n FROM notifications'),1);
    assert.equal(local.count('SELECT count(*) n FROM engagement_snapshots'),1);

    now+=60_000;
    await server.tick();
    const secondB=await read(b.token,firstB.frames.at(-1)!.id,2);
    assert.deepEqual(topics(secondB),['microsoft','openai']);
    await server.close();store.db.close();
    store=new HostedStore(database);
    server=create();
    origin=await server.app.listen({host:'127.0.0.1',port:0});
    const started=performance.now();
    const secondA=await read(a.token,firstA.frames.at(-1)!.id,2);
    t.diagnostic(`loopback SSE time to replay two retained events after reopen: ${Math.round(performance.now()-started)} ms`);
    assert.deepEqual(topics(secondA),['nvidia','openai']);
    assert.equal(openai(secondA).id,openai(secondB).id);
    assert.ok(secondA.frames[0].id>firstA.frames.at(-1)!.id);
    assert.ok(secondA.frames[1].id>secondA.frames[0].id);
    now+=120_000;
    await server.tick();
    const expired=await fetch(origin+'/v1/status',{headers:headers(b.token),signal:AbortSignal.timeout(3000)});
    assert.equal(expired.status,401);
    assert.equal((await expired.json()).code,'TOKEN_EXPIRED');
    assert.deepEqual(store.current(b.id),[]);
    const latestA=await read(a.token,firstA.frames[0].id,2);
    assert.equal(latestA.gap,true);
    store.revoke(a.id,now);
    assert.equal((await fetch(origin+'/v1/events',{headers:headers(a.token),signal:AbortSignal.timeout(3000)})).status,401);
    now+=2*3_600_000+1000;
    await server.tick();
    assert.deepEqual(store.current(dormant.id),[]);
    assert.equal((store.db.prepare('SELECT count(*) AS n FROM topics').get() as {n:number}).n,0);
  }finally{await server.close();store.db.close();local.close();rmSync(folder,{recursive:true,force:true,maxRetries:5});}
});
