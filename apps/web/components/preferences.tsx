'use client';

import {Database,Radio} from 'lucide-react';
import Link from 'next/link';
import {useEffect,useState,type FormEvent} from 'react';
import {collectorLabel,type BrowserAction,type CollectionCoverage,type MonitorStatus,type Settings,type Source,type SourceInfo} from '../../../packages/contracts/index';
import {label,request,timestamp} from './client';
import {Mascot} from './mascot/mascot';
import {Modal,type ProfileSettings,type Run} from './workspace';

export function SourcesPage({sources,monitor,reduced,run,busy}:{sources:SourceInfo[];monitor:MonitorStatus;reduced:boolean;run:Run;busy:boolean}) {
  const [importOpen,setImportOpen]=useState(false),[share,setShare]=useState(false),[remember,setRemember]=useState(false);
  const local=sources.find(source=>source.id==='session');
  const simulated=sources.find(source=>source.id==='mock');
  const browserAction=(input:BrowserAction)=>void run(()=>request('/sources/session/browser','POST',input));
  const select=(source:SourceInfo)=>void run(()=>request(`/sources/${source.id}/active`,'PUT'),`Selected ${collectorLabel[source.id]}.`);
  return <div className="stack">
    <div className="grid two">
      {local&&<section className="panel form-stack">
        <div className="panel-heading"><div><h2>Local X Account</h2><p>Sign in directly on X in a separate desktop window.</p></div><span className="stat-icon"><Database size={18}/></span></div>
        <dl className="fields">
          <div><dt>Browser sign-in</dt><dd>{local.browser?.available?(local.browser.status==='Connected'?'Confirmed by you':local.browser.status):'Available in the desktop app'}</dd></div>
          <div><dt>Username</dt><dd>{local.account?'@'+local.account:'Awaiting confirmation'}</dd></div>
          <div><dt>Python worker</dt><dd>{local.pythonWorker??'Unavailable'}</dd></div>
          <div><dt>Session collection</dt><dd>{local.status}</dd></div>
          <div><dt>Monitoring state</dt><dd>{local.status==='Unsupported'?(local.browser?.available?'X authorization required':'Desktop app required'):!local.active?'Not selected':monitor.paused?'Paused':monitor.status}</dd></div>
          <div><dt>Collection capabilities</dt><dd>{local.capabilities.length?local.capabilities.join(', '):'None available'}</dd></div>
          <SourceStats source={local}/>
          <div><dt>Manually saved posts</dt><dd>{local.manualPosts??0}</dd></div>
        </dl>
        {local.status==='Unsupported'&&<p className="warning">Automatic X collection requires X authorization. The Python worker can process local exports.</p>}
        {local.status==='Rate limited'&&<p className="warning">Collection is rate limited. See the next scheduled check.</p>}
        {local.error&&<p className="warning">Collection error: {local.error}</p>}
        {local.browser?.available&&local.browser.status==='Check required'&&<p className="subtle">Checking the saved local session…</p>}
        {local.browser?.status==='Profile confirmation required'&&<p>In the X window, choose <strong>Profile</strong>. Confirm below when your profile shows <strong>Edit profile</strong>.</p>}
        {local.browser?.status==='Authentication required'&&<p className="subtle">Use an email code or password when X offers it. The embedded window cannot complete Sign in with Google.</p>}
        {local.browser?.status==='Verification required'&&<p className="warning">Complete verification directly in the X window.</p>}
        {local.browser?.status==='Rate limited'&&<p className="warning">X limited access. Follow the directions shown in the X window.</p>}
        {local.browser?.status==='Restricted'&&<p className="warning">X denied access. Follow the directions shown in the X window.</p>}
        {local.browser?.status==='Temporarily unavailable'&&<p className="warning">Check your network and unlock your system credential store if you saved a session.</p>}
        {local.browser?.available&&<>
          {local.browser.persistent?<p className="subtle">This browser uses a saved session on this device.</p>:
            <label className="check"><input type="checkbox" checked={remember} onChange={event=>setRemember(event.target.checked)}/> Remember my sign-in on this device when secure storage is available</label>}
          <div className="actions">
            <button className="button primary" disabled={busy} onClick={()=>browserAction({action:'open',remember})}>{local.browser.status==='Disconnected'?'Open X sign-in':'Open X account window'}</button>
            <button className="button" disabled={busy} onClick={()=>browserAction({action:'check'})}>Check browser session</button>
            {local.browser.status==='Profile confirmation required'&&
              <button className="button" disabled={busy} onClick={()=>browserAction({action:'confirm'})}>Confirm my X profile</button>}
            <button className="button" disabled={busy||local.browser.status==='Disconnected'} onClick={()=>browserAction({action:'disconnect'})}>Disconnect browser</button>
          </div>
        </>}
        <div className="actions">
          {local.browser?.status === 'Connected' &&
            local.status !== 'Unsupported' && (
              <button
                className="button primary"
                disabled={busy}
                onClick={() =>
                  void run(
                    () => request(
                      '/sources/session/connect',
                      'POST'
                    ),
                    'Local collection session configured.'
                  )
                }
              >
                {local.configured
                  ? 'Reconnect collection'
                  : 'Enable collection'}
              </button>
            )}

          {local.configured && (
            <button
              className="button"
              disabled={busy || local.active}
              onClick={() => select(local)}
            >
              {local.active ? 'Selected' : 'Use Local X Account'}
            </button>
          )}

          <button className="button" disabled={busy} onClick={() => setShare(true)}>
            Share selected X post
          </button>

          <button className="button" disabled={busy} onClick={() => setImportOpen(true)}>
            Import posts
          </button>

          {!!local.manualPosts && (
            <Link className="button" href="/feed/?collector=manual">
              View manual posts
            </Link>
          )}
        </div>
      </section>}
      {simulated&&<section className="panel form-stack">
        <div className="panel-heading"><div><h2>Simulated</h2><p>Test watchlists, ranking, and alerts with seeded example posts.</p></div><span className="stat-icon"><Radio size={18}/></span></div>
        <dl className="fields"><SourceStats source={simulated}/></dl>
        <div className="actions">
          <button className="button" disabled={busy||simulated.active} onClick={()=>select(simulated)}>{simulated.active?'Selected':'Use Simulated'}</button>
          <button className="button" disabled={busy||!simulated.active} onClick={()=>void run(()=>request('/sources/mock/replay','POST'),'Simulation queued.')}>Replay simulation</button>
        </div>
      </section>}
    </div>
    <section className="panel form-stack">
      <div className="panel-heading"><div><h2>Monitoring</h2><p>{collectorLabel[monitor.source]} · {monitor.status}</p></div><Mascot mode={monitor.error?'ERROR':'IDLE'} reduced={reduced}/></div>
      {(monitor.error||monitor.gap)&&<p className="warning">{monitor.gap??monitor.error}</p>}
      <dl className="fields"><div><dt>Polling interval</dt><dd>{monitor.intervalSeconds} seconds</dd></div></dl>
      <CoverageFields coverage={monitor.coverage}/>
    </section>
    {share&&<SharePost busy={busy} close={()=>setShare(false)} run={run}/>}
    {importOpen&&<ImportPosts busy={busy} close={()=>setImportOpen(false)} run={run}/>}
  </div>;
}

function SourceStats({source}:{source:SourceInfo}) {
  return <>
    <div><dt>Last successful collection</dt><dd>{timestamp(source.lastSuccess)}</dd></div>
    <div><dt>Next scheduled check</dt><dd>{source.nextDue===null?'Unscheduled':timestamp(source.nextDue)}</dd></div>
    <div><dt>Collected posts</dt><dd>{source.postCount}</dd></div>
  </>;
}

export function CoverageFields({coverage}:{coverage?:CollectionCoverage}) {
  if(!coverage)return null;
  return <dl className="fields">
    <div><dt>Last attempt</dt><dd>{timestamp(coverage.lastAttempt)}</dd></div>
    <div><dt>Latest attempt</dt><dd>{coverage.posts} posts · {coverage.pages} pages</dd></div>
    <div><dt>Oldest covered</dt><dd>{timestamp(coverage.oldest)}</dd></div>
    <div><dt>Newest covered</dt><dd>{timestamp(coverage.newest)}</dd></div>
  </dl>;
}


function SharePost({busy,close,run}:{busy:boolean;close:()=>void;run:Run}) {
  const [url,setUrl]=useState(''),[excerpt,setExcerpt]=useState(''),[consent,setConsent]=useState(false),[postId,setPostId]=useState('');
  const [language,setLanguage]=useState('');
  return <Modal title="Share a selected X post" close={close}>
    <p>Paste a permalink and excerpt to match it against your watchlists. Manual posts are saved on this device and never trigger alerts.</p>
    {postId?<Link className="button primary" href={`/feed/?collector=manual&post=${encodeURIComponent(postId)}&source=x`}>View saved post</Link>:
      <form className="form-stack" onSubmit={e=>{e.preventDefault();void run(async()=>{
        const post=await request<{id:string}>('/posts/share','POST',{url,excerpt,language:language.trim()||undefined,consent});
        setPostId(post.id);
      },'Selected post saved locally.');}}>
        <label>X post permalink<input type="url" required maxLength={600} value={url} onChange={e=>setUrl(e.target.value)}/></label>
        <label>Selected excerpt<textarea required maxLength={5000} value={excerpt} onChange={e=>setExcerpt(e.target.value)}/></label>
        <label>Language code (optional)<input placeholder="en" maxLength={3} pattern="[A-Za-z]{2,3}" value={language} onChange={e=>setLanguage(e.target.value)}/></label>
        <label className="check"><input type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)}/> I choose to store this excerpt locally.</label>
        <button className="button primary" disabled={busy||!consent}>Save selected post</button>
      </form>}
  </Modal>;
}

const examplePosts=encodeURIComponent(JSON.stringify([
  {url:'https://x.com/i/web/status/1234',text:'SQLite release candidate',author:'example',language:'en',metrics:{likes:10}},
],null,2));

function ImportPosts({busy,close,run}:{busy:boolean;close:()=>void;run:Run}) {
  const [file,setFile]=useState<File|null>(null),[consent,setConsent]=useState(false);
  const [result,setResult]=useState<{saved:number;skipped:number}|null>(null);
  return <Modal title="Import X posts" close={close}>
    <p>Choose a Smart Monitor JSON file or a twscrape JSONL export with up to 50 posts and a maximum size of 60 KB. Imports are matched locally and never trigger alerts.</p>
    <p><a href={`data:application/json;charset=utf-8,${examplePosts}`} download="smart-monitor-posts.example.json">Download JSON example</a></p>
    <form className="form-stack" onSubmit={event=>{event.preventDefault();void run(async()=>{
      if(!file||file.size>60*1024)throw new Error('Choose a JSON or JSONL file up to 60 KB.');
      const text=await file.text();
      if(file.name.toLowerCase().endsWith('.jsonl')){
        setResult(await request('/posts/import','POST',{twscrape:text,consent}));
      }else{
        let posts:unknown;
        try {posts=JSON.parse(text);}
        catch {throw new Error('The selected JSON file must contain a valid array.');}
        setResult(await request('/posts/import','POST',{posts,consent}));
      }
    });}}>
      <label>Post file<input type="file" accept=".json,.jsonl,application/json,application/x-ndjson" required onChange={event=>{
        setFile(event.target.files?.[0]??null);
        setResult(null);
      }}/></label>
      <label className="check"><input type="checkbox" checked={consent} onChange={event=>setConsent(event.target.checked)}/> I choose to store these posts on this device.</label>
      <button className="button primary" disabled={busy||!consent||!file}>Import selected file</button>
    </form>
    {result&&<p role="status">{result.saved} saved{result.skipped? ` · ${result.skipped} skipped because they were removed`:''}</p>}
    {!!result?.saved&&<Link className="button" href="/feed/?collector=manual">View manual posts</Link>}
  </Modal>;
}

type Preference = {namespace:Source;id:string;handle:string|null;muted:boolean;favorite:boolean};
export function SettingsPage({settings,run,busy,localX}:{settings:ProfileSettings;run:Run;busy:boolean;localX:boolean}) {
  const minimum=localX?120:60;
  const [draft,setDraft]=useState({...settings,intervalSeconds:Math.max(minimum,settings.intervalSeconds)}),[important,setImportant]=useState(settings.importantTerms.join(', '));
  const [authors,setAuthors]=useState<Preference[]>([]),[feedback,setFeedback]=useState(''),[confirmation,setConfirmation]=useState('');
  const [notificationTest,setNotificationTest]=useState('');
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
        <label>Polling interval (seconds)<input type="number" min={minimum} max={3600} value={draft.intervalSeconds} onChange={e=>set('intervalSeconds',+e.target.value)}/></label>
        <label>Daily notification cap<input type="number" min={0} max={1000} value={draft.dailyCap} onChange={e=>set('dailyCap',+e.target.value)}/></label>
        <label className="check"><input type="checkbox" checked={draft.nativeNotifications} onChange={e=>set('nativeNotifications',e.target.checked)}/> Desktop notifications</label>
        <label className="check"><input type="checkbox" checked={draft.simulatedNotifications} onChange={e=>set('simulatedNotifications',e.target.checked)}/> Allow desktop notifications for simulated posts</label>
        <label className="check"><input type="checkbox" checked={draft.quiet.enabled} onChange={e=>set('quiet',{...draft.quiet,enabled:e.target.checked})}/> Enable quiet hours</label>
        <label>Quiet hours start<input type="time" required value={draft.quiet.start} onChange={e=>set('quiet',{...draft.quiet,start:e.target.value})}/></label>
        <label>Quiet hours end<input type="time" required value={draft.quiet.end} onChange={e=>set('quiet',{...draft.quiet,end:e.target.value})}/></label>
        <label>IANA time zone<input required value={draft.quiet.zone} onChange={e=>set('quiet',{...draft.quiet,zone:e.target.value})}/></label>
      </div><button type="button" className="button" disabled={busy} onClick={()=>void run(async()=>{
        setNotificationTest('');
        const {result}=await request<{result:string}>('/notifications/test','POST');
        setNotificationTest(result==='submitted'?'Submitted to the operating system. Check that the notification appeared.':'The operating system did not accept the test notification.');
      })}>Send test notification</button>
      {notificationTest&&<p role="status">{notificationTest}</p>}
      <p className="subtle">If you don’t see a banner, check the system’s notification permission for Smart Monitor and turn off Do Not Disturb temporarily.</p></section>
      <section className="panel form-stack"><h2>Relevance weights</h2><div className="form-grid">{Object.entries(draft.weights).map(([key,value])=><label key={key}>{label(key)}<input type="number" min={key==='term'?1:0} max={100} value={value} onChange={e=>set('weights',{...draft.weights,[key]:+e.target.value})}/></label>)}</div>
        <label>Important terms, separated by commas<input value={important} onChange={e=>setImportant(e.target.value)}/></label>
      </section>
      <section className="panel form-stack"><h2>Application and local data</h2><div className="form-grid">
        <label>Retention (days)<input type="number" min={1} max={90} value={draft.retentionDays} onChange={e=>set('retentionDays',+e.target.value)}/></label>
        <label className="check"><input type="checkbox" checked={draft.reduceMotion} onChange={e=>set('reduceMotion',e.target.checked)}/> Reduce motion</label></div>
        <label className="check"><input type="checkbox" checked={draft.officialEmbeds} onChange={e=>set('officialEmbeds',e.target.checked)}/> Offer official X embeds on request, where authorized</label>
        <p className="subtle">Login launch is managed through the packaged desktop tray.</p>
        <div><button className="button primary" type="submit" disabled={busy}>Save settings</button></div>
      </section>
    </form>
    <section className="panel form-stack"><h2>Author preferences</h2>{feedback&&<p className="warning">{feedback}</p>}
      {!authors.length?<p className="subtle">Favorite or mute an author from their post details.</p>:authors.map(author=><div className="preference-row" key={author.namespace+author.id}><strong>{author.handle?'@'+author.handle:author.id}</strong><span className="subtle">{author.namespace==='mock'?'Simulated':'X'}</span>
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
