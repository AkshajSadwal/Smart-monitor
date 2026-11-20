import {strict as assert} from 'node:assert';
import {execFileSync,spawn} from 'node:child_process';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {createServer} from 'node:net';
import {join,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {lines} from '../packages/collection-core/http';
import {hostedEvent} from '../packages/collection-core/hosted';

const local=resolve('.local');
mkdirSync(local,{recursive:true});
const root=mkdtempSync(join(local,'hosted-runtime-'));
const executable=resolve('dist/hosted.cjs');
const lock=createServer();
await new Promise<void>((resolve,reject)=>{lock.once('error',reject);lock.listen(0,'127.0.0.1',resolve);});
const address=lock.address();
if(!address||typeof address==='string')throw new Error('Expected a loopback port');
const port=address.port,origin='http://127.0.0.1:'+port;
await new Promise<void>(resolve=>lock.close(()=>resolve()));
const env={...process.env,HOSTED_DB:join(root,'fixture.sqlite'),HOSTED_MODE:'simulated',HOSTED_BIND:'127.0.0.1',HOSTED_PORT:String(port)};
const {token}=JSON.parse(execFileSync(process.execPath,[executable,'client','issue','Runtime fixture'],{env,encoding:'utf8'})) as {token:string};
const server=spawn(process.execPath,[executable,'serve'],{env,stdio:'ignore',windowsHide:true});
const closed=new Promise<void>(resolve=>server.once('close',()=>resolve()));
const signal=AbortSignal.timeout(14_000);
try{
  let health:Response|undefined;
  while(!signal.aborted&&server.exitCode===null){
    try{health=await fetch(origin+'/health',{signal});break;}catch{await delay(100);}
  }
  assert.equal(health?.status,200);
  const headers={Authorization:'Bearer '+token,'Content-Type':'application/json'};
  const subscription=await fetch(origin+'/v1/subscriptions',{method:'PUT',headers,body:JSON.stringify({topics:['sqlite']}),signal});
  assert.equal(subscription.status,200);
  const streamed=await fetch(origin+'/v1/events?after=0',{headers,signal});
  let published=false;
  for await(const line of lines(streamed.body!)){
    if(!line.startsWith('data: '))continue;
    const result=hostedEvent.safeParse(JSON.parse(line.slice(6)));
    if(!result.success)continue;
    assert.equal(result.data.topic,'sqlite');
    assert.equal(result.data.delivery,'simulated');
    published=true;break;
  }
  assert.equal(published,true);
  console.log('Bundled hosted runtime passed health, client issuance, subscription and simulated SSE checks.');
}finally{
  server.kill();
  await closed;
  rmSync(root,{recursive:true,force:true,maxRetries:4,retryDelay:150});
}
