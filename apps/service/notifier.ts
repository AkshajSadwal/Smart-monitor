import notifier from 'node-notifier';

export type Notice = {title:string;message:string;onClick?:()=>void};
export type Notify = (notice:Notice)=>Promise<'submitted'|'unavailable'>;
export const notifyNative:Notify = ({title,message,onClick}) => new Promise(resolve=>{
  const timeout=setTimeout(()=>resolve('unavailable'),8000);
  timeout.unref();
  try {
    notifier.notify({title,message,wait:!!onClick,timeout:5},(error,response,metadata)=>{
      clearTimeout(timeout);
      const action=String(response??'').toLowerCase();
      if (action==='activate' || action==='clicked' || metadata?.activationType==='contentsClicked') onClick?.();
      resolve(error?'unavailable':'submitted');
    });
  } catch {
    clearTimeout(timeout);
    resolve('unavailable');
  }
});
