const {BrowserWindow,safeStorage,session}=require('electron');

const origin='https://x.com';
const signIn=origin+'/i/flow/login';
const savedPartition='persist:smart-monitor-x-account';
const temporaryPartition='smart-monitor-x-account';

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

function browserAccount(){
  let current,accountWindow,transientStatus,seenSignedIn=false;
  let operations=Promise.resolve();
  const result=(status,persistent)=>({status,persistent});
  function prepare(persistent){
    const context=session.fromPartition(persistent?savedPartition:temporaryPartition,{cache:false});
    context.setPermissionRequestHandler((_content,_permission,respond)=>respond(false));
    context.setPermissionCheckHandler(()=>false);
    context.on('will-download',event=>event.preventDefault());
    context.webRequest.onBeforeRequest((details,done)=>done({cancel:!allowedResource(details)}));
    context.webRequest.onCompleted(details=>{
      if(resourceIsPage(details)&&details.statusCode===429)transientStatus='Rate limited';
      else if(resourceIsPage(details)&&details.statusCode===403)transientStatus='Restricted';
    });
    return {context,persistent};
  }
  function resourceIsPage(details){
    return accountWindow&&!accountWindow.isDestroyed()&&details.webContentsId===accountWindow.webContents.id&&details.resourceType==='mainFrame';
  }
  async function check(remembered){
    if(!current&&remembered){
      if(!await canPersist())return result('Temporarily unavailable',true);
      current=prepare(true);
    }
    if(!current)return result('Disconnected',false);
    if(transientStatus)return result(transientStatus,current.persistent);
    const currentUrl=accountWindow?.webContents.getURL();
    const path=currentUrl&&xNavigation(currentUrl)?new URL(currentUrl).pathname:'';
    if(path==='/account/access'||path.startsWith('/i/flow/verify'))
      return result('Verification required',current.persistent);
    if(path==='/i/flow/login'||path==='/login')return result('Authentication required',current.persistent);
    const cookies=await current.context.cookies.get({url:origin,name:'auth_token',secure:true});
    if(cookies.length){
      seenSignedIn=true;
      return result('Connected',current.persistent);
    }
    return result(seenSignedIn?'Session expired':'Authentication required',current.persistent);
  }
  async function open(remember,remembered){
    if(accountWindow){accountWindow.focus();return check(remembered);}
    const persistent=(remember||remembered)&&await canPersist();
    if(remembered&&!persistent)return result('Temporarily unavailable',true);
    if(current&&current.persistent!==persistent)
      await current.context.clearStorageData();
    if(!current||current.persistent!==persistent)current=prepare(persistent);
    const state=await check(remembered);
    transientStatus=undefined;
    const window=new BrowserWindow({width:650,height:800,title:'X sign-in · Smart Monitor',
      autoHideMenuBar:true,webPreferences:{session:current.context,sandbox:true,contextIsolation:true,nodeIntegration:false,devTools:false}});
    accountWindow=window;
    const blockOrdinaryNavigation=event=>{if(!xNavigation(event.url))event.preventDefault();};
    window.webContents.on('will-navigate',blockOrdinaryNavigation);
    window.webContents.on('will-redirect',blockOrdinaryNavigation);
    window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    window.webContents.on('page-title-updated',event=>event.preventDefault());
    window.webContents.on('did-navigate',(_event,_target,code)=>{if(code>=200&&code<400)transientStatus=undefined;});
    window.webContents.on('did-fail-load',(_event,code,_description,_target,isMainFrame)=>{
      if(isMainFrame&&code!==-3)transientStatus='Temporarily unavailable';
    });
    window.on('closed',()=>{accountWindow=undefined;});
    void window.loadURL(state.status==='Connected'?origin+'/home':signIn).catch(()=>{
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
    current=undefined;
    transientStatus=undefined;
    seenSignedIn=false;
    return result('Disconnected',false);
  }
  return ({action,remember,remembered})=>{
    const work=operations.then(()=>action==='open'?open(remember,remembered):action==='check'?check(remembered):disconnect(remembered));
    operations=work.catch(()=>{});
    return work;
  };
}

module.exports={browserAccount,xNavigation,allowedResource};

