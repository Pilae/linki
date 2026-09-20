import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
export type Db = Database.Database;
export const DAY = 86_400_000;
export const MAX_ATTEMPTS = 3;
export function initWithdrawals(db: Db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS withdrawal_stopped_runs (run_id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS withdrawal_settings (
      workflow_id TEXT PRIMARY KEY REFERENCES workflows(id) ON DELETE CASCADE,
      enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
      days INTEGER NOT NULL DEFAULT 30 CHECK(days BETWEEN 1 AND 365),
      eligible_since INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS campaign_invitations (
      id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, run_id TEXT NOT NULL,
      target_id TEXT NOT NULL, account_id TEXT NOT NULL, sender_urn TEXT NOT NULL,
      recipient_urn TEXT NOT NULL, profile_url TEXT NOT NULL, invitation_urn TEXT NOT NULL,
      sent_at INTEGER NOT NULL, recorded_at INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending',
      UNIQUE(account_id, invitation_urn)
    );
    CREATE TABLE IF NOT EXISTS invitation_withdrawals (
      invitation_id TEXT PRIMARY KEY REFERENCES campaign_invitations(id),
      account_id TEXT NOT NULL, status TEXT NOT NULL, due_at INTEGER NOT NULL,
      next_check_at INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
      checks INTEGER NOT NULL DEFAULT 0, action_started INTEGER NOT NULL DEFAULT 0,
      reason TEXT, updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS withdrawal_due ON invitation_withdrawals(account_id,status,next_check_at);
    CREATE TABLE IF NOT EXISTS invitation_withdrawal_events (
      id TEXT PRIMARY KEY, invitation_id TEXT NOT NULL, run_id TEXT NOT NULL,
      workflow_id TEXT NOT NULL, target_id TEXT NOT NULL, account_id TEXT NOT NULL,
      kind TEXT NOT NULL, occurred_at INTEGER NOT NULL, body TEXT NOT NULL,
      UNIQUE(invitation_id,kind)
    );
    CREATE TABLE IF NOT EXISTS linkedin_execution_locks (
      key TEXT PRIMARY KEY, owner TEXT NOT NULL, host TEXT NOT NULL, pid INTEGER NOT NULL
    );
  `);
}
export interface Invitation {
  id: string; workflow_id: string; run_id: string; target_id: string; account_id: string;
  sender_urn: string; recipient_urn: string; profile_url: string; invitation_urn: string;
  sent_at: number; recorded_at: number; state: string;
}
export interface Setting { enabled: number; days: number; eligible_since: number; revision: number }
export function settings(db: Db, workflow: string): Setting {
  return db.prepare('SELECT * FROM withdrawal_settings WHERE workflow_id=?').get(workflow) as Setting ||
    { enabled: 0, days: 30, eligible_since: Date.now(), revision: 0 };
}
export function configure(db: Db, workflow: string, input: unknown, now = Date.now()) {
  const v = input as { enabled?: unknown; days?: unknown; existing?: unknown } | null;
  if (!v || typeof v.enabled !== 'boolean' || !Number.isInteger(v.days) || (v.days as number) < 1 || (v.days as number) > 365)
    throw new Error('Use enabled: true/false and a whole number of days from 1 to 365.');
  const old = settings(db, workflow);
  if (v.enabled && !old.enabled && !['future_only', 'include_verified'].includes(v.existing as string))
    throw new Error('Choose future_only or include_verified before enabling withdrawals.');
  if (v.existing !== undefined && !['future_only', 'include_verified'].includes(v.existing as string))
    throw new Error('Invalid existing-invitation choice.');
  db.transaction(() => {
    if (!db.prepare('SELECT id FROM workflows WHERE id=?').get(workflow)) throw new Error('Campaign not found.');
    const since = v.enabled && !old.enabled ? (v.existing === 'include_verified' ? 0 : now) : old.eligible_since;
    db.prepare(`INSERT INTO withdrawal_settings VALUES(?,?,?,?,1)
      ON CONFLICT(workflow_id) DO UPDATE SET enabled=excluded.enabled,days=excluded.days,
      eligible_since=excluded.eligible_since,revision=revision+1`).run(workflow, v.enabled ? 1 : 0, v.days, since);
    reconcile(db, now);
  }).immediate();
  return settings(db, workflow);
}
export function recordInvitation(db: Db, invitation: Omit<Invitation, 'id' | 'recorded_at' | 'state'>, now = Date.now()) {
  if (!Number.isSafeInteger(invitation.sent_at) || invitation.sent_at <= 0 || invitation.sent_at > now ||
      !invitation.sender_urn || !invitation.recipient_urn || !invitation.invitation_urn) throw new Error('Unverified invitation evidence');
  const prior = db.prepare('SELECT * FROM campaign_invitations WHERE account_id=? AND invitation_urn=?')
    .get(invitation.account_id, invitation.invitation_urn) as Invitation | undefined;
  if (prior) {
    if (['workflow_id','run_id','target_id','sender_urn','recipient_urn','sent_at'].some(k => prior[k as keyof Invitation] !== invitation[k as keyof typeof invitation])) {
      db.prepare("UPDATE campaign_invitations SET state='ownership_ambiguous' WHERE id=?").run(prior.id);
      reconcile(db, now);
    }
    return;
  }
  db.prepare(`INSERT INTO campaign_invitations
    (id,workflow_id,run_id,target_id,account_id,sender_urn,recipient_urn,profile_url,invitation_urn,sent_at,recorded_at)
    VALUES (@id,@workflow_id,@run_id,@target_id,@account_id,@sender_urn,@recipient_urn,@profile_url,@invitation_urn,@sent_at,@recorded_at)`)
    .run({ ...invitation, id: randomUUID(), recorded_at: now });
}
export function eligibility(db: Db, i: Invitation, now: number): { allowed: boolean; due: number; reason: string } {
  const s = settings(db, i.workflow_id), due = i.sent_at + s.days * DAY;
  const no = (reason: string) => ({ allowed: false, due, reason });
  const owner = db.prepare(`SELECT r.status, r.account_id, r.workflow_id, w.is_archived,
    t.connected_at,t.degree,t.linkedin_url FROM runs r JOIN workflows w ON w.id=r.workflow_id
    JOIN run_profiles rp ON rp.run_id=r.id JOIN targets t ON t.id=rp.target_id
    WHERE r.id=? AND rp.target_id=?`).get(i.run_id, i.target_id) as
    { status: string; account_id: string; workflow_id: string; is_archived: number; connected_at: string | null; degree: number | null; linkedin_url: string } | undefined;
  if (db.prepare('SELECT 1 FROM withdrawal_stopped_runs WHERE run_id=?').get(i.run_id)) return no('Campaign explicitly stopped');
  if (!owner || owner.is_archived || !['running','completed','paused','pending'].includes(owner.status)) return no('Campaign stopped, archived, deleted, or prospect removed');
  if (!s.enabled) return no('Withdrawals disabled');
  if (i.sent_at < s.eligible_since) return no('Existing invitation excluded');
  if (owner.account_id !== i.account_id || owner.workflow_id !== i.workflow_id || owner.linkedin_url !== i.profile_url) return no('Ownership changed');
  if (i.state !== 'pending') return no(i.state);
  if (owner.connected_at || owner.degree === 1) return no('Connection already recorded');
  if (!Number.isSafeInteger(i.sent_at) || i.sent_at <= 0 || i.sent_at > now) return no('Uncertain send timestamp');
  const others = db.prepare(`SELECT 1 FROM run_profiles rp JOIN runs r ON r.id=rp.run_id
    JOIN targets t ON t.id=rp.target_id WHERE (rp.target_id=? OR t.linkedin_url=?)
    AND r.id<>? LIMIT 1`).get(i.target_id, i.profile_url, i.run_id);
  if (others || db.prepare('SELECT 1 FROM campaign_invitations WHERE recipient_urn=? AND id<>? LIMIT 1').get(i.recipient_urn, i.id)) return no('Multiple campaign/account ownership requires review');
  if (owner.status === 'paused' || owner.status === 'pending') return no('Campaign paused');
  if (now < due) return no('Delay not elapsed');
  return { allowed: true, due, reason: '' };
}
export function reconcile(db: Db, now = Date.now()) {
  const invitations = db.prepare('SELECT * FROM campaign_invitations').all() as Invitation[];
  for (const i of invitations) {
    const e = eligibility(db, i, now);
    const suspended = ['Campaign paused','Delay not elapsed'].includes(e.reason);
    const job = db.prepare('SELECT status,action_started FROM invitation_withdrawals WHERE invitation_id=?').get(i.id) as { status: string; action_started: number } | undefined;
    // Preserve uncertain external effects forever; cancellation must not erase them.
    if (job && (job.action_started || ['withdrawn','accepted','absent'].includes(job.status) ||
        job.status === 'verification_required' && (e.allowed || suspended))) continue;
    if (!e.allowed && !suspended) {
      if (job) db.prepare("UPDATE invitation_withdrawals SET status='cancelled',reason=?,updated_at=? WHERE invitation_id=?").run(e.reason, now, i.id);
      continue;
    }
    db.prepare(`INSERT INTO invitation_withdrawals(invitation_id,account_id,status,due_at,updated_at)
      VALUES(?,?,?,?,?) ON CONFLICT(invitation_id) DO UPDATE SET due_at=excluded.due_at,
      status=CASE WHEN status IN ('cancelled','suspended','queued') AND checks<6 THEN excluded.status
        WHEN status='cancelled' THEN 'verification_required' ELSE status END,updated_at=excluded.updated_at`)
      .run(i.id, i.account_id, e.reason === 'Campaign paused' ? 'suspended' : 'queued', e.due, now);
  }
}
export function event(db: Db, i: Invitation, kind: string, body: string, now: number) {
  db.prepare('INSERT OR IGNORE INTO invitation_withdrawal_events VALUES(?,?,?,?,?,?,?,?,?)')
    .run(randomUUID(), i.id, i.run_id, i.workflow_id, i.target_id, i.account_id, kind, now, body);
}
export function stopLinkedinTrack(db: Db, i: Invitation, reason: string) {
  db.prepare(`UPDATE run_profile_tracks SET state='skipped',error_message=?,next_step_at=NULL
    WHERE track='linkedin' AND run_profile_id IN (SELECT id FROM run_profiles WHERE run_id=? AND target_id=?)`)
    .run(reason, i.run_id, i.target_id);
}
