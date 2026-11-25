const {BrowserWindow,safeStorage,session}=require('electron');
const {createHash}=require('node:crypto');
const {readFile,rename,rm,writeFile}=require('node:fs/promises');

const origin='https://x.com';
const signIn=origin+'/i/flow/login';
const savedPartition='persist:smart-monitor-x-account';
const temporaryPartition='smart-monitor-x-account';
const siteRoutes=new Set(['about','account','bookmarks','communities','compose','explore','home','i','jobs','login','logout',
  'messages','notifications','premium','search','settings','signup','tos','privacy']);

function xNavigation(target){
  try {
    const url=new URL(target);
    return !url.username&&!url.password&&[origin,'https://www.x.com','https://twitter.com','https://www.twitter.com'].includes(url.origin);
  }
  catch{return false;}
}
function allowedResource({url,resourceType}){
  if(resourceType==='mainFrame')return xNavigation(url);
  try {
    const {protocol,hostname,port}=new URL(url);
    return protocol==='https:'&&!port&&['x.com','twitter.com','twimg.com'].some(domain=>hostname===domain||hostname.endsWith('.'+domain));
  } catch {return false;}
}
async function canPersist(){
  const encryption=await safeStorage.isAsyncEncryptionAvailable();
  return encryption&&(process.platform!=='linux'||['kwallet','kwallet5','kwallet6','gnome_libsecret'].includes(safeStorage.getSelectedStorageBackend()));
}

function profileHandle(target){
  if(!xNavigation(target))return;
  const handle=new URL(target).pathname.match(/^\/([a-z0-9_]{1,15})\/?$/i)?.[1];
  if(handle&&!siteRoutes.has(handle.toLowerCase()))return handle;
}

const fingerprintOf=value=>createHash('sha256').update('smart-monitor-x-session-v1\0').update(value).digest('hex');

function browserAccount(identityPath,onStatus){
  let current,accountWindow,transientStatus,identity,seenCookie=false,updateTimer,expiryTimer;
  let operations=Promise.resolve();
  const prepared=new WeakSet();
  const result=(status,persistent)=>({status,persistent,...(status==='Connected'?{handle:identity.handle}:{})});
  function serialized(work){
    const next=operations.then(work);
    operations=next.catch(()=>{});
    return next;
  }
  function publishSoon(){
    clearTimeout(updateTimer);
    updateTimer=setTimeout(()=>void serialized(async()=>{
      if(!current)return;
      const state=await check(current.persistent).catch(()=>result('Temporarily unavailable',current.persistent));
      onStatus(state);
    }).catch(()=>{}),100);
    updateTimer.unref();
  }
  async function saveIdentity(saved){
    if(current.persistent){
      const sealed=await safeStorage.encryptStringAsync(JSON.stringify(saved));
      const pending=identityPath+'.tmp';
      try {
        await writeFile(pending,sealed,{mode:0o600});
        await rename(pending,identityPath);
      } finally {await rm(pending,{force:true});}
    }
    identity=saved;
  }
  async function clearIdentity(){
    identity=undefined;
    if(current?.persistent)await rm(identityPath,{force:true});
  }
  async function restoreIdentity(){
    const sealed=await readFile(identityPath).catch(error=>{
      if(error.code!=='ENOENT')throw error;
    });
    if(!sealed)return;
    const decrypted=await safeStorage.decryptStringAsync(sealed).catch(()=>null);
    if(!decrypted)return;
    let saved;
    try {saved=JSON.parse(decrypted.result);}catch{}
    if(typeof saved?.handle!=='string'||!/^[a-z0-9_]{1,15}$/i.test(saved.handle)||
      typeof saved.fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(saved.fingerprint)){
      await clearIdentity();
      return;
    }
    identity={handle:saved.handle,fingerprint:saved.fingerprint};
    if(decrypted.shouldReEncrypt)await saveIdentity(identity);
  }
  function prepare(persistent){
    const context=session.fromPartition(persistent?savedPartition:temporaryPartition,{cache:false});
    if(prepared.has(context))return {context,persistent};
    prepared.add(context);
    context.setPermissionRequestHandler((_content,_permission,respond)=>respond(false));
    context.setPermissionCheckHandler(()=>false);
    context.on('will-download',event=>event.preventDefault());
    context.webRequest.onBeforeRequest((details,done)=>done({cancel:!allowedResource(details)}));
    context.cookies.on('changed',(_event,cookie)=>{
      if(current?.context===context&&cookie.name==='auth_token')publishSoon();
    });
    return {context,persistent};
  }
  async function check(remembered,confirm=false){
    if(!current&&remembered){
      if(!await canPersist())return result('Temporarily unavailable',true);
      current=prepare(true);
    }
    if(!current)return result('Disconnected',false);
    if(current.persistent&&!current.identityLoaded){
      await restoreIdentity();
      current.identityLoaded=true;
    }
    seenCookie ||= !!identity;
    const confirmationUrl=confirm?accountWindow?.webContents.getURL():undefined;
    const cookies=await current.context.cookies.get({url:origin,name:'auth_token',secure:true});
    const currentUrl=accountWindow?.webContents.getURL();
    const path=currentUrl&&xNavigation(currentUrl)?new URL(currentUrl).pathname:'';
    const login=path==='/i/flow/login'||path==='/login';
    const challenge=path==='/account/access'||path.startsWith('/i/flow/verify');
    const now=Date.now();
    const valid=cookies.filter(cookie=>cookie.value&&(cookie.expirationDate===undefined||cookie.expirationDate*1000>now));
    const cookie=valid.length===1?valid[0]:undefined;
    clearTimeout(expiryTimer);
    if(cookie?.expirationDate!==undefined){
      expiryTimer=setTimeout(publishSoon,Math.min(2_147_483_647,Math.max(1,cookie.expirationDate*1000-now)));
      expiryTimer.unref();
    }
    const fingerprint=cookie?fingerprintOf(cookie.value):undefined;
    if(identity&&(identity.fingerprint!==fingerprint||login||transientStatus==='Session expired'))await clearIdentity();
    if(transientStatus)return result(transientStatus,current.persistent);
    if(challenge)return result('Verification required',current.persistent);
    if(login||!fingerprint)return result(seenCookie?'Session expired':'Authentication required',current.persistent);
    seenCookie=true;
    if(confirm){
      const contents=accountWindow?.webContents;
      const handle=contents&&!contents.isLoadingMainFrame()&&confirmationUrl===currentUrl?profileHandle(currentUrl):undefined;
      if(handle)await saveIdentity({handle,fingerprint});
    }
    return result(identity?'Connected':'Profile confirmation required',current.persistent);
  }
  async function open(remember,remembered){
    if(accountWindow){accountWindow.focus();return check(remembered);}
    const persistent=(remember||remembered)&&await canPersist();
    if(remembered&&!persistent)return result('Temporarily unavailable',true);
    if(current&&current.persistent!==persistent){
      await current.context.clearStorageData();
      await clearIdentity();
      seenCookie=false;
    }
    if(!current||current.persistent!==persistent)current=prepare(persistent);
    transientStatus=undefined;
    const state=await check(remembered);
    const window=new BrowserWindow({width:650,height:800,title:'X sign-in · Smart Monitor',
      autoHideMenuBar:true,webPreferences:{session:current.context,sandbox:true,contextIsolation:true,nodeIntegration:false,devTools:false}});
    accountWindow=window;
    const blockOrdinaryNavigation=event=>{if(!xNavigation(event.url))event.preventDefault();};
    window.webContents.on('will-navigate',blockOrdinaryNavigation);
    window.webContents.on('will-redirect',blockOrdinaryNavigation);
    window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    window.webContents.on('page-title-updated',event=>event.preventDefault());
    window.webContents.on('did-start-navigation',event=>{
      if(event.isMainFrame&&!event.isSameDocument)transientStatus=undefined;
    });
    window.webContents.on('did-navigate',(_event,_target,code)=>{
      transientStatus=code===429?'Rate limited':code===403?'Restricted':code===401?'Session expired':
        code>=500?'Temporarily unavailable':undefined;
      publishSoon();
    });
    window.webContents.on('did-navigate-in-page',(_event,_url,isMainFrame)=>{if(isMainFrame)publishSoon();});
    window.webContents.on('did-fail-load',(_event,code,_description,_target,isMainFrame)=>{
      if(isMainFrame&&code!==-3){
        transientStatus??='Temporarily unavailable';
        publishSoon();
      }
    });
    window.on('closed',()=>{accountWindow=undefined;});
    const hasSession=['Connected','Profile confirmation required'].includes(state.status);
    void window.loadURL(hasSession?origin+'/home':signIn).catch(()=>{
      if(accountWindow===window)transientStatus??='Temporarily unavailable';
    });
    return state;
  }

  async function disconnect(remembered){
    accountWindow?.destroy();
    const saved=remembered&&!current?.persistent?session.fromPartition(savedPartition):undefined;
    for(const context of new Set([current?.context,saved].filter(Boolean))){
      await context.clearStorageData();
      await context.clearCache();
      await context.cookies.flushStore();
    }
    await rm(identityPath,{force:true});
    clearTimeout(expiryTimer);
    current=undefined;
    transientStatus=undefined;
    seenCookie=false;
    identity=undefined;
    return result('Disconnected',false);
  }
  const controller=({action,remember,remembered})=>serialized(() =>
    action==='open'?open(remember,remembered):action==='disconnect'?disconnect(remembered):check(remembered,action==='confirm'));
  // This method is called only over the private Electron-to-service channel.
  controller.collectionCredentials=remembered=>serialized(async()=>{
    const state=await check(remembered);
    if(state.status!=='Connected')return {status:state.status};
    const now=Date.now();
    const read=async name=>(await current.context.cookies.get({url:origin,name,secure:true})).filter(cookie=>
      /^[!-~]{1,1024}$/.test(cookie.value)&&(cookie.expirationDate===undefined||cookie.expirationDate*1000>now));
    const [auth,csrf]=await Promise.all([read('auth_token'),read('ct0')]);
    if(auth.length!==1||csrf.length!==1||fingerprintOf(auth[0].value)!==identity.fingerprint)
      return {status:'Authentication required'};
    return {status:'Connected',handle:state.handle,fingerprint:identity.fingerprint,authToken:auth[0].value,
      csrfToken:csrf[0].value,expiresAt:Math.floor(Math.min(auth[0].expirationDate===undefined?Infinity:auth[0].expirationDate*1000,now+30*86_400_000))};
  });
  return controller;
}

module.exports={browserAccount,xNavigation,allowedResource};

