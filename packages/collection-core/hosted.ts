import {z} from 'zod';
import {kindSchema,metricsSchema,normalize} from '../contracts/index';

// A public topic is one literal phrase. The operator never receives local filters or accounts.
export const topicSchema=z.string().trim().min(1).max(100)
  .transform(normalize)
  .refine(value=>/^[\p{L}\p{M}\p{N}_# .,'‘’!?+-]+$/u.test(value)&&/[\p{L}\p{N}]/u.test(value),'Use a public keyword, hashtag, or literal phrase.');
export const topicsSchema=z.array(topicSchema).max(16).transform(topics=>[...new Set(topics)].sort());
export const deliverySchema=z.enum(['disabled','simulated','ids','approved-public']);
export type Delivery=z.infer<typeof deliverySchema>;
export const hostedPost=z.strictObject({
  namespace:z.enum(['mock','x']),id:z.string().regex(/^[\w-]{1,100}$/),canonicalId:z.string().regex(/^[\w-]{1,100}$/),
  text:z.string().max(100_000),authorId:z.string().max(100).nullable(),handle:z.string().max(30).nullable(),
  displayName:z.string().max(200).nullable(),language:z.string().max(35).nullable(),createdAt:z.number().int().nonnegative().nullable(),
  kind:kindSchema,metrics:metricsSchema,observedAt:z.number().int().nonnegative(),observation:z.string().max(200),
}).refine(p=>p.namespace==='mock'||[p.id,p.canonicalId].every(id=>/^\d{1,25}$/.test(id)));
export const hostedEvent=z.strictObject({
  topic:topicSchema,delivery:z.enum(['simulated','ids','approved-public']),post:hostedPost,
}).superRefine(({delivery,post},ctx)=>{
  if((post.namespace==='mock')!==(delivery==='simulated')||(delivery==='ids'&&(post.text||post.authorId||post.handle||post.displayName||post.language||
    post.createdAt!==null||Object.values(post.metrics).some(value=>value!==null))))ctx.addIssue({code:'custom',message:'Invalid hosted publication'});
});
export const hostedStatus=z.object({
  delivery:deliverySchema,serverTime:z.number().int().nonnegative(),
  topics:z.array(z.object({topic:topicSchema,state:z.string().max(100)})).max(16),
});
