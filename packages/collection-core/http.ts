export function resetTime(headers:Headers,now:number,minDelay=1_000) {
  const reset=Number(headers.get('x-rate-limit-reset'))*1000;
  const raw=headers.get('retry-after');
  const retry=raw&&/^\d+$/.test(raw)?now+Number(raw)*1000:Date.parse(raw??'');
  return Math.max(now+minDelay,reset||0,retry||0);
}

export async function* lines(body:ReadableStream<Uint8Array>,limit=262144) {
  const reader=body.getReader(),decoder=new TextDecoder();
  let pending='';
  try {
    for(;;) {
      const chunk=await reader.read();
      if(chunk.done)break;
      pending+=decoder.decode(chunk.value,{stream:true});
      for(let end=pending.indexOf('\n');end>=0;end=pending.indexOf('\n')) {
        if(end>limit)throw new Error('Upstream frame exceeded the size limit');
        yield pending.slice(0,end).replace(/\r$/,'');
        pending=pending.slice(end+1);
      }
      if(pending.length>limit)throw new Error('Upstream frame exceeded the size limit');
    }
    if(pending.length)yield pending+decoder.decode();
  } finally {
    await reader.cancel().catch(()=>{});
    reader.releaseLock();
  }
}
