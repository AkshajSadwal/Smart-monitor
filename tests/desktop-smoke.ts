import { _electron as electron, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const local=resolve('.local');
mkdirSync(local,{recursive:true});
const profile=mkdtempSync(join(local,'desktop-smoke-'));
const packaged=resolve('release/win-unpacked');
const resource=join(packaged,'resources');
const env={...process.env,MONITOR_PROFILE:profile,MONITOR_DESKTOP_SMOKE:'1'};
const cli=(...args:string[])=>execFileSync(join(resource,'runtime','node.exe'),[
  join(resource,'service','monitor.mjs'),...args,
],{env,encoding:'utf8',timeout:10_000});
let instance:Awaited<ReturnType<typeof electron.launch>>|undefined;
try {
  instance=await electron.launch({executablePath:join(packaged,'Smart Monitor.exe'),env,timeout:20_000});
  const original=await instance.firstWindow({timeout:15_000});
  await expect(original.getByRole('heading',{name:'Dashboard'})).toBeVisible();
  await original.getByRole('link',{name:'Settings',exact:true}).click();
  await original.getByRole('checkbox',{name:'Desktop notifications'}).uncheck();
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
  const attempt=reopened.waitForResponse(response=>response.url().endsWith('/api/v1/notifications/test'),{timeout:12_000});
  await reopened.getByRole('button',{name:'Test desktop alert'}).click();
  const native=await (await attempt).json() as {result:string};
  expect(['submitted','unavailable']).toContain(native.result);
  console.log('Native test result: '+native.result);
  await instance.close();
  instance=undefined;
  await expect.poll(()=>{
    try{cli('status');return true;}catch{return false;}
  }).toBe(false);
  console.log('Packaged Windows app: worker, dashboard, window-close polling, durable notification, tray-host activation, and quit passed.');
} catch(error) {
  try{console.error(readFileSync(join(profile,'desktop','desktop.log'),'utf8'));}catch{ /* startup may fail before logging */ }
  throw error;
} finally {
  if(instance)await instance.close().catch(()=>{});
  rmSync(profile,{recursive:true,force:true,maxRetries:8,retryDelay:200});
}
