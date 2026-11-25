let csrf='';
let login:Promise<void>|undefined;

export async function request<T>(path:string, method='GET', data?:unknown, revision?:number):Promise<T> {
  const headers:Record<string,string>={};
  if (data!==undefined) headers['Content-Type']='application/json';
  if (method!=='GET' && csrf) headers['X-Monitor-CSRF']=csrf;
  if (revision!==undefined) headers['If-Match']=String(revision);
  const response=await fetch('/api/v1'+path,{method,headers,body:data===undefined?undefined:JSON.stringify(data),cache:'no-store'});
  if (response.status===204) return undefined as T;
  const body=await response.json();
  if (!response.ok) throw new Error(body.error?.message??'Local service request failed.');
  return body as T;
}
export function authenticate() {
  login ??= (async()=>{
    const params=new URLSearchParams(location.hash.slice(1));
    const nonce=params.get('open');
    if (nonce) history.replaceState(history.state,'',location.pathname+location.search);
    const result=nonce?await request<{csrf:string}>('/session','POST',{nonce}):await request<{csrf:string}>('/session');
    csrf=result.csrf;
  })().catch(error=>{login=undefined;throw error;});
  return login;
}

export const label=(key:string)=>({
  term:'Keyword relevance',popularity:'Popularity',velocity:'Engagement growth',following:'Following',
  likedAuthor:'Previously liked author',favorite:'Favorite author',feedback:'Local feedback',
  silent:'Feed only',standard:'Standard',immediate:'Immediate',delayed:'Delayed popularity',
  disabled:'Desktop alerts off',unavailable:'Native delivery unavailable',submitted:'Submitted to desktop',unknown:'Delivery unknown',started:'Dispatch started',
}[key]??key);
export const timestamp=(value:number|null|undefined)=>{
  if (value===null||value===undefined) return '—';
  return new Intl.DateTimeFormat(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(value);
};
