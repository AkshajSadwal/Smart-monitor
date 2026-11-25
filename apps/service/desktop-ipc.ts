import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {browserAccountSchema,type BrowserAccount,type BrowserAction} from '../../packages/contracts/index';
import {ApiError} from './api';
import type {Notify} from './notifier';

type Message={type?:string;id?:string;result?:unknown};
const credentialReply=z.discriminatedUnion('status',[
  z.strictObject({status:z.literal('Connected'),handle:z.string().regex(/^[A-Za-z0-9_]{1,15}$/),
    fingerprint:z.string().regex(/^[a-f0-9]{64}$/),expiresAt:z.number().int().positive(),
    authToken:z.string().regex(/^[!-~]{1,1024}$/),csrfToken:z.string().regex(/^[!-~]{1,1024}$/)}),
  z.strictObject({status:z.enum(['Disconnected','Check required','Profile confirmation required','Authentication required',
    'Verification required','Session expired','Restricted','Rate limited','Temporarily unavailable'])}),
]);
export type CollectionCredentials=z.infer<typeof credentialReply>;
type Parent = {
  postMessage:(message:unknown)=>void;
  on:(event:'message',listen:(event:{data?:Message})=>void)=>void;
};
const port=(process as NodeJS.Process & {parentPort?:Parent}).parentPort;
export function desktopBridge() {
  const transport:Parent|undefined=port??(process.send?{
    postMessage:message=>{process.send?.(message as object);},
    on:(_event,listen)=>{process.on('message',data=>listen({data:data as Parameters<typeof listen>[0]['data']}));},
  }:undefined);
  if(!transport)return null;
  const pending=new Map<string,{result:(state:'submitted'|'unavailable')=>void;click?:()=>void}>();
  const accountRequests=new Map<string,(result:unknown)=>void>();
  let onStop=()=>{};
  let onAccount:((state:BrowserAccount)=>void)|undefined;
  transport.on('message',({data})=>{
    if(data?.type==='shutdown'){onStop();return;}
    if(data?.type==='browser-account-state'){
      const state=browserAccountSchema.safeParse(data.result);
      if(state.success)onAccount?.(state.data);
      return;
    }
    if(!data?.id)return;
    if(data.type==='browser-account-result'){accountRequests.get(data.id)?.(data.result);return;}
    const request=pending.get(data.id);
    if(data.type==='notification-click'){request?.click?.();pending.delete(data.id);}
    else if(data.type==='notification-result')request?.result(data.result==='submitted'?'submitted':'unavailable');
  });
  const notify:Notify=({title,message,onClick})=>new Promise(resolve=>{
    const id=randomUUID();
    const timeout=setTimeout(()=>resolve('unavailable'),8000);
    timeout.unref();
    const expire=setTimeout(()=>pending.delete(id),24*3600_000);
    expire.unref();
    pending.set(id,{result:state=>{
      clearTimeout(timeout);
      resolve(state);
      if(!onClick||state==='unavailable'){clearTimeout(expire);pending.delete(id);}
    },click:onClick});
    transport.postMessage({type:'notification',id,title,message});
  });
  const accountRequest=<T>(message:object,schema:z.ZodType<T>,signal?:AbortSignal)=>new Promise<T>((resolve,reject)=>{
    signal?.throwIfAborted();
    const id=randomUUID();
    const failed=()=>new ApiError(503,'DESKTOP_SESSION_UNAVAILABLE','The local X sign-in window could not complete this action.');
    const cleanup=()=>{clearTimeout(timer);accountRequests.delete(id);signal?.removeEventListener('abort',abort);};
    const abort=()=>{cleanup();reject(signal?.reason);};
    const timer=setTimeout(()=>{cleanup();reject(failed());},15_000);
    timer.unref();
    accountRequests.set(id,result=>{
      cleanup();
      const parsed=schema.safeParse(result);
      if(parsed.success)resolve(parsed.data);
      else reject(failed());
    });
    signal?.addEventListener('abort',abort,{once:true});
    try {transport.postMessage({...message,id});}
    catch {cleanup();reject(failed());}
  });

  const account=(action:BrowserAction,remembered:boolean)=>(accountRequest({type:'browser-account',...action,remembered},browserAccountSchema));
  const collectionCredentials=(remembered:boolean,signal:AbortSignal)=>accountRequest({type:'collection-credentials',remembered},credentialReply,signal);

  return {notify,account,collectionCredentials,onBrowserAccount:(listen:(state:BrowserAccount)=>void)=>{onAccount=listen;},
    onShutdown:(stop:()=>void)=>{onStop=stop;},send:(message:unknown)=>transport.postMessage(message)};
}
