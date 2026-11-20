import { normalize,termKey,type Candidate,type Metrics,type Rule,type Score,type Settings,type Signal } from '../../packages/contracts/index';

const references = {likes:500,reposts:100,replies:100,views:50000};
const growthWeights = {likes:1,reposts:2,replies:1};
const hour = 3_600_000;
type Factors = {muted?:boolean;favorite?:boolean;feedback?:number;following?:number;likedAuthor?:number;repeated?:boolean;authorMedianLikes?:number;previous?:{collectedAt:number;metrics:Metrics}};

export function contains(text:string, term:string) {
  const literal = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}\\p{M}_#@])${literal}(?![\\p{L}\\p{N}\\p{M}_])`, 'u').test(text);
}

export function scorePost(post:Candidate, rule:Rule, settings:Settings, factors:Factors = {}): {result:Score|null;reason:string|null;unresolved:boolean} {
  const reject = (reason:string, unresolved=false) => ({result:null,reason,unresolved});
  const account = post.handle ? normalize(post.handle).replace(/^@/, '') : null;
  if (!rule.enabled) return reject('Watchlist paused');
  if (factors.muted) return reject('Author muted');
  if (rule.allowedAuthors.length && (!account || !rule.allowedAuthors.includes(account))) return reject('Author filter');
  if (rule.language && post.language?.toLowerCase() !== rule.language) return reject('Language filter');
  const text = normalize(post.text);
  const included = rule.terms.filter(t => t.direction === 'include');
  const matched = included.filter(t => contains(text,termKey(t)));
  if (rule.terms.some(t => t.direction === 'exclude' && contains(text,termKey(t)))) return reject('Excluded term');
  if (!matched.length || (rule.mode === 'ALL' && matched.length < included.length)) return reject('Required terms did not match');
  const counters = Object.keys(growthWeights) as (keyof typeof growthWeights)[];
  const engagement=counters.reduce((sum,key) => sum + (post.metrics[key] ?? 0),0);
  if (rule.minEngagement > engagement) {
    return reject('Below minimum engagement',engagement>=rule.minEngagement/2||counters.some(key => post.metrics[key] === null));
  }
  const relevance = .4 + .4 * matched.length / included.length
    + (matched.some(t => t.kind === 'phrase') ? .1 : 0)
    + (matched.some(t => t.important || settings.importantTerms.some(x => normalize(x) === termKey(t))) ? .1 : 0);
  const popularity = (Object.keys(references) as (keyof Metrics)[]).flatMap(key => {
    const count = post.metrics[key];
    return count === null ? [] : [Math.min(1,Math.log1p(count)/Math.log1p(references[key]))];
  });
  const baseline=factors.authorMedianLikes;
  const relative=baseline===undefined||post.metrics.likes===null?undefined:Math.min(1,(post.metrics.likes+1)/(2*(baseline+1)));
  const absolute=popularity.length?popularity.reduce((a,b)=>a+b,0)/popularity.length:undefined;
  let velocity: number | undefined;
  let detail: string | undefined;
  const previous = factors.previous;
  const age = post.createdAt === null ? -1 : (post.observedAt - post.createdAt) / hour;
  if (previous && post.observedAt - previous.collectedAt >= 300_000) {
    const changes = counters.flatMap(key => {
      const start = previous.metrics[key], end = post.metrics[key];
      return start === null || end === null || end < start ? [] : [(end-start)*growthWeights[key]];
    });
    if (changes.length) {
      velocity = changes.reduce((a,b) => a+b,0) * hour / (post.observedAt-previous.collectedAt);
      detail = 'Measured growth per hour';
    }
  } else if (!previous && age >= 0 && counters.some(key => post.metrics[key] !== null)) {
    velocity = counters.reduce((sum,key) => sum + (post.metrics[key] ?? 0)*growthWeights[key],0) / Math.max(age,.5);
    detail = 'Estimated growth from post age';
  }
  const values: Partial<Record<Signal,number>> = {
    term: Math.min(1,relevance),
    popularity:absolute===undefined||relative===undefined?absolute:.75*absolute+.25*relative,
    velocity: velocity === undefined ? undefined : Math.min(1,Math.log1p(velocity)/Math.log(101)),
    following:factors.following,likedAuthor:factors.likedAuthor,
    favorite:factors.favorite || (account && rule.favoriteAuthors.includes(account)) ? 1 : undefined,
    feedback:factors.feedback,
  };
  const signals:Score['signals'] = [];
  const unavailable:Signal[] = [];
  for (const key of Object.keys(values) as Signal[]) {
    const value = values[key], weight=settings.weights[key];
    if (!weight) continue;
    if (value === undefined) unavailable.push(key);
    else signals.push({key,value,weight,...(key === 'velocity' ? {detail} : key==='popularity'&&relative!==undefined?{detail:`Includes author-relative likes. Comparable median: ${baseline}.`}:{})});
  }
  const penalties:Score['penalties'] = [];
  if (new Set(post.text.match(/https?:\/\/[^\s]+/gi)).size >= 3) penalties.push({reason:'Three or more outbound links',points:10});
  if (factors.repeated) penalties.push({reason:'Author repeated the same text',points:15});
  const availableWeight = signals.reduce((a,s) => a+s.weight,0);
  const score = Math.round(Math.max(0,Math.min(100,100*signals.reduce((a,s) => a+s.value*s.weight,0)/availableWeight - penalties.reduce((a,p) => a+p.points,0))));
  return {reason:null,unresolved:false,result:{score,modelVersion:1,availableWeight,matched:matched.map(t=>t.text),signals,unavailable,penalties,
    classification:score>=rule.immediate?'immediate':score>=rule.standard?'standard':'silent'}};
}

let lastZone:string|undefined;
let timeFormatter:Intl.DateTimeFormat|undefined;
export function localTime(now:number, zone:string) {
  if(!timeFormatter||lastZone!==zone){
    timeFormatter=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
    lastZone=zone;
  }
  const parts = timeFormatter.formatToParts(now);
  const get = (type:string) => parts.find(part=>part.type===type)?.value;
  return {day:`${get('year')}-${get('month')}-${get('day')}`,time:`${get('hour')}:${get('minute')}`};
}
export function quietNow(now:number, quiet:Settings['quiet']) {
  if (!quiet.enabled) return false;
  const {time} = localTime(now,quiet.zone);
  return quiet.start < quiet.end ? time>=quiet.start && time<quiet.end : time>=quiet.start || time<quiet.end;
}
