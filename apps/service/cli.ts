import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {existsSync,mkdirSync,openSync,closeSync,readFileSync,renameSync,statSync,unlinkSync,writeFileSync} from 'node:fs';
import {createServer} from 'node:net';
import {homedir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {ApiError,createApi} from './api';
import {Store,hash} from './storage';
import {Monitor} from './monitor';
import {OSVault,XApi} from './x-api';
import {WebsiteSession} from './website-session';
import {HostedClient} from './hosted-client';
import {desktopBridge} from './desktop-ipc';

function profileHome() {
  if (process.env.MONITOR_PROFILE) return resolve(process.env.MONITOR_PROFILE);
  if (process.platform==='win32') return join(process.env.LOCALAPPDATA??join(homedir(),'AppData','Local'),'X Smart Monitor');
  if (process.platform==='darwin') return join(homedir(),'Library','Application Support','X Smart Monitor');
  return join(process.env.XDG_DATA_HOME??join(homedir(),'.local','share'),'x-smart-monitor');
}
const profile=profileHome(),runtime=join(profile,'runtime.json');
type Runtime={origin:string;token:string;pid:number};
const random=()=>randomBytes(32).toString('base64url');
function ensureProfile() {
  mkdirSync(profile,{recursive:true,mode:0o700});
  if (process.platform!=='win32' && (statSync(profile).mode&0o077)!==0) throw new Error('The profile directory must allow access only to its owner (mode 0700).');
}
function readRuntime():Runtime|null {
  try {
    const value=JSON.parse(readFileSync(runtime,'utf8')) as Runtime;
    return /^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(value.origin)&&/^[\w-]{43}$/.test(value.token)?value:null;
  } catch {return null;}
}
async function control<T>(path:string,method='GET',body?:unknown,timeout=10_000):Promise<T> {
  const info=readRuntime();
  if (!info) throw new Error('The local monitor is stopped.');
  const response=await fetch(info.origin+'/api/control/'+path,{
    method,headers:{'x-monitor-control':info.token,...(body===undefined?{}:{'Content-Type':'application/json'})},
    body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(timeout),
  });
  const result=await response.json();
  if (!response.ok) throw new ApiError(response.status,result.error?.code??'REQUEST_FAILED',result.error?.message??'Local control request failed.');
  return result as T;
}
async function alive() {try {await control('status');return true;} catch {return false;}}
function openBrowser(url:string) {
  if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(url) && !/^https:\/\/x\.com\/i\/web\/status\/\d+$/.test(url)) return;
  let child;
  if (process.platform==='win32') {
    const literal=Buffer.from(`Start-Process -FilePath '${url.replaceAll("'", "''")}'`,'utf16le').toString('base64');
    child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',literal],{stdio:'ignore',windowsHide:true});
  } else child=spawn(process.platform==='darwin'?'open':'xdg-open',[url],{stdio:'ignore'});
  child.on('error',()=>process.stderr.write('Could not open the system browser.\n'));
  child.unref();
}
async function listenLock() {
  const lock=createServer(socket=>socket.destroy());
  const port=28000+parseInt(hash(process.platform==='win32'?profile.toLowerCase():profile).slice(0,6),16)%22000;
  await new Promise<void>((resolve,reject)=>{
    lock.once('error',reject);
    lock.listen({port,host:'127.0.0.1',exclusive:true},resolve);
  });
  return lock;
}
async function serve() {
  ensureProfile();
  if (process.platform!=='win32') process.umask(0o077);
  const lock=await listenLock().catch(()=>{throw new Error('The profile is already active or its instance lock port is unavailable.');});
  let store:Store;
  try {store=new Store(join(profile,'monitor.sqlite'));}
  catch(error){lock.close();throw error;}
  let shutting=false;
  const token=random();
  const desktop=desktopBridge();
  const collectionChanged=()=>{
    monitor.invalidate();
    monitor.signal('source.changed','overview.changed','posts.changed');
  };
  const x:XApi=new XApi(store,new OSVault(profile),fetch,collectionChanged);
  const localAccount:XApi=new XApi(store,new OSVault(profile+':local-account'),fetch,collectionChanged,'session');
  const website=new WebsiteSession(store,new OSVault(profile+':website'));
  const hosted:HostedClient=new HostedClient(store,new OSVault(profile+':hosted'),undefined,()=>{
    monitor.wake();
    monitor.signal('source.changed');
  });
  const monitor:Monitor=new Monitor(store,Date.now,desktop?.notify,(source,id,url)=>{
    if(desktop)desktop.send({type:'activate',source,id,url});
    else if(url) openBrowser(url);
    else void control<{url:string}>('bootstrap','POST',{post:id,source}).then(result=>openBrowser(result.url)).catch(()=>{});
  },x,localAccount,hosted);
  const file=fileURLToPath(import.meta.url);
  const root=process.env.MONITOR_WEB_ROOT??resolve(dirname(file),file.endsWith('.ts')?'../../apps/web/out':'../apps/web/out');
  const stop=()=>{
    if (shutting) return;
    shutting=true;
    void (async()=>{
      await monitor.stop();
      await service.api.close();
      store.close();
      if (readRuntime()?.token===token) unlinkSync(runtime);
      lock.close();
      if(process.connected)process.disconnect?.();
    })().catch(()=>{process.exitCode=1;lock.close();});
  };
  const erase=async()=>{
    monitor.pause(true);
    await monitor.stop();
    store.set('erase:pending',true);
    try {
      await x.disconnect();
      await localAccount.disconnect();
      await website.disconnect();
      await hosted.disconnect();
    }
    catch(error) {monitor.start();throw error;}
    store.db.pragma('secure_delete = ON');
    store.db.transaction(()=>{
      for (const table of ['notifications','monitoring_jobs','scores','posts','watchlists','author_preferences','authors','account_relationships','usage_buckets','notification_limits','settings']) store.db.exec('DELETE FROM '+table);
      store.run("UPDATE data_sources SET active=0,configured=0,status='Credential required',account_id=NULL,vault_ref=NULL,error_code=NULL,last_success_at=NULL,gap=NULL WHERE id='x'");
      store.run("UPDATE data_sources SET active=0,configured=0,status='Disconnected',account_id=NULL,vault_ref=NULL,error_code=NULL,last_success_at=NULL,gap=NULL WHERE id IN ('session','hosted')");
      store.run("UPDATE data_sources SET active=1,configured=1,status='Ready',error_code=NULL,last_success_at=NULL,gap=NULL WHERE id='mock'");
    })();
    store.db.exec('VACUUM');
    store.db.pragma('wal_checkpoint(TRUNCATE)');
    monitor.start();
  };
  const service=createApi(monitor,{profile,webRoot:root,controlToken:token,stop,erase,official:x,localAccount,website,hosted,
    credential:value=>{monitor.invalidate();return x.credential(value);},
    disconnect:()=>{monitor.invalidate();return x.disconnect();},authorize:(input,origin)=>x.authorize(input,origin),
    clearSignals:()=>{monitor.invalidate();return x.clearSignals();},
    callback:(url,origin)=>x.callback(url,origin),check:()=>x.check(),
  });
  const fixed=process.env.MONITOR_PORT;
  if (fixed&&!/^\d{1,5}$/.test(fixed)) throw new ApiError(400,'INVALID_PORT','MONITOR_PORT must be an available loopback port.');
  const origin=await service.api.listen({host:'127.0.0.1',port:fixed?Number(fixed):0});
  service.setOrigin(origin);
  const next=runtime+'.'+process.pid;
  writeFileSync(next,JSON.stringify({origin,token,pid:process.pid}),{mode:0o600});
  renameSync(next,runtime);
  process.on('SIGINT',stop);
  process.on('SIGTERM',stop);
  process.on('disconnect',stop);
  desktop?.onShutdown(stop);
  if(store.value('erase:pending',false)) await erase().catch(()=>{});
  else if(store.sources.some(s=>s.id==='x'&&!s.configured&&s.vault_ref)) await x.disconnect().catch(()=>{});
  else if(store.value('x:oauth:remove',false))await x.clearSignals().catch(()=>{});
  if(store.sources.some(s=>s.id==='session'&&!s.configured&&s.vault_ref)) await localAccount.disconnect().catch(()=>{});
  if(store.sources.some(s=>s.id==='hosted'&&!s.configured&&s.vault_ref)) await hosted.disconnect().catch(()=>{});
  monitor.start();
  desktop?.send({type:'ready'});
  console.log('Smart Monitor is ready.');
}
async function start() {
  if (await alive()) return;
  ensureProfile();
  const log=join(profile,'service.log');
  if(existsSync(log)&&statSync(log).size>1_000_000) renameSync(log,log+'.1');
  const fd=openSync(log,'a',0o600);
  const child=spawn(process.execPath,[...process.execArgv,process.argv[1],'serve'],{
    detached:true,windowsHide:true,stdio:['ignore',fd,fd],
  });
  closeSync(fd);
  let failure:Error|undefined;
  child.once('error',error=>{failure=error;});
  child.unref();
  for(let count=0;count<50;count++) {
    if(await alive())return;
    if(failure)throw failure;
    await delay(150);
  }
  throw new Error(`The monitor did not become ready. Review ${log}.`);
}
async function hiddenInput(prompt='App-only X bearer: '):Promise<string> {
  if (!process.stdin.isTTY) throw new Error('Enter the credential from an interactive terminal.');
  process.stderr.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve,reject)=>{
    let value='';
    const finish=(cancelled:boolean)=>{
      process.stdin.setRawMode(false);
      process.stdin.off('data',read);
      process.stdin.pause();
      process.stderr.write('\n');
      if(cancelled)reject(new Error('Credential entry cancelled.'));
      else resolve(value.trim());
    };
    const read=(input:Buffer)=>{
      for(const character of input.toString()) {
        if(character==='\u0003')return finish(true);
        if(character==='\r'||character==='\n')return finish(false);
        if(character==='\b'||character==='\x7f')value=value.slice(0,-1);
        else if(character>=' '&&value.length<4096)value+=character;
      }
    };
    process.stdin.on('data',read);
  });
}
async function main() {
  const [, ,command,option]=process.argv;
  if(command==='serve'||(command==='start'&&option==='--foreground')) {await serve();return;}
  if(command==='start') {await start();console.log('Smart Monitor is running.');return;}
  if(command==='open') {
    await start();
    const {url}=await control<{url:string}>('bootstrap','POST',{});
    if(option==='--print') console.log(url);
    else openBrowser(url);
    return;
  }
  if(command==='credentials'&&(option==='set'||option==='remove')) {
    await start();
    const value=option==='set'?await hiddenInput():null;
    await control('credentials','POST',{value});
    console.log(option==='set'?'X credential stored in the OS vault.':'X credential removed.');
    return;
  }
  if(command==='hosted-credential'&&option==='set'){
    await start();
    await control('hosted-credential','POST',{value:await hiddenInput('Hosted client token: ')});
    console.log('Hosted credential stored in the OS vault.');
    return;
  }
  if(command==='verify-x'||command==='verify-oauth'){
    const cap=process.argv[4]?.match(/^--cap-cents=(\d{1,3})$/);
    if(option!=='--confirm-paid'||!cap||+cap[1]<1||+cap[1]>100){
      console.log('NOT TESTED — EXPLICIT PAID OPT-IN AND A CAP OF 1–100 US CENTS REQUIRED');
      return;
    }
    if(!await alive()){
      console.log('NOT TESTED — START THE LOCAL SERVICE WITH A CONFIGURED CREDENTIAL');
      return;
    }
    try{
      console.log(JSON.stringify(await control('verify-x','POST',{source:command==='verify-x'?'x':'session',capCents:+cap[1],confirm:true},25_000),null,2));
    }catch(error){
      if(error instanceof ApiError&&error.code==='CREDENTIAL_REQUIRED'){
        console.log('NOT TESTED — CREDENTIALS REQUIRED');
        return;
      }
      throw error;
    }
    return;
  }
  if(command==='purge-x'&&/^\d{1,25}$/.test(option??'')&&process.argv[4]==='--confirm'){
    await control('purge-x','POST',{id:option});
    console.log('X post removed from this profile.');
    return;
  }
  if(command==='verify-hosted'){
    if(option!=='--confirm-vm'){console.log('NOT TESTED — EXPLICIT VM OPT-IN REQUIRED');return;}
    console.log(JSON.stringify(await control('verify-hosted','POST',{confirm:true},18_000),null,2));
    return;
  }
  if(command==='status') {console.log(JSON.stringify(await control('status'),null,2));return;}
  if(command==='stop') {if(await alive())await control('stop','POST');return;}
  if(command==='pause'||command==='resume') {await control('pause','POST',{paused:command==='pause'});return;}
  console.log('Usage: monitor start [--foreground] | open | status | pause | resume | stop | credentials set/remove | hosted-credential set | verify-x or verify-oauth --confirm-paid --cap-cents=N | verify-hosted --confirm-vm | purge-x POST_ID --confirm');
}

void main().catch(error=>{
  const message=error instanceof Error?error.message:'Unknown error.';
  console.error(`Smart Monitor: ${message.split('\n')[0]}`);
  process.exitCode=1;
  if(process.argv[2]==='serve'||process.argv.includes('--foreground')) process.exit(1);
});
