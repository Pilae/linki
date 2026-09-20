import { getDb } from '@/lib/db';
import { getSessionContext } from '@/lib/linkedin/session';
import { premium } from '@/lib/premium';
import { SessionReader } from './reader';
import { synchronize } from './sync';
import { acquire, migrate, release, state } from './store';
export { hasRunReply } from './campaigns';
export function enabledAccounts(): string[] {
  return (process.env.PILAE_REPLY_ACCOUNT_IDS || '').split(',').filter(id=>/^[a-zA-Z0-9-]{1,100}$/.test(id));
}
export async function checkAccount(account: string) {
  const db=getDb(); migrate(db);
  if(premium?.replies || !enabledAccounts().includes(account)) return {disabled:true,reason:premium?.replies?'premium_provider':'not_enabled',status:state(db,account)};
  const owner=state(db,account)?.provider;
  if(owner && owner!=='pilae') return {disabled:true,reason:'provider_handover_required',status:state(db,account)};
  const a=db.prepare('SELECT is_authenticated FROM accounts WHERE id=?').get(account) as {is_authenticated:number}|undefined;
  if(!a) return {disabled:true,reason:'unknown_account'};
  // Lazy context creation happens inside synchronization so failures get durable health status.
  let reader: SessionReader;
  const getReader=async()=>reader ??= new SessionReader(await getSessionContext(account),{
    conversations:process.env.PILAE_REPLY_CONVERSATIONS_QUERY || '',messages:process.env.PILAE_REPLY_MESSAGES_QUERY || '',
  });
  return synchronize(db,account,{
    identity:async()=>{
      if(!a.is_authenticated) {const {SyncError}=await import('./contracts');throw new SyncError('authentication');}
      return (await getReader()).identity();
    },
    conversations:async c=>(await getReader()).conversations(c),
    messages:async(c,p)=>(await getReader()).messages(c,p),
  });
}
/** Premium retains its own implementation. Both entrypoints claim the same persistent account owner/lease. */
export async function syncPremium(account:string): Promise<number> {
  if(!premium?.replies) return 0;
  const db=getDb(); migrate(db); const token=acquire(db,account,'premium',Date.now());
  if(!token) throw new Error('Reply provider ownership or synchronization lease unavailable');
  // Premium is opaque: renew while it is executing, do not pretend its internal cursor is ours.
  const timer=setInterval(()=>db.prepare('UPDATE pilae_reply_accounts SET lease_until=? WHERE account_id=? AND lease=?').run(Date.now()+120_000,account,token),30_000);
  try{return await premium.replies.syncAccountInbox(account);}finally{clearInterval(timer);release(db,account,token);}
}
let started=false, running=false;
export function startReplyScheduler() {
  if(started || !enabledAccounts().length || premium?.replies) return;
  started=true;
  const tick=async()=>{
    if(running) return; running=true;
    try{
      const db=getDb();migrate(db);
      for(const id of enabledAccounts()) {
        const s=state(db,id);
        if(s?.provider && s.provider!=='pilae') continue;
        if(s && (s.next_check>Date.now() || s.error==='authentication' || s.error==='identity_changed')) continue;
        await checkAccount(id);
      }
    } catch { console.warn('[pilae replies] Scheduler failed; no provider details logged'); }
    finally{running=false;}
  };
  const timer=setInterval(()=>void tick(),60_000);timer.unref();void tick();
}
