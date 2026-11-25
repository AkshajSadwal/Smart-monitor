import assert from 'node:assert/strict';
import test from 'node:test';
import {abortable,readJson,resetTime} from '../packages/collection-core/http';

const encoder=new TextEncoder();
const stream=(...chunks:Uint8Array[])=>new ReadableStream<Uint8Array>({start(c){for(const chunk of chunks)c.enqueue(chunk);c.close();}});

test('bounded JSON reader preserves split UTF-8 and whitespace',async()=>{
  const bytes=encoder.encode('{"text":"é🙂"}\n');
  assert.deepEqual(await readJson(stream(bytes.slice(0,10),bytes.slice(10,12),bytes.slice(12)),new AbortController().signal),{text:'é🙂'});
});

test('JSON reader enforces byte limit and rejects invalid responses',async()=>{
  const signal=new AbortController().signal;
  await assert.rejects(readJson(stream(encoder.encode('"é"')),signal,3),/size limit/);
  await assert.rejects(readJson(stream(Uint8Array.of(0xff)),signal));
  await assert.rejects(readJson(stream(encoder.encode('{')),signal),SyntaxError);
});

test('cancellation releases a stalled response and ignores a stalled request',async()=>{
  const controller=new AbortController();
  let cancelled=false;
  const body=new ReadableStream<Uint8Array>({cancel(){cancelled=true;}});
  const pending=readJson(body,controller.signal);
  const request=abortable(new Promise<void>(()=>{}),controller.signal);
  controller.abort(new Error('cancelled'));
  await Promise.all([assert.rejects(pending,/cancelled/),assert.rejects(request,/cancelled/)]);
  assert.equal(cancelled,true);
  assert.equal(body.locked,false);
});

test('rate limit reset uses the later valid header and ignores overflowing values',()=>{
  const now=1_700_000_000_000;
  assert.equal(resetTime(new Headers({'retry-after':'120','x-rate-limit-reset':String(now/1000+180)}),now),now+180_000);
  assert.equal(resetTime(new Headers({'retry-after':'999999999999999999999999999','x-rate-limit-reset':'Infinity'}),now,60_000),now+60_000);
});
