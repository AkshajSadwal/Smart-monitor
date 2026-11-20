'use client';

import dynamic from 'next/dynamic';
import {Component,useEffect,useRef,useState,useSyncExternalStore,type ReactNode} from 'react';
import {getMascotPortrait,getServerPortrait,subscribePortrait} from './portrait';
import './mascot.css';

const query = '(prefers-reduced-motion: reduce)';
function subscribeMotion(callback:()=>void) {
  const media=window.matchMedia(query);
  media.addEventListener('change',callback);
  return ()=>media.removeEventListener('change',callback);
}
function Portrait({mode='IDLE'}:{mode?:string}) {
  const image=useSyncExternalStore(subscribePortrait,getMascotPortrait,getServerPortrait);
  return <span className="robot-avatar robot-fallback" data-expression={mode}>
    {image ? <img src={image} alt="" className="mascot-portrait"/> : <i className="avatar-body"><i/><i/></i>}
  </span>;
}
const Scene=dynamic(()=>import('./scene'),{ssr:false,loading:()=> <Portrait/>});
class SceneBoundary extends Component<{fallback:ReactNode;children:ReactNode},{failed:boolean}> {
  state={failed:false};
  static getDerivedStateFromError() {return {failed:true};}
  render() {return this.state.failed?this.props.fallback:this.props.children;}
}
export function Mascot({mode='IDLE',cue,reduced=false}:{mode?:string;cue?:number;reduced?:boolean}) {
  const still=useSyncExternalStore(subscribeMotion,()=>window.matchMedia(query).matches,()=>false)||reduced;
  const stage=useRef<HTMLDivElement>(null);
  const [visible,setVisible]=useState(true);
  useEffect(()=>{
    if (!stage.current || !window.IntersectionObserver) return;
    const observer=new IntersectionObserver(([entry])=>setVisible(entry.isIntersecting));
    observer.observe(stage.current);
    return ()=>observer.disconnect();
  },[]);
  const fallback=<Portrait mode={mode}/>;
  return <div ref={stage} className="robot-stage" aria-hidden="true" data-reduced={still} data-robot-mode={mode}>
    <span className="robot-shadow"/>
    <SceneBoundary fallback={fallback}><Scene mode={mode} visible={visible} still={still} cue={cue} fallback={fallback}/></SceneBoundary>
  </div>;
}
