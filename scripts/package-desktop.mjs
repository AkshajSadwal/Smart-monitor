import {spawnSync} from 'node:child_process';
import {copyFileSync,cpSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('..',import.meta.url));
const local=join(root,'.local');
mkdirSync(local,{recursive:true});
const stage=mkdtempSync(join(local,'desktop-build-'));
const metadata=JSON.parse(readFileSync(join(root,'apps','desktop','package.json'),'utf8'));
const lock=JSON.parse(readFileSync(join(root,'package-lock.json'),'utf8'));
const require=createRequire(import.meta.url);
delete metadata.scripts;
const electron=metadata.devDependencies.electron;
delete metadata.devDependencies;
for(const name of Object.keys(metadata.dependencies)){
  metadata.dependencies[name]=(lock.packages['apps/desktop/node_modules/'+name]??lock.packages['node_modules/'+name]).version;
}
metadata.name='smart-monitor';
metadata.build.electronVersion=electron;
metadata.build.npmRebuild=false;
metadata.build.directories.output=resolve(root,process.env.MONITOR_DESKTOP_RELEASE??'release');
metadata.build.files=['main.cjs','account.cjs','tray.png','package.json','!node_modules{,/**/*}'];
metadata.build.extraResources=[{from:'web',to:'web'},{from:'worker',to:'service'},{from:'node_modules',to:'service/node_modules'},{from:'runtime',to:'runtime'}];
metadata.build.win.icon='app.ico';
const rootManifest=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));
metadata.allowScripts=rootManifest.allowScripts;
writeFileSync(join(stage,'package.json'),JSON.stringify(metadata,null,2));
for(const file of ['main.cjs','account.cjs','tray.png','installer.nsh'])copyFileSync(join(root,'apps','desktop',file),join(stage,file));
const icon=readFileSync(join(stage,'tray.png'));
const icoHeader=Buffer.alloc(22);
icoHeader.writeUInt16LE(1,2);
icoHeader.writeUInt16LE(1,4);
icoHeader.writeUInt16LE(1,10);
icoHeader.writeUInt16LE(32,12);
icoHeader.writeUInt32LE(icon.length,14);
icoHeader.writeUInt32LE(icoHeader.length,18);
writeFileSync(join(stage,'app.ico'),Buffer.concat([icoHeader,icon]));
mkdirSync(join(stage,'worker'));
copyFileSync(join(root,'dist','monitor.mjs'),join(stage,'worker','monitor.mjs'));
cpSync(join(root,'apps','web','out'),join(stage,'web'),{recursive:true});

const env={
  ...process.env,
  npm_config_cache:process.env.npm_config_cache||join(local,'npm-cache'),
  ELECTRON_CACHE:process.env.ELECTRON_CACHE||join(local,'electron-cache'),
  ELECTRON_BUILDER_CACHE:process.env.ELECTRON_BUILDER_CACHE||join(local,'electron-builder-cache'),
};
const managedBuilderCache=join(local,'electron-builder-cache');
if(env.ELECTRON_BUILDER_CACHE===managedBuilderCache){
  mkdirSync(managedBuilderCache,{recursive:true});
  writeFileSync(join(managedBuilderCache,'package.json'),'{"type":"commonjs"}');
}
const run=(file,args)=>{
  const result=spawnSync(file,args,{cwd:stage,env,stdio:'inherit',windowsHide:true});
  if(result.error)throw result.error;
  if(result.status!==0)process.exit(result.status??1);
};
const npm=process.env.npm_execpath;
if(!npm)throw new Error('Run this script through npm run desktop:package.');
run(process.execPath,[npm,'install','--omit=dev','--ignore-scripts','--workspaces=false','--no-audit','--no-fund']);
run(process.execPath,[npm,'rebuild','better-sqlite3','--foreground-scripts','--workspaces=false']);
const platform={win32:'win',darwin:'darwin',linux:'linux'}[process.platform];
if(!platform||!['x64','arm64'].includes(process.arch))throw new Error('Build the bundle on its supported native OS and architecture.');
const version='v'+process.versions.node;
const archiveName=`node-${version}-${platform}-${process.arch}`;
const extension=platform==='win'?'.zip':'.tar.gz';
const download=async file=>{
  const result=await fetch(`https://nodejs.org/dist/${version}/${file}`,{signal:AbortSignal.timeout(120_000),redirect:'error'});
  if(!result.ok)throw new Error('Unable to download the official Node.js runtime.');
  return Buffer.from(await result.arrayBuffer());
};
const filename=archiveName+extension;
const cache=join(local,'node-runtime');
mkdirSync(cache,{recursive:true});
const sums=(await download('SHASUMS256.txt')).toString();
let archive;
try{archive=readFileSync(join(cache,filename));}catch{archive=await download(filename);}
const expected=sums.split(/\r?\n/).find(line=>line.trim().endsWith(' '+filename))?.split(/\s+/)[0];
if(!expected||createHash('sha256').update(archive).digest('hex')!==expected)throw new Error('Node.js runtime checksum verification failed.');
writeFileSync(join(cache,filename),archive);
run('tar',['-xf',join(cache,filename),archiveName+(platform==='win'?'/node.exe':'/bin/node'),archiveName+'/LICENSE']);
mkdirSync(join(stage,'runtime'));
copyFileSync(join(stage,archiveName,platform==='win'?'node.exe':'bin/node'),join(stage,'runtime',platform==='win'?'node.exe':'node'));
copyFileSync(join(stage,archiveName,'LICENSE'),join(stage,'runtime','LICENSE'));
run(process.execPath,[resolve(require.resolve('electron-builder/package.json'),'..','cli.js'),'--projectDir',stage,...process.argv.slice(2)]);
