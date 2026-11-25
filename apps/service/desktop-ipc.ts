import {randomUUID} from 'node:crypto';
import {browserAccountSchema,type BrowserAccount,type BrowserAction} from '../../packages/contracts/index';
import {ApiError} from './api';
import type {Notify} from './notifier';

type Message={type?:string;id?:string;result?:unknown};
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
  const account=(action:BrowserAction,remembered:boolean)=>new Promise<BrowserAccount>((resolve,reject)=>{
    const id=randomUUID();
    const failed=()=>new ApiError(503,'DESKTOP_SESSION_UNAVAILABLE','The local X sign-in window could not complete this action.');
    const timer=setTimeout(()=>{accountRequests.delete(id);reject(failed());},15_000);
    timer.unref();
    accountRequests.set(id,result=>{
      clearTimeout(timer);accountRequests.delete(id);
      const parsed=browserAccountSchema.safeParse(result);
      if(parsed.success)resolve(parsed.data);
      else reject(failed());
    });
    try {transport.postMessage({type:'browser-account',id,...action,remembered});}
    catch {clearTimeout(timer);accountRequests.delete(id);reject(failed());}
  });
  return {notify,account,onBrowserAccount:(listen:(state:BrowserAccount)=>void)=>{onAccount=listen;},
    onShutdown:(stop:()=>void)=>{onStop=stop;},send:(message:unknown)=>transport.postMessage(message)};
}
