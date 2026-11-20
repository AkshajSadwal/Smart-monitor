import {createHash,randomBytes} from 'node:crypto';
import {z} from 'zod';
import {normalizeResponse,queryGroups,responseSchema,searchResponseSchema,tweetId,userSchema,type FeedResponse} from '../../packages/collection-core/x-protocol';
export {queryGroups} from '../../packages/collection-core/x-protocol';
import {type Candidate,type Watchlist} from '../../packages/contracts/index';
import {ApiError,paid} from './api';
import {hash,type Store} from './storage';
import type {LiveCollector} from './monitor';
import {lines,resetTime} from '../../packages/collection-core/http';

const second=1000, minute=60*second,hour=60*minute,day=24*hour;
const oauthSchema=z.strictObject({clientId:z.string().min(8).max(128).regex(/^[\w-]+$/),following:z.boolean(),likes:z.boolean(),refresh:z.boolean().default(false)});
const authorization=z.object({access_token:z.string().min(5).max(8192),scope:z.string().max(512).optional(),refresh_token:z.string().min(5).max(8192).optional(),expires_in:z.number().int().positive().max(30*86400).optional()});
const shortTime=(epoch:number)=>new Date(Math.floor(epoch/second)*second).toISOString().replace('.000Z','Z');
const tweetFields='author_id,created_at,lang,public_metrics,referenced_tweets,edit_history_tweet_ids,note_tweet,entities';

type Receive=typeof fetch;
type Cursor={completed:number|null;start:number;end:number;token?:string;pending:boolean;initial:boolean;oldEnd:number;partial?:boolean};
type SignalConsent={clientId:string;following:boolean;likes:boolean};
type Pending=SignalConsent & {refresh:boolean;verifier:string;expires:number;generation:number;redirect:string};
type OAuthSettings=SignalConsent & {accountId:string;scope:string;next:number};
type SessionGrant=SignalConsent & {accountId:string;username:string|null;expiresAt:number;renewable:boolean};
type SignalProgress={token?:string;complete:boolean;begun:number;retry?:boolean};
export const collectorOptions=z.strictObject({
  pages:z.number().int().min(1).max(12),pageSize:z.number().int().min(10).max(100),
  recoveryHours:z.number().int().min(1).max(168),stream:z.boolean(),
});
export const xOptions={pages:4,pageSize:10,recoveryHours:1,stream:false};

export interface Vault { get(key:string):Promise<string|null>; set(key:string,value:string):Promise<void>; remove(key:string):Promise<void> }
export class OSVault implements Vault {
  constructor(private readonly profile:string) {}
  private async entry(key:string) {
    try {
      const {AsyncEntry}=await import('@napi-rs/keyring');
      return new AsyncEntry('X Smart Monitor',hash(this.profile).slice(0,20)+'-'+key);
    } catch {throw new ApiError(503,'VAULT_UNAVAILABLE','The OS credential store is unavailable.');}
  }
  async get(key:string) {
    try {return await(await this.entry(key)).getPassword()??null;}
    catch {throw new ApiError(503,'VAULT_UNAVAILABLE','Unlock your OS credential store and try again.');}
  }
  async set(key:string,value:string) {
    try {await(await this.entry(key)).setPassword(value);}
    catch {throw new ApiError(503,'VAULT_UNAVAILABLE','Unlock your OS credential store and try again.');}
  }
  async remove(key:string) {
    try {
      const entry=await this.entry(key);
      if(await entry.getPassword())await entry.deleteCredential();
    }
    catch {throw new ApiError(503,'VAULT_UNAVAILABLE','Unlock your OS credential store to finish removing the saved credential.');}
  }
}

type Issue='RATE_LIMIT'|'NETWORK'|'ACCESS_DENIED'|'CREDITS_REQUIRED'|'BUDGET_EXHAUSTED'|'CREDENTIAL_REQUIRED'|'SESSION_EXPIRED'|'VERIFICATION_REQUIRED'|'UPSTREAM_INVALID'|'PAGE_INVALID';
class XIssue extends Error {constructor(readonly code:Issue,readonly retryAt:number|null=null) {super(code);}}

export class XApi implements LiveCollector {
  private chain=Promise.resolve<unknown>(undefined);
  private pending=new Map<string,Pending>();
  readonly capabilities=['Recent search polling','Budgeted engagement lookup','Optional personal signals'];
  constructor(readonly store:Store,readonly vault:Vault,readonly transport:Receive=fetch,readonly changed:()=>void=()=>{},
    readonly id:'x'|'session'='x') {}
  private get row(){return this.store.sources.find(row=>row.id===this.id)!;}
  get settings(){return this.store.value(`${this.id}:options`,xOptions);}
  get account(){return this.store.value<SessionGrant|null>('session:grant',null);}
  configure(input:unknown) {
    const options=collectorOptions.parse(input);
    if(this.id==='session'&&options.stream)throw new ApiError(400,'UNSUPPORTED','Filtered Stream requires app-only authentication.');
    if(options.stream&&!paid(this.store.settings))throw new ApiError(409,'BUDGET_REQUIRED','Confirm a provider-side spending ceiling first.');
    this.store.set(`${this.id}:options`,options);
    if(this.id==='x'){
      this.store.set('x:stream-next',0);
      this.store.set('x:stream-note',null);
    }
    this.changed();
    return options;
  }
  private serialize<T>(work:()=>Promise<T>) {
    const result=this.chain.then(work);
    this.chain=result.catch(()=>{});
    return result;
  }
  private reserve(now:number,resources:number) {
    const settings=this.store.settings;
    if (!paid(settings)) throw new XIssue('BUDGET_EXHAUSTED');
    const date=new Date(now).toISOString().slice(0,10);
    this.store.db.transaction(()=>{
      const row=this.store.get<{requests:number;resources:number}>('SELECT * FROM usage_buckets WHERE day=?',date);
      if ((row?.requests??0)+1>settings.dailyRequests||(row?.resources??0)+resources>settings.dailyResources) throw new XIssue('BUDGET_EXHAUSTED',Date.parse(date)+day);
      this.store.run('INSERT INTO usage_buckets VALUES (?,1,?) ON CONFLICT(day) DO UPDATE SET requests=requests+1,resources=resources+excluded.resources',date,resources);
    })();
  }
  private async get(path:string,parameters:URLSearchParams,now:number,resources:number,signal:AbortSignal,delegated?:string) {
    signal.throwIfAborted();
    const source=this.store.sources.find(s=>s.id===this.id)!;
    if ((!delegated&&(!source.active||!source.configured)) || this.store.value('erase:pending',false)) throw new XIssue('CREDENTIAL_REQUIRED');
    let token:string|null;
    try {token=delegated??(this.id==='session'?await this.sessionToken(now,signal):await this.vault.get('bearer'));}
    catch(error) {throw error instanceof XIssue?error:new XIssue('CREDENTIAL_REQUIRED');}
    if (!token) throw new XIssue('CREDENTIAL_REQUIRED');
    signal.throwIfAborted();
    if (this.store.sources.find(s=>s.id===this.id)?.generation!==source.generation) throw new XIssue('CREDENTIAL_REQUIRED');
    const rateAt=this.store.value(`${this.id}:rate-at`,0);
    if (rateAt>now) throw new XIssue('RATE_LIMIT',rateAt);
    this.reserve(now,resources);
    let response:Response;
    try {
      response=await this.transport(`https://api.x.com/2/${path}?${parameters}`,{headers:{Authorization:'Bearer '+token},signal:AbortSignal.any([signal,AbortSignal.timeout(20_000)]),redirect:'error'});
    } catch {throw new XIssue('NETWORK');}
    signal.throwIfAborted();
    if(!response.ok&&response.status!==403)await response.body?.cancel().catch(()=>{});
    if (response.status===429) {
      const at=resetTime(response.headers,now,minute)+Math.floor(Math.random()*2000);
      this.store.set(`${this.id}:rate-at`,at);
      throw new XIssue('RATE_LIMIT',at);
    }
    if (response.headers.get('x-rate-limit-remaining')==='0') {
      const at=Number(response.headers.get('x-rate-limit-reset'))*1000;
      if (Number.isFinite(at)&&at>now) this.store.set(`${this.id}:rate-at`,at+1000);
    }
    if (response.status===401) throw new XIssue(this.id==='session'&&!delegated?'SESSION_EXPIRED':'CREDENTIAL_REQUIRED');
    if (response.status===402) throw new XIssue('CREDITS_REQUIRED');
    if (response.status===403) {
      const payload=await response.json().catch(()=>null) as {type?:unknown}|null;
      if (typeof payload?.type==='string'&&/(?:usage-capped|credits-depleted|credits-required)/i.test(payload.type)) throw new XIssue('CREDITS_REQUIRED');
      if (typeof payload?.type==='string'&&/(?:challenge|verification)/i.test(payload.type))throw new XIssue('VERIFICATION_REQUIRED');
      throw new XIssue('ACCESS_DENIED');
    }
    if (response.status===400) throw new XIssue('PAGE_INVALID');
    if (!response.ok) throw new XIssue('NETWORK');
    return response.json() as Promise<unknown>;
  }
  private fields(extra:Record<string,string>) {
    return new URLSearchParams({...extra,'tweet.fields':tweetFields,expansions:'author_id','user.fields':'username,name'});
  }
  private failure(error:unknown,now:number) {
    const issue=error instanceof XIssue?error:new XIssue('UPSTREAM_INVALID');
    const states:Record<Issue,string>={
      RATE_LIMIT:'Rate limited',NETWORK:'Backoff',ACCESS_DENIED:'Access denied',CREDITS_REQUIRED:'Credits required',
      BUDGET_EXHAUSTED:'Budget paused',CREDENTIAL_REQUIRED:'Authorization required',UPSTREAM_INVALID:'Invalid API response',PAGE_INVALID:'Query or cursor rejected',
      SESSION_EXPIRED:'Session expired',VERIFICATION_REQUIRED:'Verification required',
    };
    this.store.run('UPDATE data_sources SET status=?,error_code=? WHERE id=?',states[issue.code],issue.code,this.id);
    const attempt=this.store.value(`${this.id}:attempt`,0)+1;
    this.store.set(`${this.id}:attempt`,attempt);
    const terminal=['ACCESS_DENIED','CREDITS_REQUIRED','CREDENTIAL_REQUIRED','SESSION_EXPIRED','VERIFICATION_REQUIRED','PAGE_INVALID'].includes(issue.code);
    if(issue.code==='BUDGET_EXHAUSTED'||issue.code==='CREDITS_REQUIRED'){
      this.store.changeCoverage(this.id,{budgetBlocked:true});
      this.store.run('UPDATE data_sources SET gap=? WHERE id=?','Collection may be incomplete because the request or resource budget stopped retrieval.',this.id);
    }
    this.store.set(`${this.id}:hold`,terminal);
    this.store.set(`next:${this.id}`,terminal?Number.MAX_SAFE_INTEGER:issue.retryAt??now+Math.min(30*minute,30*second*2**Math.min(10,attempt-1))+Math.floor(Math.random()*3000));
  }
  collect(lists:Watchlist[],now:number,signal:AbortSignal,commit:Parameters<LiveCollector['collect']>[3]) {
    return this.serialize(async()=>{
      if(this.store.value(`${this.id}:hold`,false)) {
        this.store.set(`next:${this.id}`,Number.MAX_SAFE_INTEGER);
        return false;
      }
      this.store.changeCoverage(this.id,{lastAttempt:now,pages:0,posts:0,budgetBlocked:false});
      const {pages,pageSize,recoveryHours}=this.settings;
      const byQuery=new Map<string,string[]>();
      let unsupported=0;
      for(const list of lists) {
        const queries=queryGroups(list);
        if(!queries.length||list.mode==='ANY'&&list.terms.some(term=>term.direction==='include'&&!queryGroups({...list,terms:[term]}).length))unsupported++;
        for(const query of queries) {
          const keys=byQuery.get(query)??[];
          keys.push(`cursor:${this.id}:${list.id}:${list.revision}:${hash(query).slice(0,12)}`);
          byQuery.set(query,keys);
        }
      }
      const groups=[...byQuery].map(([query,legacy])=>({query,legacy,key:`cursor:${this.id}:${hash(query)}`}));
      if (groups.length===0) {
        this.store.run(`UPDATE data_sources SET status='No supported queries',error_code='LOCAL_ONLY_RULES' WHERE id='${this.id}'`);
        return false;
      }
      let useful=false, partial=false, capped=false, olderGap=false;
      try {
        const offset=this.store.value(`${this.id}:group-offset`,0)%groups.length;
        for (let n=0;n<Math.min(groups.length,12);n++) {
          const index=(offset+n)%groups.length;
          const {query,key,legacy}=groups[index];
          this.store.set(`${this.id}:group-offset`,(index+1)%groups.length);
          const end=Math.floor((now-40*second)/second)*second;
          const old=this.store.value<Cursor|null>(key,null)??legacy.map(k=>this.store.value<Cursor|null>(k,null)).find(Boolean);
          if (old?.completed!==null && old?.completed!==undefined && old.completed>=end && !old.pending) continue;
          const initial=!old||old.completed===null;
          const previous=old?.completed??old?.start??end-15*minute;
          const earliest=end-recoveryHours*hour;
          if(end-previous>recoveryHours*hour||(old?.pending&&old.start<earliest))olderGap=true;
          let cursor:Cursor=old?.pending&&old.start>=earliest?old:{completed:old?.completed??null,start:Math.max(previous,earliest),end,initial,oldEnd:previous,pending:true};
          if(cursor.start>=cursor.end)continue;
          commit([],true,key,cursor);
          for(let page=0;page<pages;page++) {
            const params=this.fields({query,start_time:shortTime(cursor.start),end_time:shortTime(cursor.end),max_results:String(pageSize),sort_order:'recency'});
            if(cursor.token) params.set('next_token',cursor.token);
            let body:FeedResponse;
            try {body=searchResponseSchema.parse(await this.get('tweets/search/recent',params,now,pageSize*2,signal));}
            catch(error) {
              if(error instanceof XIssue&&error.code==='PAGE_INVALID'&&cursor.token) {
                cursor={...cursor,token:undefined,partial:false};
                commit([],cursor.initial,key,cursor);
                partial=true;
                break;
              }
              throw error;
            }
            const posts=normalizeResponse(body,now,`search:${cursor.start}:${cursor.end}`);
            if(signal.aborted)return false;
            const windowPartial=!!cursor.partial||!!body.errors?.length||posts.length!==(body.data?.length??0);
            partial ||= windowPartial;
            const historical=cursor.initial||cursor.end-cursor.oldEnd>2*this.store.settings.intervalSeconds*second;
            const next=body.meta?.next_token;
            if(next&&next===cursor.token) {
              this.store.db.transaction(()=>{
                commit(posts,historical,key,{...cursor,token:undefined,partial:false});
                const coverage=this.store.coverage(this.id);
                this.store.changeCoverage(this.id,{pages:coverage.pages+1,posts:coverage.posts+posts.length});
              })();
              useful=true;
              partial=true;
              break;
            }
            cursor={...cursor,token:next,pending:!!next,completed:next?cursor.completed:cursor.end,partial:windowPartial};
            this.store.db.transaction(()=>{
              commit(posts,historical,key,cursor);
              const coverage=this.store.coverage(this.id);
              this.store.changeCoverage(this.id,{pages:coverage.pages+1,posts:coverage.posts+posts.length,
                ...(!cursor.pending&&!windowPartial?{oldest:Math.min(coverage.oldest??Infinity,cursor.start),newest:Math.max(coverage.newest??0,cursor.end)}:{})});
            })();
            useful=true;
            if(!cursor.token)break;
            if(page===pages-1)capped=true;
          }
        }
        if (!signal.aborted) {
          this.store.set(`${this.id}:attempt`,0);
          const gaps=[olderGap?'Older coverage exceeded the configured recovery window.':'',partial?'The API returned partial results or an invalid cursor.':'',
            capped?'The page limit was reached. A checkpoint is saved for the next cycle.':'',unsupported?`${unsupported} watchlist(s) contain unsupported search terms.`:'',
            groups.length>12?'Search groups are rotated across cycles.':''].filter(Boolean);
          if(gaps.length||useful)this.store.run('UPDATE data_sources SET gap=? WHERE id=?',gaps.join(' ')||null,this.id);
        }
        return useful;
      } catch(error) {
        if(!signal.aborted){
          if(!(error instanceof XIssue&&['BUDGET_EXHAUSTED','CREDITS_REQUIRED'].includes(error.code)))
            this.store.run('UPDATE data_sources SET gap=? WHERE id=?','Collection stopped before the search window finished. The checkpoint was kept.',this.id);
          this.failure(error,now);
        }
        return false;
      }
    });
  }
  lookup(posts:Candidate[],now:number,signal:AbortSignal) {
    return this.serialize(async()=>{
      if(!posts.length||this.store.value(`${this.id}:hold`,false))return {posts:[],removed:[]};
      try {
        const ids=posts.map(p=>p.id).filter(id=>tweetId.safeParse(id).success).slice(0,25);
        if(!ids.length)return {posts:[],removed:[]};
        const body=responseSchema.parse(await this.get('tweets',this.fields({ids:ids.join(',')}),now,ids.length*2,signal));
        const normalized=normalizeResponse(body,now,'lookup:'+now);
        this.store.set(`${this.id}:lookup-state`,'Available');
        const removed=(body.errors??[]).flatMap(e=>{
          const id=e.resource_id??e.value;
          return id&&ids.includes(id)&&e.type?.endsWith('/resource-not-found')?[id]:[];
        });
        return {posts:normalized,removed};
      } catch(error) {
        if(!signal.aborted){
          const issue=error instanceof XIssue?error.code:'UPSTREAM_INVALID';
          this.store.set(`${this.id}:lookup-state`,issue==='ACCESS_DENIED'?'Permission required':issue==='CREDENTIAL_REQUIRED'||issue==='SESSION_EXPIRED'?'Authentication required':'Unverified');
        }
        return {posts:[],removed:[]};
      }
    });
  }
  async stream(_lists:Watchlist[],signal:AbortSignal,commit:Parameters<LiveCollector['collect']>[3]) {
    const now=Date.now();
    if(this.id!=='x'||!this.settings.stream||!paid(this.store.settings)||!this.row.configured||
      this.store.value('x:stream-next',0)>now||this.store.value('x:hold',false)||this.store.value('x:rate-at',0)>now)return;
    const quota=Math.min(this.settings.pageSize,50);
    const run=new AbortController();
    const lifetime=AbortSignal.any([signal,run.signal,AbortSignal.timeout(10*minute)]);
    let timer:ReturnType<typeof setTimeout>|undefined;
    const timeout=()=>{
      clearTimeout(timer);
      timer=setTimeout(()=>run.abort(),45_000);
      timer.unref();
    };
    const status=(state:string,error:string|null,gap:string|null)=>{
      this.store.run("UPDATE data_sources SET status=?,error_code=?,gap=? WHERE id='x'",state,error,gap);
      this.store.set('x:stream-note',gap);
      commit([],true,'',null);
    };
    try {
      const token=await this.vault.get('bearer');
      if(!token||signal.aborted)return;
      this.reserve(now,quota*2);
      timeout();
      const response=await this.transport('https://api.x.com/2/tweets/search/stream?'+this.fields({}),{
        signal:lifetime,headers:{Authorization:'Bearer '+token},redirect:'error',
      });
      if(response.status===429)throw new XIssue('RATE_LIMIT',resetTime(response.headers,now,minute));
      if([400,401,402,403,404].includes(response.status)) {
        this.store.set('x:stream-next',Number.MAX_SAFE_INTEGER);
        status('Polling','STREAM_UNAVAILABLE','X denied the stream or no matching rules are configured. Recent search remains available.');
        await response.body?.cancel();
        return;
      }
      if(!response.ok||!response.body)throw new XIssue('NETWORK');
      status('Streaming',null,'Stream coverage follows the rules configured for this X application. Recent search also runs on its normal schedule.');
      let count=0;
      for await(const frame of lines(response.body)) {
        timeout();
        if(!frame.trim())continue;
        const value=z.object({data:z.unknown(),includes:z.unknown().optional()}).parse(JSON.parse(frame));
        const received=Date.now();
        const posts=normalizeResponse(responseSchema.parse({data:[value.data],includes:value.includes}),received,'stream');
        if(!posts.length)continue;
        commit(posts,false,'',null);
        if(++count>=quota)break;
      }
      if(!signal.aborted)status('Polling',null,'The stream window ended. Recent search continues and the stream can reconnect.');
    } catch(error) {
      if(signal.aborted)return;
      const issue=error instanceof XIssue?error:new XIssue('NETWORK');
      if(issue.retryAt)this.store.set('x:stream-next',issue.retryAt);
      status('Polling',issue.code,'The stream was interrupted. Recent search continues subject to its budget.');
    } finally {
      clearTimeout(timer);
      run.abort();
      if(!signal.aborted)this.store.set('x:stream-next',Math.max(this.store.value('x:stream-next',0),Date.now()+minute));
      if(signal.aborted&&this.row.status==='Streaming')this.store.run("UPDATE data_sources SET status='Polling' WHERE id='x'");
    }
  }
  async check() {
    const query=this.store.lists.filter(l=>l.enabled).flatMap(queryGroups)[0];
    if(!query)throw new ApiError(409,'NO_QUERY','Create an enabled watchlist with a supported query first.');
    const now=Date.now();
    try {
      await this.serialize(async()=>searchResponseSchema.parse(await this.get('tweets/search/recent',this.fields({query,max_results:'10'}),now,20,AbortSignal.timeout(22_000))));
      this.store.run(`UPDATE data_sources SET status='Search verified',error_code=NULL WHERE id='${this.id}'`);
      this.store.set(`${this.id}:search-verified`,true);
      this.store.set(`${this.id}:hold`,false);
      this.store.set(`next:${this.id}`,now+this.store.settings.intervalSeconds*1000);
    } catch(error) {
      this.failure(error,now);
      const issue=error instanceof XIssue?error.code:'UPSTREAM_INVALID';
      const messages:Partial<Record<Issue,string>>={
        ACCESS_DENIED:'X denied access to recent search. Check the app’s endpoint entitlement and OAuth scopes.',
        CREDENTIAL_REQUIRED:'X rejected the credential or the OS vault could not supply it.',
        SESSION_EXPIRED:'The OAuth authorization expired. Reconnect from Data sources.',
        VERIFICATION_REQUIRED:'X requires account verification before allowing this request.',
        CREDITS_REQUIRED:'X reports that this project has insufficient credits.',
        BUDGET_EXHAUSTED:'The configured daily budget blocked the connection check.',
        RATE_LIMIT:'X rate limited this credential. Wait for the reset before retrying.',
        PAGE_INVALID:'X rejected the current watchlist query.',
      };
      throw new ApiError(503,issue,messages[issue]??'X is unavailable or returned an invalid response. Review collection diagnostics.');
    } finally {this.changed();}
  }
  authorize(input:unknown,origin:string) {
    const settings=oauthSchema.parse(input);
    const row=this.row;
    if(!paid(this.store.settings)||(this.id==='x'&&(!row.active||!row.configured||(!settings.following&&!settings.likes)))) throw new ApiError(409,'SOURCE_NOT_READY','Confirm positive X API budgets and select any required account scopes.');
    const state=randomBytes(32).toString('base64url'),verifier=randomBytes(48).toString('base64url');
    this.pending.clear();
    const redirect=origin+(this.id==='session'?'/api/v1/oauth/session/callback':'/api/v1/oauth/callback');
    this.pending.set(state,{...settings,verifier,expires:Date.now()+5*minute,generation:row.generation,redirect});
    const scopes=['tweet.read','users.read',...(settings.following?['follows.read']:[]),...(settings.likes?['like.read']:[]),...(settings.refresh?['offline.access']:[])];
    const params=new URLSearchParams({response_type:'code',client_id:settings.clientId,redirect_uri:redirect,scope:scopes.join(' '),state,
      code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'});
    return Promise.resolve({url:'https://x.com/i/oauth2/authorize?'+params});
  }
  async callback(relative:string,origin:string) {
    const url=new URL(relative,origin),state=url.searchParams.get('state')??'',code=url.searchParams.get('code');
    const grant=this.pending.get(state);
    this.pending.delete(state);
    const valid=()=>grant && (this.id==='session'||this.row.active) && this.row.generation===grant.generation && paid(this.store.settings);
    if(!grant||grant.expires<Date.now()||!valid()||!code||code.length>4096||grant.redirect!==origin+url.pathname)throw new ApiError(403,'OAUTH_STATE','Authorization expired or was declined. Start again from Data sources.');
    try {
      await this.serialize(async()=>{
        const now=Date.now(),signal=AbortSignal.timeout(60_000);
        const body=new URLSearchParams({grant_type:'authorization_code',client_id:grant.clientId,redirect_uri:grant.redirect,code,code_verifier:grant.verifier});
        const response=await this.transport('https://api.x.com/2/oauth2/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body,signal,redirect:'error'});
        if(!response.ok||!valid())throw new XIssue('ACCESS_DENIED');
        const token=authorization.parse(await response.json());
        const scope=token.scope??'';
        if(this.id==='session'&&!['tweet.read','users.read'].every(required=>scope.split(/\s+/).includes(required)))throw new XIssue('ACCESS_DENIED');
        const identity=await this.syncSignals(grant,scope,token.access_token,now,signal,valid);
        const accountId=identity.id;
        const keep=grant.refresh&&scope.split(/\s+/).includes('offline.access')&&token.refresh_token;
        if(this.id==='session') {
          this.store.run("UPDATE data_sources SET vault_ref='session' WHERE id='session'");
          if(keep)await this.vault.set('oauth-refresh',keep);
          else await this.vault.remove('oauth-refresh');
          await this.vault.set('access',token.access_token);
          if(!valid())throw new XIssue('ACCESS_DENIED');
          this.store.set('session:grant',{clientId:grant.clientId,following:grant.following,likes:grant.likes,accountId,
            username:identity.username??null,expiresAt:now+(token.expires_in??7200)*1000,renewable:!!keep} satisfies SessionGrant);
          this.store.run("UPDATE data_sources SET configured=1,status='Connected',error_code=NULL WHERE id='session'");
          this.store.set('session:hold',false);
          this.store.set('next:session',now);
          if(grant.following||grant.likes||keep)this.store.set('session:oauth',{clientId:grant.clientId,following:grant.following,likes:grant.likes,accountId,scope,next:now+(this.syncPending(accountId)?minute:day)} satisfies OAuthSettings);
          else this.store.run("DELETE FROM settings WHERE key='session:oauth'");
          return;
        }
        if(keep&&valid()){
          await this.vault.set('oauth-refresh',keep);
          if(!valid()) {await this.vault.remove('oauth-refresh');throw new XIssue('ACCESS_DENIED');}
          this.store.set(`${this.id}:oauth`,{clientId:grant.clientId,following:grant.following,likes:grant.likes,accountId,scope,next:now+(this.syncPending(accountId)?minute:day)} satisfies OAuthSettings);
        } else if(this.store.value<OAuthSettings|null>(`${this.id}:oauth`,null)) {
          this.store.run(`DELETE FROM settings WHERE key='${this.id}:oauth'`);
          await this.vault.remove('oauth-refresh');
        }
      });
    } catch {throw new ApiError(503,'OAUTH_FAILED','X could not verify the selected account signals.');}
    finally {this.changed();}
  }
  private async syncSignals(consent:SignalConsent,scope:string,access:string,now:number,signal:AbortSignal,valid:()=>unknown,expected?:string) {
    const own=z.object({data:userSchema}).parse(await this.get('users/me',new URLSearchParams(),now,1,signal,access)).data;
    if(expected&&own.id!==expected)throw new XIssue('ACCESS_DENIED');
    const scopes=scope.split(/\s+/), revoked=new Set<string>(),missingSignals:string[]=[];
    const sets:{kind:string;authors:Set<string>;progress:SignalProgress;success:boolean}[]=[];
    for(const flag of [{enabled:consent.following,scope:'follows.read',path:'following',kind:'following'},{enabled:consent.likes,scope:'like.read',path:'liked_tweets',kind:'liked-author'}]){
      if(!flag.enabled)continue;
      if(!scopes.includes(flag.scope)){revoked.add(flag.kind);missingSignals.push(flag.kind);continue;}
      const authors=new Set<string>();
      const cursorKey=`${this.id}:sync:${own.id}:${flag.kind}`;
      const saved=expected?this.store.value<SignalProgress|null>(cursorKey,null):null;
      if(saved?.complete&&this.syncPending(own.id)&&saved.begun>now-day){sets.push({kind:flag.kind,authors,progress:saved,success:false});continue;}
      const begun=saved&&!saved.complete?saved.begun??now:now;
      let next=saved?.token,complete=false,success=false;
      for(let page=0;page<2;page++){
        if(!valid())throw new XIssue('ACCESS_DENIED');
        try{
          const limit=flag.path==='following'?25:10;
          const params=new URLSearchParams({max_results:String(limit),...(flag.path==='liked_tweets'?{'tweet.fields':'author_id'}:{})});
          if(next)params.set('pagination_token',next);
          const result=z.object({
            data:z.array(z.object({id:tweetId,author_id:tweetId.optional()})).optional(),
            meta:z.object({next_token:z.string().max(4096).optional()}).optional(),
            errors:z.array(z.unknown()).optional(),
          }).parse(await this.get(`users/${own.id}/${flag.path}`,params,now,limit,signal,access));
          for(const post of result.data??[]) {
            if(flag.path==='following')authors.add(post.id);
            else if(post.author_id)authors.add(post.author_id);
          }
          success=true;
          const followingCursor=result.meta?.next_token;
          if(followingCursor&&followingCursor===next){next=undefined;break;}
          next=followingCursor;
          if(!next){complete=!result.errors?.length;break;}
        } catch(error) {
          if(error instanceof XIssue&&['ACCESS_DENIED','CREDENTIAL_REQUIRED','SESSION_EXPIRED'].includes(error.code))revoked.add(flag.kind);
          if(next&&error instanceof XIssue&&error.code==='PAGE_INVALID')next=undefined;
          break;
        }
      }
      if(!revoked.has(flag.kind))sets.push({kind:flag.kind,authors,progress:{token:next,complete,begun,retry:!complete&&!next},success});
      if(!complete&&!next)missingSignals.push(flag.kind);
    }
    if(!valid())throw new XIssue('ACCESS_DENIED');
    this.store.db.transaction(()=>{
      if(!expected){
        this.store.run('DELETE FROM account_relationships WHERE source_id=?',this.id);
        this.store.run('DELETE FROM settings WHERE key LIKE ?',`${this.id}:sync:%`);
      }
      for(const kind of revoked){
        this.store.run('DELETE FROM account_relationships WHERE source_id=? AND account_id=? AND kind=?',this.id,own.id,kind);
        this.store.run('DELETE FROM settings WHERE key=?',`${this.id}:sync:${own.id}:${kind}`);
      }
      for(const {kind,authors,progress} of sets){
        for(const author of authors)this.store.run('INSERT INTO account_relationships VALUES (?,?,?,?,1,?) ON CONFLICT(source_id,account_id,author_id,kind) DO UPDATE SET expires_at=excluded.expires_at',this.id,own.id,author,kind,now+day);
        if(progress.complete)this.store.run('DELETE FROM account_relationships WHERE source_id=? AND account_id=? AND kind=? AND expires_at<?',this.id,own.id,kind,progress.begun+day);
        this.store.set(`${this.id}:sync:${own.id}:${kind}`,progress);
      }
      const prior=expected?this.store.value<{lastSuccess?:number;expires:number;verified:string[]}|null>(`${this.id}:signals`,null):null;
      const success=sets.some(result=>result.success);
      const verified=sets.filter(result=>result.success||prior?.verified.includes(result.kind)&&prior.expires>now).map(result=>result.kind);
      this.store.run(`UPDATE data_sources SET account_id=?,gap=coalesce(?,gap) WHERE id='${this.id}'`,own.id,missingSignals.length?`Optional signals unavailable: ${missingSignals.join(', ')}.`:null);
      this.store.set(`${this.id}:signals`,{verified,syncing:this.syncPending(own.id),partial:!!missingSignals.length,
        followingComplete:sets.some(r=>r.kind==='following'&&r.progress.complete),accountId:own.id,
        lastSuccess:success?now:prior?.lastSuccess??null,expires:success?now+day:prior?.expires??now});
    })();
    return own;
  }
  private syncPending(account:string) {
    return ['following','liked-author'].some(kind=>{
      const saved=this.store.value<SignalProgress|null>(`${this.id}:sync:${account}:${kind}`,null);
      return !!(saved?.token||saved?.retry);
    });
  }
  private async sessionToken(now:number,signal:AbortSignal) {
    const grant=this.account;
    if(!grant)throw new XIssue('CREDENTIAL_REQUIRED');
    if(grant.expiresAt>now+30_000)return this.vault.get('access');
    if(!grant.renewable)throw new XIssue('SESSION_EXPIRED');
    if(!paid(this.store.settings))throw new XIssue('BUDGET_EXHAUSTED');
    const generation=this.row.generation,previous=await this.vault.get('oauth-refresh');
    if(!previous)throw new XIssue('SESSION_EXPIRED');
    const body=new URLSearchParams({grant_type:'refresh_token',client_id:grant.clientId,refresh_token:previous});
    let response:Response;
    try {
      response=await this.transport('https://api.x.com/2/oauth2/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body,signal:AbortSignal.any([signal,AbortSignal.timeout(20_000)]),redirect:'error'});
    } catch {throw new XIssue('NETWORK');}
    if(response.status===429)throw new XIssue('RATE_LIMIT',resetTime(response.headers,now,minute));
    if(response.status===400||response.status===401)throw new XIssue('SESSION_EXPIRED');
    if(response.status===403)throw new XIssue('ACCESS_DENIED');
    if(!response.ok)throw new XIssue('NETWORK');
    const token=authorization.parse(await response.json());
    signal.throwIfAborted();
    if(generation!==this.row.generation)throw new XIssue('CREDENTIAL_REQUIRED');
    if(token.refresh_token)await this.vault.set('oauth-refresh',token.refresh_token);
    await this.vault.set('access',token.access_token);
    const config=this.store.value<OAuthSettings|null>('session:oauth',null);
    if(config&&token.scope!==undefined)this.store.set('session:oauth',{...config,scope:token.scope});
    this.store.set('session:grant',{...grant,expiresAt:now+(token.expires_in??7200)*1000});
    return token.access_token;
  }
  refreshSignals(now:number,signal:AbortSignal) {
    return this.serialize(async()=>{
      const config=this.store.value<OAuthSettings|null>(`${this.id}:oauth`,null);
      if(!config||config.next>now||!paid(this.store.settings)||this.store.value(`${this.id}:hold`,false))return;
      const generation=this.store.active.generation;
      const valid=()=>!signal.aborted&&this.store.active.id===this.id&&this.store.active.generation===generation;
      try{
        if(this.id==='session'){
          const access=await this.sessionToken(now,signal);
          if(!access||!valid())return;
          const current=this.store.value<OAuthSettings>('session:oauth',config);
          await this.syncSignals(current,current.scope,access,now,signal,valid,current.accountId);
          if(valid())this.store.set('session:oauth',{...current,next:now+(this.syncPending(current.accountId)?minute:day)});
          return;
        }
        const previous=await this.vault.get('oauth-refresh');
        if(!previous||!valid())return;
        const body=new URLSearchParams({grant_type:'refresh_token',client_id:config.clientId,refresh_token:previous});
        const response=await this.transport('https://api.x.com/2/oauth2/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body,signal:AbortSignal.any([signal,AbortSignal.timeout(20_000)]),redirect:'error'});
        if(!valid())return;
        if(response.status===400||response.status===401){
          this.store.run(`DELETE FROM account_relationships WHERE source_id='${this.id}'`);
          this.store.run('DELETE FROM settings WHERE key IN (?,?) OR key LIKE ?',`${this.id}:signals`,`${this.id}:oauth`,`${this.id}:sync:%`);
          this.store.run(`UPDATE data_sources SET account_id=NULL,gap='Personal signal consent expired. Reconnect from Data sources.' WHERE id='${this.id}'`);
          await this.vault.remove('oauth-refresh');
          return;
        }
        if(!response.ok)throw new XIssue('NETWORK');
        const token=authorization.parse(await response.json());
        if(!valid())return;
        if(token.refresh_token)await this.vault.set('oauth-refresh',token.refresh_token);
        const scope=token.scope??config.scope;
        await this.syncSignals(config,scope,token.access_token,now,signal,valid,config.accountId);
        if(valid())this.store.set(`${this.id}:oauth`,{...config,scope,next:now+(this.syncPending(config.accountId)?minute:day)});
      } catch(error) {
        if(!valid())return;
        if(error instanceof XIssue&&['ACCESS_DENIED','CREDENTIAL_REQUIRED','SESSION_EXPIRED'].includes(error.code)){
          this.store.run('DELETE FROM account_relationships WHERE source_id=?',this.id);
          this.store.run('DELETE FROM settings WHERE key IN (?,?) OR key LIKE ?',`${this.id}:signals`,`${this.id}:oauth`,`${this.id}:sync:%`);
          this.store.run('UPDATE data_sources SET gap=? WHERE id=?','Personal authorization expired or was revoked. Reconnect from Data sources.',this.id);
          if(this.id==='session')this.failure(error,now);
        }else{
          const current=this.store.value<OAuthSettings|null>(`${this.id}:oauth`,null);
          if(current)this.store.set(`${this.id}:oauth`,{...current,next:error instanceof XIssue&&error.retryAt?error.retryAt:now+hour});
        }
      }
    });
  }
  async credential(value:string|null) {
    if(value===null) {await this.disconnect();return;}
    if(this.store.value(`${this.id}:oauth`,null))await this.vault.remove('oauth-refresh');
    await this.vault.set('bearer',value);
    this.store.db.transaction(()=>{
      this.store.run(`UPDATE data_sources SET configured=1,status='Configured · unverified',generation=generation+1,error_code=NULL,account_id=NULL,vault_ref='bearer' WHERE id='${this.id}'`);
      this.store.run(`DELETE FROM account_relationships WHERE source_id='${this.id}'`);
      this.store.run(`DELETE FROM settings WHERE key LIKE 'cursor:${this.id}:%' OR key LIKE '${this.id}:sync:%' OR key IN ('${this.id}:signals','${this.id}:oauth','${this.id}:rate-at','${this.id}:hold','${this.id}:lookup-state','${this.id}:search-verified')`);
      this.store.set(`next:${this.id}`,Date.now());
    })();
    this.pending.clear();this.changed();
  }
  async clearSignals() {
    this.pending.clear();
    this.store.db.transaction(()=>{
      this.store.run(`UPDATE data_sources SET account_id=NULL,generation=generation+1 WHERE id='${this.id}'`);
      this.store.run(`DELETE FROM account_relationships WHERE source_id='${this.id}'`);
      this.store.run('DELETE FROM settings WHERE key=? OR key LIKE ?',`${this.id}:signals`,`${this.id}:sync:%`);
      if(this.store.value(`${this.id}:oauth`,null))this.store.set(`${this.id}:oauth:remove`,true);
      this.store.run(`DELETE FROM settings WHERE key='${this.id}:oauth'`);
    })();
    try {
      if(this.store.value(`${this.id}:oauth:remove`,false))await this.vault.remove('oauth-refresh');
      this.store.run(`DELETE FROM settings WHERE key='${this.id}:oauth:remove'`);
    } finally {this.changed();}
  }
  async disconnect() {
    this.pending.clear();
    await this.chain;
    const wasActive=this.store.active.id===this.id;
    this.store.db.transaction(()=>{
      this.store.run(`UPDATE data_sources SET active=0,configured=0,generation=generation+1,status='Credential required',account_id=NULL,error_code=NULL,last_success_at=NULL WHERE id='${this.id}'`);
      if(wasActive){
        this.store.run("UPDATE data_sources SET active=1 WHERE id='mock'");
        this.store.set('paused',true);
      }
      this.store.run(`DELETE FROM account_relationships WHERE source_id='${this.id}'`);
      this.store.run(`DELETE FROM monitoring_jobs WHERE collector='${this.id}'`);
      this.store.run(`DELETE FROM settings WHERE key LIKE 'cursor:${this.id}:%' OR key IN ('${this.id}:signals','${this.id}:oauth','${this.id}:rate-at','${this.id}:hold','${this.id}:lookup-state','${this.id}:search-verified')`);
      this.store.run('DELETE FROM settings WHERE key=? OR key LIKE ?',`${this.id}:grant`,`${this.id}:sync:%`);
    })();
    if(!this.store.sources.find(s=>s.id===this.id)?.vault_ref) {this.changed();return;}
    try {
      await this.vault.remove('oauth-refresh');
      await this.vault.remove(this.id==='session'?'access':'bearer');
      this.store.run(`UPDATE data_sources SET vault_ref=NULL WHERE id='${this.id}'`);
      this.store.run(`DELETE FROM settings WHERE key='${this.id}:oauth:remove'`);
    } catch(error) {
      this.store.run(`UPDATE data_sources SET status='Credential removal pending',error_code='VAULT_UNAVAILABLE' WHERE id='${this.id}'`);
      throw error;
    } finally {this.changed();}
  }
}
