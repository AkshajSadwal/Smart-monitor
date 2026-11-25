import {strict as assert} from 'node:assert';
import {spawnSync} from 'node:child_process';
import {existsSync,mkdirSync,mkdtempSync,rmdirSync,rmSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import test from 'node:test';
import {createApi} from '../apps/service/api';
import {Monitor} from '../apps/service/monitor';
import {Store} from '../apps/service/storage';
import {TwscrapeWorker} from '../apps/service/twscrape-worker';
import {watchlist,type SourceInfo} from '../packages/contracts/index';

const directory=resolve('apps/service/python');
const venv=resolve('.local/twscrape-venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
const python=process.env.MONITOR_PYTHON??(existsSync(venv)?venv:process.platform==='win32'?'python':'python3');
const skip=spawnSync(python,['--version'],{windowsHide:true}).status!==0?'Python is unavailable':false;
const now=Date.parse('2026-11-20T12:00:00Z');
const id='1951234567890123456';
const exportLine=JSON.stringify({
  id_str:id,user:{id_str:'1931234567890123456',username:'sqlite_news',displayname:'SQLite News'},
  rawContent:'SQLite release candidate',date:'2026-11-20 11:59:00+00:00',lang:'en',
  likeCount:11,replyCount:0,retweetCount:4,quoteCount:3,viewCount:null,
  media:{photos:[{url:'https://pbs.twimg.com/media/fixture.png',width:640,height:400,altText:'Fixture'}]},
});

test('Python protocol describes the installed package and rejects live commands', {skip},async()=>{
  const call=(input:object)=>{
    const result=spawnSync(python,['-I','-B','-X','utf8',join(directory,'twscrape_worker.py')],{
      input:JSON.stringify(input),encoding:'utf8',timeout:5000,windowsHide:true,
    });
    assert.equal(result.status,0);
    assert.equal(result.stderr,'');
    return JSON.parse(result.stdout);
  };
  const probe=call({action:'status'}).result;
  assert.ok(['Ready','Package missing','Package version mismatch'].includes(probe.status));
  if(probe.status==='Ready'){
    assert.equal(probe.version,'0.21.1');
    assert.deepEqual(probe.methods,['search','search_raw','tweet_details','following','user_by_login','user_by_id']);
    assert.equal(probe.cookieSetup,true);
    assert.deepEqual(probe.limits,{hour:60,day:600});
  }
  assert.deepEqual(call({action:'search'}),{error:'Invalid request'});
  const worker=new TwscrapeWorker(python,directory);
  const [post]=await worker.normalize(exportLine,now,AbortSignal.timeout(5000));
  assert.equal(post.id,id);
  assert.equal(post.authorId,'1931234567890123456');
  assert.equal(post.createdAt,now-60000);
  assert.deepEqual(post.metrics,{likes:11,reposts:4,replies:0,views:null,quotes:3});
  assert.equal(post.media?.[0].width,640);
  const [numeric]=await worker.normalize('{"id":1951234567890123456,"rawContent":"Example"}',now,AbortSignal.timeout(5000));
  assert.equal(numeric.id,id);
  assert.equal(numeric.metrics.quotes,null);
  await assert.rejects(worker.normalize(exportLine+'\n{bad',now,AbortSignal.timeout(5000)),/Invalid request/);
  await assert.rejects(worker.normalize(Array(51).fill(exportLine).join('\n'),now,AbortSignal.timeout(5000)),/Invalid request/);
});

test('cancellation terminates an in-flight worker and permits the following request', {skip},async()=>{
  mkdirSync('.local',{recursive:true});
  const fixture=mkdtempSync(resolve('.local/python-test-'));
  const script=join(fixture,'twscrape_worker.py');
  const marker=join(fixture,'started');
  const controller=new AbortController();
  try{
    writeFileSync(script,'from pathlib import Path\nfrom time import sleep\nPath(__file__).with_name("started").touch()\nsleep(60)\n');
    const worker=new TwscrapeWorker(python,fixture);
    const cancelled=assert.rejects(worker.normalize(exportLine,now,controller.signal),{name:'AbortError'});
    const end=Date.now()+3000;
    while(!existsSync(marker)&&Date.now()<end)await delay(15);
    assert.ok(existsSync(marker));
    controller.abort();
    await cancelled;
    writeFileSync(script,'import json\nimport sys\njson.load(sys.stdin)\nprint(\'{"result":{"status":"Package missing"}}\')\n');
    assert.deepEqual(await worker.status(),{status:'Package missing'});
  }finally{
    controller.abort();
    rmSync(script,{force:true});
    rmSync(marker,{force:true});
    rmdirSync(fixture);
  }
});

test('twscrape exports use the local watchlists, SQLite and manual notification policy', {skip},async()=>{
  const store=new Store(':memory:');
  const monitor=new Monitor(store,()=>now,async()=>assert.fail('Manual imports cannot send notifications'));
  store.saveList(watchlist.parse({name:'SQLite',terms:[{direction:'include',kind:'phrase',text:'SQLite release'}]}),now);
  const {api,setOrigin}=createApi(monitor,{profile:'test',controlToken:'worker-control',stop:()=>{},erase:async()=>{},
    twscrape:new TwscrapeWorker(python,directory)});
  const host='127.0.0.1:43123',origin='http://'+host;
  setOrigin(origin);
  try{
    const boot=await api.inject({method:'POST',url:'/api/control/bootstrap',headers:{host,'x-monitor-control':'worker-control'},payload:{}});
    const session=await api.inject({method:'POST',url:'/api/v1/session',headers:{host,origin},payload:{nonce:new URL(boot.json().url).hash.slice(6)}});
    const headers={host,origin,cookie:String(session.headers['set-cookie']).split(';')[0],'x-monitor-csrf':session.json().csrf};
    const upload=(twscrape:string,consent=true)=>api.inject({method:'POST',url:'/api/v1/posts/import',headers,payload:{twscrape,consent}});
    assert.equal((await upload(exportLine,false)).statusCode,400);
    assert.equal((await upload(`${exportLine}\n${exportLine}`)).json().error.code,'DUPLICATE_IMPORT');
    assert.equal(store.row('x',id),undefined);
    const imported=await upload(exportLine);
    assert.equal(imported.statusCode,201,imported.body);
    assert.deepEqual(imported.json(),{saved:1,skipped:0});
    await upload(exportLine);
    assert.equal(store.count('SELECT count(*) n FROM engagement_snapshots'),1);
    const post=(await api.inject({url:`/api/v1/posts/x/${id}`,headers})).json();
    assert.equal(post.originalUrl,`https://x.com/i/web/status/${id}`);
    assert.equal(post.displayName,'SQLite News');
    assert.equal(post.preview,'manual-import');
    assert.equal(post.metrics.quotes,3);
    assert.equal(post.media[0].url,'https://pbs.twimg.com/media/fixture.png');
    assert.equal(post.matches.length,1);
    assert.equal(store.count('SELECT count(*) n FROM notifications'),0);
    assert.equal(store.count('SELECT count(*) n FROM monitoring_jobs'),0);
    const source=(await api.inject({url:'/api/v1/sources',headers})).json<SourceInfo[]>().find(source=>source.id==='session');
    assert.equal(source?.status,'Unsupported');
    assert.equal(source?.configured,false);
    assert.equal(source?.postCount,0);
    assert.equal(source?.manualPosts,1);
    assert.deepEqual(source?.capabilities,[]);
    assert.ok(source?.pythonWorker);
  }finally{await api.close();store.close();}
});
