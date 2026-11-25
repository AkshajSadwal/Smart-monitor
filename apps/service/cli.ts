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
import {OSVault,removeRetiredCredentials} from './credential-store';
import {WebsiteSession} from './website-session';
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
  const website=new WebsiteSession(store,new OSVault(profile+':website'));
  // A previously configured driver must not leave an unsupported source running.
  if(website.state.status==='Unsupported'&&store.sources.some(row=>row.id==='session'&&(row.active||row.configured))){
    store.db.transaction(()=>{
      store.deactivate('session');
      store.run("UPDATE data_sources SET status='Unsupported',error_code=NULL WHERE id='session'");
    })();
  }
  const remembered=()=>store.value<{persistent:boolean}>('session:browser',{persistent:false}).persistent;
  const browserAccount=desktop?(action:Parameters<typeof desktop.account>[0])=>desktop.account(action,remembered()):undefined;
  const monitor:Monitor=new Monitor(store,Date.now,desktop?.notify,(source,id,url)=>{
    if(desktop)desktop.send({type:'activate',source,id,url});
    else if(url) openBrowser(url);
    else void control<{url:string}>('bootstrap','POST',{post:id,source}).then(result=>openBrowser(result.url)).catch(()=>{});
  },website);
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
      if(browserAccount)service.setBrowserAccount(await browserAccount({action:'disconnect'}));
      else if(remembered())throw new ApiError(409,'DESKTOP_REQUIRED','Open the desktop app to clear the saved X browser session.');
      await website.disconnect();
      await removeRetiredCredentials(profile,store);
    }
    catch(error) {monitor.start();throw error;}
    store.db.pragma('secure_delete = ON');
    store.db.transaction(()=>{
      for (const table of ['notifications','monitoring_jobs','scores','posts','watchlists','author_preferences','authors','account_relationships','usage_buckets','notification_limits','settings']) store.db.exec('DELETE FROM '+table);
      store.run("UPDATE data_sources SET active=0,configured=0,status='Retired',account_id=NULL,vault_ref=NULL,error_code=NULL,last_success_at=NULL,gap=NULL WHERE id='x'");
      store.run("UPDATE data_sources SET active=0,configured=0,status='Unsupported',account_id=NULL,vault_ref=NULL,error_code=NULL,last_success_at=NULL,gap=NULL WHERE id='session'");
      store.run("UPDATE data_sources SET active=1,configured=1,status='Ready',error_code=NULL,last_success_at=NULL,gap=NULL WHERE id='mock'");
    })();
    store.db.exec('VACUUM');
    store.db.pragma('wal_checkpoint(TRUNCATE)');
    monitor.start();
  };
  const service=createApi(monitor,{profile,webRoot:root,controlToken:token,stop,erase,browserAccount,website,
    cleanupRetiredCredentials:()=>removeRetiredCredentials(profile,store),
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
  desktop?.onBrowserAccount(service.setBrowserAccount);
  if(store.value('erase:pending',false)) await erase().catch(()=>{});
  if(browserAccount&&remembered()){
    void browserAccount({action:'check'}).then(service.setBrowserAccount,()=>{
      service.setBrowserAccount({status:'Temporarily unavailable',persistent:true});
    });
  }
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
  if(command==='cleanup-retired-credentials'&&option==='--confirm'){
    await start();
    await control('cleanup-retired-credentials','POST',{confirm:true});
    console.log('Retired collection credentials removed from the local OS vault.');
    return;
  }
  if(command==='purge-x'&&/^\d{1,25}$/.test(option??'')&&process.argv[4]==='--confirm'){
    await control('purge-x','POST',{id:option});
    console.log('X post removed from this profile.');
    return;
  }
  if(command==='status') {console.log(JSON.stringify(await control('status'),null,2));return;}
  if(command==='stop') {if(await alive())await control('stop','POST');return;}
  if(command==='pause'||command==='resume') {await control('pause','POST',{paused:command==='pause'});return;}
  console.log('Usage: monitor start [--foreground] | open | status | pause | resume | stop | cleanup-retired-credentials --confirm | purge-x POST_ID --confirm');
}

void main().catch(error=>{
  const message=error instanceof Error?error.message:'Unknown error.';
  console.error(`Smart Monitor: ${message.split('\n')[0]}`);
  process.exitCode=1;
  if(process.argv[2]==='serve'||process.argv.includes('--foreground')) process.exit(1);
});
