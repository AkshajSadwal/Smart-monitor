import {performance} from 'node:perf_hooks';
import {cpus,platform,arch,release,totalmem} from 'node:os';
import {Store} from '../apps/service/storage';
import {Monitor} from '../apps/service/monitor';
import {createApi} from '../apps/service/api';
import {defaults,watchlist} from '../packages/contracts/index';
import {simulatedPage} from '../fixtures/simulated';
import {scorePost} from '../apps/service/rank';

const store = new Store(':memory:');
const now=Date.now();
const monitor=new Monitor(store,()=>now,async()=> 'submitted');
const started=performance.now(),cpu=process.cpuUsage();
const origin='http://127.0.0.1:44000';
const host='127.0.0.1:44000';
const service=createApi(monitor,{profile:'benchmark',controlToken:'benchmark-test',stop:()=>{},erase:async()=>{}});
service.setOrigin(origin);
try {
  for(let i=0;i<20;i++) store.saveList(watchlist.parse({name:'Topic '+i,terms:[{direction:'include',kind:'word',text:'SQLite'}]}),now);
  const lists=store.lists, example=simulatedPage(0,now).posts[0];
  const rankStarted=performance.now();
  for(let i=0;i<20_000;i++)scorePost(example,lists[i%lists.length],defaults);
  const rankMs=performance.now()-rankStarted;
  const ingestStarted=performance.now();
  store.db.transaction(()=>{
    for(let i=0;i<10000;i++){
      const id='perf-'+i;
      monitor.ingest({...example,id,canonicalId:id,observation:id,text:`SQLite performance record ${i}`},lists,now,false,true);
    }
  })();
  const ingestMs=performance.now()-ingestStarted;
  const query=store.db.prepare('SELECT post_id,score FROM scores WHERE list_id=? ORDER BY score DESC LIMIT 30');
  const queryStarted=performance.now();
  for(let i=0;i<1000;i++)query.all(lists[i%lists.length].id);
  const sqliteMeanMs=(performance.now()-queryStarted)/1000;
  const bootstrap=await service.api.inject({method:'POST',url:'/api/control/bootstrap',headers:{host,'x-monitor-control':'benchmark-test'},payload:{}});
  const nonce=new URL(bootstrap.json().url).hash.slice(6);
  const session=await service.api.inject({method:'POST',url:'/api/v1/session',headers:{host,origin},payload:{nonce}});
  const cookie=String(session.headers['set-cookie']).split(';')[0];
  const values=[];
  for(let i=0;i<30;i++){
    const t=performance.now();
    const response=await service.api.inject({url:'/api/v1/posts?sort=recent&limit=30',headers:{host,cookie}});
    if(response.statusCode!==200||response.json().items.length!==30)throw new Error('The feed benchmark did not return a full page.');
    values.push(performance.now()-t);
  }
  values.sort((a,b)=>a-b);
  const notificationList=store.saveList(watchlist.parse({name:'Benchmark alert',standard:40,immediate:50,cooldownSeconds:0,
    terms:[{direction:'include',kind:'word',text:'benchmarkalert'}]}),now);
  store.set('preferences',{...defaults,dailyCap:100,nativeNotifications:false});
  monitor.pause(false);
  store.set('next:mock',now+60_000);
  for(let i=0;i<25;i++){
    const id='notification-bench-'+i;
    monitor.ingest({...example,id,canonicalId:id,observation:id,text:'benchmarkalert '+i},[notificationList],now,false,false);
  }
  const notificationStarted=performance.now();
  await monitor.tick();
  const notificationMs=performance.now()-notificationStarted;
  const delivered=store.count('SELECT count(*) n FROM notifications');
  if(delivered!==25)throw new Error('Notification evaluation benchmark did not process all 25 jobs.');
  const elapsed=performance.now()-started,work=process.cpuUsage(cpu);
  console.log(JSON.stringify({
    environment:{node:process.version,os:platform(),release:release(),arch:arch(),cpu:cpus()[0]?.model,logicalCpus:cpus().length,ramMiB:Math.round(totalmem()/1048576),database:'in-memory SQLite'},
    posts:10000,watchlists:20,feedQueries:30,feedP95Ms:Math.round(values[Math.ceil(values.length*.95)-1]),
    rankingsPerSecond:Math.round(20_000_000/rankMs),ingestedPostsPerSecond:Math.round(10_000_000/ingestMs),sqliteQueryMeanMs:Number(sqliteMeanMs.toFixed(3)),
    notificationBatchMs:Number(notificationMs.toFixed(2)),notificationJobs:delivered,peakRssMiB:Math.round(process.resourceUsage().maxRSS/1024),
    cpuPercentOfOneCore:Math.round((work.user+work.system)/(elapsed*10)),
  }));
} finally {await service.api.close();store.close();}
