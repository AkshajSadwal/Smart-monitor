import {z} from 'zod';
import {unknownMetrics,type Candidate} from '../../packages/contracts/index';
import {ApiError} from './api';
import {hash} from './storage';

const permalink=z.url().max(600);
const text=z.string().trim().min(1).max(5000);
const language=z.string().regex(/^[a-z]{2,3}$/i).optional();
const count=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const manualPost=z.strictObject({
  url:permalink,text,author:z.string().trim().regex(/^@?[a-z0-9_]{1,15}$/i).optional(),
  createdAt:z.iso.datetime({offset:true}).optional(),language,
  metrics:z.strictObject({likes:count.optional(),reposts:count.optional(),replies:count.optional(),views:count.optional()}).optional(),
});
const shareSchema=z.strictObject({url:permalink,excerpt:text,language,consent:z.literal(true)});
const importSchema=z.strictObject({consent:z.literal(true),posts:z.array(manualPost).min(1).max(50)});

function normalizePost(post:z.infer<typeof manualPost>,now:number):Candidate {
  const url=new URL(post.url);
  if(url.protocol!=='https:'||!['x.com','www.x.com','twitter.com','www.twitter.com'].includes(url.hostname)||url.port||url.username||url.password)
    throw new ApiError(400,'INVALID_POST_LINK','Paste an HTTPS link to the selected X post.');
  const match=url.pathname.match(/^\/(i\/web|[A-Za-z0-9_]{1,30})\/status\/(\d{1,25})\/?$/);
  if(!match)throw new ApiError(400,'INVALID_POST_LINK','Paste a direct X post permalink.');
  const [,pathname,id]=match;
  const handle=(post.author??(pathname==='i/web'?null:pathname))?.replace(/^@/,'').toLowerCase()??null;
  const createdAt=post.createdAt?Date.parse(post.createdAt):null;
  if(createdAt!==null&&(createdAt<0||createdAt>now+60_000))
    throw new ApiError(400,'INVALID_POST_DATE','Use a valid post timestamp at or before the current time.');
  const metrics={...unknownMetrics,...post.metrics};
  const details={id,text:post.text,handle,createdAt,language:post.language?.toLowerCase()??null,metrics};
  return {...details,namespace:'x',canonicalId:id,authorId:handle?'handle-'+handle:null,displayName:null,
    kind:'unknown',observedAt:now,observation:'manual:'+hash(JSON.stringify(details)),collector:'manual'};
}

export function selectedPost(input:unknown,now:number) {
  const {url,excerpt,language}=shareSchema.parse(input);
  return normalizePost({url,text:excerpt,language},now);
}

export function importedPosts(input:unknown,now:number) {
  const {posts}=importSchema.parse(input);
  return posts.map(post=>normalizePost(post,now));
}
