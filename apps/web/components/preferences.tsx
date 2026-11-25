'use client';

import {Database,Radio} from 'lucide-react';
import Link from 'next/link';
import {useEffect,useState,type FormEvent} from 'react';
import {collectorLabel,type CollectionCoverage,type MonitorStatus,type Settings,type Source,type SourceInfo} from '../../../packages/contracts/index';
import {label,request,timestamp} from './client';
import {Mascot} from './mascot/mascot';
import {Modal,type ProfileSettings,type Run} from './workspace';

export function SourcesPage({sources,monitor,reduced,run,busy}:{sources:SourceInfo[];monitor:MonitorStatus;reduced:boolean;run:Run;busy:boolean}) {
  const [hosted,setHosted]=useState<SourceInfo|null>(null),[share,setShare]=useState(false),[remember,setRemember]=useState(false);
  const local=sources.find(source=>source.id==='session');
  const remote=sources.find(source=>source.id==='hosted');
  const simulated=sources.find(source=>source.id==='mock');
  const browserAction=(input:{action:'open';remember:boolean}|{action:'check'|'disconnect'},message?:string)=>
    void run(()=>request('/sources/session/browser','POST',input),message);
  const select=(source:SourceInfo)=>void run(()=>request(`/sources/${source.id}/active`,'PUT'),`Selected ${collectorLabel[source.id]}.`);
  return <div className="stack">
    <div className="grid two">
      {local&&<section className="panel form-stack">
        <div className="panel-heading"><div><h2>Local X Account</h2><p>Sign in directly on X in a separate desktop window.</p></div><span className="stat-icon"><Database size={18}/></span></div>
        <dl className="fields">
          <div><dt>Browser sign-in</dt><dd>{local.browser?.available?local.browser.status:'Available in the desktop app'}</dd></div>
          <div><dt>Username</dt><dd>{local.account?'@'+local.account:'Unverified'}</dd></div>
          <div><dt>Session collection</dt><dd>{local.status}</dd></div>
          <div><dt>Last successful collection</dt><dd>{timestamp(local.lastSuccess)}</dd></div>
        </dl>
        {local.status==='Unsupported'&&<p className="warning">Automatic search requires an authorized X collection interface. Signing in lets you browse X manually.</p>}
        {local.browser?.status==='Connected'&&<p className="subtle">A local sign-in cookie is present. Confirm the account in the X window.</p>}
        {local.browser?.status==='Verification required'&&<p className="warning">Complete verification directly in the X window.</p>}
        {local.browser?.status==='Rate limited'&&<p className="warning">X limited access. Follow the directions shown in the X window.</p>}
        {local.browser?.status==='Temporarily unavailable'&&<p className="warning">Check your network and unlock your system credential store if you saved a session.</p>}
        {local.browser?.available&&<>
          {local.browser.persistent?<p className="subtle">This browser uses a saved session on this device.</p>:
            <label className="check"><input type="checkbox" checked={remember} onChange={event=>setRemember(event.target.checked)}/> Remember my sign-in on this device when secure storage is available</label>}
          <div className="actions">
            <button className="button primary" disabled={busy} onClick={()=>browserAction({action:'open',remember})}>{local.browser.status==='Disconnected'?'Open X sign-in':'Open X account window'}</button>
            <button className="button" disabled={busy} onClick={()=>browserAction({action:'check'})}>Check browser session</button>
            <button className="button" disabled={busy||local.browser.status==='Disconnected'} onClick={()=>browserAction({action:'disconnect'},'Local X browser session cleared.')}>Disconnect browser</button>
          </div>
        </>}
        <div className="actions">
          {local.configured&&<button className="button" disabled={busy||local.active} onClick={()=>select(local)}>{local.active?'Selected':'Use Local X Account'}</button>}
          <button className="button" disabled={busy} onClick={()=>setShare(true)}>Share selected X post</button>
        </div>
      </section>}
      {remote&&<section className="panel form-stack">
        <div className="panel-heading"><div><h2>Hosted Monitoring</h2><p>Receive updates from your server for public topics you approve.</p></div><span className="stat-icon"><Database size={18}/></span></div>
        <dl className="fields">
          <div><dt>Connection</dt><dd>{remote.status}</dd></div>
          <div><dt>Client token</dt><dd>{remote.configured?'Saved locally':'Required'}</dd></div>
          <div><dt>Server</dt><dd>{remote.hosted?.origin??'—'}</dd></div>
          <div><dt>Subscribed topics</dt><dd>{remote.hosted?.topics.join(', ')||'—'}</dd></div>
          <div><dt>Last received post</dt><dd>{timestamp(remote.hosted?.lastReceived??null)}</dd></div>
          <div><dt>Delivery mode</dt><dd>{remote.hosted?.delivery??'Unavailable'}</dd></div>
        </dl>
        <p className="subtle">The bundled server supports simulated delivery. Live collection requires an authorized source and redistribution rights.</p>
        {remote.error&&<p className="warning">{label(remote.error)}{remote.gap?' · '+remote.gap:''}</p>}
        <div className="actions">
          <button className="button" disabled={busy} onClick={()=>setHosted(remote)}>Configure server</button>
          <button className="button" disabled={busy||!remote.configured} onClick={()=>void run(()=>request('/sources/hosted/check','POST'),'Hosted connection checked.')}>Check connection</button>
          <button className="button primary" disabled={busy||remote.active||!remote.configured} onClick={()=>select(remote)}>{remote.active?'Selected':'Use Hosted Monitoring'}</button>
          {remote.hosted&&<button className="button" disabled={busy} onClick={()=>void run(()=>request('/sources/hosted/disconnect','POST'),'Hosted Monitoring disconnected.')}>Disconnect</button>}
        </div>
      </section>}
    </div>
    {simulated&&<section className="panel form-stack">
      <div className="panel-heading"><div><h2>Simulated</h2><p>Test watchlists, ranking, and alerts with seeded example posts.</p></div><span className="stat-icon"><Radio size={18}/></span></div>
      <div className="actions">
        <button className="button" disabled={busy||simulated.active} onClick={()=>select(simulated)}>{simulated.active?'Selected':'Use Simulated'}</button>
        <button className="button" disabled={busy||!simulated.active} onClick={()=>void run(()=>request('/sources/mock/replay','POST'),'Simulation queued.')}>Replay simulation</button>
      </div>
    </section>}
    <section className="panel form-stack">
      <div className="panel-heading"><div><h2>Monitoring</h2><p>{collectorLabel[monitor.source]} · {monitor.status}</p></div><Mascot mode={monitor.error?'ERROR':'IDLE'} reduced={reduced}/></div>
      <dl className="fields"><div><dt>Next attempt</dt><dd>{timestamp(monitor.nextDue)}</dd></div><div><dt>Polling interval</dt><dd>{monitor.intervalSeconds} seconds</dd></div></dl>
      <CoverageFields coverage={monitor.coverage}/>
    </section>
    {hosted&&<HostedSetup source={hosted} busy={busy} close={()=>setHosted(null)} run={run}/>}
    {share&&<SharePost busy={busy} close={()=>setShare(false)} run={run}/>}
  </div>;
}

export function CoverageFields({coverage}:{coverage?:CollectionCoverage}) {
  if(!coverage)return null;
  return <dl className="fields">
    <div><dt>Last attempt</dt><dd>{timestamp(coverage.lastAttempt)}</dd></div>
    <div><dt>Latest attempt</dt><dd>{coverage.posts} posts · {coverage.pages} pages or deliveries</dd></div>
    <div><dt>Oldest covered</dt><dd>{timestamp(coverage.oldest)}</dd></div>
    <div><dt>Newest covered</dt><dd>{timestamp(coverage.newest)}</dd></div>
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
  const [liveTermsAccepted,setLiveTermsAccepted]=useState(!!source.hosted?.liveTermsAccepted);
  const [topics,setTopics]=useState((source.hosted?.approvedTopics??[]).filter(topic=>source.publicTopics?.includes(topic)));
  const [error,setError]=useState('');
  return <Modal title="Configure Hosted Monitoring" close={close}>
    <form className="form-stack" onSubmit={e=>{e.preventDefault();void run(async()=>{
      setError('');
      try{await request('/sources/hosted/config','PUT',{origin,topics,consent,liveTermsAccepted});close();}
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
      <label className="check"><input type="checkbox" checked={liveTermsAccepted} onChange={e=>setLiveTermsAccepted(e.target.checked)}/> For live X delivery, I agree to the applicable X Terms of Service, Privacy Policy, Developer Agreement, and Developer Policy.</label>
      <p>Enter the VM-issued token in the local terminal using <code>npm run monitor -- hosted-credential set</code>. In the desktop app, use the tray's hosted credential action.</p>
      {error&&<p className="warning" role="alert">{error}</p>}
      <button className="button primary" type="submit" disabled={!origin||!topics.length||!consent||busy}>Approve hosted configuration</button>
    </form>
  </Modal>;
}
type Preference = {namespace:Source;id:string;handle:string|null;muted:boolean;favorite:boolean};
export function SettingsPage({settings,run,busy}:{settings:ProfileSettings;run:Run;busy:boolean}) {
  const [draft,setDraft]=useState(settings),[important,setImportant]=useState(settings.importantTerms.join(', '));
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
        <label>Polling interval (seconds)<input type="number" min={60} max={3600} value={draft.intervalSeconds} onChange={e=>set('intervalSeconds',+e.target.value)}/></label>
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
