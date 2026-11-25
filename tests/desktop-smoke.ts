import { _electron as electron, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const local=resolve('.local');
mkdirSync(local,{recursive:true});
const profile=mkdtempSync(join(local,'desktop-smoke-'));
const development=process.argv.includes('--dev');
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
  const reopened=await shown;
  await expect(reopened.getByText(/SQLite release candidate is ready/)).toBeVisible();
  await reopened.getByRole('link',{name:/^Notifications/}).click();
  await expect(reopened.getByText('Matched SQLite releases')).toBeVisible();
  await reopened.getByRole('link',{name:'Settings',exact:true}).click();
  const attempt=reopened.waitForResponse(response=>response.url().endsWith('/api/v1/notifications/test'),{timeout:12_000});
  await reopened.getByRole('button',{name:'Send test notification'}).click();
  const native=await (await attempt).json() as {result:string};
  expect(['submitted','unavailable']).toContain(native.result);
  console.log('Native test result: '+native.result);
  await instance.context().route('https://x.com/**',route=>{
    if(new URL(route.request().url()).pathname==='/home')return route.fulfill({
      contentType:'text/html',headers:{'Set-Cookie':'auth_token=desktop-fixture-only; Path=/; Secure; HttpOnly; Max-Age=3600'},
      body:'<h1>Fixture account</h1>',
    });
    return route.fulfill({contentType:'text/html',body:'<a href="/home">Complete fixture sign-in</a>'});
  });
  await reopened.getByRole('link',{name:'Data sources',exact:true}).click();
  await expect(reopened.getByText('Automatic search requires an authorized X collection interface.',{exact:false})).toBeVisible();
  if(windows)await reopened.getByRole('checkbox',{name:/Remember my sign-in/}).check();
  const accountOpened=instance.waitForEvent('window',{timeout:12_000});
  await reopened.getByRole('button',{name:'Open X sign-in'}).click();
  const accountWindow=await accountOpened;
  await accountWindow.getByRole('link',{name:'Complete fixture sign-in'}).click();
  await expect(accountWindow.getByRole('heading',{name:'Fixture account'})).toBeVisible();
  const accountCheck=reopened.waitForResponse(response=>response.url().endsWith('/api/v1/sources/session/browser'));
  await reopened.getByRole('button',{name:'Check browser session'}).click();
  const checked=await (await accountCheck).json();
  expect(checked).toEqual({status:'Connected',persistent:windows});
  await expect(reopened.getByText('Unsupported',{exact:true})).toBeVisible();
  await expect(reopened.getByText('desktop-fixture-only')).toHaveCount(0);
  if(windows){
    await instance.close();
    instance=await electron.launch({executablePath,args:development?[resolve('apps/desktop')]:[],env,timeout:20_000});
    const restart=await instance.firstWindow({timeout:15_000});
    await restart.getByRole('link',{name:'Data sources',exact:true}).click();
    const restored=restart.waitForResponse(response=>response.url().endsWith('/api/v1/sources/session/browser'));
    await restart.getByRole('button',{name:'Check browser session'}).click();
    expect(await (await restored).json()).toEqual({status:'Connected',persistent:true});
    await restart.getByRole('button',{name:'Disconnect browser'}).click();
    await expect(restart.getByText('Local X browser session cleared.')).toBeVisible();
  }else{
    await reopened.getByRole('button',{name:'Disconnect browser'}).click();
    await expect(reopened.getByText('Local X browser session cleared.')).toBeVisible();
  }
  console.log('Isolated X-window fixture passed sign-in detection and disconnect.'+(windows?' Windows session restore passed.':''));
  await instance.close();
  instance=undefined;
  await expect.poll(()=>{
    try{cli('status');return true;}catch{return false;}
  }).toBe(false);
  console.log(`${development?'Development':'Packaged'} desktop (${process.platform}/${process.arch}): worker, dashboard, background polling, notification history, activation and quit passed.`);
} catch(error) {
  try{console.error(readFileSync(join(profile,'desktop','desktop.log'),'utf8'));}catch{ /* startup may fail before logging */ }
  throw error;
} finally {
  if(instance)await instance.close().catch(()=>{});
  rmSync(profile,{recursive:true,force:true,maxRetries:8,retryDelay:200});
}
