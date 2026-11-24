import type {Candidate,CollectorId,Watchlist} from '../contracts/index';

export type CommitPage = (posts:Candidate[],historical:boolean,key:string,state:unknown)=>void;
export interface Collector {
  readonly id:CollectorId;
  readonly capabilities:readonly string[];
  initialize?():Promise<void>;
  collect(lists:Watchlist[],now:number,signal:AbortSignal,commit:CommitPage):Promise<boolean>;
  lookup?(posts:Candidate[],now:number,signal:AbortSignal,attempts?:Map<string,number>):Promise<{posts:Candidate[];removed:string[]}>;
  hydrate?(ids:string[],now:number,signal:AbortSignal):Promise<{posts:Candidate[];removed:string[];status:string}>;
  refreshSignals?(now:number,signal:AbortSignal):Promise<void>;
  stream?(lists:Watchlist[],signal:AbortSignal,commit:CommitPage):Promise<void>;
  check?():Promise<unknown>;
  disconnect?():Promise<void>;
  pause?():Promise<void>;
}

export class SourceManager {
  private readonly sources=new Map<CollectorId,Collector>();
  constructor(...collectors:Collector[]) {
    for (const collector of collectors) {
      if(this.sources.has(collector.id))throw new Error('Duplicate collector');
      this.sources.set(collector.id,collector);
    }
  }
  get(id:CollectorId) {return this.sources.get(id);}
}
