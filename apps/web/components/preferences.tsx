'use client';

import {Database,Radio,RefreshCw} from 'lucide-react';
import Link from 'next/link';
import {useEffect,useState,type FormEvent} from 'react';
import {collectorLabel,type CollectionCoverage,type MonitorStatus,type Settings,type Source,type SourceInfo} from '../../../packages/contracts/index';
import {label,request,timestamp} from './client';
import {Mascot} from './mascot/mascot';
import {Modal,type ProfileSettings,type Run} from './workspace';

export function SourcesPage({sources,monitor,reduced,run,busy}:{sources:SourceInfo[];monitor:MonitorStatus;reduced:boolean;run:Run;busy:boolean}) {
  const [oauth,setOauth]=useState<'x'|'session'|null>(null),[client,setClient]=useState(''),[follows,setFollows]=useState(true),[likes,setLikes]=useState(false);
  const [refresh,setRefresh]=useState(false);
  const [oauthError,setOauthError]=useState('');
  const [hosted,setHosted]=useState<SourceInfo|null>(null);
  const [tuning,setTuning]=useState<SourceInfo|null>(null);
  const [sharing,setSharing]=useState(false);
  const summaries={mock:'Seeded posts for testing your rules',x:'Your app-only credentials and spending limits',session:'Local OAuth consent for documented X read operations',hosted:'Shared collection for public topics you approve'};
  return <div className="stack">
    <div className="list-grid">{sources.map(s=><section key={s.id} className="panel source-card">
      <div className="panel-heading"><div><h2>{collectorLabel[s.id]}</h2><p>{summaries[s.id]}</p></div><span className="stat-icon">{s.id==='mock'?<Radio size={18}/>:<Database size={18}/>}</span></div>
      <p><span className="chip">{s.active?'Active · ':''}{s.status}</span></p>
      {s.error&&<p className="warning">{s.error}</p>}
      {s.gap&&<p className="subtle">{s.gap}</p>}
      <dl className="fields">{s.features?.map(feature=><div key={feature.label}><dt>{feature.label}{feature.detail&&<small>{feature.detail}</small>}</dt><dd>{feature.state}</dd></div>)}</dl>
      {s.id==='x'&&<>
        <p className="subtle">Set your app-only bearer via <code>npm run monitor -- credentials set</code>. Configure X request and resource budgets in Settings.</p>
        <dl className="fields"><div><dt>Requests reserved today</dt><dd>{s.requests}</dd></div><div><dt>Resources reserved today</dt><dd>{s.resources}</dd></div><div><dt>Projected requests per day</dt><dd>Up to {s.projectedRequests}</dd></div><div><dt>UTC budget resets</dt><dd>{timestamp(s.resetAt)}</dd></div></dl>
        <p className="subtle">Filtered Stream uses rules set in your developer app. Recent search also runs at the configured interval.</p>
      </>}
      {s.id==='session'&&<>
        <p className="subtle">Official OAuth uses X’s consent screen and your app’s API budget. Access and refresh tokens stay in the OS vault.</p>
        <dl className="fields"><div><dt>Account</dt><dd>{s.account?'@'+s.account:'—'}</dd></div><div><dt>OAuth token expires</dt><dd>{timestamp(s.expiresAt)}</dd></div></dl>
      </>}
      {s.personalSync&&<dl className="fields">
        <div><dt>Last successful signal sync</dt><dd>{timestamp(s.personalSync.lastSuccess)}</dd></div>
        <div><dt>Signal coverage</dt><dd>{s.syncing?'Paging · checkpoint saved':s.personalSync.partial?'Partial or expired':s.personalSync.followingComplete?'Following sync complete':'Optional'}</dd></div>
        <div><dt>Following and liked authors</dt><dd>{s.personalSync.following} following · {s.personalSync.liked} liked</dd></div>
      </dl>}
      {s.id==='hosted'&&<>
        <p className="subtle">The VM receives approved public topics. Watchlist filters, X credentials, and personal ranking stay on this device.</p>
        {s.hosted&&<dl className="fields"><div><dt>Server</dt><dd>{s.hosted.origin}</dd></div><div><dt>Active subscriptions</dt><dd>{s.hosted.topics.join(', ')||'—'}</dd></div>
          <div><dt>Collection provider</dt><dd>{s.hosted.provider?label(s.hosted.provider):'Unverified'}</dd></div>
          <div><dt>Delivery</dt><dd>{s.hosted.delivery==='ids'?'Post IDs and links only':s.hosted.delivery}</dd></div><div><dt>Latency estimate</dt><dd>{s.hosted.latencyMs===null?'—':s.hosted.latencyMs+' ms'}</dd></div></dl>}
      </>}
      <div className="actions">
        <button className="button" disabled={s.active||busy||!s.configured} onClick={()=>void run(()=>request(`/sources/${s.id}/active`,'PUT'),`Selected ${collectorLabel[s.id]}.`)}>{s.active?'Selected':'Use source'}</button>
        {s.id==='mock'&&s.active&&<button className="button" disabled={busy} onClick={()=>void run(()=>request('/sources/mock/replay','POST'),'A fresh simulated timeline is queued.')}>Replay simulation</button>}
        {s.id!=='mock'&&(s.active||s.id==='hosted')&&s.configured&&<button className="button" disabled={busy} onClick={()=>void run(()=>request(`/sources/${s.id}/check`,'POST'),'Connection checked.')}><RefreshCw size={15}/> Check connection</button>}
        {s.id!=='mock'&&(s.configured||s.hosted)&&<button className="button" disabled={busy} onClick={()=>void run(()=>request(`/sources/${s.id}/disconnect`,'POST'),s.active?'Disconnected. Monitoring is paused.':'Disconnected.')}>Disconnect</button>}
        {s.id==='x'&&s.active&&<button className="button" disabled={busy} onClick={()=>{setOauthError('');setOauth('x');}}>Connect personal signals</button>}
        {s.id==='session'&&<button className="button" disabled={busy} onClick={()=>{setOauthError('');setFollows(false);setOauth('session');}}>{s.configured?'Reconnect official OAuth':'Connect official OAuth'}</button>}
        {s.id==='session'&&<button className="button" disabled={busy} onClick={()=>setSharing(true)}>Share selected X post</button>}
        {s.id==='hosted'&&<button className="button" disabled={busy} onClick={()=>setHosted(s)}>Configure hosted service</button>}
        {s.options&&<button className="button" disabled={busy} onClick={()=>setTuning(s)}>Collection settings</button>}
        {s.id==='x'&&s.configured&&<button className="button" disabled={busy} onClick={()=>void run(()=>request('/sources/x/signals','DELETE'),'Personal signals cleared.')}>Clear personal signals</button>}
      </div>
    </section>)}</div>
    <section className="panel collector source-diagnostics">
      <div className="panel-heading"><div><h2>Collection diagnostics</h2><p>Current source and local scheduling state</p></div></div>
      <Mascot mode={busy?'THINKING':monitor.error?'SAD':'IDLE'} reduced={reduced}/>
      <dl className="fields"><div><dt>Source</dt><dd>{collectorLabel[monitor.source]}</dd></div><div><dt>Last success</dt><dd>{timestamp(monitor.lastSuccess)}</dd></div><div><dt>Next attempt</dt><dd>{timestamp(monitor.nextDue)}</dd></div><div><dt>Polling interval</dt><dd>{monitor.intervalSeconds} seconds</dd></div></dl>
      <CoverageFields coverage={monitor.coverage}/>
      {monitor.gap&&<p className="warning">{monitor.gap}</p>}
    </section>
    {oauth&&<Modal title={oauth==='session'?'Connect with official X OAuth':'Connect personal signals'} close={()=>setOauth(null)}><p>Register <code>{typeof window!=='undefined'?location.origin:''}/api/v1/oauth/{oauth==='session'?'session/':''}callback</code> as the exact redirect URI for a public OAuth client in your developer app.</p>
      <div className="form-stack"><label>OAuth client ID<input value={client} onChange={e=>setClient(e.target.value)}/></label>
        <label className="check"><input type="checkbox" checked={follows} onChange={e=>setFollows(e.target.checked)}/> Accounts I follow</label>
        <label className="check"><input type="checkbox" checked={likes} onChange={e=>setLikes(e.target.checked)}/> Authors of posts I liked</label>
        <label className="check"><input type="checkbox" checked={refresh} onChange={e=>setRefresh(e.target.checked)}/> Allow refresh using the OS vault</label>
        {oauthError&&<p className="warning" role="alert">{oauthError}</p>}
        <button className="button primary" disabled={!client.trim()||(oauth==='x'&&!follows&&!likes)||busy} onClick={()=>void run(async()=>{
          setOauthError('');
          try{
            const result=await request<{url:string}>(`/sources/${oauth}/authorize`,'POST',{clientId:client.trim(),following:follows,likes,refresh});
            const url=new URL(result.url);
            if(url.origin!=='https://x.com'||url.pathname!=='/i/oauth2/authorize')throw new Error('Invalid authorization URL.');
            location.assign(url.toString());
          }catch(error){setOauthError(error instanceof Error?error.message:'Authorization unavailable');}
        })}>Continue to X</button>
      </div></Modal>}
    {hosted&&<HostedSetup source={hosted} busy={busy} close={()=>setHosted(null)} run={run}/>}
    {tuning?.options&&<CollectionOptions source={tuning} initial={tuning.options} busy={busy} close={()=>setTuning(null)} run={run}/>}
    {sharing&&<SharePost busy={busy} close={()=>setSharing(false)} run={run}/>}
  </div>;
}

export function CoverageFields({coverage}:{coverage?:CollectionCoverage}) {
  if(!coverage)return null;
  return <dl className="fields">
    <div><dt>Last attempt</dt><dd>{timestamp(coverage.lastAttempt)}</dd></div>
    <div><dt>Latest attempt</dt><dd>{coverage.posts} posts · {coverage.pages} pages or deliveries</dd></div>
    <div><dt>Oldest covered</dt><dd>{timestamp(coverage.oldest)}</dd></div>
    <div><dt>Newest covered</dt><dd>{timestamp(coverage.newest)}</dd></div>
    {coverage.budgetBlocked&&<div><dt>Collection budget</dt><dd>Budget prevented collection</dd></div>}
  </dl>;
}

function SharePost({busy,close,run}:{busy:boolean;close:()=>void;run:Run}) {
  const [url,setUrl]=useState(''),[excerpt,setExcerpt]=useState(''),[consent,setConsent]=useState(false),[postId,setPostId]=useState('');
  return <Modal title="Share a selected X post" close={close}>
    <p>From a post you’ve opened on X, copy the permalink and the text you choose to keep on this device.</p>
    {postId?<Link className="button primary" href={`/feed/?post=${encodeURIComponent(postId)}&source=x`}>View saved post</Link>:
      <form className="form-stack" onSubmit={e=>{e.preventDefault();void run(async()=>{
        const post=await request<{id:string}>('/posts/share','POST',{url,excerpt,consent});
        setPostId(post.id);
      },'Selected post saved locally.');}}>
        <label>X post permalink<input type="url" required maxLength={600} value={url} onChange={e=>setUrl(e.target.value)}/></label>
        <label>Selected excerpt<textarea required maxLength={5000} value={excerpt} onChange={e=>setExcerpt(e.target.value)}/></label>
        <label className="check"><input type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)}/> I choose to store this excerpt locally.</label>
        <button className="button primary" disabled={busy||!consent}>Save selected post</button>
      </form>}
  </Modal>;
}

function HostedSetup({source,busy,close,run}:{source:SourceInfo;busy:boolean;close:()=>void;run:Run}) {
  const [origin,setOrigin]=useState(source.hosted?.origin??''),[consent,setConsent]=useState(false);
  const [topics,setTopics]=useState((source.hosted?.approvedTopics??[]).filter(topic=>source.publicTopics?.includes(topic)));
  const [error,setError]=useState('');
  return <Modal title="Configure Hosted Monitoring" close={close}>
    <form className="form-stack" onSubmit={e=>{e.preventDefault();void run(async()=>{
      setError('');
      try{await request('/sources/hosted/config','PUT',{origin,topics,consent});close();}
      catch(error){setError(error instanceof Error?error.message:'Hosted setup unavailable');}
    });}}>
      <label>Public HTTPS server URL<input type="url" required value={origin} onChange={e=>setOrigin(e.target.value)} placeholder="https://monitor.example.com"/></label>
      <fieldset><legend>Public topics to send, up to 16</legend>
        {!source.publicTopics?.length&&<p>Create an enabled watchlist with a public keyword or phrase first.</p>}
        {source.publicTopics?.map(topic=><label className="check" key={topic}>
          <input type="checkbox" checked={topics.includes(topic)} disabled={topics.length>=16&&!topics.includes(topic)}
            onChange={e=>setTopics(e.target.checked?[...topics,topic]:topics.filter(value=>value!==topic))}/>{topic}
        </label>)}
      </fieldset>
      <label className="check"><input type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)}/> I consent to send these public topics to this server when Hosted Monitoring is active.</label>
      <p>Enter the VM-issued token in the local terminal using <code>npm run monitor -- hosted-credential set</code>. In the desktop app, use the tray's hosted credential action.</p>
      {error&&<p className="warning" role="alert">{error}</p>}
      <button className="button primary" type="submit" disabled={!origin||!topics.length||!consent||busy}>Approve hosted configuration</button>
    </form>
  </Modal>;
}
function CollectionOptions({source,initial,busy,close,run}:{source:SourceInfo;initial:NonNullable<SourceInfo['options']>;busy:boolean;close:()=>void;run:Run}) {
  const [draft,setDraft]=useState(initial);
  return <Modal title={collectorLabel[source.id]+' collection settings'} close={close}>
    <form className="form-stack" onSubmit={e=>{e.preventDefault();void run(()=>request(`/sources/${source.id}/options`,'PUT',draft),'Collection settings saved.').then(saved=>{if(saved)close();});}}>
      <label>Pages per query per cycle<input type="number" min={1} max={12} required value={draft.pages} onChange={e=>setDraft({...draft,pages:+e.target.value})}/></label>
      <label>Results per page<input type="number" min={10} max={100} required value={draft.pageSize} onChange={e=>setDraft({...draft,pageSize:+e.target.value})}/></label>
      <label>Recovery window in hours<input type="number" min={1} max={168} required value={draft.recoveryHours} onChange={e=>setDraft({...draft,recoveryHours:+e.target.value})}/></label>
      {source.id==='x'&&<label className="check"><input type="checkbox" checked={draft.stream} onChange={e=>setDraft({...draft,stream:e.target.checked})}/> Enable Filtered Stream with my configured X rules and provider-side spending ceiling</label>}
      <button className="button primary" type="submit" disabled={busy}>Save collection settings</button>
    </form>
  </Modal>;
}

type Preference = {namespace:Source;id:string;handle:string|null;muted:boolean;favorite:boolean};
export function SettingsPage({settings,run,busy}:{settings:ProfileSettings;run:Run;busy:boolean}) {
  const [draft,setDraft]=useState(settings),[important,setImportant]=useState(settings.importantTerms.join(', '));
  const [authors,setAuthors]=useState<Preference[]>([]),[feedback,setFeedback]=useState(''),[confirmation,setConfirmation]=useState('');
  const [erase,setErase]=useState<{nonce:string;profile:string;posts:number;lists:number}|null>(null),[erased,setErased]=useState(false);
  useEffect(()=>{void request<Preference[]>('/authors/preferences').then(setAuthors).catch(e=>setFeedback(e.message));},[]);
  const set=<K extends keyof Settings>(key:K,value:Settings[K])=>setDraft({...draft,[key]:value});
  async function save(event:FormEvent) {
    event.preventDefault();
    const {revision,...state}=draft;
    await run(async()=>{
      const result=await request<ProfileSettings>('/settings','PATCH',{...state,importantTerms:important.split(',').map(v=>v.trim()).filter(Boolean)},revision);
      setDraft(result);
    },'Settings saved.');
  }
  if(erased)return <section className="panel empty"><h2>Local profile erased</h2><p>Run <code>npm run monitor -- open</code> to create a new session.</p></section>;
  return <div className="stack">
    <form className="stack" onSubmit={save}>
      <section className="panel form-stack"><h2>Monitoring and alerts</h2><div className="form-grid">
        <label>Polling interval (seconds)<input type="number" min={60} max={3600} value={draft.intervalSeconds} onChange={e=>set('intervalSeconds',+e.target.value)}/></label>
        <label>Daily notification cap<input type="number" min={0} max={1000} value={draft.dailyCap} onChange={e=>set('dailyCap',+e.target.value)}/></label>
        <label className="check"><input type="checkbox" checked={draft.nativeNotifications} onChange={e=>set('nativeNotifications',e.target.checked)}/> Desktop notifications</label>
        <label className="check"><input type="checkbox" checked={draft.quiet.enabled} onChange={e=>set('quiet',{...draft.quiet,enabled:e.target.checked})}/> Enable quiet hours</label>
        <label>Quiet hours start<input type="time" required value={draft.quiet.start} onChange={e=>set('quiet',{...draft.quiet,start:e.target.value})}/></label>
        <label>Quiet hours end<input type="time" required value={draft.quiet.end} onChange={e=>set('quiet',{...draft.quiet,end:e.target.value})}/></label>
        <label>IANA time zone<input required value={draft.quiet.zone} onChange={e=>set('quiet',{...draft.quiet,zone:e.target.value})}/></label>
      </div></section>
      <section className="panel form-stack"><h2>Relevance weights</h2><div className="form-grid">{Object.entries(draft.weights).map(([key,value])=><label key={key}>{label(key)}<input type="number" min={key==='term'?1:0} max={100} value={value} onChange={e=>set('weights',{...draft.weights,[key]:+e.target.value})}/></label>)}</div>
        <label>Important terms, separated by commas<input value={important} onChange={e=>setImportant(e.target.value)}/></label>
      </section>
      <section className="panel form-stack"><h2>Live API budget</h2><p className="subtle">The monitor reserves resources before each request. Confirm a monthly spending limit in the X Developer Console before enabling paid traffic.</p><div className="form-grid">
        <label>Daily request ceiling<input type="number" min={0} max={5000} value={draft.dailyRequests} onChange={e=>set('dailyRequests',+e.target.value)}/></label>
        <label>Daily resource ceiling<input type="number" min={0} max={100000} value={draft.dailyResources} onChange={e=>set('dailyResources',+e.target.value)}/></label></div>
        <label className="check"><input type="checkbox" checked={draft.consoleBudgetConfirmed} onChange={e=>set('consoleBudgetConfirmed',e.target.checked)}/> I set a spending limit in the X Developer Console</label>
      </section>
      <section className="panel form-stack"><h2>Application and local data</h2><div className="form-grid">
        <label>Retention (days)<input type="number" min={1} max={90} value={draft.retentionDays} onChange={e=>set('retentionDays',+e.target.value)}/></label>
        <label className="check"><input type="checkbox" checked={draft.reduceMotion} onChange={e=>set('reduceMotion',e.target.checked)}/> Reduce motion</label></div>
        <p className="subtle">Login launch is managed through the packaged desktop tray.</p>
        <div><button className="button primary" type="submit" disabled={busy}>Save settings</button></div>
      </section>
    </form>
    <section className="panel form-stack"><h2>Author preferences</h2>{feedback&&<p className="warning">{feedback}</p>}
      {!authors.length?<p className="subtle">Favorite or mute an author from their post details.</p>:authors.map(author=><div className="preference-row" key={author.namespace+author.id}><strong>{author.handle?'@'+author.handle:author.id}</strong><span className="subtle">{author.namespace==='mock'?'Simulated':'Official X'}</span>
        <div className="actions">{(['favorite','muted'] as const).map(key=><button key={key} className="button" aria-pressed={author[key]} disabled={busy} onClick={()=>void run(async()=>{
          await request(`/authors/${author.namespace}/${author.id}/preferences`,'PUT',{favorite:author.favorite,muted:author.muted,[key]:!author[key]});
          setAuthors(await request('/authors/preferences'));
        })}>{key==='favorite'?(author.favorite?'Remove favorite':'Favorite'):(author.muted?'Unmute':'Mute')}</button>)}</div></div>)}
    </section>
    <section className="panel form-stack"><h2>Erase local profile</h2><p className="subtle">Remove this profile’s watchlists, posts, notifications, preferences, and saved X credentials.</p>
      <div><button className="button danger" onClick={()=>void run(async()=>setErase(await request('/data/erase-preview','POST')))}>Review erasure</button></div>
    </section>
    {erase&&<Modal title="Erase local profile" close={()=>{setErase(null);setConfirmation('');}}><p>{erase.posts} posts and {erase.lists} watchlists in <code>{erase.profile}</code>.</p>
      <label>Type ERASE to confirm<input value={confirmation} onChange={e=>setConfirmation(e.target.value)}/></label>
      <div className="actions section-actions"><button className="button danger" disabled={confirmation!=='ERASE'} onClick={async()=>{
        try {await request('/data/erase','POST',{nonce:erase.nonce,confirm:'ERASE'});setErase(null);setErased(true);}
        catch(error){setFeedback((error as Error).message);setErase(null);}
      }}>Erase profile</button></div>
    </Modal>}
  </div>;
}
