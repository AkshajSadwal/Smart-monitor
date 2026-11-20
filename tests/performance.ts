import {performance} from 'node:perf_hooks';
import {Store} from '../apps/service/storage';
import {Monitor} from '../apps/service/monitor';
import {createApi} from '../apps/service/api';
import {watchlist} from '../packages/contracts/index';
import {simulatedPage} from '../fixtures/simulated';

const store = new Store(':memory:');
const now=Date.now();
const monitor=new Monitor(store,()=>now,async()=> 'submitted');
const origin='http://127.0.0.1:44000';
const host='127.0.0.1:44000';
const service=createApi(monitor,{profile:'benchmark',controlToken:'benchmark-test',stop:()=>{},erase:async()=>{}});
service.setOrigin(origin);
try {
  for(let i=0;i<20;i++) store.saveList(watchlist.parse({name:'Topic '+i,terms:[{direction:'include',kind:'word',text:'SQLite'}]}),now);
  const lists=store.lists, example=simulatedPage(0,now).posts[0];
  store.db.transaction(()=>{
    for(let i=0;i<10000;i++){
      const id='perf-'+i;
      monitor.ingest({...example,id,canonicalId:id,observation:id,text:`SQLite performance record ${i}`},lists,now,false,true);
    }
  })();
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
  console.log(JSON.stringify({posts:10000,watchlists:20,queries:30,p95Ms:Math.round(values[Math.ceil(values.length*.95)-1])}));
} finally {await service.api.close();store.close();}
