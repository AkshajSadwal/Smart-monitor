import {unknownMetrics,type Candidate} from '../../../packages/contracts/index';
import {hostedEvent,type Delivery} from '../../../packages/collection-core/hosted';

export function publication(mode:Delivery,topic:string,post:Candidate){
  if(mode==='disabled')return null;
  const permitted=mode==='ids'||mode==='metadata'?{
    namespace:post.namespace,id:post.canonicalId,canonicalId:post.canonicalId,text:'',authorId:null,handle:null,displayName:null,language:null,
    createdAt:mode==='metadata'?post.createdAt:null,kind:'unknown' as const,
    metrics:mode==='metadata'?post.metrics:unknownMetrics,observedAt:post.observedAt,
    observation:mode==='metadata'?`metadata:${post.canonicalId}:${post.observedAt}`:`id:${post.canonicalId}`,
  }:post;
  return hostedEvent.parse({topic,delivery:mode,post:permitted,resolution:permitted.text?'resolved':'unresolved'});
}
