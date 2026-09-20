import Head from 'next/head';
import { useEffect, useState } from 'react';
import type { ReplyEvent } from '@/pilae/linkedin-replies/contracts';
import type { State } from '@/pilae/linkedin-replies/store';

type Snapshot = {status:State|null;events:ReplyEvent[];next:number;hasMore:boolean;diagnostics:{unsupportedConversations:number;decisions:{reason:string;count:number}[]}};
const date = (value:number|null|undefined) => value ? new Date(value).toLocaleString() : 'Never';
export default function LinkedInReplies() {
  const [accounts,setAccounts]=useState<{id:string;name:string}[]>([]),[account,setAccount]=useState('');
  const [snapshot,setSnapshot]=useState<Snapshot|null>(null),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
  useEffect(()=>{
    const controller=new AbortController();
    fetch('/api/accounts',{signal:controller.signal}).then(async r=>{if(!r.ok)throw Error();return r.json();}).then(setAccounts).catch(()=>{if(!controller.signal.aborted)setNotice('Could not load accounts. Sign in and retry.');});
    return ()=>controller.abort();
  },[]);
  useEffect(()=>{
    setSnapshot(null);setNotice('');if(!account)return;
    const controller=new AbortController();
    fetch('/api/pilae/replies?account='+encodeURIComponent(account),{signal:controller.signal}).then(async r=>{if(!r.ok)throw Error();return r.json();}).then(setSnapshot).catch(()=>{if(!controller.signal.aborted)setNotice('Stored reply status could not be loaded.');});
    return ()=>controller.abort();
  },[account]);
  async function check() {
    setBusy(true);setNotice('');
    try {
      const r=await fetch('/api/pilae/replies?account='+encodeURIComponent(account),{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
      const result=await r.json();
      if(!r.ok)throw Error(result.error || 'Reply check failed.');
      if(result.disabled)setNotice('Check unavailable: '+result.reason+'.');
      else if(result.busy)setNotice('A check is already running. Refresh stored status shortly.');
      const stored=await fetch('/api/pilae/replies?account='+encodeURIComponent(account));
      if(!stored.ok)throw Error('Could not refresh stored status.');
      setSnapshot(await stored.json());
    } catch(e) {setNotice(e instanceof Error?e.message:'Reply check failed.');} finally {setBusy(false);}
  }
  async function more() {
    if(!snapshot)return;setBusy(true);
    try {
      const r=await fetch(`/api/pilae/replies?account=${encodeURIComponent(account)}&after=${snapshot.next}`);
      if(!r.ok)throw Error();const next:Snapshot=await r.json();
      setSnapshot({...next,events:[...snapshot.events,...next.events.filter(e=>!snapshot.events.some(old=>old.id===e.id))]});
    }catch{setNotice('Could not load the next stored event page.');}finally{setBusy(false);}
  }
  const s=snapshot?.status;
  return <main className="max-w-4xl mx-auto p-6 space-y-6">
    <Head><title>LinkedIn reply checks · Pilae</title></Head>
    <h1 className="text-2xl font-semibold">LinkedIn reply checks</h1>
    <p>Stored replies and check status for each sender. A zero event count does not establish that the inbox was checked.</p>
    <div className="flex gap-3 items-end">
      <label className="flex flex-col gap-1">Account<select className="select select-bordered" value={account} disabled={busy} onChange={e=>setAccount(e.target.value)}><option value="">Choose an account</option>{accounts.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
      <button className="btn btn-primary" disabled={!account||busy} onClick={()=>void check()}>{busy?'Checking…':'Check replies'}</button>
    </div>
    <p className="text-sm">Checking reads LinkedIn only for accounts enabled on the server. Real-account validation requires approval; credentials and verification challenges stay in the account settings flow.</p>
    {notice&&<p role="status" className="alert">{notice}</p>}
    {account&&<section className="card bg-base-200 p-5 space-y-3" aria-label="Reply check status">
      <h2 className="font-semibold">{!s?'Never checked':s.error?`Needs attention: ${s.error}`:s.incomplete?'Check incomplete':'Supported inbox scan completed'}</h2>
      <dl className="grid grid-cols-2 gap-2">
        <dt>Last attempt</dt><dd>{date(s?.last_attempt)}</dd><dt>Last successful scan</dt><dd>{date(s?.last_success)}</dd>
        <dt>Next eligible check</dt><dd>{s?.error==='authentication'||s?.error==='identity_changed'?'Suspended for review':date(s?.next_check)}</dd>
        <dt>Authentication failures</dt><dd>{s?.auth_failures??0}</dd><dt>Provider owner</dt><dd>{s?.provider??'Not assigned'}</dd>
        <dt>Unsupported conversations</dt><dd>{snapshot?.diagnostics.unsupportedConversations??'Unknown'}</dd>
      </dl>
      <p className="text-sm">Scope: supported one-to-one INBOX messages. Archived conversations, groups and unknown message formats are not verified by this check.</p>
      {snapshot?.diagnostics.decisions.map(d=><p key={d.reason}>{d.reason}: {d.count}</p>)}
    </section>}
    {snapshot&&<section className="space-y-3" aria-label="Stored replies"><h2 className="font-semibold">Stored reply events</h2>
      {!snapshot.events.length&&<p>No stored reply events on this page. Review check status and attribution diagnostics above.</p>}
      {snapshot.events.map(e=><article key={e.id} className="card bg-base-200 p-4"><p className="text-sm">{e.targetId} · {new Date(e.occurredAt).toLocaleString()}</p><p className="whitespace-pre-wrap">{e.body}</p></article>)}
      {snapshot.hasMore&&<button className="btn" disabled={busy} onClick={()=>void more()}>Load more stored replies</button>}
    </section>}
  </main>;
}
