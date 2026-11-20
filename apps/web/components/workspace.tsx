'use client';

import Link from 'next/link';
import {Activity,ArrowRight,Bell,Bookmark,ChevronRight,CircleAlert,Database,ExternalLink,LayoutGrid,ListFilter,Menu,Pause,Play,Plus,Radar,Settings2,Signal,Target,X,Zap} from 'lucide-react';
import {useCallback,useEffect,useRef,useState,type ReactNode} from 'react';
import {collectorLabel,type Alert,type CollectorId,type Overview,type Post,type Settings,type Source,type SourceInfo,type Watchlist} from '../../../packages/contracts/index';
import {authenticate,label,request,timestamp} from './client';
import {Mascot} from './mascot/mascot';
import {Watchlists} from './watchlists';
import {CoverageFields,SettingsPage,SourcesPage} from './preferences';

export type Page='overview'|'watchlists'|'feed'|'notifications'|'sources'|'settings';
const nav=[
  {id:'overview',path:'/',title:'Overview',icon:LayoutGrid},
  {id:'watchlists',path:'/watchlists/',title:'Watchlists',icon:Target},
  {id:'feed',path:'/feed/',title:'Post feed',icon:Activity},
  {id:'notifications',path:'/notifications/',title:'Notifications',icon:Bell},
  {id:'sources',path:'/sources/',title:'Data sources',icon:Database},
  {id:'settings',path:'/settings/',title:'Settings',icon:Settings2},
] as const;
const title={
  overview:['Dashboard','Your watchlists, recent matches, and monitoring health.'],
  watchlists:['Watchlists','Choose what to track and when a match deserves an alert.'],
  feed:['Post feed','Search matches and see how each post earned its score.'],
  notifications:['Notifications','Review the matches that crossed your alert rules.'],
  sources:['Data sources','Manage collection access, usage, and connection health.'],
  settings:['Settings','Set monitoring, attention, and local data preferences.'],
};
export type ProfileSettings=Settings & {revision:number};
type Base={overview:Overview;lists:Watchlist[];settings:ProfileSettings;sources:SourceInfo[]};
type PageData<T>={items:T[];cursor?:string|null};
export function Workspace({page}:{page:Page}) {
  const [base,setBase]=useState<Base|null>(null),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [updates,setUpdates]=useState(0),[connected,setConnected]=useState(true),[menu,setMenu]=useState(false);
  const [detail,setDetail]=useState<{source:Source;id:string}|null>(null);
  const [busy,setBusy]=useState(false),[celebrate,setCelebrate]=useState(false);
  const refreshing=useRef(0);
  const refresh=useCallback(async()=>{
    const rank=++refreshing.current;
    const [overview,lists,settings,sources]=await Promise.all([
      request<Overview>('/overview'),request<Watchlist[]>('/watchlists'),request<ProfileSettings>('/settings'),request<SourceInfo[]>('/sources'),
    ]);
    if (rank===refreshing.current) setBase({overview,lists,settings,sources});
  },[]);
  useEffect(()=>{
    let disposed=false, stream:EventSource|undefined,debounce:ReturnType<typeof setTimeout>;
    const query=new URLSearchParams(location.search),post=query.get('post');
    if(post) setDetail({id:post,source:query.get('source')==='x'?'x':'mock'});
    void authenticate().then(async()=>{
      if(disposed) return;
      await refresh();
      if(disposed) return;
      stream=new EventSource('/api/v1/events');
      stream.onopen=()=>setConnected(true);
      stream.onmessage=()=>{
        clearTimeout(debounce);
        debounce=setTimeout(()=>{setUpdates(n=>n+1);void refresh().catch(()=>setConnected(false));},160);
      };
      stream.onerror=()=>setConnected(false);
    }).catch(error=>{if(!disposed)setError(error.message);});
    return ()=>{disposed=true;stream?.close();clearTimeout(debounce);};
  },[refresh]);
  const run=useCallback(async(work:()=>Promise<unknown>,message?:string)=>{
    setBusy(true);setError('');
    try {await work();await refresh();setUpdates(n=>n+1);if(message)setNotice(message);return true;}
    catch(error){setError(error instanceof Error?error.message:'The action failed.');return false;}
    finally{setBusy(false);}
  },[refresh]);
  const status=base?.overview.status;
  const toggle=async()=>{
    if(await run(()=>request('/monitor','PUT',{paused:!status?.paused}),status?.paused?'Monitoring resumed.':'Monitoring paused.') && status?.paused) setCelebrate(true);
  };
  function open(post:{namespace:Source;id:string}) {
    setDetail({source:post.namespace,id:post.id});
    if (page==='feed') history.replaceState(history.state,'',`/feed/?post=${encodeURIComponent(post.id)}&source=${post.namespace}`);
  }
  function close() {setDetail(null);if(page==='feed')history.replaceState(history.state,'','/feed/');}
  return <div className="app-shell" data-motion={base?.settings.reduceMotion?'off':undefined}>
    <a className="skip" href="#main">Skip to content</a>
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><Radar size={23}/></div><span>Smart Monitor<small>LOCAL WORKSPACE</small></span></div>
      <button className="button menu" aria-expanded={menu} onClick={()=>setMenu(!menu)}><Menu size={18}/> Menu</button>
      <nav aria-label="Workspace" className={menu?'nav expanded':'nav'}>
        {nav.map(({id,path,title,icon:Icon})=><Link key={id} href={path} aria-current={page===id?'page':undefined}><Icon size={18}/><span>{title}</span>{id==='notifications'&&!!base?.overview.unread&&<b>{base.overview.unread}</b>}</Link>)}
      </nav>
      <div className="sidebar-foot"><span className="dot"/> <span>On this device<small>Local storage</small></span></div>
    </aside>
    <main id="main" className="main">
      <header className="topbar"><span className="crumb">Workspace <ChevronRight size={15}/> {nav.find(n=>n.id===page)?.title}</span>
        {status&&<span className={`status-pill ${status.paused?'waiting':''}`}><span className="dot"/>{collectorLabel[status.source]} · {status.paused?'Paused':status.status}</span>}
      </header>
      <div className="content">
        <header className="heading"><div><h1>{title[page][0]}</h1><p>{title[page][1]}</p></div>
          {base&&page==='overview'&&<button className="button primary" disabled={busy||(status?.paused&&!base.lists.some(l=>l.enabled))} onClick={toggle}>{status?.paused?<Play size={17}/>:<Pause size={17}/>} {status?.paused?'Start monitoring':'Pause monitoring'}</button>}
        </header>
        {!connected&&<div className="banner" role="status"><CircleAlert size={18}/> Live connection interrupted. Showing the last available data.</div>}
        {error&&<div className="banner error" role="alert"><CircleAlert size={18}/><span>{error}</span>{base&&<button className="icon-button" aria-label="Dismiss error" onClick={()=>setError('')}><X size={16}/></button>}</div>}
        {notice&&<div className="banner good" role="status"><span>{notice}</span><button className="icon-button" aria-label="Dismiss message" onClick={()=>setNotice('')}><X size={16}/></button></div>}
        {!base&&!error&&<div className="panel empty">Connecting to the local service…</div>}
        {!base&&error&&<div className="panel empty"><Radar size={32}/><h2>Open your workspace</h2><p>Run <code>npm run monitor -- open</code> from the project folder to open a local session.</p></div>}
        {base&&page==='overview'&&<Dashboard base={base} updates={updates} open={open} celebrate={celebrate}/>}
        {base&&page==='watchlists'&&<Watchlists lists={base.lists} paused={base.overview.status.paused} run={run} busy={busy}/>}
        {base&&page==='feed'&&<Feed source={base.overview.status.source} lists={base.lists} updates={updates} open={open}/>}
        {base&&page==='notifications'&&<Notifications source={base.overview.status.source} updates={updates} run={run} open={open} busy={busy}/>}
        {base&&page==='sources'&&<SourcesPage sources={base.sources} monitor={base.overview.status} reduced={base.settings.reduceMotion} run={run} busy={busy}/>}
        {base&&page==='settings'&&<SettingsPage settings={base.settings} run={run} busy={busy}/>}
      </div>
    </main>
    {base&&detail&&<PostDetail selection={detail} onClose={close} run={run}/>}
  </div>;
}
export type Run=(work:()=>Promise<unknown>,message?:string)=>Promise<boolean>;
type Open=(post:{namespace:Source;id:string})=>void;

function Dashboard({base,updates,open,celebrate}:{base:Base;updates:number;open:Open;celebrate:boolean}) {
  const [posts,setPosts]=useState<Post[]>([]),[recent,setRecent]=useState<Alert[]>([]);
  const [failure,setFailure]=useState('');
  const o=base.overview, status=o.status;
  useEffect(()=>{
    let active=true;
    void Promise.all([request<PageData<Post>>(`/posts?collector=${status.source}&sort=score&limit=6`),request<PageData<Alert>>(`/notifications?collector=${status.source}&limit=3`)])
      .then(([p,n])=>{if(active){setPosts(p.items);setRecent(n.items);setFailure('');}})
      .catch(error=>{if(active)setFailure(error.message);});
    return ()=>{active=false;};
  },[status.source,updates]);
  const stats=[{name:'Matching posts today',value:o.today,icon:Activity},{name:'High priority today',value:o.priority,icon:Zap},{name:'Active watchlists',value:o.lists,icon:Target},{name:'Unread alerts',value:o.unread,icon:Bell}];
  return <>
    <div className="stats">{stats.map(({name,value,icon:Icon})=><section className="panel stat" key={name}><span className="stat-icon"><Icon size={18}/></span><span>{name}</span><strong>{value}</strong></section>)}</div>
    <div className="dashboard-grid">
      <div className="stack">
        <section className="panel">
          <div className="panel-heading"><div><h2>Top matches</h2><p>Ranked by relevance across your active source.</p></div><Link className="text-link" href="/feed/">View feed <ArrowRight size={16}/></Link></div>
          {failure&&<div className="banner error">{failure}</div>}
          {posts.length?<div className="post-list">{posts.map(post=><PostRow key={post.id} post={post} open={open}/>)}</div>:
            <div className="empty inset"><span className="empty-icon"><ListFilter size={26}/></span><h3>{base.lists.length?'Waiting for matching posts':'Create your first watchlist'}</h3>
              <p>{base.lists.length?'New matches appear here after collection.':'Try with simulated posts, or connect an official X data source.'}</p>
              <Link className="button" href="/watchlists/">{base.lists.length?'Manage watchlists':<><Plus size={16}/> Create watchlist</>}</Link>
              {!base.lists.length&&<Link className="text-link" href="/sources/">Choose data source <ArrowRight size={15}/></Link>}
            </div>}
        </section>
      </div>
      <div className="stack">
        <section className="panel collector">
          <div className="panel-heading"><div><h2>Collector health</h2><p>{collectorLabel[status.source]}</p></div><Signal size={18}/></div>
          <Mascot mode={status.error?'SAD':celebrate?'CELEBRATING':base.lists.length?'IDLE':'GREETING'} reduced={base.settings.reduceMotion}/>
          <dl className="fields"><div><dt>State</dt><dd>{status.paused?'Paused':status.status}</dd></div><div><dt>Last collection success</dt><dd>{timestamp(status.lastSuccess)}</dd></div><div><dt>Next check</dt><dd>{timestamp(status.nextDue)}</dd></div><div><dt>Interval</dt><dd>{status.intervalSeconds/60} min</dd></div></dl>
          <CoverageFields coverage={status.coverage}/>
          {status.error&&<p className="warning">{status.error}</p>}{status.gap&&<p className="warning">{status.gap}</p>}
          <Link className="text-link" href="/sources/">Source details <ArrowRight size={15}/></Link>
        </section>
        <section className="panel"><div className="panel-heading"><div><h2>Recent alerts</h2></div><Bell size={17}/></div>
          {recent.length?<div className="compact-list">{recent.map(a=><Link key={a.id} href="/notifications/"><span>{a.reason}</span><small>{timestamp(a.decisionAt)} · {label(a.kind)}</small></Link>)}</div>:<p className="subtle">Alerts appear when a match crosses a threshold.</p>}
        </section>
      </div>
    </div>
  </>;
}
function PostRow({post,open}:{post:Post;open:Open}) {
  const match=post.matches[0],author=post.displayName??post.handle??(post.simulated?'Simulated author':'X post');
  return <article className="post-row">
    <div className="avatar" aria-hidden="true">{author.split(/\s+/).slice(0,2).map(v=>v[0]).join('')}</div>
    <button className="post-body" onClick={()=>open(post)}>
      <span className="post-meta"><strong>{author}</strong>{post.handle&&<span>@{post.handle}</span>}<span>{timestamp(post.createdAt??post.observedAt)}</span>{post.simulated&&<span className="chip mini">Simulated</span>}{post.preview==='user-shared'&&<span className="chip mini">User-shared excerpt</span>}</span>
      <span className="post-copy">{post.text??(post.preview==='unresolved'?`Unresolved X post · ID ${post.id}`:'Preview opens on X')}</span>
      {post.collector&&post.collector!=='mock'&&<span className="subtle">{collectorLabel[post.collector]}</span>}
      <span className="post-reason">{match ? <><Target size={14}/> {match.listName}{post.matches.length>1?' +' + (post.matches.length-1):''} · {match.matched.join(', ')}</>:post.preview==='unresolved'||post.preview==='user-shared'?'Awaiting authorized content for matching':'No active match'}</span>
    </button>
    {match&&<span className={`score ${match.classification}`} title={label(match.classification)}><strong>{match.score}</strong><small>score</small></span>}
  </article>;
}
const blankFilters={q:'',listId:'',priority:'',kind:'',sort:'recent'};
function Feed({source,lists,updates,open}:{source:CollectorId;lists:Watchlist[];updates:number;open:Open}) {
  const [filters,setFilters]=useState(blankFilters),[items,setItems]=useState<Post[]>([]),[cursor,setCursor]=useState<string|null>(null);
  const [sourceFilter,setSourceFilter]=useState<CollectorId|''>('');
  const [pending,setPending]=useState<PageData<Post>|null>(null),[error,setError]=useState(''),[generation,setGeneration]=useState(0);
  const selected=sourceFilter||source;
  const query=new URLSearchParams({collector:selected,...Object.fromEntries(Object.entries(filters).filter(([,v])=>v))}).toString();
  const queryRef=useRef('');
  const shown=useRef<Post[]>([]);
  useEffect(()=>{
    let active=true;
    const changed=queryRef.current!==query;
    const timer=setTimeout(()=>{
      void request<PageData<Post>>('/posts?'+query).then(result=>{
        if(!active)return;
        queryRef.current=query;
        setError('');
        if(changed||!shown.current.length) {shown.current=result.items;setItems(result.items);setCursor(result.cursor??null);setPending(null);}
        else if(result.items.some(post=>!shown.current.some(old=>old.id===post.id))) setPending(result);
        else {
          const fresh=new Map(result.items.map(p=>[p.id,p]));
          const updated=[...result.items,...shown.current.filter(p=>!fresh.has(p.id))];
          shown.current=updated;setItems(updated);
        }
      }).catch(error=>{if(active)setError(error.message);});
    },180);
    return ()=>{active=false;clearTimeout(timer);};
  },[query,updates,generation]);
  const more=async()=>{
    try {
      const next=await request<PageData<Post>>('/posts?'+query+'&cursor='+encodeURIComponent(cursor??''));
      const merged=[...new Map([...shown.current,...next.items].map(p=>[p.id,p])).values()];
      shown.current=merged;setItems(merged);setCursor(next.cursor??null);
    } catch(error){setError((error as Error).message);setGeneration(n=>n+1);}
  };
  return <section className="panel">
    <div className="toolbar">
      <label className="grow">Search<input value={filters.q} onChange={e=>setFilters({...filters,q:e.target.value})} maxLength={200} placeholder={selected==='mock'?'Post text or author':'X post ID'}/></label>
      <label>Source<select value={sourceFilter} onChange={event=>setSourceFilter(event.target.value as CollectorId|'')}><option value="">Active source</option>{Object.entries(collectorLabel).map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label>
      <label>Watchlist<select value={filters.listId} onChange={e=>setFilters({...filters,listId:e.target.value})}><option value="">All watchlists</option>{lists.map(l=><option value={l.id} key={l.id}>{l.name}</option>)}</select></label>
      <label>Priority<select value={filters.priority} onChange={e=>setFilters({...filters,priority:e.target.value})}><option value="">All priorities</option>{['immediate','standard','delayed','silent'].map(s=><option key={s} value={s}>{label(s)}</option>)}</select></label>
      <label>Post kind<select value={filters.kind} onChange={e=>setFilters({...filters,kind:e.target.value})}><option value="">All kinds</option>{['original','reply','repost','quote','unknown'].map(s=><option key={s} value={s}>{s}</option>)}</select></label>
      <label>Sort<select value={filters.sort} onChange={e=>setFilters({...filters,sort:e.target.value})}><option value="recent">Most recent</option><option value="score">Highest score</option></select></label>
    </div>
    {error&&<div className="banner error">{error}</div>}
    {pending&&<button className="button update" onClick={()=>{shown.current=pending.items;setItems(pending.items);setCursor(pending.cursor??null);setPending(null);}}>Show {pending.items.filter(p=>!shown.current.some(s=>s.id===p.id)).length} new posts</button>}
    {items.length?<div className="post-list">{items.map(post=><PostRow key={post.id} post={post} open={open}/>)}</div>:<div className="empty"><Activity size={26}/><h3>No matches to show</h3><p>Change the filters or let the next collection finish.</p></div>}
    {cursor&&<button className="button update" onClick={()=>void more()}>Load more</button>}
  </section>;
}
function Notifications({source,updates,run,open,busy}:{source:CollectorId;updates:number;run:Run;open:Open;busy:boolean}) {
  const [unread,setUnread]=useState(false),[alerts,setAlerts]=useState<Alert[]>([]),[error,setError]=useState('');
  const [limit,setLimit]=useState(50);
  const [older,setOlder]=useState<{before:number;beforeId:string}|null>(null);
  type AlertPage={items:Alert[];cursor:{before:number;beforeId:string}|null};
  useEffect(()=>{
    let active=true;
    async function load() {
      const loaded:Alert[]=[];
      let page:AlertPage|undefined;
      while(active && loaded.length<limit) {
        const query=new URLSearchParams({collector:source,unread:String(unread),limit:String(Math.min(100,limit-loaded.length))});
        if(page?.cursor) {
          query.set('before',String(page.cursor.before));
          query.set('beforeId',page.cursor.beforeId);
        }
        page=await request<AlertPage>('/notifications?'+query);
        loaded.push(...page.items);
        if(!page.cursor)break;
      }
      if(active){setAlerts(loaded);setOlder(page?.cursor??null);setError('');}
    }
    void load().catch(e=>{if(active)setError(e.message);});
    return ()=>{active=false;};
  },[source,updates,unread,limit]);
  const mark=(alert:Alert,read:boolean)=>request(`/notifications/${alert.id}/read`,'PUT',{read});
  return <section className="panel">
    <div className="toolbar"><div className="segmented"><button aria-pressed={!unread} onClick={()=>setUnread(false)}>All</button><button aria-pressed={unread} onClick={()=>setUnread(true)}>Unread</button></div>
      <div className="actions"><button className="button" disabled={busy} onClick={()=>void run(async()=>{
        const result=await request<{result:string}>('/notifications/test','POST');
        if(result.result!=='submitted')throw new Error('The native notification service did not accept the test.');
      },'Test submitted to the desktop.')}>Test desktop alert</button>
      <button className="button" disabled={busy||!alerts.some(a=>a.readAt===null)} onClick={()=>void run(()=>request('/notifications/read-all','POST',{collector:source,cutoff:Math.max(...alerts.map(a=>a.decisionAt))}))}>Mark all read</button></div>
    </div>
    {error&&<div className="banner error">{error}</div>}
    {alerts.length?alerts.map(a=><article className="alert-row" key={a.id}><span className={`alert-icon ${a.readAt===null?'unread':''}`}><Bell size={18}/></span>
      <div><strong>{a.reason}</strong><div className="subtle">{label(a.kind)} · Score {a.score} · {timestamp(a.decisionAt)}{a.namespace==='mock'?' · Simulated':''}</div><small>{label(a.dispatchState)}</small></div>
      <div className="actions">{a.originalUrl?<a className="button" href={a.originalUrl} target="_blank" rel="noreferrer" onClick={()=>void run(()=>mark(a,true))}>Open on X <ExternalLink size={15}/></a>:
        a.postId&&<button className="button" onClick={()=>{void run(()=>mark(a,true));open({namespace:a.namespace,id:a.postId!});}}>View match</button>}
        <button className="button" onClick={()=>void run(()=>mark(a,a.readAt===null))}>{a.readAt===null?'Mark read':'Mark unread'}</button></div>
    </article>):<div className="empty"><Bell size={27}/><h3>{unread?'You’re caught up':'No notifications yet'}</h3><p>Matches below your thresholds remain in the feed.</p></div>}
    {older&&<button className="button update" onClick={()=>setLimit(value=>value+50)}>Load older alerts</button>}
  </section>;
}

export function Modal({title,children,close}:{title:string;children:ReactNode;close:()=>void}) {
  const dialog=useRef<HTMLDialogElement>(null);
  useEffect(()=>{
    const node=dialog.current;
    const trigger=document.activeElement;
    node?.showModal();
    return ()=>{
      node?.close();
      if(trigger instanceof HTMLElement&&trigger.isConnected)trigger.focus({preventScroll:true});
    };
  },[]);
  return <dialog ref={dialog} className="dialog" aria-label={title} onCancel={event=>{event.preventDefault();close();}}>
    <div className="dialog-content"><header><h2>{title}</h2><button className="icon-button" onClick={close} aria-label="Close dialog"><X size={22}/></button></header>{children}</div>
  </dialog>;
}
function PostDetail({selection,onClose,run}:{selection:{source:Source;id:string};onClose:()=>void;run:Run}) {
  const [post,setPost]=useState<Post|null>(null),[error,setError]=useState('');
  const path=`/posts/${selection.source}/${encodeURIComponent(selection.id)}`;
  const load=useCallback(async()=>setPost(await request<Post>(path)),[path]);
  useEffect(()=>{void load().catch(e=>setError(e.message));},[load]);
  return <Modal title="Post details" close={onClose}>
    {error&&<p className="banner error">{error}</p>}
    {!post&&!error&&<p>Loading match…</p>}
    {post&&<>
      <div className="post-meta"><strong>{post.displayName??'X post'}</strong>{post.handle&&<span>@{post.handle}</span>}{post.simulated&&<span className="chip">Simulated</span>}</div>
      {post.preview==='user-shared'&&<p className="subtle">User-shared excerpt</p>}
      <p>{post.text??'Open the original on X to read this post.'}</p>
      {(post.preview==='unresolved'||post.preview==='user-shared')&&!post.matches.length&&<p className="subtle">The monitor is awaiting authorized post content before evaluating watchlist rules.</p>}
      <p className="subtle">Created {timestamp(post.createdAt)} · Collected {timestamp(post.observedAt)} · {post.kind}</p>
      {!!post.provenance?.length&&<p className="subtle">Sources · {post.provenance.map(id=>collectorLabel[id]).join(', ')}</p>}
      {post.originalUrl&&<a className="button" href={post.originalUrl} target="_blank" rel="noreferrer">Open original <ExternalLink size={16}/></a>}
      <div className="metrics">{Object.entries(post.metrics).map(([key,value])=><div key={key}><small>{key}</small><strong>{value===null?'Unknown':value.toLocaleString()}</strong></div>)}</div>
      {post.matches.map(match=><details key={match.listId} className="explain" open><summary>{match.score} · {label(match.classification)} · {match.listName}</summary>
        <p>Matched {match.matched.join(', ')}</p>{match.previousScore!==undefined&&<p>Previous score {match.previousScore}</p>}{match.suppression&&<p className="warning">{match.suppression}</p>}
        <dl className="fields">{match.signals.map(signal=><div key={signal.key}><dt>{label(signal.key)}{signal.detail&&<small>{signal.detail}</small>}</dt><dd>{signal.value.toFixed(2)} × {signal.weight}</dd></div>)}</dl>
        <p className="subtle">Available weight {match.availableWeight}{match.unavailable.length?' · Unavailable: '+match.unavailable.map(label).join(', '):''}</p>
        {match.penalties.map(p=><div key={p.reason}>{p.reason} (−{p.points})</div>)}
      </details>)}
      {!!post.snapshots?.length&&<details className="explain"><summary>Engagement history ({post.snapshots.length})</summary>
        {post.snapshots.map(s=><p key={s.collectedAt}>{timestamp(s.collectedAt)} · {Object.entries(s.metrics).filter(([,v])=>v!==null).map(([k,v])=>`${v} ${k}`).join(', ')||'Counters unavailable'}</p>)}
      </details>}
      <section className="stack"><h3>Personalize future matches</h3><div className="actions">
        {(['useful','irrelevant'] as const).map(rating=><button className="button" key={rating} aria-pressed={post.feedback.rating===rating} onClick={()=>void run(async()=>{await request(path+'/feedback','PUT',{...post.feedback,rating:post.feedback.rating===rating?null:rating});await load();})}>{rating==='useful'?'Useful':'Not relevant'}</button>)}
        <button className="button" aria-pressed={post.feedback.favorite} onClick={()=>void run(async()=>{await request(path+'/feedback','PUT',{...post.feedback,favorite:!post.feedback.favorite});await load();})}><Bookmark size={16}/> Favorite post</button>
        {post.authorId&&(['favorite','muted'] as const).map(key=><button className="button" aria-pressed={post.preferences[key]} key={key} onClick={()=>void run(async()=>{await request(`/authors/${post.namespace}/${post.authorId}/preferences`,'PUT',{...post.preferences,[key]:!post.preferences[key]});await load();})}>{key==='favorite'?'Favorite author':post.preferences.muted?'Unmute author':'Mute author'}</button>)}
      </div></section>
    </>}
  </Modal>;
}
