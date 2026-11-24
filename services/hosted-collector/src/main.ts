import {readFileSync,mkdirSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {z} from 'zod';
import {deliverySchema} from '../../../packages/collection-core/hosted';
import {tweetId} from '../../../packages/collection-core/x-protocol';
import {HostedStore,createHostedService,identityName} from './service';
import {officialProvider} from './provider';

const value=(name:string,fallback:number,min:number,max:number)=>z.coerce.number().int().min(min).max(max).parse(process.env[name]??fallback);
const key=()=>{
  if(!process.env.HOSTED_MASTER_KEY_FILE)throw new Error('Set HOSTED_MASTER_KEY_FILE to an operator-controlled key file.');
  const encoded=readFileSync(process.env.HOSTED_MASTER_KEY_FILE,'utf8').trim();
  if(!/^[\da-f]{64}$/i.test(encoded))throw new Error('The master key file must contain 32 bytes encoded as hex.');
  return Buffer.from(encoded,'hex');
};
async function main(){
  process.umask(0o077);
  const path=resolve(process.env.HOSTED_DB??'.local/hosted.sqlite');
  mkdirSync(dirname(path),{recursive:true,mode:0o700});
  const store=new HostedStore(path);
  const [command='serve',action,argument]=process.argv.slice(2);
  if(command==='client'&&action==='issue'){
    console.log(JSON.stringify(store.issue(argument??'',Date.now(),value('HOSTED_CLIENT_LIMIT',500,1,5000),value('HOSTED_TOKEN_TTL_HOURS',720,1,8760)*3_600_000)));
    store.db.close();
    return;
  }
  if(command==='client'&&action==='revoke'){
    store.revoke(z.uuid().parse(argument));
    store.db.close();
    return;
  }
  if(command==='content'&&action==='purge'){
    store.purgePost(tweetId.parse(argument));
    store.db.close();
    console.log('Post removed from hosted replay.');
    return;
  }
  if(command==='credential'&&action==='status'){
    console.log(JSON.stringify(store.identityStatus(identityName.parse(argument??process.env.HOSTED_IDENTITY??'default'))));
    store.db.close();
    return;
  }
  if(command==='credential'&&action==='revoke'){
    store.revokeBearer(identityName.parse(argument??process.env.HOSTED_IDENTITY??'default'));
    store.db.close();
    console.log('Encrypted operator credential removed.');
    return;
  }
  if(command==='credential'&&action==='set'){
    const input:Buffer[]=[];
    let length=0;
    for await(const chunk of process.stdin){
      length+=chunk.length;
      if(length>4096)throw new Error('Credential too long.');
      input.push(Buffer.from(chunk));
    }
    store.setBearer(Buffer.concat(input).toString('utf8'),key(),Date.now(),identityName.parse(argument??process.env.HOSTED_IDENTITY??'default'));
    store.db.close();
    console.log('Encrypted operator credential saved.');
    return;
  }
  if(command!=='serve')throw new Error('Invalid operator command');
  const mode=deliverySchema.parse(process.env.HOSTED_MODE??'disabled');
  const live=mode==='ids'||mode==='metadata'||mode==='approved-public';
  const kind=z.enum(['disabled','simulation','official-api','website-session']).parse(process.env.HOSTED_PROVIDER||(live?'official-api':mode==='simulated'?'simulation':'disabled'));
  if(kind==='website-session'){
    console.error('Hosted authenticated website-session collection is unsupported. An authorized provider is required.');
    store.db.close();
    process.exitCode=1;
    return;
  }
  if(kind!==(live?'official-api':mode==='simulated'?'simulation':'disabled'))throw new Error('The hosted provider and delivery mode must agree');
  const identity=identityName.parse(process.env.HOSTED_IDENTITY??'default');
  let provider;
  if(live){
    const version=store.identityVersion(identity),bearer=store.getBearer(key(),identity);
    provider=officialProvider(identity,()=>bearer,fetch,()=>store.identityVersion(identity)===version);
  }
  const service=createHostedService(store,{
    mode,permission:process.env.HOSTED_PERMISSION_REFERENCE,provider,licenseConfirmed:process.env.HOSTED_LICENSE_CONFIRMED==='true',
    intervalMs:value('HOSTED_INTERVAL_SECONDS',300,30,3600)*1000,retainMs:value('HOSTED_RETENTION_HOURS',24,1,168)*3_600_000,
    topicLimit:value('HOSTED_TOPIC_LIMIT',200,1,1000),dailyRequests:value('HOSTED_DAILY_REQUESTS',0,0,50000),
    dailyResources:value('HOSTED_DAILY_RESOURCES',0,0,1_000_000),
    dailyUsdCents:value('HOSTED_DAILY_USD_CENTS',0,0,1_000_000),
    maxResourceUsdMicros:value('HOSTED_MAX_RESOURCE_USD_MICROS',0,0,10_000_000),
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
void main().catch(()=>{console.error('Hosted collector failed. Check its configuration, credentials, database permissions, and listen port.');process.exitCode=1;});
