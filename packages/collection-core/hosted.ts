import {z} from 'zod';
import {normalize,type Watchlist} from '../contracts/index';
import {collectedPost} from './collector';

// A public topic is one literal phrase. The operator never receives local filters or accounts.
export const topicSchema=z.string().trim().min(1).max(100)
  .transform(normalize)
  .refine(value=>/^[\p{L}\p{M}\p{N}_# .,'‘’!?+-]+$/u.test(value)&&/[\p{L}\p{N}]/u.test(value),'Use a public keyword, hashtag, or literal phrase.');
export const topicsSchema=z.array(topicSchema).max(16).transform(topics=>[...new Set(topics)].sort());
export function publicTopics(lists:Watchlist[]) {
  return [...new Set(lists.filter(list=>list.enabled).flatMap(list=>list.terms.flatMap(term=>{
    if(term.direction!=='include')return [];
    const parsed=topicSchema.safeParse(term.kind==='hashtag'?'#'+normalize(term.text).replace(/^#/,''):term.text);
    return parsed.success?[parsed.data]:[];
  })))].sort();
}
export const deliverySchema=z.enum(['disabled','simulated','ids','metadata','approved-public']);
export type Delivery=z.infer<typeof deliverySchema>;
export const hostedEvent=z.strictObject({
  topic:topicSchema,delivery:z.enum(['simulated','ids','metadata','approved-public']),post:collectedPost,
  resolution:z.enum(['unresolved','resolved']).optional(),
}).superRefine(({delivery,post,resolution},ctx)=>{
  if((post.namespace==='mock')!==(delivery==='simulated')||(delivery==='ids'&&(post.text||post.authorId||post.handle||post.displayName||post.language||
    post.createdAt!==null||Object.values(post.metrics).some(value=>value!==null)))||
    (delivery==='metadata'&&(post.text||post.authorId||post.handle||post.displayName||post.language))||
    (resolution!==undefined&&((resolution==='resolved')!==!!post.text)))ctx.addIssue({code:'custom',message:'Invalid hosted publication'});
});
export const hostedStatus=z.object({
  delivery:deliverySchema,serverTime:z.number().int().nonnegative(),
  provider:z.enum(['disabled','simulation','website-session']).catch('disabled').optional(),
  topics:z.array(z.object({topic:topicSchema,state:z.string().max(100)})).max(16),
});
