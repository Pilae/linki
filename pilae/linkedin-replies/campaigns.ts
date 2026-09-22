import { createHash } from 'node:crypto';
import type { DB } from './store';
import type { Conversation, Message, ReplyEvent } from './contracts';

function profileUrl(value: string | undefined | null) {
  try { const u = new URL(value || ''); return u.protocol === 'https:' && ['www.linkedin.com','linkedin.com'].includes(u.hostname) && /^\/in\/[^/]+\/?$/.test(u.pathname) ? u.pathname.replace(/\/$/,'') : null; } catch { return null; }
}
/** Uses account-scoped enrollment plus exact profile evidence; never display names or legacy name-derived messaging_urn. */
export function projectReply(db: DB, account: string, self: string, c: Conversation, m: Message) {
  const decide = (reason: string) => { db.prepare(`INSERT INTO pilae_reply_decisions VALUES(?,?,?,?) ON CONFLICT(account_id,conversation_id,message_id) DO UPDATE SET reason=excluded.reason`).run(account,c.id,m.id,reason); };
  if (c.group || c.participants.length !== 2 || !c.participants.some(p => p.id === self) || m.kind !== 'message' || m.sender === self) return;
  const peer = c.participants.find(p => p.id !== self)!;
  if (m.sender !== peer.id) return;
  const candidates = db.prepare(`SELECT DISTINCT t.id,t.linkedin_url,t.linkedin_member_urn FROM targets t
    JOIN run_profiles rp ON rp.target_id=t.id JOIN runs r ON r.id=rp.run_id WHERE r.account_id=?`).all(account) as {id:string;linkedin_url:string;linkedin_member_urn:string}[];
  const bindings = db.prepare('SELECT target_id,participant_id FROM pilae_reply_identities WHERE account_id=?').all(account) as {target_id:string;participant_id:string}[];
  const matches = candidates.filter(t => {
    const bound = bindings.find(b=>b.target_id===t.id);
    return bound ? bound.participant_id===peer.id : t.linkedin_member_urn === peer.id || (profileUrl(peer.profileUrl) && profileUrl(t.linkedin_url) === profileUrl(peer.profileUrl));
  });
  if (matches.length !== 1) { decide(matches.length ? 'ambiguous_recipient' : 'unmatched_recipient'); return; }
  const target = matches[0].id;
  if (bindings.some(b=>b.participant_id===peer.id && b.target_id!==target)) { decide('identity_conflict'); return; }
  db.prepare('INSERT OR IGNORE INTO pilae_reply_identities VALUES(?,?,?)').run(account,target,peer.id);
  // Successful outbound logs establish account/run attribution, unlike global target timestamps.
  const sends = db.prepare(`SELECT DISTINCT r.id,r.workflow_id,l.created_at FROM logs l
    JOIN runs r ON r.id=l.run_id JOIN run_profiles rp ON rp.run_id=r.id AND rp.target_id=l.target_id
    WHERE r.account_id=? AND l.target_id=? AND l.level='info'
    AND (l.message LIKE 'Message sent%' OR l.message LIKE 'InMail sent%')
    AND julianday(l.created_at)>=julianday(rp.created_at)
    AND julianday(l.created_at)<julianday(?) ORDER BY l.created_at DESC`).all(account,target,new Date(m.at).toISOString()) as {id:string;workflow_id:string;created_at:string}[];
  // Require actual outbound conversation evidence too; never classify old inbound history as a reply.
  const eligible = sends.filter(s => {
    const raw = s.created_at.replace(' ','T');
    const at = Date.parse(/[zZ]$|[+-]\d\d:\d\d$/.test(raw) ? raw : raw+'Z');
    return db.prepare(`SELECT 1 FROM pilae_reply_messages WHERE account_id=? AND conversation_id=?
      AND sender=? AND kind='message' AND occurred_at BETWEEN ? AND ? AND occurred_at<?`).get(account,c.id,self,at-60_000,at+60_000,m.at);
  });
  const runs = new Set(eligible.map(s=>s.id));
  if (runs.size !== 1) { decide(runs.size ? 'ambiguous_campaign' : 'no_attributable_outbound'); return; }
  const sent = eligible[0];
  decide('verified_reply');
  const occurredAt = new Date(m.at).toISOString();
  const id = createHash('sha256').update(JSON.stringify([account,c.id,m.id])).digest('hex');
  const event: ReplyEvent = {version:1,id,accountId:account,conversationId:c.id,messageId:m.id,targetId:target,workflowId:sent.workflow_id,runId:sent.id,channel:'linkedin',kind:'reply_received',occurredAt,body:m.body};
  db.prepare('INSERT OR IGNORE INTO pilae_reply_events(id,account_id,target_id,run_id,payload) VALUES(?,?,?,?,?)').run(id,account,target,sent.id,JSON.stringify(event));
  db.prepare('INSERT OR IGNORE INTO campaign_outcome_events VALUES(?,?,?,?,?)').run(sent.workflow_id,target,'linkedin_reply',occurredAt,'pilae-linkedin-replies-v1');
  // Leave global last_replied_at unchanged: it would stop another account's outreach.
  // Existing runner semantics stop both channels, scoped here to the attributed run.
  db.prepare(`UPDATE run_profile_tracks SET state='skipped',error_message='Lead replied'
    WHERE run_profile_id IN (SELECT id FROM run_profiles WHERE run_id=? AND target_id=?)
    AND state NOT IN ('completed','failed','skipped')`).run(sent.id,target);
}
export function hasRunReply(db: DB, run: string, target: string): boolean {
  // Read-only runner hook also works before first extension migration.
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='pilae_reply_events'").get()) return false;
  return !!db.prepare('SELECT 1 FROM pilae_reply_events WHERE run_id=? AND target_id=? LIMIT 1').get(run,target);
}
