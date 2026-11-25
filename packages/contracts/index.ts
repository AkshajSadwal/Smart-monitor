import { z } from 'zod';

export const normalize = (text: string) => text.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
export const handle = z.string().trim().regex(/^@?[\p{L}\p{N}_]{1,30}$/u).transform(v => normalize(v).replace(/^@/, ''));
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const threshold = z.number().int().min(0).max(100);
export const term = z.strictObject({
  direction: z.enum(['include', 'exclude']),
  kind: z.enum(['word', 'phrase', 'hashtag']),
  text: z.string().trim().min(1).refine(v => [...v].length <= 100),
  important: z.boolean().default(false),
}).refine(t => t.kind === 'phrase' || (t.kind === 'hashtag' ? /^#?[\p{L}\p{M}\p{N}_]+$/u : /^@?[\p{L}\p{M}\p{N}_]+$/u).test(normalize(t.text)), { path: ['text'], message: 'Choose Phrase for terms with spaces or punctuation.' });
export const watchlist = z.strictObject({
  name: z.string().trim().min(1).max(80), enabled: z.boolean().default(true),
  mode: z.enum(['ANY', 'ALL']).default('ANY'),
  terms: z.array(term).min(1).max(32),
  allowedAuthors: z.array(handle).max(100).default([]),
  favoriteAuthors: z.array(handle).max(100).default([]),
  language: z.string().regex(/^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/i).toLowerCase().nullable().default(null),
  minEngagement: counter.default(0), standard: threshold.default(70), immediate: threshold.default(85),
  cooldownSeconds: z.number().int().min(0).max(86400).default(300),
}).superRefine((v, ctx) => {
  if (!v.terms.some(t => t.direction === 'include')) ctx.addIssue({ code:'custom', path:['terms'], message:'Add at least one included term.' });
  if (v.standard > v.immediate) ctx.addIssue({ code:'custom', path:['immediate'], message:'Immediate must be at least the standard threshold.' });
}).transform(v => ({
  ...v, terms: [...new Map(v.terms.map(t => [`${t.direction}/${t.kind}/${termKey(t)}`, t])).values()],
  allowedAuthors: [...new Set(v.allowedAuthors)], favoriteAuthors: [...new Set(v.favoriteAuthors)],
}));
export function termKey(t: {kind:string; text:string}) {
  const value = normalize(t.text);
  return t.kind === 'hashtag' ? '#' + value.replace(/^#/, '') : value;
}
export type Rule = z.output<typeof watchlist>;
export type Watchlist = Rule & {id:string; revision:number; createdAt:number; updatedAt:number; matches:number};
export const defaultWeights = {term:35, popularity:20, velocity:15, following:10, likedAuthor:5, favorite:10, feedback:5};
export const DEFAULT_POLL_SECONDS=300;
export const X_MIN_POLL_SECONDS=120;
export type Signal = keyof typeof defaultWeights;
const wallTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const zone = z.string().max(80).refine(value => {
  try { new Intl.DateTimeFormat('en', {timeZone:value}); return true; } catch { return false; }
}, 'Use a valid IANA time zone.');
export const settingsSchema = z.strictObject({
  intervalSeconds: z.number().int().min(60).max(3600),
  dailyCap: z.number().int().min(0).max(1000),
  quiet: z.strictObject({enabled:z.boolean(), start:wallTime, end:wallTime, zone}).refine(v => !v.enabled || v.start !== v.end, 'Choose distinct quiet-hour endpoints.'),
  weights: z.strictObject({...Object.fromEntries(Object.keys(defaultWeights).map(key => [key, threshold])) as Record<Signal, typeof threshold>, term:threshold.min(1)}),
  importantTerms:z.array(z.string().trim().min(1).max(100)).max(32),
  retentionDays:z.number().int().min(1).max(90),
  reduceMotion:z.boolean(), nativeNotifications:z.boolean(),
  simulatedNotifications:z.boolean().default(false),
  officialEmbeds:z.boolean().default(false),
});
export type Settings = z.infer<typeof settingsSchema>;
export const defaults: Settings = {
  intervalSeconds:DEFAULT_POLL_SECONDS, dailyCap:20, quiet:{enabled:false,start:'22:00',end:'08:00',zone:Intl.DateTimeFormat().resolvedOptions().timeZone},
  weights:defaultWeights, importantTerms:[], retentionDays:30, reduceMotion:false, nativeNotifications:true,
  simulatedNotifications:false,officialEmbeds:false,
};
export const feedbackSchema = z.strictObject({rating:z.enum(['useful','irrelevant']).nullable(),favorite:z.boolean()});
export const preferencesSchema = z.strictObject({muted:z.boolean(),favorite:z.boolean()});
export type Feedback = z.infer<typeof feedbackSchema>;
export type Preferences = z.infer<typeof preferencesSchema>;
export const metricsSchema = z.strictObject({likes:counter.nullable(),reposts:counter.nullable(),replies:counter.nullable(),views:counter.nullable(),quotes:counter.nullable().optional()});
export type Metrics = z.infer<typeof metricsSchema>;
export const unknownMetrics: Metrics = {likes:null,reposts:null,replies:null,views:null};
export const postMediaSchema=z.strictObject({
  kind:z.enum(['photo','video','gif']),url:z.string().max(512).regex(/^https:\/\/pbs\.twimg\.com\//).nullable(),
  width:counter.nullable(),height:counter.nullable(),alt:z.string().max(1000).nullable(),durationMs:counter.nullable(),
});
export const kindSchema = z.enum(['original','reply','repost','quote','unknown']);
export const namespaceSchema = z.enum(['mock','x']);
export type Source = z.infer<typeof namespaceSchema>;
export const collectorSchema = z.enum(['mock','session']);
export type CollectorId = z.infer<typeof collectorSchema>;
export const historyCollectorSchema = z.enum(['mock','session','manual','hosted','x']);
export type HistoryCollectorId = z.infer<typeof historyCollectorSchema>;
export const collectorLabel:Record<HistoryCollectorId,string> = {
  mock:'Simulated',session:'Local X Account',manual:'Manual X imports',hosted:'Earlier remote collection',x:'Earlier X collection',
};
export type Candidate = {
  namespace: Source; id:string; canonicalId:string; text:string; authorId:string|null; handle:string|null;
  displayName:string|null; language:string|null; createdAt:number|null; kind:z.infer<typeof kindSchema>;
  metrics:Metrics; observedAt:number; observation:string;
  media?:z.infer<typeof postMediaSchema>[]|null;
  collector?:CollectorId|'manual';
};
export type Classification = 'silent'|'standard'|'immediate'|'delayed';
export type Score = {
  score:number; modelVersion:1; availableWeight:number; matched:string[];
  signals:{key:Signal;value:number;weight:number;detail?:string}[];
  unavailable:Signal[]; penalties:{reason:string;points:number}[];
  classification:Classification; previousScore?:number;
};
export type Match = Score & {listId:string;listName:string;revision:number;suppression:string|null};
export type Post = Omit<Candidate,'observation'|'text'|'collector'|'media'> & {
  text:string|null; originalUrl:string|null; firstSeenAt:number; simulated:boolean; matches:Match[];
  feedback:Feedback; preferences:Preferences; snapshots?:{collectedAt:number;metrics:Metrics}[];
  preview?:'simulation'|'user-shared'|'manual-import'|'local-collection'|'metadata'|'unresolved'|'stale';
  collector?:HistoryCollectorId;
  provenance?:HistoryCollectorId[];
  media?:z.infer<typeof postMediaSchema>[];
};
export type Alert = {
  id:string; namespace:Source; postId:string|null; listName:string|null; decisionAt:number;
  kind:Exclude<Classification,'silent'>; score:number; readAt:number|null; dispatchState:string;
  reason:string; originalUrl:string|null;
};
export type MonitorStatus = {
  paused:boolean; source:CollectorId; status:string; lastSuccess:number|null; nextDue:number|null;
  error:string|null; gap:string|null; intervalSeconds:number;
  coverage?:CollectionCoverage;
};
export type CollectionCoverage = {
  lastAttempt:number|null; pages:number; posts:number; oldest:number|null; newest:number|null;
};
export type Overview = {today:number;priority:number;lists:number;unread:number;status:MonitorStatus};
export const browserAccountSchema = z.discriminatedUnion('status',[
  z.strictObject({status:z.literal('Connected'),persistent:z.boolean(),handle:z.string().regex(/^[a-z0-9_]{1,15}$/i)}),
  z.strictObject({
    status:z.enum(['Check required','Profile confirmation required','Authentication required','Verification required','Session expired',
      'Restricted','Rate limited','Temporarily unavailable','Disconnected']),
    persistent:z.boolean(),
  }),
]);
export type BrowserAccount = z.infer<typeof browserAccountSchema>;
export const browserActionSchema = z.discriminatedUnion('action',[
  z.strictObject({action:z.literal('open'),remember:z.boolean()}),
  z.strictObject({action:z.enum(['check','confirm','disconnect'])}),
]);
export type BrowserAction = z.infer<typeof browserActionSchema>;
export type SourceInfo = {
  id:CollectorId; active:boolean; configured:boolean; status:string; capabilities:string[];
  error:string|null; lastSuccess:number|null; gap?:string|null;
  nextDue:number|null; postCount:number;
  browser?:BrowserAccount&{available:boolean};
  account?:string|null;
  coverage?:CollectionCoverage;
  manualPosts?:number;
  pythonWorker?:string;
  requestUsage?:RequestUsage;
};
export type RequestUsage = {
  hour:{used:number;limit:number};day:{used:number;limit:number};heldUntil:number|null;
};
