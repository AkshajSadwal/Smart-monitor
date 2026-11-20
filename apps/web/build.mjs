import {spawnSync} from 'node:child_process';
import {rmSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const require=createRequire(import.meta.url);
// A fresh Next cache avoids Windows leaving locked partial RSC segment exports.
rmSync(fileURLToPath(new URL('./.next',import.meta.url)),{recursive:true,force:true,maxRetries:4,retryDelay:150});
const result=spawnSync(process.execPath,[require.resolve('next/dist/bin/next'),'build','--webpack'],{
  stdio:'inherit',env:{...process.env,NEXT_TELEMETRY_DISABLED:'1'},
});
if(result.error)throw result.error;
process.exitCode=result.status??1;
