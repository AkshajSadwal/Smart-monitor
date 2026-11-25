'use client';

import {Copy,Pause,Play,Plus,Target,Trash2,X} from 'lucide-react';
import {useState,type FormEvent} from 'react';
import type {Rule,Score,Watchlist} from '../../../packages/contracts/index';
import {request} from './client';
import {Modal,type Run} from './workspace';

const fresh=():Rule=>({name:'',mode:'ANY',enabled:true,terms:[{kind:'word',direction:'include',text:'',important:false}],allowedAuthors:[],favoriteAuthors:[],language:null,minEngagement:0,standard:70,immediate:85,cooldownSeconds:300});
const example=():Rule=>({...fresh(),name:'SQLite releases',mode:'ALL',language:'en',terms:[{kind:'word',direction:'include',text:'SQLite',important:true},{kind:'phrase',direction:'include',text:'release candidate',important:false},{kind:'word',direction:'exclude',text:'hiring',important:false}]});
function draftFrom(list:Watchlist):Rule {
  const {name,mode,enabled,terms,allowedAuthors,favoriteAuthors,language,minEngagement,standard,immediate,cooldownSeconds}=list;
  return {name,mode,enabled,terms,allowedAuthors,favoriteAuthors,language,minEngagement,standard,immediate,cooldownSeconds};
}
export function Watchlists({lists,run,busy}:{lists:Watchlist[];run:Run;busy:boolean}) {
  const [editor,setEditor]=useState<{draft:Rule;list?:Watchlist}|null>(null),[remove,setRemove]=useState<Watchlist|null>(null);
  return <>
    <div className="actions section-actions">
      <button className="button primary" onClick={()=>setEditor({draft:fresh()})}><Plus size={17}/> New watchlist</button>
      <button className="button" onClick={()=>setEditor({draft:example()})}>Use SQLite example</button>
    </div>
    {!lists.length?<section className="panel empty"><Target size={30}/><h2>Watch your first topic</h2><p>Start with the SQLite example to try monitoring with simulated posts.</p></section>:
      <div className="list-grid">{lists.map(list=><section className="panel watch-card" key={list.id}>
        <div className="panel-heading"><div><h2>{list.name}</h2><p>{list.matches} matching posts · {list.mode==='ANY'?'Any included term':'All included terms'}</p></div><span className="chip">{list.enabled?'Enabled':'Paused'}</span></div>
        <div className="actions">{list.terms.map(t=><span key={t.direction+t.kind+t.text} className="chip">{t.direction==='exclude'?'Exclude ':''}{t.text}</span>)}</div>
        <p className="subtle">Standard ≥ {list.standard} · Immediate ≥ {list.immediate}</p>
        <div className="actions">
          <button className="button" onClick={()=>setEditor({draft:draftFrom(list),list})}>Edit</button>
          <button className="button" disabled={busy} onClick={()=>void run(()=>request('/watchlists/'+list.id,'PATCH',{enabled:!list.enabled},list.revision))}>{list.enabled?<Pause size={15}/>:<Play size={15}/>} {list.enabled?'Pause':'Resume'}</button>
          <button className="button" onClick={()=>setEditor({draft:{...draftFrom(list),name:(list.name+' copy').slice(0,80)}})}><Copy size={15}/> Duplicate</button>
          <button className="icon-button" aria-label={'Delete '+list.name} onClick={()=>setRemove(list)}><Trash2 size={17}/></button>
        </div>
      </section>)}</div>}
    {editor&&<Editor initial={editor.draft} existing={editor.list} close={()=>setEditor(null)} done={()=>setEditor(null)} run={run} busy={busy}/>}
    {remove&&<Modal title="Delete watchlist" close={()=>setRemove(null)}><p>Delete “{remove.name}” and its rules? Other watchlists and alert history are retained.</p>
      <div className="actions"><button className="button" onClick={()=>setRemove(null)}>Cancel</button><button className="button danger" disabled={busy} onClick={async()=>{if(await run(()=>request('/watchlists/'+remove.id,'DELETE',undefined,remove.revision),'Watchlist deleted.'))setRemove(null);}}>Delete watchlist</button></div>
    </Modal>}
  </>;
}

function Editor({initial,existing,close,done,run,busy}:{initial:Rule;existing?:Watchlist;close:()=>void;done:()=>void;run:Run;busy:boolean}) {
  const [draft,setDraft]=useState(initial),[sample,setSample]=useState('SQLite release candidate is ready.'),[sampleAuthor,setSampleAuthor]=useState('releasewatch');
  const [result,setResult]=useState<{result:Score|null;reason:string|null}|null>(null),[error,setError]=useState('');
  const [allowed,setAllowed]=useState(initial.allowedAuthors.join(', ')),[favorites,setFavorites]=useState(initial.favoriteAuthors.join(', '));
  const clean=(value:string)=>value.split(',').map(v=>v.trim()).filter(Boolean);
  const payload={...draft,allowedAuthors:clean(allowed),favoriteAuthors:clean(favorites)};
  const set=<K extends keyof Rule>(key:K,value:Rule[K])=>setDraft({...draft,[key]:value});
  const closeEditor=()=>{if(JSON.stringify(initial)===JSON.stringify(payload)||window.confirm('Discard your unsaved watchlist changes?'))close();};
  const changeTerm=(index:number,patch:Partial<Rule['terms'][number]>)=>set('terms',draft.terms.map((t,i)=>i===index?{...t,...patch}:t));
  const save=async(event:FormEvent)=>{
    event.preventDefault();setError('');
    const okay=await run(async()=>{
      try {await request(existing?'/watchlists/'+existing.id:'/watchlists',existing?'PATCH':'POST',payload,existing?.revision);}
      catch(e){setError((e as Error).message);throw e;}
    },existing?'Watchlist saved.':'Watchlist created.');
    if(okay)done();
  };
  return <Modal title={existing?'Edit watchlist':'New watchlist'} close={closeEditor}>
    <form className="form-stack" onSubmit={save}>
      <div className="form-grid"><label>Name<input required maxLength={80} value={draft.name} onChange={e=>set('name',e.target.value)}/></label>
        <label>Match mode<select value={draft.mode} onChange={e=>set('mode',e.target.value as Rule['mode'])}><option value="ANY">Any included term</option><option value="ALL">All included terms</option></select></label></div>
      <fieldset><legend>Keyword rules</legend>
        {draft.terms.map((term,index)=><div className="term-row" key={index}>
          <label>Action<select value={term.direction} onChange={e=>changeTerm(index,{direction:e.target.value as typeof term.direction})}><option value="include">Include</option><option value="exclude">Exclude</option></select></label>
          <label>Type<select value={term.kind} onChange={e=>changeTerm(index,{kind:e.target.value as typeof term.kind})}><option value="word">Word</option><option value="phrase">Phrase</option><option value="hashtag">Hashtag</option></select></label>
          <label>Term<input required maxLength={100} value={term.text} onChange={e=>changeTerm(index,{text:e.target.value})}/></label>
          <label className="check"><input type="checkbox" checked={term.important} disabled={term.direction==='exclude'} onChange={e=>changeTerm(index,{important:e.target.checked})}/> Important</label>
          <button type="button" className="icon-button" aria-label={'Remove term '+(index+1)} disabled={draft.terms.length===1} onClick={()=>set('terms',draft.terms.filter((_,i)=>i!==index))}><X size={17}/></button>
        </div>)}
        <button type="button" className="button" disabled={draft.terms.length>=32} onClick={()=>set('terms',[...draft.terms,fresh().terms[0]])}><Plus size={16}/> Add term</button>
      </fieldset>
      <div className="form-grid"><label>Allowed authors<input placeholder="@account, @another" value={allowed} onChange={e=>setAllowed(e.target.value)}/></label>
        <label>Favorite authors<input placeholder="@account, @another" value={favorites} onChange={e=>setFavorites(e.target.value)}/></label>
        <label>Language code<input placeholder="Any language" value={draft.language??''} onChange={e=>set('language',e.target.value||null)}/></label>
        <label>Minimum engagement<input type="number" min={0} value={draft.minEngagement} onChange={e=>set('minEngagement',Number(e.target.value))}/></label>
        <label>Standard threshold<input type="number" min={0} max={100} value={draft.standard} onChange={e=>set('standard',Number(e.target.value))}/></label>
        <label>Immediate threshold<input type="number" min={0} max={100} value={draft.immediate} onChange={e=>set('immediate',Number(e.target.value))}/></label>
        <label>Cooldown (seconds)<input type="number" min={0} max={86400} value={draft.cooldownSeconds} onChange={e=>set('cooldownSeconds',Number(e.target.value))}/></label>
        <label className="check"><input type="checkbox" checked={draft.enabled} onChange={e=>set('enabled',e.target.checked)}/> Watchlist enabled</label></div>
      <fieldset><legend>Preview a sample</legend><label>Sample text<textarea value={sample} onChange={e=>setSample(e.target.value)} maxLength={5000}/></label>
        <label>Sample author<input value={sampleAuthor} onChange={e=>setSampleAuthor(e.target.value)} maxLength={30}/></label>
        <button type="button" className="button" onClick={async()=>{setError('');setResult(null);try{setResult(await request('/watchlists/preview','POST',{rule:payload,sample:{text:sample,handle:sampleAuthor||null}}));}catch(e){setError((e as Error).message);}}}>Test watchlist</button>
        {result&&<p role="status">{result.result?`Matched · Score ${result.result.score} · ${result.result.matched.join(', ')}`:result.reason}</p>}
      </fieldset>
      {error&&<p className="banner error" role="alert">{error}</p>}
      <div className="actions"><button type="submit" disabled={busy} className="button primary">Save watchlist</button><button type="button" className="button" onClick={closeEditor}>Cancel</button></div>
    </form>
  </Modal>;
}
