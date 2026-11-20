import {test,expect} from '@playwright/test';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';

const root=resolve('.local');
let profile:string;
function cli(...args:string[]) {
  return execFileSync(process.execPath,[resolve('dist/monitor.mjs'),...args],{env:{...process.env,MONITOR_PROFILE:profile},encoding:'utf8',timeout:15_000}).trim();
}
test.beforeEach(()=>{
  mkdirSync(root,{recursive:true});
  profile=mkdtempSync(join(root,'browser-profile-'));
});
test.afterEach(async()=>{
  try {
    cli('stop');
    await new Promise(resolve=>setTimeout(resolve,500));
  } finally {rmSync(profile,{recursive:true,force:true,maxRetries:5,retryDelay:200});}
});

test('production launcher, watchlist preview, closed-tab polling, feedback and durable restart',async({page,context},testInfo)=>{
  cli('start');
  const initial=cli('open','--print');
  expect(new URL(initial).origin).toBe(new URL(cli('open','--print')).origin);
  await page.goto(initial);
  await expect(page.getByRole('heading',{name:'Dashboard'})).toBeVisible();
  await page.getByRole('link',{name:'Settings',exact:true}).click();
  await page.getByRole('checkbox',{name:'Desktop notifications'}).uncheck();
  await page.getByRole('checkbox',{name:'Reduce motion'}).check();
  await page.getByRole('button',{name:'Save settings'}).click();
  await expect(page.getByText('Settings saved.')).toBeVisible();
  await page.getByRole('link',{name:'Watchlists',exact:true}).click();
  await page.getByRole('button',{name:'Use SQLite example'}).click();
  await page.getByRole('button',{name:'Test watchlist'}).click();
  await expect(page.getByText(/Matched · Score 100/)).toBeVisible();
  await page.getByRole('button',{name:'Save watchlist'}).click();
  await expect(page.getByRole('heading',{name:'SQLite releases'})).toBeVisible();
  await page.close();
  cli('resume');
  let active=await context.newPage();
  await active.goto(cli('open','--print'));
  await expect(active.getByText(/SQLite release candidate is ready/)).toBeVisible();
  await expect(active.locator('.robot-stage canvas')).toHaveAttribute('data-fur-strands',/^(1800|5000)$/);
  await active.screenshot({path:testInfo.outputPath('dashboard-desktop.png')});
  await active.getByRole('button',{name:/SQLite release candidate is ready/}).click();
  await expect(active.getByRole('dialog',{name:'Post details'})).toBeVisible();
  await expect(active.getByText('100 · Immediate · SQLite releases')).toBeVisible();
  await active.getByRole('button',{name:'Useful',exact:true}).click();
  await expect(active.getByRole('button',{name:'Useful',exact:true})).toHaveAttribute('aria-pressed','true');
  await active.keyboard.press('Escape');
  await expect(active.getByRole('dialog')).toHaveCount(0);
  await expect(active.getByRole('button',{name:/SQLite release candidate is ready/})).toBeFocused();
  await active.getByRole('link',{name:/^Notifications/}).click();
  await expect(active.getByText(/Matched SQLite releases/)).toBeVisible();
  await active.getByRole('button',{name:'Mark read',exact:true}).click();
  await expect(active.getByRole('button',{name:'Mark unread',exact:true})).toBeVisible();
  await active.close();
  cli('stop');
  await new Promise(resolve=>setTimeout(resolve,600));
  active=await context.newPage();
  await active.goto(cli('open','--print'));
  await expect(active.getByText(/SQLite release candidate is ready/)).toBeVisible();
  await active.getByRole('button',{name:'Pause monitoring'}).click();
  await expect(active.getByText('Monitoring paused.')).toBeVisible();
  await active.setViewportSize({width:320,height:720});
  await expect(active.getByRole('button',{name:'Menu'})).toBeVisible();
  expect(await active.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await active.screenshot({path:testInfo.outputPath('dashboard-320.png')});
});

test('small layout shows static mascot when WebGL is unavailable',async({page})=>{
  await page.addInitScript(()=>{
    const get=HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext=function(this:HTMLCanvasElement,type:string,...args:unknown[]) {
      if(type.startsWith('webgl')) return null;
      return Reflect.apply(get,this,[type,...args]);
    } as typeof get;
  });
  await page.setViewportSize({width:320,height:720});
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.goto(cli('open','--print'));
  await expect(page.locator('.avatar-body')).toBeVisible();
  await expect(page.locator('.robot-stage')).toHaveAttribute('data-reduced','true');
  await expect(page.getByRole('link',{name:'Create watchlist'})).toBeVisible();
});

test('source controls enforce hosted consent and preserve the selected source after invalid input',async({page})=>{
  await page.goto(cli('open','--print'));
  await page.getByRole('link',{name:'Watchlists',exact:true}).click();
  await page.getByRole('button',{name:'Use SQLite example'}).click();
  await page.getByRole('button',{name:'Save watchlist'}).click();
  await expect(page.getByRole('heading',{name:'SQLite releases'})).toBeVisible();
  await page.getByRole('link',{name:'Data sources',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Local X Account',exact:true})).toBeVisible();
  await expect(page.getByRole('heading',{name:'Official X API',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Configure hosted service'}).click();
  const modal=page.getByRole('dialog',{name:'Configure Hosted Monitoring'});
  await modal.getByLabel('Public HTTPS server URL').fill('https://127.0.0.1');
  await modal.getByRole('checkbox',{name:'sqlite',exact:true}).check();
  await expect(modal.getByRole('button',{name:'Approve hosted configuration'})).toBeDisabled();
  await modal.getByRole('checkbox',{name:/I consent/}).check();
  await modal.getByRole('button',{name:'Approve hosted configuration'}).click();
  await expect(modal.getByRole('alert')).toContainText('public HTTPS hostname');
  await modal.getByRole('button',{name:'Close dialog'}).click();
  await expect(page.getByText('Simulated · Paused')).toBeVisible();
});
