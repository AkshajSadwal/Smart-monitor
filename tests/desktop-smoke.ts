import { _electron as electron, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const local=resolve('.local');
mkdirSync(local,{recursive:true});
const profile=mkdtempSync(join(local,'desktop-smoke-'));
const development=process.argv.includes('--dev');
const accountOnly=process.argv.includes('--account-only');
const windows=process.platform==='win32';
const mac=process.platform==='darwin';
const macFolder=process.arch==='arm64'?'mac-arm64':'mac';
const packaged=resolve(process.env.MONITOR_DESKTOP_RELEASE??'release',windows?'win-unpacked':mac?join(macFolder,'Smart Monitor.app','Contents'):'linux-unpacked');
const resource=join(packaged,mac?'Resources':'resources');
const env={...process.env,MONITOR_PROFILE:profile,MONITOR_DESKTOP_SMOKE:'1',npm_node_execpath:process.execPath};
const runtime=development?process.execPath:join(resource,'runtime',windows?'node.exe':'node');
const worker=development?resolve('dist/monitor.mjs'):join(resource,'service','monitor.mjs');
const cli=(...args:string[])=>execFileSync(runtime,[worker,...args],{env,encoding:'utf8',timeout:10_000});
let instance:Awaited<ReturnType<typeof electron.launch>>|undefined;
try {
  const executablePath=development?createRequire(resolve('apps/desktop/package.json'))('electron') as string:
    windows?join(packaged,'Smart Monitor.exe'):mac?join(packaged,'MacOS','Smart Monitor'):join(packaged,'smart-monitor');
  if(!existsSync(executablePath))throw new Error('Build the native desktop package before running its smoke test.');
  instance=await electron.launch({executablePath,args:development?[resolve('apps/desktop')]:[],env,timeout:20_000});
  const original=await instance.firstWindow({timeout:15_000});
  await expect(original.getByRole('heading',{name:'Dashboard'})).toBeVisible();
  let reopened=original;
  if(!accountOnly){
    await original.getByRole('link',{name:'Settings',exact:true}).click();
    await original.getByRole('checkbox',{name:'Desktop notifications',exact:true}).uncheck();
    await original.getByRole('button',{name:'Save settings'}).click();
    await expect(original.getByText('Settings saved.')).toBeVisible();
    await original.getByRole('link',{name:'Watchlists',exact:true}).click();
    await original.getByRole('button',{name:'Use SQLite example'}).click();
    await original.getByRole('button',{name:'Save watchlist'}).click();
    await expect(original.getByRole('heading',{name:'SQLite releases'})).toBeVisible();
    await original.close();
    cli('resume');
    await expect.poll(()=>JSON.parse(cli('status')).lastSuccess).not.toBeNull();
    const shown=instance.waitForEvent('window',{timeout:12_000});
    await instance.evaluate(({app})=>app.emit('activate'));
    reopened=await shown;
    await expect(reopened.getByText(/SQLite release candidate is ready/)).toBeVisible();
    await reopened.getByRole('link',{name:/^Notifications/}).click();
    await expect(reopened.getByText('Matched SQLite releases')).toBeVisible();
    await reopened.getByRole('link',{name:'Settings',exact:true}).click();
    const attempt=reopened.waitForResponse(response=>response.url().endsWith('/api/v1/notifications/test'),{timeout:12_000});
    await reopened.getByRole('button',{name:'Send test notification'}).click();
    const native=await (await attempt).json() as {result:string};
    expect(['submitted','unavailable']).toContain(native.result);
    console.log('Native test result: '+native.result);
  }
  const routeAccount=(app:NonNullable<typeof instance>)=>app.context().route('https://x.com/**',route=>{
    const path=new URL(route.request().url()).pathname;
    if(path==='/home')return route.fulfill({
      contentType:'text/html',headers:{'Set-Cookie':'auth_token=desktop-fixture-only; Path=/; Secure; HttpOnly; Max-Age=3600'},
      body:'<h1>Fixture account</h1><a href="/fixture_user">Profile</a><a href="/other_user">Switch account</a>',
    });
    if(path==='/fixture_user')return route.fulfill({contentType:'text/html',body:'<h1>Fixture profile</h1><button>Edit profile</button><a href="/account/access">Challenge</a>'});
    if(path==='/account/access')return route.fulfill({contentType:'text/html',body:'<h1>Verify account</h1><a href="/limited">Rate limit</a>'});
    if(path==='/limited')return route.fulfill({status:429,contentType:'text/html',body:'<h1>Try later</h1>'});
    if(path==='/other_user')return route.fulfill({
      contentType:'text/html',headers:{'Set-Cookie':'auth_token=desktop-fixture-other; Path=/; Secure; HttpOnly; Max-Age=3600'},
      body:'<h1>Other fixture profile</h1><button>Edit profile</button><a href="/expired">Expire session</a>',
    });
    if(path==='/expired')return route.fulfill({status:401,contentType:'text/html',body:'<h1>Session rejected</h1>'});
    return route.fulfill({contentType:'text/html',body:'<a href="/home">Complete fixture sign-in</a>'});
  });
  await routeAccount(instance);
  await reopened.getByRole('link',{name:'Data sources',exact:true}).click();
  await expect(reopened.getByText('Automatic X collection requires X authorization.',{exact:false})).toBeVisible();
  if(windows)await reopened.getByRole('checkbox',{name:/Remember my sign-in/}).check();
  const accountOpened=instance.waitForEvent('window',{timeout:12_000});
  await reopened.getByRole('button',{name:'Open X sign-in'}).click();
  const accountWindow=await accountOpened;
  await accountWindow.getByRole('link',{name:'Complete fixture sign-in'}).click();
  await expect(accountWindow.getByRole('heading',{name:'Fixture account'})).toBeVisible();
  const browserAction=async(button:string,page=reopened)=>{
    const attempt=page.waitForResponse(response=>response.url().endsWith('/api/v1/sources/session/browser'));
    await page.getByRole('button',{name:button,exact:true}).click();
    return (await attempt).json();
  };
  expect(await browserAction('Check browser session')).toEqual({status:'Profile confirmation required',persistent:windows});
  expect(await browserAction('Confirm my X profile')).toEqual({status:'Profile confirmation required',persistent:windows});
  await accountWindow.getByRole('link',{name:'Profile',exact:true}).click();
  await expect(accountWindow.getByRole('button',{name:'Edit profile'})).toBeVisible();
  expect(await browserAction('Confirm my X profile')).toEqual({status:'Connected',persistent:windows,handle:'fixture_user'});
  await expect(reopened.getByText('@fixture_user',{exact:true})).toBeVisible();
  const identityPath=join(profile,'desktop','x-account-identity');
  if(windows){
    const sealed=readFileSync(identityPath);
    expect(sealed.includes('fixture_user')).toBe(false);
    expect(sealed.includes('desktop-fixture-only')).toBe(false);
  }
  await expect(reopened.getByText('Unsupported',{exact:true})).toBeVisible();
  await expect(reopened.getByText('desktop-fixture-only')).toHaveCount(0);
  await accountWindow.getByRole('link',{name:'Challenge'}).click();
  await expect(accountWindow.getByRole('heading',{name:'Verify account'})).toBeVisible();
  expect(await browserAction('Check browser session')).toEqual({status:'Verification required',persistent:windows});
  await expect(reopened.getByText('@fixture_user',{exact:true})).toHaveCount(0);
  await accountWindow.getByRole('link',{name:'Rate limit'}).click();
  await expect(accountWindow.getByRole('heading',{name:'Try later'})).toBeVisible();
  expect(await browserAction('Check browser session')).toEqual({status:'Rate limited',persistent:windows});
  let active=accountWindow;
  if(windows){
    await instance.close();
    instance=await electron.launch({executablePath,args:development?[resolve('apps/desktop')]:[],env,timeout:20_000});
    await routeAccount(instance);
    reopened=await instance.firstWindow({timeout:15_000});
    await reopened.getByRole('link',{name:'Data sources',exact:true}).click();
    await expect(reopened.getByText('@fixture_user',{exact:true})).toBeVisible();
    await expect(reopened.getByRole('button',{name:'Confirm my X profile'})).toHaveCount(0);
    const opened=instance.waitForEvent('window',{timeout:12_000});
    await browserAction('Open X account window');
    active=await opened;
  }else{
    await active.goto('https://x.com/home');
  }
  await active.getByRole('link',{name:'Switch account'}).click();
  await expect(reopened.getByText('Profile confirmation required',{exact:true})).toBeVisible();
  await expect(reopened.getByText('@fixture_user',{exact:true})).toHaveCount(0);
  await expect(active.getByRole('button',{name:'Edit profile'})).toBeVisible();
  expect(await browserAction('Confirm my X profile')).toEqual({status:'Connected',persistent:windows,handle:'other_user'});
  await active.getByRole('link',{name:'Expire session'}).click();
  await expect(reopened.getByText('Session expired',{exact:true})).toBeVisible();
  await expect(reopened.getByText('@other_user',{exact:true})).toHaveCount(0);
  expect(existsSync(identityPath)).toBe(false);
  expect(await browserAction('Disconnect browser')).toEqual({status:'Disconnected',persistent:false});
  const reopenedAccount=instance.waitForEvent('window',{timeout:12_000});
  await browserAction('Open X sign-in');
  active=await reopenedAccount;
  await active.getByRole('link',{name:'Complete fixture sign-in'}).click();
  await active.getByRole('link',{name:'Profile',exact:true}).click();
  await expect(active.getByRole('button',{name:'Edit profile'})).toBeVisible();
  expect(await browserAction('Confirm my X profile')).toMatchObject({status:'Connected',handle:'fixture_user'});
  await expect(reopened.getByText('Local X browser session cleared.')).toHaveCount(0);
  console.log('Isolated X-window fixture passed confirmation, challenge, rate limit, switching, expiry and reconnect.'+(windows?' Windows identity restore passed.':''));
  await instance.close();
  instance=undefined;
  await expect.poll(()=>{
    try{cli('status');return true;}catch{return false;}
  }).toBe(false);
  console.log(accountOnly?'Local X Account desktop fixture passed.':
    `${development?'Development':'Packaged'} desktop (${process.platform}/${process.arch}): worker, dashboard, background polling, notification history, activation and quit passed.`);
} catch(error) {
  try{console.error(readFileSync(join(profile,'desktop','desktop.log'),'utf8'));}catch{ /* startup may fail before logging */ }
  throw error;
} finally {
  if(instance)await instance.close().catch(()=>{});
  rmSync(profile,{recursive:true,force:true,maxRetries:8,retryDelay:200});
}
