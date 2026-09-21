import { SyncError, type Conversation, type Message, type Page, type Reader } from './contracts';
import { acquire, fenced, migrate, release, state, type DB } from './store';
import { projectReply } from './campaigns';
const INTERVAL = 15 * 60_000;
export async function synchronize(db: DB, account: string, reader: Reader, clock = Date.now, budget = 20) {
  migrate(db);
  const token = acquire(db,account,'pilae',clock());
  if (!token) return {busy:true,status:state(db,account)};
  const commit = (fn:()=>void) => fenced(db,account,token,clock(),fn);
  const checkpoint = (scope:string,page:Page<unknown>) => {
    if(page.coverage==='partial') db.prepare('UPDATE pilae_reply_accounts SET coverage_gap=1 WHERE account_id=?').run(account);
    if(page.syncToken) db.prepare(`INSERT INTO pilae_reply_checkpoints VALUES(?,?,?)
      ON CONFLICT(account_id,scope) DO UPDATE SET sync_token=excluded.sync_token`).run(account,scope,page.syncToken);
  };
  const persist = (conversation:string,messages:Message[]) => {
    for(const m of messages) db.prepare('INSERT OR IGNORE INTO pilae_reply_messages VALUES(?,?,?,?,?,?,?)').run(account,conversation,m.id,m.sender,m.at,m.kind,m.body);
  };
  try {
    commit(()=> { db.prepare('UPDATE pilae_reply_accounts SET last_attempt=?,incomplete=1,error=NULL WHERE account_id=?').run(clock(),account); });
    const identity = await reader.identity();
    if (state(db,account)!.identity && state(db,account)!.identity !== identity) throw new SyncError('identity_changed');
    commit(()=> { db.prepare('UPDATE pilae_reply_accounts SET identity=? WHERE account_id=?').run(identity,account); });
    for (let i=0; i<budget; i++) {
      const s = state(db,account)!;
      const job = db.prepare('SELECT * FROM pilae_reply_conversations WHERE account_id=? AND pending=1 LIMIT 1').get(account) as {conversation_id:string;participants:string;unsupported:number;cursor:string|null}|undefined;
      if (job) {
        const c: Conversation = {id:job.conversation_id,participants:JSON.parse(job.participants),group:!!job.unsupported};
        // Internal profile links need an authenticated canonical resolution. Bind by URN,
        // not display name, and persist only after a successful, fenced page commit.
        for(const peer of c.participants) {
          if(peer.id===identity || !peer.profileUrl || !reader.resolveProfile) continue;
          if(/^https:\/\/(www\.)?linkedin\.com\/in\/ACo[A-Za-z0-9_-]+\/?$/.test(peer.profileUrl)) {
            const resolved=await reader.resolveProfile(peer.profileUrl);
            if(resolved.id!==peer.id) throw new SyncError('identity_changed');
            peer.profileUrl=resolved.profileUrl;
          }
        }
        const page = await reader.messages(job.conversation_id,job.cursor);
        if (page.next !== null && page.next === job.cursor) throw new SyncError('incomplete');
        commit(()=> {
          checkpoint('conversation:'+job.conversation_id,page);
          persist(job.conversation_id,page.items);
          db.prepare('UPDATE pilae_reply_conversations SET participants=? WHERE account_id=? AND conversation_id=?').run(JSON.stringify(c.participants),account,job.conversation_id);
          db.prepare('UPDATE pilae_reply_conversations SET cursor=?,pending=? WHERE account_id=? AND conversation_id=?').run(page.next,page.next===null?0:1,account,job.conversation_id);
          // Re-evaluate persisted inbound messages after each page: older outbound evidence may arrive later.
          const messages = db.prepare('SELECT message_id AS id,sender,occurred_at AS at,kind,body FROM pilae_reply_messages WHERE account_id=? AND conversation_id=? ORDER BY occurred_at').all(account,job.conversation_id) as Message[];
          for (const m of messages) projectReply(db,account,identity,c,m);
        });
      } else if (!s.listing_done) {
        const page = await reader.conversations(s.cursor);
        if (page.next !== null && page.next === s.cursor) throw new SyncError('incomplete');
        commit(()=> {
          checkpoint('inbox',page);
          for (const c of page.items) {
            const unsupported = c.group || c.participants.length!==2 || !c.participants.some(p=>p.id===identity);
            db.prepare(`INSERT INTO pilae_reply_conversations VALUES(?,?,?,?,?,NULL)
              ON CONFLICT(account_id,conversation_id) DO UPDATE SET participants=excluded.participants,
              unsupported=excluded.unsupported,pending=excluded.pending,cursor=NULL`).run(account,c.id,JSON.stringify(c.participants),+unsupported,unsupported?0:1);
            if(!unsupported) persist(c.id,c.messages ?? []);
          }
          db.prepare('UPDATE pilae_reply_accounts SET cursor=?,listing_done=? WHERE account_id=?').run(page.next,page.next===null?1:0,account);
        });
      } else {
        commit(()=> { db.prepare(`UPDATE pilae_reply_accounts SET last_success=CASE WHEN coverage_gap=0 THEN ? ELSE last_success END,
          next_check=?,error=CASE WHEN coverage_gap=1 THEN 'incomplete' ELSE NULL END,incomplete=coverage_gap,
          auth_failures=0,cursor=NULL,listing_done=0,coverage_gap=0 WHERE account_id=?`).run(clock(),clock()+INTERVAL,account); });
        return {busy:false,status:state(db,account)};
      }
    }
    commit(()=> {db.prepare("UPDATE pilae_reply_accounts SET next_check=?,error='page_budget',incomplete=1 WHERE account_id=?").run(clock()+60_000,account);});
  } catch(e) {
    const code = e instanceof SyncError ? e.code : 'transport';
    commit(()=> { db.prepare(`UPDATE pilae_reply_accounts SET error=?,incomplete=1,next_check=?,
      auth_failures=auth_failures+? WHERE account_id=?`).run(code,clock()+(code==='authentication'?24*60*60_000:INTERVAL),code==='authentication'?1:0,account); });
  } finally { release(db,account,token); }
  return {busy:false,status:state(db,account)};
}
