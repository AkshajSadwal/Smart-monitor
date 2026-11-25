import {mkdirSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {z} from 'zod';
import {deliverySchema} from '../../../packages/collection-core/hosted';
import {xPostId} from '../../../packages/collection-core/collector';
import {HostedStore,createHostedService} from './service';

const value=(name:string,fallback:number,min:number,max:number)=>z.coerce.number().int().min(min).max(max).parse(process.env[name]??fallback);

async function main(){
  process.umask(0o077);
  const [command='serve',action,argument]=process.argv.slice(2);
  const mode=deliverySchema.parse(process.env.HOSTED_MODE??'disabled');
  if(command==='serve'&&mode!=='disabled'&&mode!=='simulated'){
    console.error('Live hosted collection is unavailable. An authorized session provider and redistribution permission are required.');
    process.exitCode=1;
    return;
  }
  const path=resolve(process.env.HOSTED_DB??'.local/hosted.sqlite');
  mkdirSync(dirname(path),{recursive:true,mode:0o700});
  const store=new HostedStore(path);
  if(command!=='serve'){
    try {
      if(command==='client'&&action==='issue'){
        console.log(JSON.stringify(store.issue(argument??'',Date.now(),
          value('HOSTED_CLIENT_LIMIT',500,1,5000),value('HOSTED_TOKEN_TTL_HOURS',720,1,8760)*3_600_000)));
      }else if(command==='client'&&action==='revoke'){
        store.revoke(z.uuid().parse(argument));
      }else if(command==='content'&&action==='purge'){
        store.purgePost(xPostId.parse(argument));
        console.log('Post removed from hosted replay.');
      }else if(command==='cleanup-retired-credentials'&&action==='--confirm'){
        store.removeRetiredCredentials();
        console.log('Retired operator credentials removed from the hosted database.');
      }else throw new Error('Invalid operator command');
    } finally {store.db.close();}
    return;
  }
  const service=createHostedService(store,{
    mode,intervalMs:value('HOSTED_INTERVAL_SECONDS',300,30,3600)*1000,
    retainMs:value('HOSTED_RETENTION_HOURS',24,1,168)*3_600_000,topicLimit:value('HOSTED_TOPIC_LIMIT',200,1,1000),
  });
  await service.app.listen({host:process.env.HOSTED_BIND??'127.0.0.1',port:value('HOSTED_PORT',8787,1,65535)});
  service.start();
  console.log(`Hosted collector listening in ${mode} mode.`);
  let stopping=false;
  const stop=()=>{
    if(stopping)return;
    stopping=true;
    void service.close().then(()=>store.db.close()).catch(()=>{process.exitCode=1;});
  };
  process.once('SIGINT',stop);
  process.once('SIGTERM',stop);
}
void main().catch(()=>{console.error('Hosted collector failed. Check its configuration, database permissions, and listen port.');process.exitCode=1;});
