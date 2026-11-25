import assert from 'node:assert/strict';
import test from 'node:test';
import {createApi} from '../apps/service/api';
import {Monitor} from '../apps/service/monitor';
import {Store} from '../apps/service/storage';
import {defaults,unknownMetrics,watchlist,type Candidate} from '../packages/contracts/index';

const now=Date.now();
const rule=watchlist.parse({name:'OpenAI',terms:[{direction:'include',kind:'word',text:'OpenAI'}],standard:40,immediate:50});
const candidate:Candidate={namespace:'x',id:'12345678',canonicalId:'12345678',createdAt:now-60_000,observedAt:now,observation:'fixture',
  text:'OpenAI public fixture',authorId:'77',handle:'fixture_account',displayName:'Fixture',language:'en',kind:'original',metrics:{...unknownMetrics,likes:20}};
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
