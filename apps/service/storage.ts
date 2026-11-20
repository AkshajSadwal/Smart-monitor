import Database from 'better-sqlite3';
import {createHash,randomUUID} from 'node:crypto';
import {existsSync,rmSync} from 'node:fs';
import { defaults,normalize,termKey,type Alert,type Candidate,type CollectorId,type Feedback,type Match,type Post,type Preferences,type Rule,type Settings,type Source,type Watchlist } from '../../packages/contracts/index';

const migrations = [
  `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE data_sources (
    id TEXT PRIMARY KEY, active INTEGER DEFAULT 0, configured INTEGER DEFAULT 0, generation INTEGER DEFAULT 0,
    status TEXT NOT NULL, last_success_at INTEGER, error_code TEXT, gap TEXT, vault_ref TEXT, account_id TEXT
  );
  CREATE UNIQUE INDEX active_source ON data_sources(active) WHERE active=1;
  INSERT INTO data_sources(id,active,configured,status) VALUES ('mock',1,1,'Ready'),('x',0,0,'Credential required');
  CREATE TABLE watchlists (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, enabled INTEGER NOT NULL, revision INTEGER NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, rule_json TEXT NOT NULL,
    CHECK(json_extract(rule_json,'$.standard') BETWEEN 0 AND json_extract(rule_json,'$.immediate'))
  );
  CREATE TABLE keyword_rules (
    list_id TEXT REFERENCES watchlists ON DELETE CASCADE, direction TEXT, kind TEXT, normalized_term TEXT,
    display_term TEXT NOT NULL, important INTEGER NOT NULL, PRIMARY KEY (list_id,direction,kind,normalized_term)
  );
  CREATE TABLE watchlist_authors (
    list_id TEXT REFERENCES watchlists ON DELETE CASCADE, selector TEXT, role TEXT, PRIMARY KEY(list_id,selector,role)
  );
  CREATE TABLE authors (
    namespace TEXT, id TEXT, handle TEXT, display_name TEXT, last_seen_at INTEGER,
    PRIMARY KEY(namespace,id)
  );
  CREATE TABLE posts (
    namespace TEXT, id TEXT, canonical_id TEXT NOT NULL, author_id TEXT, text TEXT, content_hash TEXT, kind TEXT NOT NULL,
    language TEXT, created_at INTEGER, first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
    verified_at INTEGER, observation TEXT NOT NULL, metrics_json TEXT NOT NULL,
    PRIMARY KEY(namespace,id), FOREIGN KEY(namespace,author_id) REFERENCES authors
  );
  CREATE TABLE scores (
    namespace TEXT, post_id TEXT, list_id TEXT REFERENCES watchlists ON DELETE CASCADE,
    score INTEGER NOT NULL CHECK(score BETWEEN 0 AND 100), revision INTEGER NOT NULL, settings_revision INTEGER NOT NULL,
    explanation TEXT NOT NULL, scored_at INTEGER NOT NULL,
    PRIMARY KEY(namespace,post_id,list_id), FOREIGN KEY(namespace,post_id) REFERENCES posts ON DELETE CASCADE
  );
  CREATE TABLE monitoring_jobs (
    id TEXT PRIMARY KEY, type TEXT NOT NULL, due_at INTEGER NOT NULL, namespace TEXT,
    post_id TEXT, payload TEXT NOT NULL
  );`,
  `
  CREATE TABLE engagement_snapshots (
    namespace TEXT, post_id TEXT, observation TEXT, collected_at INTEGER NOT NULL, metrics TEXT NOT NULL,
    PRIMARY KEY(namespace,post_id,observation), FOREIGN KEY(namespace,post_id) REFERENCES posts ON DELETE CASCADE
  );
  CREATE TABLE author_preferences (
    namespace TEXT, author_id TEXT, muted INTEGER NOT NULL, favorite INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY(namespace,author_id)
  );
  CREATE TABLE feedback (
    namespace TEXT, post_id TEXT, rating TEXT, favorite INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY(namespace,post_id), FOREIGN KEY(namespace,post_id) REFERENCES posts ON DELETE CASCADE
  );
  CREATE TABLE notifications (
    id TEXT PRIMARY KEY, namespace TEXT NOT NULL, canonical_id TEXT NOT NULL, post_id TEXT,
    list_id TEXT REFERENCES watchlists ON DELETE SET NULL, list_name TEXT, decision_at INTEGER NOT NULL, local_day TEXT NOT NULL,
    kind TEXT NOT NULL, score INTEGER NOT NULL, reason TEXT NOT NULL, read_at INTEGER,
    dispatch_state TEXT NOT NULL, UNIQUE(namespace,canonical_id)
  );
  CREATE TABLE notification_limits (key TEXT PRIMARY KEY, value INTEGER NOT NULL);`,
  `
  CREATE TABLE account_relationships (
    source_id TEXT, account_id TEXT, author_id TEXT, kind TEXT, value INTEGER, expires_at INTEGER,
    PRIMARY KEY(source_id,account_id,author_id,kind)
  );
  CREATE TABLE usage_buckets (day TEXT PRIMARY KEY, requests INTEGER NOT NULL, resources INTEGER NOT NULL);
  CREATE TABLE post_display (
    namespace TEXT,post_id TEXT,metadata TEXT,PRIMARY KEY(namespace,post_id),
    FOREIGN KEY(namespace,post_id) REFERENCES posts ON DELETE CASCADE
  );
  CREATE INDEX feed_clock ON posts(namespace,coalesce(created_at,first_seen_at) DESC,id DESC);
  CREATE INDEX author_hash ON posts(namespace,author_id,content_hash,first_seen_at);
  CREATE INDEX score_top ON scores(list_id,score DESC,post_id);
  CREATE INDEX jobs_due ON monitoring_jobs(namespace,type,due_at);
  CREATE INDEX alerts_read ON notifications(namespace,read_at,decision_at DESC);
  CREATE INDEX snapshots_time ON engagement_snapshots(namespace,post_id,collected_at DESC);
  CREATE INDEX freshness ON posts(namespace,verified_at);
  `,
  `
  INSERT INTO data_sources(id,active,configured,status) VALUES
    ('session',0,0,'Authentication required'),('hosted',0,0,'Disconnected');
  CREATE TABLE post_sources (
    namespace TEXT NOT NULL, post_id TEXT NOT NULL, collector TEXT NOT NULL, observed_at INTEGER NOT NULL,
    PRIMARY KEY(namespace,post_id,collector),
    FOREIGN KEY(namespace,post_id) REFERENCES posts ON DELETE CASCADE,
    FOREIGN KEY(collector) REFERENCES data_sources(id)
  );
  INSERT INTO post_sources SELECT namespace,id,namespace,last_seen_at FROM posts WHERE namespace IN ('mock','x');
  CREATE INDEX post_sources_collector ON post_sources(collector,namespace,post_id);
  ALTER TABLE monitoring_jobs ADD COLUMN collector TEXT;
  UPDATE monitoring_jobs SET collector=namespace;
  CREATE INDEX jobs_collector ON monitoring_jobs(collector,type,due_at);
  ALTER TABLE notifications ADD COLUMN collector TEXT;
  UPDATE notifications SET collector=namespace;
  CREATE INDEX notifications_collector ON notifications(collector,decision_at DESC,id DESC);
  `,
];

export const hash = (value:string) => createHash('sha256').update(value).digest('hex');
export const json = <T>(value:string):T => JSON.parse(value);
export const canonicalUrl = (source:string,id:string|null) => source==='x' && id && /^\d{1,25}$/.test(id) ? `https://x.com/i/web/status/${id}` : null;
export type PostRow = {namespace:Source;id:string;canonical_id:string;text:string|null;author_id:string|null;handle:string|null;display_name:string|null;language:string|null;created_at:number|null;first_seen_at:number;last_seen_at:number;kind:Candidate['kind'];observation:string;metrics_json:string;verified_at:number|null};
type ListRow = {id:string;name:string;created_at:number;updated_at:number;revision:number;rule_json:string;matches:number};
export type SourceRow = {id:CollectorId;active:number;configured:number;generation:number;status:string;last_success_at:number|null;error_code:string|null;gap:string|null;vault_ref:string|null;account_id:string|null};
export type Job = {id:string;type:string;due_at:number;namespace:Source;post_id:string;payload:string;collector:CollectorId};
export const postSelect = 'SELECT p.*,a.handle,a.display_name FROM posts p LEFT JOIN authors a ON p.namespace=a.namespace AND p.author_id=a.id';

export class Store {
  readonly db:Database.Database;
  constructor(path:string, now=Date.now()) {
    this.db = new Database(path);
    try {
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');
      this.db.pragma('busy_timeout = 3000');
      this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY,checksum TEXT NOT NULL,applied_at INTEGER NOT NULL)');
      const applied = this.all<{version:number;checksum:string}>('SELECT version,checksum FROM schema_migrations ORDER BY version');
      for (const [i,item] of applied.entries()) {
        if (item.version!==i+1 || !migrations[i] || hash(migrations[i])!==item.checksum) throw new Error('Unsupported or modified database schema');
      }
      const migrate = this.db.transaction(() => {
        for (let i=applied.length;i<migrations.length;i++) {
          this.db.exec(migrations[i]);
          this.run('INSERT INTO schema_migrations VALUES (?,?,?)',i+1,hash(migrations[i]),now);
        }
      });
      const backup=path!==':memory:'&&applied.length>0&&applied.length<migrations.length?path+'.migration-'+randomUUID():null;
      try {
        if(backup)this.run('VACUUM INTO ?',backup);
        migrate();
      } finally {
        if(backup&&existsSync(backup))rmSync(backup);
      }
      this.run("UPDATE notifications SET dispatch_state='unknown' WHERE dispatch_state='started'");
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  run(sql:string,...parameters:unknown[]) {return this.db.prepare(sql).run(...parameters);}
  get<T>(sql:string,...parameters:unknown[]) {return this.db.prepare(sql).get(...parameters) as T|undefined;}
  all<T>(sql:string,...parameters:unknown[]) {return this.db.prepare(sql).all(...parameters) as T[];}
  count(sql:string,...parameters:unknown[]) {return this.get<{n:number}>(sql,...parameters)?.n ?? 0;}
  value<T>(key:string,fallback:T):T { const row=this.get<{value_json:string}>('SELECT value_json FROM settings WHERE key=?',key);return row?json<T>(row.value_json):fallback; }
  revision(key:string) { return this.get<{revision:number}>('SELECT revision FROM settings WHERE key=?',key)?.revision??0; }
  set(key:string,value:unknown) {this.run('INSERT INTO settings VALUES (?,?,1) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,revision=revision+1',key,JSON.stringify(value));}
  get settings():Settings {return this.value('preferences',defaults);}
  get paused() {return this.value('paused',true);}
  get sources() {return this.all<SourceRow>('SELECT * FROM data_sources ORDER BY id');}
  get active() {return this.get<SourceRow>('SELECT * FROM data_sources WHERE active=1')!;}
  get lists():Watchlist[] {
    return this.all<ListRow>('SELECT w.*, (SELECT count(*) FROM scores s WHERE s.list_id=w.id) AS matches FROM watchlists w ORDER BY created_at,id')
      .map(row=>({...json<Rule>(row.rule_json),id:row.id,revision:row.revision,createdAt:row.created_at,updatedAt:row.updated_at,matches:row.matches}));
  }
  saveList(rule:Rule,now:number,previous?:Watchlist) {
    const id = previous?.id ?? randomUUID();
    this.db.transaction(()=>{
      this.run('INSERT INTO watchlists VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,enabled=excluded.enabled,revision=excluded.revision,updated_at=excluded.updated_at,rule_json=excluded.rule_json',
        id,rule.name,+rule.enabled,(previous?.revision??0)+1,previous?.createdAt??now,now,JSON.stringify(rule));
      this.run('DELETE FROM keyword_rules WHERE list_id=?',id);
      this.run('DELETE FROM watchlist_authors WHERE list_id=?',id);
      for (const t of rule.terms) this.run('INSERT INTO keyword_rules VALUES (?,?,?,?,?,?)',id,t.direction,t.kind,termKey(t),t.text,+t.important);
      for (const [role,selectors] of [['allow',rule.allowedAuthors],['favorite',rule.favoriteAuthors]] as const) {
        for (const selector of selectors) this.run('INSERT INTO watchlist_authors VALUES (?,?,?)',id,selector,role);
      }
    })();
    return this.lists.find(list=>list.id===id)!;
  }
  row(source:Source,id:string) {return this.get<PostRow>(postSelect+' WHERE p.namespace=? AND p.id=?',source,id);}
  candidate(row:PostRow):Candidate {
    return {namespace:row.namespace,id:row.id,canonicalId:row.canonical_id,text:row.text??'',authorId:row.author_id,
      handle:row.handle,displayName:row.display_name,language:row.language,createdAt:row.created_at,
      kind:row.kind,observedAt:row.last_seen_at,observation:row.observation,metrics:json(row.metrics_json)};
  }
  post(row:PostRow,detail=false):Post {
    const p=this.candidate(row);
    const [source,id]=[p.namespace,p.id];
    return {namespace:source,id,canonicalId:p.canonicalId,text:source==='mock'?p.text:null,
      authorId:p.authorId,handle:source==='mock'?p.handle:null,displayName:source==='mock'?p.displayName:null,
      language:p.language,createdAt:p.createdAt,kind:p.kind,metrics:p.metrics,observedAt:p.observedAt,
      simulated:source==='mock',firstSeenAt:row.first_seen_at,originalUrl:canonicalUrl(source,id),
      collector:this.get<{collector:CollectorId}>('SELECT collector FROM post_sources WHERE namespace=? AND post_id=? ORDER BY observed_at DESC,collector LIMIT 1',source,id)?.collector,
      matches:this.matches(source,id).map(match=>detail?match:{...match,signals:[],unavailable:[],penalties:[]}),
      feedback:this.feedback(source,id),preferences:this.preferences(source,p.authorId),
      ...(detail?{snapshots:this.all<{collected_at:number;metrics:string}>('SELECT collected_at,metrics FROM engagement_snapshots WHERE namespace=? AND post_id=? ORDER BY collected_at DESC LIMIT 20',source,id).map(s=>({collectedAt:s.collected_at,metrics:json(s.metrics)}))}:{})};
  }
  matches(source:Source,id:string) {return this.all<{explanation:string}>('SELECT explanation FROM scores WHERE namespace=? AND post_id=? ORDER BY score DESC,list_id',source,id).map(row=>json<Match>(row.explanation));}
  feedback(source:Source,id:string):Feedback {
    const row=this.get<{rating:Feedback['rating'];favorite:number}>('SELECT rating,favorite FROM feedback WHERE namespace=? AND post_id=?',source,id);
    return {rating:row?.rating??null,favorite:!!row?.favorite};
  }
  preferences(source:Source,author:string|null):Preferences {
    const row=this.get<{muted:number;favorite:number}>('SELECT muted,favorite FROM author_preferences WHERE namespace=? AND author_id=?',source,author);
    return {muted:!!row?.muted,favorite:!!row?.favorite};
  }
  provenance(p:Candidate) {
    this.run('INSERT INTO post_sources VALUES (?,?,?,?) ON CONFLICT(namespace,post_id,collector) DO UPDATE SET observed_at=max(observed_at,excluded.observed_at)',
      p.namespace,p.id,p.collector??p.namespace,p.observedAt);
  }
  persist(p:Candidate,now:number) {
    if (this.get('SELECT 1 FROM engagement_snapshots WHERE namespace=? AND post_id=? AND observation=?',p.namespace,p.id,p.observation)) {
      this.provenance(p);
      return false;
    }
    if (p.authorId) this.run('INSERT INTO authors VALUES (?,?,?,?,?) ON CONFLICT(namespace,id) DO UPDATE SET handle=coalesce(excluded.handle,handle),display_name=coalesce(excluded.display_name,display_name),last_seen_at=excluded.last_seen_at',p.namespace,p.authorId,p.handle,p.displayName,now);
    this.run(`INSERT INTO posts VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(namespace,id) DO UPDATE SET author_id=coalesce(excluded.author_id,author_id),text=coalesce(excluded.text,text),content_hash=coalesce(excluded.content_hash,content_hash),kind=CASE WHEN excluded.kind='unknown' THEN kind ELSE excluded.kind END,language=coalesce(excluded.language,language),created_at=coalesce(excluded.created_at,created_at),last_seen_at=excluded.last_seen_at,verified_at=excluded.verified_at,observation=excluded.observation,metrics_json=excluded.metrics_json
      WHERE excluded.last_seen_at>=last_seen_at`,
      p.namespace,p.id,p.canonicalId,p.authorId,p.text||null,p.text?hash(normalize(p.text)):null,p.kind,p.language,p.createdAt,now,p.observedAt,p.namespace==='x'?now:null,p.observation,JSON.stringify(p.metrics));
    this.run('INSERT INTO engagement_snapshots VALUES (?,?,?,?,?)',p.namespace,p.id,p.observation,p.observedAt,JSON.stringify(p.metrics));
    this.provenance(p);
    return this.row(p.namespace,p.id)?.observation===p.observation;
  }
  alert(row:{id:string;namespace:Source;post_id:string|null;list_name:string|null;decision_at:number;kind:Alert['kind'];score:number;read_at:number|null;dispatch_state:string;reason:string}):Alert {
    return {id:row.id,namespace:row.namespace,postId:row.post_id,listName:row.list_name,decisionAt:row.decision_at,kind:row.kind,
      score:row.score,readAt:row.read_at,dispatchState:row.dispatch_state,reason:row.reason,originalUrl:canonicalUrl(row.namespace,row.post_id)};
  }
  jobs(type:string,collector:CollectorId,now:number) {
    return this.all<Job>('SELECT * FROM monitoring_jobs WHERE type=? AND collector=? AND due_at<=? ORDER BY due_at,id LIMIT 25',type,collector,now);
  }
  schedule(id:string,type:string,source:Source,postId:string,due:number,payload:unknown) {
    this.run('INSERT INTO monitoring_jobs (id,type,due_at,namespace,post_id,payload,collector) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET due_at=min(due_at,excluded.due_at)',id,type,due,source,postId,JSON.stringify(payload),this.active.id);
  }
  close() {this.db.pragma('wal_checkpoint(TRUNCATE)');this.db.close();}
}
