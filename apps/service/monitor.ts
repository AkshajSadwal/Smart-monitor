import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {type Candidate,type CollectorId,type Match,type Metrics,type MonitorStatus,type Settings,type Source,type Watchlist} from '../../packages/contracts/index';
import {SourceManager,type Collector,type CommitPage} from '../../packages/collection-core/collector';
import {simulatedCollector} from './simulated';
import {localTime,quietNow,scorePost} from './rank';
import {canonicalUrl,hash,json,type Store} from './storage';
import {notifyNative,type Notify} from './notifier';

const minute=60_000;
export class Monitor {
  readonly events = new EventEmitter();
  private timer?:NodeJS.Timeout;
  private flight?:Promise<void>;
  private controller?:AbortController;
  readonly sources:SourceManager;
  private running=false;
  private lastCleanup=0;
  constructor(readonly store:Store,readonly clock=Date.now,readonly notify:Notify=notifyNative,readonly activate?:(source:Source,id:string,original:string|null)=>void,...collectors:Collector[]) {
    this.sources=new SourceManager(simulatedCollector(store),...collectors);
    this.events.setMaxListeners(0);
  }
  get status():MonitorStatus {
    const row=this.store.active;
    const collector=this.sources.get(row.id);
    const due=this.pollDue(row.id);
    const state=collector?.availabilityStatus??row.status;
    return {paused:this.store.paused,source:row.id,status:this.store.paused?'Paused':state,
      lastSuccess:row.last_success_at,nextDue:this.store.paused||!Number.isFinite(due)||due===Number.MAX_SAFE_INTEGER||!this.store.lists.some(l=>l.enabled)?null:due,
      error:row.error_code,gap:row.gap,intervalSeconds:this.store.settings.intervalSeconds,coverage:this.store.coverage(row.id)};
  }
  private pollDue(source:CollectorId) {
    const collector=this.sources.get(source);
    return collector?Math.max(this.store.value(`next:${source}`,0),collector.nextAllowedAt??0):Infinity;
  }
  signal(...names:string[]) { for (const name of names) this.events.emit('change',name); }
  start() { this.running=true;this.wake(); }
  wake() {
    if (this.timer) clearTimeout(this.timer);
    if (!this.running || this.flight) return;
    const source=this.store.active.id;
    const collector=this.sources.get(source);
    const alert=this.store.get<{due:number|null}>("SELECT min(due_at) AS due FROM monitoring_jobs WHERE collector=? AND type='alert'",source)?.due;
    const recheck=this.store.get<{due:number|null}>("SELECT min(due_at) AS due FROM monitoring_jobs WHERE collector=? AND type='recheck'",source)?.due;
    const poll=this.store.lists.some(l=>l.enabled)?this.pollDue(source):Infinity;
    const lookup=collector?.lookup?Math.max(recheck??Infinity,collector.nextAllowedAt??0):Infinity;
    const due=this.store.paused?Infinity:Math.min(poll,alert??Infinity,lookup);
    const timeout=Math.min(Math.max(100,due-this.clock()),60_000);
    this.timer=setTimeout(()=>void this.tick().finally(()=>this.wake()),timeout);
    this.timer.unref();
  }
  invalidate() {
    this.controller?.abort();
    this.store.run('UPDATE data_sources SET generation=generation+1 WHERE active=1');
    this.wake();
  }
  pause(value:boolean) {
    if (this.store.paused!==value) {
      this.store.set('paused',value);
      if (value) {
        this.store.run("DELETE FROM monitoring_jobs WHERE type='alert'");
      }
      else this.store.set(`next:${this.store.active.id}`,this.clock());
      this.invalidate();
    }
    this.signal('overview.changed','source.changed');
    return this.status;
  }
  async stop() {
    this.running=false;
    if (this.timer) clearTimeout(this.timer);
    this.controller?.abort();
    await this.flight;
  }
  tick() {
    if (this.flight) return this.flight;
    const controller=new AbortController();
    this.controller=controller;
    this.flight=this.cycle(controller.signal).catch(()=>{
      if (!controller.signal.aborted) {
        this.store.run("UPDATE data_sources SET status='Backoff',error_code='COLLECTION_ERROR' WHERE active=1");
        this.store.set(`next:${this.store.active.id}`,this.clock()+minute);
        this.signal('source.changed');
      }
    }).finally(()=>{this.flight=undefined;this.controller=undefined;this.wake();});
    return this.flight;
  }
  private async cycle(signal:AbortSignal) {
    const now=this.clock(), source=this.store.active.id, settings=this.store.settings;
    const collector=this.sources.get(source);
    if (now-this.lastCleanup>=86_400_000) this.cleanup(now,settings);
    if (this.store.paused) return;
    const lists=this.store.lists.filter(l=>l.enabled);
    if (lists.length && collector && now>=this.pollDue(source)) {
      const next=now+1000*settings.intervalSeconds;
      this.store.changeCoverage(source,{lastAttempt:now,pages:0,posts:0});
      const success=await collector.collect(lists,now,signal,this.commit(source,lists,signal));
      if (signal.aborted) return;
      if (success) this.success(source,now,next);
      else if (this.store.value(`next:${source}`,0)<=now) this.store.set(`next:${source}`,next);
      if(success&&!signal.aborted&&collector.refreshSignals){
        const key=source+':signals',before=this.store.value(key,null);
        await collector.refreshSignals(now,signal);
        if(!signal.aborted&&JSON.stringify(before)!==JSON.stringify(this.store.value(key,null)))this.rerankStored(undefined,'x');
      }
      this.signal('posts.changed','overview.changed','source.changed');
    }
    if (signal.aborted) return;
    if(now>=(collector?.nextAllowedAt??0))await this.recheck(source,collector,lists,now,signal);
    if (signal.aborted) return;
    for (const job of this.store.jobs('alert',source,now)) {
      if (signal.aborted || this.store.paused) break;
      const alert=this.store.db.transaction(()=>this.decide(job.namespace,job.post_id,job.id,now,settings,lists,job.due_at))();
      if (alert) this.deliver(alert);
    }
  }
  private commit(source:CollectorId,lists:Watchlist[],signal:AbortSignal):CommitPage {
    return (posts,historical,key,state)=>{
      if (signal.aborted||this.store.active.id!==source||this.store.paused)return;
      const now=this.clock();
      this.store.db.transaction(()=>{
        for (const post of posts) this.ingest({...post,collector:source},lists,now,false,historical);
        if(key)this.store.set(key,state);
        if(posts.length||source==='mock'){
          const coverage=this.store.coverage(source);
          const times=posts.flatMap(post=>post.createdAt===null?[]:[post.createdAt]);
          this.store.changeCoverage(source,{pages:coverage.pages+1,posts:coverage.posts+posts.length,
            ...(times.length?{oldest:Math.min(coverage.oldest??Infinity,...times),newest:Math.max(coverage.newest??0,...times)}:{})});
        }
      })();
      if(posts.length) {
        this.store.run('UPDATE data_sources SET last_success_at=? WHERE id=?',now,source);
        this.signal('posts.changed','overview.changed','source.changed');
        this.wake();
      } else if(!key)this.signal('source.changed','overview.changed');
    };
  }
  private success(source:CollectorId,now:number,next:number) {
    this.store.set(`next:${source}`,next);
    this.store.run("UPDATE data_sources SET status=CASE WHEN status='Connected' THEN status ELSE 'Polling' END,last_success_at=?,error_code=NULL WHERE id=?",now,source);
  }
  ingest(post:Candidate,lists:Watchlist[],now:number,recheck:boolean,historical:boolean) {
    if(post.namespace==='x'){
      if(this.store.blockedX(post.id)||this.store.blockedX(post.canonicalId))return;
      const existing=this.store.get<{id:string}>('SELECT id FROM posts WHERE namespace=? AND canonical_id=? ORDER BY first_seen_at,id LIMIT 1',post.namespace,post.canonicalId);
      if(existing)post={...post,id:existing.id};
      if(post.collector==='manual'){
        const saved=this.store.row('x',post.id);
        if(saved?.text&&!saved.observation.startsWith('manual:')){
          this.store.provenance(post);
          return post.id;
        }
      }
    }
    if(this.store.persist(post,now)||post.collector==='manual')
      this.rank(post.namespace,post.id,lists,now,recheck,historical,false);
    return post.id;
  }
  rerank(namespace:Source,id:string,authorId:string|null,now=this.clock()) {
    const rows=authorId?this.store.all<{id:string}>('SELECT id FROM posts WHERE namespace=? AND author_id=?',namespace,authorId):[{id}];
    this.rerankRows(rows.map(row=>({...row,namespace})),now);
  }
  rerankStored(listId?:string,namespace?:Source) {
    const rows=this.store.all<{namespace:Source;id:string}>(`SELECT DISTINCT p.namespace,p.id FROM posts p JOIN scores s ON s.namespace=p.namespace AND s.post_id=p.id
      WHERE p.text IS NOT NULL ${listId?'AND s.list_id=?':''} ${namespace?'AND p.namespace=?':''}`,...[listId,namespace].filter(value=>value!==undefined));
    this.rerankRows(rows,this.clock());
  }
  private rerankRows(rows:{namespace:Source;id:string}[],now:number) {
    const lists=this.store.lists.filter(list=>list.enabled);
    this.store.db.transaction(()=>{
      for(const row of rows)this.rank(row.namespace,row.id,lists,now,false,false,true);
    })();
  }
  private rank(namespace:Source,id:string,lists:Watchlist[],now:number,recheck:boolean,historical:boolean,feedbackOnly:boolean) {
    const row=this.store.row(namespace,id);
    if(!row?.text)return;
    const candidate=this.store.candidate(row);
    const settings=this.store.settings;
    const {authorId}=candidate;
    const first=row.first_seen_at;
    const before=this.store.matches(namespace,id);
    const previous=this.store.get<{collected_at:number;metrics:string}>(
      'SELECT collected_at,metrics FROM engagement_snapshots WHERE namespace=? AND post_id=? AND collected_at BETWEEN ? AND ? ORDER BY collected_at DESC LIMIT 1',
      namespace,id,candidate.observedAt-6*60*minute,candidate.observedAt-5*minute);
    const prefs=this.store.preferences(namespace,authorId);
    const affinity=authorId ? this.store.get<{sum:number|null}>(`
      SELECT sum(CASE WHEN f.rating='irrelevant' THEN -1 WHEN f.rating='useful' OR f.favorite=1 THEN 1 ELSE 0 END) sum
      FROM feedback f JOIN posts p ON p.namespace=f.namespace AND p.id=f.post_id WHERE p.namespace=? AND p.author_id=?`,namespace,authorId)?.sum : null;
    const feedback=this.store.feedback(namespace,id);
    const imported=candidate.observation.startsWith('manual:');
    const relation=(kind:string)=>imported?undefined:this.store.get<{value:number}>(`
      SELECT a.value FROM account_relationships a JOIN data_sources d ON d.id=a.source_id AND d.account_id=a.account_id
      WHERE a.source_id=? AND a.author_id=? AND a.kind=? AND a.expires_at>?`,
      namespace==='x'?'session':'mock',authorId,kind,now)?.value;
    const relationship=imported?undefined:storeFollowing(this.store,namespace,authorId,now);
    const authorLikes=namespace==='x'&&authorId&&candidate.metrics.likes!==null&&candidate.createdAt!==null?
      this.store.all<{likes:number}>(`SELECT json_extract(metrics_json,'$.likes') AS likes FROM posts
        WHERE namespace=? AND author_id=? AND canonical_id<>? AND json_type(metrics_json,'$.likes')='integer'
        AND created_at IS NOT NULL AND abs((last_seen_at-created_at)-?)<=3600000
        ORDER BY last_seen_at DESC LIMIT 20`,namespace,authorId,candidate.canonicalId,candidate.observedAt-candidate.createdAt).map(row=>row.likes).sort((a,b)=>a-b):[];
    const factors={...prefs,following:relation('following')??relationship,likedAuthor:relation('liked-author'),
      feedback:feedback.rating==='irrelevant'?0:feedback.rating==='useful'||feedback.favorite?1:affinity?+(affinity>0):undefined,
      authorMedianLikes:authorLikes.length>=5?authorLikes[Math.floor(authorLikes.length/2)]:undefined,
      previous:previous?{collectedAt:previous.collected_at,metrics:json<Metrics>(previous.metrics)}:undefined,
      repeated:!!(authorId && this.store.get('SELECT 1 FROM posts WHERE namespace=? AND author_id=? AND content_hash=? AND id<>? AND first_seen_at BETWEEN ? AND ? LIMIT 1',
        namespace,authorId,hash(candidate.text.normalize('NFKC').toLowerCase().replace(/\s+/gu,' ').trim()),id,first-24*60*minute,first))};
    const isQuiet=quietNow(now,settings.quiet);
    let eligibleRecheck=false;
    const matches:Match[]=[];
    for (const list of lists) {
      const prior=before.find(m=>m.listId===list.id);
      if(feedbackOnly&&!prior)continue;
      const {result,unresolved}=scorePost(candidate,list,settings,factors);
      if (!result) {
        eligibleRecheck ||= unresolved;
        if(feedbackOnly&&prior&&prefs.muted){
          this.store.run('UPDATE scores SET explanation=? WHERE namespace=? AND post_id=? AND list_id=?',
            JSON.stringify({...prior,classification:'silent',suppression:'Author muted'}),namespace,id,list.id);
          continue;
        }
        this.store.run('DELETE FROM scores WHERE namespace=? AND post_id=? AND list_id=?',namespace,id,list.id);
        continue;
      }
      const match:Match={...result,listId:list.id,listName:list.name,revision:list.revision,
        suppression:feedbackOnly?(prior?.suppression==='Author muted'?null:prior?.suppression??null):historical?'Historical collection':isQuiet&&result.classification!=='silent'?'Quiet hours':null};
      if (recheck && prior?.classification==='silent' && result.classification!=='silent') {
        match.classification='delayed';
        match.previousScore=prior.score;
      }
      if(feedbackOnly&&prior?.classification==='delayed'&&result.classification!=='silent'){
        match.classification='delayed';
        match.previousScore=prior.previousScore;
      }
      eligibleRecheck ||= match.classification==='silent' && result.score>=list.standard-10;
      matches.push(match);
      this.store.run('INSERT INTO scores VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(namespace,post_id,list_id) DO UPDATE SET score=excluded.score,revision=excluded.revision,settings_revision=excluded.settings_revision,explanation=excluded.explanation,scored_at=excluded.scored_at',
        namespace,id,list.id,match.score,list.revision,this.store.revision('preferences'),JSON.stringify(match),now);
    }
    if(feedbackOnly)return;
    if (!historical && !isQuiet && matches.some(m=>m.classification!=='silent')) {
      const immediate=matches.some(m=>m.classification==='immediate'||m.classification==='delayed');
      this.store.schedule(`alert:${namespace}:${id}`,'alert',namespace,id,now+(immediate?0:minute),{});
    }
    if (!recheck && !historical && eligibleRecheck && candidate.createdAt!==null && now-candidate.createdAt<6*60*minute) {
      if(this.sources.get(this.store.active.id)?.lookup)for (const [attempt,delay] of [[1,15],[2,60]]) this.store.schedule(`recheck:${this.store.active.id}:${namespace}:${id}:${attempt}`,'recheck',namespace,id,now+delay*minute,{attempt});
    }
  }
  private async recheck(source:CollectorId,collector:Collector|undefined,lists:Watchlist[],now:number,signal:AbortSignal) {
    if(!collector?.lookup)return;
    const jobs=this.store.jobs('recheck',source,now);
    const inputs=jobs.flatMap(job=>{
      const row=this.store.row(job.namespace,job.post_id);
      if (!row || row.created_at===null || now-row.created_at>=6*60*minute ||
        this.store.get('SELECT 1 FROM notifications WHERE namespace=? AND canonical_id=?',job.namespace,row.canonical_id)) return [];
      return [{job,post:this.store.candidate(row)}];
    });
    const fresh=source==='session' ? this.store.all<import('./storage').PostRow>(
      "SELECT p.*,a.handle,a.display_name FROM posts p LEFT JOIN authors a ON p.namespace=a.namespace AND p.author_id=a.id WHERE p.namespace='x' AND p.verified_at<=? AND EXISTS(SELECT 1 FROM post_sources s WHERE s.post_id=p.id AND s.namespace=p.namespace AND s.collector=?) LIMIT 25",
      now-23*60*minute,source).map(row=>this.store.candidate(row)) : [];
    if (!jobs.length && !fresh.length) return;
    const inputsById=new Map(inputs.map(v=>[v.post.id,v]));
    const growth=await collector.lookup([...new Map([...inputs.map(v=>v.post),...fresh].map(p=>[p.id,p])).values()].slice(0,25),now,signal,
      new Map(inputs.map(({job,post})=>[post.id,json<{attempt:number}>(job.payload).attempt])));
    if (signal.aborted) return;
    this.store.db.transaction(()=>{
      for (const id of growth.removed) {
        if(source!=='session')continue;
        this.store.removeX(id);
      }
      for (const job of jobs) {
        const pending=inputs.some(input=>input.job.id===job.id);
        if (!pending || growth.posts.some(p=>p.id===job.post_id) || growth.removed.includes(job.post_id)) this.store.run('DELETE FROM monitoring_jobs WHERE id=?',job.id);
        else this.store.run('UPDATE monitoring_jobs SET due_at=? WHERE id=?',now+Math.max(minute,1000*this.store.settings.intervalSeconds),job.id);
      }
      for (const p of growth.posts) this.ingest({...p,collector:source},lists,now,true,!inputsById.has(p.id));
    })();
    this.signal('posts.changed','overview.changed');
  }
  private decide(source:Source,id:string,jobId:string,now:number,settings:Settings,lists:Watchlist[],due:number) {
    const row=this.store.row(source,id);
    this.store.run('DELETE FROM monitoring_jobs WHERE id=?',jobId);
    if (!row?.text || this.store.get('SELECT 1 FROM notifications WHERE namespace=? AND canonical_id=?',source,row.canonical_id)) return;
    const priorities={silent:0,standard:1,delayed:2,immediate:3};
    const day=localTime(now,settings.quiet.zone).day;
    const prefs=this.store.preferences(source,row.author_id);
    const carry=this.store.get<{value:number}>('SELECT value FROM notification_limits WHERE key=?','cap:'+day)?.value??0;
    const count=carry+this.store.count('SELECT count(*) n FROM notifications WHERE local_day=?',day);
    const policy=this.store.paused?'Monitoring paused':prefs.muted?'Author muted':now-due>5*minute?'Alert freshness window elapsed':
      quietNow(now,settings.quiet)?'Quiet hours':count>=settings.dailyCap?'Daily alert limit':null;
    const matches=this.store.matches(source,id).sort((a,b)=>priorities[b.classification]-priorities[a.classification]||b.score-a.score||a.listId.localeCompare(b.listId));
    for (const match of matches) {
      if (match.classification==='silent') continue;
      const list=lists.find(l=>l.id===match.listId);
      const last=this.store.get<{value:number}>('SELECT value FROM notification_limits WHERE key=?',match.listId)?.value;
      const suppression=policy??(!list?.enabled||list.revision!==match.revision?'Watchlist changed':
        (last!==undefined&&now-last<list.cooldownSeconds*1000?'Watchlist cooldown':match.suppression));
      if (suppression) {
        this.store.run('UPDATE scores SET explanation=? WHERE namespace=? AND post_id=? AND list_id=?',JSON.stringify({...match,suppression}),source,id,match.listId);
        continue;
      }
      const key=randomUUID();
      const reason=match.previousScore===undefined ? `Matched ${match.listName}` : `Popularity score rose from ${match.previousScore} to ${match.score}`;
      const native=settings.nativeNotifications&&(source!=='mock'||settings.simulatedNotifications);
      this.store.run('INSERT INTO notifications VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',key,source,row.canonical_id,id,match.listId,match.listName,now,day,match.classification,match.score,reason,null,native?'started':'disabled',this.store.active.id);
      this.store.run('INSERT INTO notification_limits VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',match.listId,now);
      return {key,source,id,reason,native};
    }
    this.signal('posts.changed');
  }
  private deliver(alert:{key:string;source:Source;id:string;reason:string;native:boolean}) {
    this.signal('notifications.changed','overview.changed');
    if (!alert.native) return;
    const open=()=>{
      if (!this.store.db.open || !this.store.run('UPDATE notifications SET read_at=coalesce(read_at,?) WHERE id=?',this.clock(),alert.key).changes) return;
      this.activate?.(alert.source,alert.id,canonicalUrl(alert.source,alert.id));
      this.signal('notifications.changed','overview.changed');
    };
    void this.notify({title:alert.source==='mock'?'Smart Monitor · Simulated':'Smart Monitor',message:alert.reason,onClick:open})
      .catch(()=> 'unknown').then(state=>{
        if (this.store.db.open) {
          this.store.run("UPDATE notifications SET dispatch_state=? WHERE id=? AND dispatch_state='started'",state,alert.key);
          this.signal('notifications.changed');
        }
      });
  }
  private cleanup(now:number,settings:Settings) {
    const cutoff=now-settings.retentionDays*24*60*minute;
    this.store.db.transaction(()=>{
      this.store.run('DELETE FROM posts WHERE rowid IN (SELECT rowid FROM posts WHERE first_seen_at<? LIMIT 250)',cutoff);
      this.store.run("UPDATE notifications SET post_id=NULL,reason='Post unavailable' WHERE post_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM posts WHERE posts.namespace=notifications.namespace AND posts.id=notifications.post_id)");
      this.store.run('DELETE FROM notifications WHERE rowid IN (SELECT rowid FROM notifications WHERE decision_at<? LIMIT 250)',cutoff);
      this.store.run('DELETE FROM monitoring_jobs WHERE post_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM posts WHERE posts.namespace=monitoring_jobs.namespace AND posts.id=monitoring_jobs.post_id)');
      this.store.run('DELETE FROM authors WHERE rowid IN (SELECT a.rowid FROM authors a WHERE last_seen_at<? AND NOT EXISTS(SELECT 1 FROM posts p WHERE p.author_id=a.id AND p.namespace=a.namespace) AND NOT EXISTS(SELECT 1 FROM author_preferences f WHERE f.author_id=a.id AND f.namespace=a.namespace) LIMIT 250)',cutoff);
      this.store.run('DELETE FROM account_relationships WHERE expires_at<?',now);
      this.store.run("UPDATE posts SET text=NULL,content_hash=NULL WHERE rowid IN (SELECT rowid FROM posts WHERE namespace='x' AND verified_at<? AND text IS NOT NULL LIMIT 250)",now-24*60*minute);
      const cutoffDate=new Date(cutoff).toISOString().slice(0,10);
      this.store.run("DELETE FROM notification_limits WHERE (key LIKE 'cap:%' AND key<?) OR (key NOT LIKE 'cap:%' AND value<?)",'cap:'+cutoffDate,cutoff);
    })();
    this.lastCleanup=now;
  }
}

function storeFollowing(store:Store,namespace:Source,author:string|null,now:number) {
  if(namespace!=='x'||!author)return undefined;
  const id='session';
  const state=store.value<{followingComplete:boolean;accountId:string;expires:number}|null>(id+':signals',null);
  return state?.followingComplete&&state.expires>now&&store.sources.find(row=>row.id===id)?.account_id===state.accountId?0:undefined;
}
