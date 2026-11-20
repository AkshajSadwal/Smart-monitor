import {type Candidate, unknownMetrics} from '../packages/contracts/index';

const timeline = [
  {id:'demo-01',handle:'devjournal',name:'Dev Journal',body:'SQLite preview is out for testing. The query planner changes are worth a look.',likes:20,age:120},
  {id:'demo-02',handle:'buildnotes',name:'Build Notes',body:'SQLite ships a smaller test build for embedded tools. Early feedback is welcome.',likes:null,age:null},
  {id:'demo-03',handle:'releasewatch',name:'Release Watch',body:'SQLite release candidate is ready. Maintainers are reviewing changes to the WAL checkpoint path.',likes:null,age:null},
  {id:'demo-04',handle:'opentools',name:'Open Tools',body:'SQLite release candidate hiring thread for maintainers.',likes:null,age:8},
  {id:'demo-05',handle:'devjournal',name:'Dev Journal',body:'SQLite preview follow-up covers indexing and query tracing.',likes:20,age:120},
  {id:'demo-06',handle:'runtimeweekly',name:'Runtime Weekly',body:'Node.js release notes cover the built-in test runner and startup performance. #JavaScript',likes:55,age:28},
  {id:'demo-07',handle:'graphicslab',name:'Graphics Lab',body:'WebGPU tools can now visualize shader timings in real time. #ThreeJS',likes:94,age:46},
  {id:'demo-08',handle:'signalreview',name:'Signal Review',body:'A new AI benchmark compares local language models on tool use and reasoning. #AI',likes:59,age:18},
];

export function simulatedPage(cursor:number,now:number,run=0): {posts:Candidate[];cursor:number} {
  if (cursor>=timeline.length) return {posts:[],cursor};
  const rows = timeline.slice(cursor,cursor===0?3:cursor+1);
  return {posts:rows.map(row=>{
    const id=run?`${row.id}-run-${run}`:row.id;
    return ({
    namespace:'mock',id,canonicalId:id,text:row.body,authorId:row.handle,handle:row.handle,
    displayName:row.name,language:'en',createdAt:row.age===null?null:now-row.age*60_000,kind:'original',
    metrics:{...unknownMetrics,likes:row.likes},observedAt:now,observation:`initial:${id}`,
    });}),cursor:cursor+rows.length};
}

export function simulatedLookup(post:Candidate,attempt:number,now:number):Candidate {
  const likes = post.id.split('-run-')[0]==='demo-01' ? (attempt===1?100:145) : post.metrics.likes;
  return {...post,metrics:{...post.metrics,likes},observedAt:now,observation:`recheck:${attempt}:${post.id}`};
}
