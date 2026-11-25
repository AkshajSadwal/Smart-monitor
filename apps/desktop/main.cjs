const {app,BrowserWindow,Menu,Notification,Tray,dialog,nativeImage,shell}=require('electron');
const {fork}=require('node:child_process');
const {createRequire}=require('node:module');
const {appendFileSync,existsSync,mkdirSync,readFileSync,statSync,writeFileSync,unlinkSync}=require('node:fs');
const {join,resolve,dirname}=require('node:path');
const {browserAccount}=require('./account.cjs');

app.setAppUserModelId('local.smartmonitor.app');
const profile=process.env.MONITOR_PROFILE?resolve(process.env.MONITOR_PROFILE):join(
  process.platform==='win32'?process.env.LOCALAPPDATA||app.getPath('appData'):
  process.platform==='linux'?process.env.XDG_DATA_HOME||join(app.getPath('home'),'.local','share'):app.getPath('appData'),
  process.platform==='linux'?'x-smart-monitor':'X Smart Monitor');
const shellData=join(profile,'desktop');
mkdirSync(shellData,{recursive:true,mode:0o700});
app.setPath('userData',shellData);
const runtime=join(profile,'runtime.json');
const startupPath=join(process.env.XDG_CONFIG_HOME||join(app.getPath('home'),'.config'),'autostart','smart-monitor.desktop');
const servicePath=app.isPackaged?join(process.resourcesPath,'service','monitor.mjs'):resolve(__dirname,'../../dist/monitor.mjs');
const nodeBinary=app.isPackaged?join(process.resourcesPath,'runtime',process.platform==='win32'?'node.exe':'node'):process.env.npm_node_execpath;
const webRoot=app.isPackaged?join(process.resourcesPath,'web'):resolve(__dirname,'../web/out');
const notifications=new Map();
let worker,window,tray,stopping=false,retry,attempt=0,quitInProgress=false;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const icon=()=>nativeImage.createFromPath(join(__dirname,'tray.png'));
const allowX=url=>/^https:\/\/x\.com\/i\/web\/status\/\d{1,25}$/.test(url);
const account=browserAccount(join(shellData,'x-account-identity'),result=>{
  if(worker?.connected)worker.send({type:'browser-account-state',result});
});

async function control(route,method='GET',body){
  const {origin,token}=JSON.parse(readFileSync(runtime,'utf8'));
  if(!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(origin)||!/^[-_\w]{43}$/.test(token))throw new Error('Invalid service runtime.');
  const result=await fetch(origin+'/api/control/'+route,{
    method,headers:{'x-monitor-control':token,...(body===undefined?{}:{'Content-Type':'application/json'})},
    body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(2500),
  });
  if(!result.ok)throw new Error('The service rejected the request.');
  return result.json();
}
async function getStatus(){
  try{return await control('status');}catch{return null;}
}
function showNotice(message,child){
  const send=result=>{if(child.connected)child.send({type:'notification-result',id:message.id,result});};
  if(!Notification.isSupported()){send('unavailable');return;}
  if(notifications.size>=100){
    const oldest=notifications.keys().next().value;
    notifications.get(oldest)?.close();
    notifications.delete(oldest);
  }
  const notice=new Notification({title:message.title,body:message.message,icon:icon()});
  notifications.set(message.id,notice);
  notice.once('click',()=>{if(child.connected)child.send({type:'notification-click',id:message.id});notifications.delete(message.id);});
  notice.once('failed',()=>{send('unavailable');notifications.delete(message.id);});
  notice.once('show',()=>send('submitted'));
  notice.once('close',()=>notifications.delete(message.id));
  try{notice.show();}
  catch{notifications.delete(message.id);send('unavailable');}
}
async function ensureWorker(){
  if(stopping||worker||await getStatus())return;
  if(stopping||worker)return;
  if(!existsSync(servicePath)||!nodeBinary||!existsSync(nodeBinary))throw new Error('Build the service and use the packaged launcher or the desktop npm script.');
  const child=fork(servicePath,['serve'],{
    execPath:nodeBinary,execArgv:[],windowsHide:true,
    env:{...process.env,MONITOR_PROFILE:profile,MONITOR_WEB_ROOT:webRoot},
    stdio:['ignore','ignore','ignore','ipc'],
  });
  worker=child;
  child.on('error',report);
  child.on('message',message=>{
    if(message?.type==='ready'){
      setTimeout(()=>{if(worker===child)attempt=0;},30_000).unref();
      void refreshTray().catch(report);
    }
    if(message?.type==='notification'&&/^[\da-f-]{36}$/i.test(message.id)&&typeof message.title==='string'&&message.title.length<=128
      &&typeof message.message==='string'&&message.message.length<=500)showNotice(message,child);
    if(message?.type==='browser-account'&&/^[\da-f-]{36}$/i.test(message.id)&&
      ['open','check','confirm','disconnect'].includes(message.action)&&typeof message.remembered==='boolean'&&
      (message.action!=='open'||typeof message.remember==='boolean')){
      const reply=result=>{if(child.connected)child.send({type:'browser-account-result',id:message.id,result});};
      void account(message).then(reply,()=>reply(null));
    }
    if(message?.type==='collection-credentials'&&/^[\da-f-]{36}$/i.test(message.id)&&typeof message.remembered==='boolean'){
      const reply=result=>{if(child.connected)child.send({type:'browser-account-result',id:message.id,result});};
      void account.collectionCredentials(message.remembered).then(reply,()=>reply(null));
    }
    if(message?.type==='activate'){
      if(typeof message.url==='string'&&allowX(message.url))void shell.openExternal(message.url);
      else if(typeof message.id==='string'&&/^[\w-]{1,100}$/.test(message.id))void openWindow({post:message.id,source:message.source==='x'?'x':'mock'}).catch(report);
    }
  });
  child.once('exit',()=>{
    worker=undefined;
    if(!stopping)retry=setTimeout(()=>void ensureWorker().catch(report),Math.min(30_000,1000*2**Math.min(5,attempt++)));
    void refreshTray().catch(report);
  });
}
function report(error){
  const message=(error instanceof Error?error.message:'Local desktop operation failed.').replace(/#open=[\w-]+/g,'#open=[redacted]').slice(0,500);
  const log=join(shellData,'desktop.log');
  try{
    if(existsSync(log)&&statSync(log).size>256_000)writeFileSync(log,'');
    appendFileSync(log,`${new Date().toISOString()} ${message}\n`,{mode:0o600});
  }catch{
    // The error dialog still works when its diagnostics cannot be written.
  }
  if(process.env.MONITOR_DESKTOP_SMOKE==='1'){console.error(message);app.exit(1);}
  else dialog.showErrorBox('Smart Monitor',message);
}
async function openWindow(detail={}){
  await ensureWorker();
  for(let count=0;count<32;count++){
    if(await getStatus())break;
    await sleep(200);
  }
  const {url}=await control('bootstrap','POST',detail);
  const origin=new URL(url).origin;
  if(!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(origin))throw new Error('Invalid monitor origin.');
  if(window&&new URL(window.webContents.getURL()||url).origin!==origin)window.destroy();
  if(!window){
    window=new BrowserWindow({width:1240,height:850,minWidth:320,minHeight:500,show:false,
      backgroundColor:'#0d121b',title:'Smart Monitor',icon:icon(),
      webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,spellcheck:false}});
    window.on('closed',()=>{window=undefined;});
    window.webContents.session.setPermissionRequestHandler((_content,_permission,respond)=>respond(false));
    window.webContents.on('will-navigate',(event,target)=>{
      if(new URL(target).origin===origin)return;
      event.preventDefault();
    });
    window.webContents.on('will-redirect',(event,target)=>{
      if(new URL(target).origin!==origin)event.preventDefault();
    });
    window.webContents.setWindowOpenHandler(({url:target})=>{
      if(allowX(target))void shell.openExternal(target);
      return {action:'deny'};
    });
  }
  const opened=window;
  try {await opened.loadURL(url);}
  catch(error) {
    if(opened.isDestroyed())return;
    const current=new URL(opened.webContents.getURL()||url);
    if(!(error instanceof Error&&error.message.includes('ERR_ABORTED')&&current.origin===origin))throw error;
  }
  if(window===opened&&!opened.isDestroyed()){
    opened.show();
    opened.focus();
  }
}
function loginEnabled(){
  return process.platform==='linux'?existsSync(startupPath):app.getLoginItemSettings().openAtLogin;
}
function setLogin(enabled){
  if(process.platform!=='linux'){
    app.setLoginItemSettings({openAtLogin:enabled,name:'local.smartmonitor.app',args:['--background']});
    return;
  }
  if(!enabled){if(existsSync(startupPath))unlinkSync(startupPath);return;}
  const exec=process.execPath.replace(/[\\`"$]/g,'\\$&').replace(/%/g,'%%');
  mkdirSync(dirname(startupPath),{recursive:true,mode:0o700});
  writeFileSync(startupPath,`[Desktop Entry]\nType=Application\nName=Smart Monitor\nExec="${exec}" --background\nTerminal=false\n`,{mode:0o600});
}
async function stopWorker(){
  stopping=true;clearTimeout(retry);
  const child=worker;
  if(!child)return;
  const exited=new Promise(resolve=>child.once('exit',resolve));
  if(child.connected)child.send({type:'shutdown'});
  if(await Promise.race([exited.then(()=>false),sleep(7000).then(()=>true)]))child.kill();
}
const canUpdate=()=>app.isPackaged&&process.platform!=='linux'&&existsSync(join(process.resourcesPath,'app-update.yml'));
async function checkUpdates(){
  const {autoUpdater}=app.isPackaged?createRequire(servicePath)('electron-updater'):require('electron-updater');
  autoUpdater.autoDownload=false;
  const result=await autoUpdater.checkForUpdates();
  if(!result?.isUpdateAvailable){await dialog.showMessageBox({message:'Smart Monitor is up to date.'});return;}
  const answer=await dialog.showMessageBox({type:'question',message:`Smart Monitor ${result.updateInfo.version} is available.`,buttons:['Download update','Later'],defaultId:0,cancelId:1});
  if(answer.response!==0)return;
  await autoUpdater.downloadUpdate();
  const restart=await dialog.showMessageBox({type:'question',message:'Install the downloaded update?',buttons:['Install and restart','Later'],defaultId:0,cancelId:1});
  if(restart.response!==0)return;
  await stopWorker();
  autoUpdater.quitAndInstall();
}
async function refreshTray(){
  if(!tray||stopping)return;
  const status=await getStatus();
  if(!tray||stopping)return;
  tray.setContextMenu(Menu.buildFromTemplate([
    {label:status?`${{mock:'Simulated',session:'Local X Account'}[status.source]??'Collection'} · ${status.status}`:'Service starting',enabled:false},
    {label:'Open Smart Monitor',click:()=>void openWindow().catch(report)},
    {label:status?.paused?'Resume monitoring':'Pause monitoring',enabled:!!status,click:()=>void control('pause','POST',{paused:!status?.paused}).then(refreshTray).catch(report)},
    {label:'Launch at login',type:'checkbox',checked:app.isPackaged&&loginEnabled(),enabled:app.isPackaged,
      click:item=>{try{setLogin(item.checked);}catch(error){report(error);}void refreshTray().catch(report);}},
    ...(canUpdate()?[{label:'Check for updates',click:()=>void checkUpdates().catch(report)}]:[]),
    {type:'separator'},
    {label:'Quit Smart Monitor',click:()=>app.quit()},
  ]));
}
if(!app.requestSingleInstanceLock())app.quit();
else {
  app.on('second-instance',()=>void openWindow().catch(report));
  app.on('activate',()=>void openWindow().catch(report));
  app.on('window-all-closed',()=>{});
  app.on('before-quit',event=>{
    if(quitInProgress)return;
    event.preventDefault();quitInProgress=true;
    void stopWorker().finally(()=>app.quit());
  });
  void app.whenReady().then(async()=>{
    tray=new Tray(icon().resize({width:22,height:22}));
    tray.setToolTip('Smart Monitor');
    tray.on('double-click',()=>void openWindow().catch(report));
    tray.on('right-click',()=>void refreshTray().catch(report));
    await ensureWorker();
    await refreshTray();
    const launchedAtLogin=process.platform==='darwin'&&app.isPackaged&&app.getLoginItemSettings().wasOpenedAtLogin;
    if(!process.argv.includes('--background')&&!launchedAtLogin)await openWindow();
  }).catch(report);
}
