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
  await page.getByRole('checkbox',{name:'Desktop notifications',exact:true}).uncheck();
  await expect(page.getByRole('checkbox',{name:'Allow desktop notifications for simulated posts'})).not.toBeChecked();
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

test('local source controls validate sharing and import posts from a JSON file',async({page})=>{
  await page.goto(cli('open','--print'));
  await page.getByRole('link',{name:'Watchlists',exact:true}).click();
  await page.getByRole('button',{name:'Use SQLite example'}).click();
  await page.getByRole('button',{name:'Save watchlist'}).click();
  await expect(page.getByRole('heading',{name:'SQLite releases'})).toBeVisible();
  await page.getByRole('link',{name:'Data sources',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Local X Account',exact:true})).toBeVisible();
  await expect(page.getByRole('heading',{name:'Hosted Monitoring',exact:true})).toHaveCount(0);
  await expect(page.getByRole('heading',{name:'Official X API',exact:true})).toHaveCount(0);
  await expect(page.getByRole('heading',{name:'Simulated',exact:true})).toBeVisible();
  await expect(page.getByText('Automatic X collection requires X authorization.',{exact:false})).toBeVisible();
  await expect(page.getByText('Python worker',{exact:true})).toBeVisible();
  await expect(page.getByText('Unsupported',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Enable collection'})).toHaveCount(0);
  await expect(page.getByText('Available in the desktop app')).toBeVisible();
  await page.getByRole('button',{name:'Share selected X post'}).click();
  const sharing=page.getByRole('dialog',{name:'Share a selected X post'});
  await sharing.getByLabel('X post permalink').fill('https://example.invalid/m/status/42');
  await sharing.getByLabel('Selected excerpt').fill('A user-selected example about SQLite');
  await expect(sharing.getByRole('button',{name:'Save selected post'})).toBeDisabled();
  await sharing.getByRole('checkbox',{name:'I choose to store this excerpt locally.'}).check();
  await sharing.getByRole('button',{name:'Save selected post'}).click();
  await expect(page.getByText('Paste an HTTPS link to the selected X post.')).toBeVisible();
  await sharing.getByLabel('X post permalink').fill('https://x.com/example/status/42');
  await sharing.getByRole('button',{name:'Save selected post'}).click();
  await sharing.getByRole('link',{name:'View saved post'}).click();
  const post=page.getByRole('dialog',{name:'Post details'});
  await expect(post.getByText('A user-selected example about SQLite')).toBeVisible();
  await expect(post.getByText('User-shared excerpt')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('link',{name:'Data sources',exact:true}).click();
  await page.getByRole('button',{name:'Import posts',exact:true}).click();
  const imports=page.getByRole('dialog',{name:'Import X posts'});
  const download=page.waitForEvent('download');
  await imports.getByRole('link',{name:'Download JSON example'}).click();
  expect((await download).suggestedFilename()).toBe('smart-monitor-posts.example.json');
  await imports.getByLabel('Post file').setInputFiles({
    name:'posts.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify([
      {url:'https://x.com/example/status/43',text:'SQLite release candidate from a JSON file',language:'en',metrics:{likes:200}},
    ])),
  });
  await expect(imports.getByRole('button',{name:'Import selected file'})).toBeDisabled();
  await imports.getByRole('checkbox',{name:/I choose to store these posts/}).check();
  await imports.getByRole('button',{name:'Import selected file'}).click();
  await expect(imports.getByRole('status')).toHaveText('1 saved');
  await imports.getByRole('link',{name:'View manual posts'}).click();
  await expect(page.getByRole('combobox',{name:'Source',exact:true})).toHaveValue('manual');
  const imported=page.getByRole('button',{name:/SQLite release candidate from a JSON file/});
  await expect(imported).toContainText('Manual import');
  await expect(imported).toContainText('SQLite releases');
  let widgetRequests=0;
  await page.route('https://platform.twitter.com/widgets.js',route=>{
    widgetRequests++;
    return route.fulfill({contentType:'text/javascript',body:"document.body.insertAdjacentHTML('beforeend','<p>Fixture widget loaded</p>');"});
  });
  await page.getByRole('link',{name:'Settings',exact:true}).click();
  await page.getByRole('checkbox',{name:/Offer official X embeds/}).check();
  await page.getByRole('button',{name:'Save settings'}).click();
  await expect(page.getByText('Settings saved.')).toBeVisible();
  await page.goto(new URL('/feed/?post=42&source=x',page.url()).toString());
  await page.getByText('Official X embed',{exact:true}).click();
  expect(widgetRequests).toBe(0);
  await page.getByRole('button',{name:'Agree and load X embed'}).click();
  await expect(page.frameLocator('iframe[title="Official X post"]').getByText('Fixture widget loaded')).toBeVisible();
  expect(widgetRequests).toBe(1);
});
