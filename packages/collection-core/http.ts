export function resetTime(headers:Headers,now:number,minDelay=1_000) {
  const reset=Number(headers.get('x-rate-limit-reset'))*1000;
  const raw=headers.get('retry-after');
  const retry=raw&&/^\d+$/.test(raw)?now+Number(raw)*1000:Date.parse(raw??'');
  const valid=(value:number)=>Number.isSafeInteger(value)&&value>=0?value:0;
  return Math.max(now+minDelay,valid(reset),valid(retry));
}

// A driver must respect cancellation; the local monitor also stops waiting if it does not.
export function abortable<T>(work:Promise<T>,signal:AbortSignal):Promise<T> {
  return new Promise((resolve,reject)=>{
    const abort=()=>{signal.removeEventListener('abort',abort);reject(signal.reason);};
    signal.addEventListener('abort',abort,{once:true});
    work.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
    if(signal.aborted)abort();
  });
}

export async function readJson(body:ReadableStream<Uint8Array>,signal:AbortSignal,limit=2_000_000):Promise<unknown> {
  const reader=body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});
  let size=0,data='';
  try {
    for(;;){
      signal.throwIfAborted();
      const chunk=await abortable(reader.read(),signal);
      if(chunk.done)break;
      size+=chunk.value.byteLength;
      if(size>limit)throw new Error('Upstream page exceeded the size limit');
      data+=decoder.decode(chunk.value,{stream:true});
    }
    signal.throwIfAborted();
    return JSON.parse(data+decoder.decode());
  } finally {
    // Cancellation must not itself hold up shutdown on a stalled transport.
    void reader.cancel().catch(()=>{});
    reader.releaseLock();
  }
}
