import {randomUUID} from 'node:crypto';
import type {Notify} from './notifier';

type Parent = {
  postMessage:(message:unknown)=>void;
  on:(event:'message',listen:(event:{data?:{type?:string;id?:string;result?:string}})=>void)=>void;
};
const port=(process as NodeJS.Process & {parentPort?:Parent}).parentPort;
export function desktopBridge() {
  const transport:Parent|undefined=port??(process.send?{
    postMessage:message=>{process.send?.(message as object);},
    on:(_event,listen)=>{process.on('message',data=>listen({data:data as Parameters<typeof listen>[0]['data']}));},
  }:undefined);
  if(!transport)return null;
  const pending=new Map<string,{result:(state:'submitted'|'unavailable')=>void;click?:()=>void}>();
  let onStop=()=>{};
  transport.on('message',({data})=>{
    if(data?.type==='shutdown'){onStop();return;}
    if(!data?.id)return;
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
  return {notify,onShutdown:(stop:()=>void)=>{onStop=stop;},send:(message:unknown)=>transport.postMessage(message)};
}
