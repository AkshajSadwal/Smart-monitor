import {z} from 'zod';
import {type Candidate,type Metrics,type Watchlist,termKey,unknownMetrics} from '../contracts/index';
export const tweetId=z.string().regex(/^\d{1,25}$/);
const tweetSchema=z.object({
  id:tweetId,text:z.string().max(100_000),author_id:tweetId.optional(),created_at:z.string().optional(),lang:z.string().max(35).optional(),
  note_tweet:z.object({text:z.string().max(100_000)}).optional(),
  public_metrics:z.record(z.string(),z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)).optional(),
  referenced_tweets:z.array(z.object({type:z.string(),id:tweetId})).optional(),
  edit_history_tweet_ids:z.array(tweetId).optional(),
});
export const userSchema=z.object({id:tweetId,username:z.string().max(30).optional(),name:z.string().max(200).optional()});
export const responseSchema=z.object({
  data:z.array(z.unknown()).optional(),includes:z.object({users:z.array(z.unknown()).optional()}).optional(),
  meta:z.object({next_token:z.string().max(4096).optional()}).optional(),
  errors:z.array(z.object({resource_id:tweetId.optional(),value:tweetId.optional(),type:z.string().optional()})).optional(),
});
export type FeedResponse=z.infer<typeof responseSchema>;
export function queryGroups(list:Watchlist) {
  const terms=list.terms.filter(t=>t.direction==='include').map(t=>{
    const key=termKey(t);
    if (t.kind==='phrase') return /^[\p{L}\p{M}\p{N}_#@ .,'‘’!?+-]+$/u.test(key)?`"${key}"`:null;
    if (!/^[#@]?[\p{L}\p{M}\p{N}_]+$/u.test(key)) return null;
    return /^[#@]/.test(key)?key:`"${key}"`;
  });
  if (list.mode==='ALL') {
    const candidate=terms.find((value):value is string=>value!==null&&encodeURIComponent(value).length<=510);
    return candidate?[candidate]:[];
  }
  if (terms.some(t=>t===null)) return [];
  const groups:string[]=[];
  let group='';
  for (const term of terms) {
    const next=group?`${group} OR ${term}`:term!;
    if (encodeURIComponent(next).length>510||[...next].length>510) {
      if (!group||encodeURIComponent(term!).length>510) return [];
      groups.push(group);
      group=term!;
    } else group=next;
  }
  if (group) groups.push(group);
  return groups;
}
export function normalizeResponse(body:FeedResponse,now:number,observation:string) {
  const users=new Map(body.includes?.users?.flatMap(raw=>{
    const user=userSchema.safeParse(raw);
    return user.success?[[user.data.id,user.data] as const]:[];
  }));
  return (body.data??[]).flatMap((raw):Candidate[]=>{
    const valid=tweetSchema.safeParse(raw);
    if (!valid.success) return [];
    const t=valid.data,reference=t.referenced_tweets?.find(r=>r.type==='retweeted')??t.referenced_tweets?.at(0);
    const dates=t.created_at ? Date.parse(t.created_at) : NaN;
    const p=t.public_metrics??{};
    const metrics:Metrics={...unknownMetrics,likes:p.like_count??null,reposts:p.retweet_count??null,replies:p.reply_count??null,views:p.impression_count??null};
    const user=t.author_id?users.get(t.author_id):undefined;
    return [{namespace:'x',id:t.id,canonicalId:reference?.type==='retweeted'?reference.id:(t.edit_history_tweet_ids?.[0]??t.id),
      text:t.note_tweet?.text??t.text,authorId:t.author_id??null,handle:user?.username??null,displayName:user?.name??null,
      language:t.lang??null,createdAt:Number.isFinite(dates)?dates:null,
      kind:reference?.type==='retweeted'?'repost':reference?.type==='replied_to'?'reply':reference?.type==='quoted'?'quote':reference?'unknown':'original',
      metrics,observedAt:now,observation:`${observation}:${t.id}`}];
  });
}
