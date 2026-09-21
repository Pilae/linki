import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
export type DB = Database.Database;
export function migrate(db: DB) {
  db.exec(`CREATE TABLE IF NOT EXISTS pilae_reply_accounts (
    account_id TEXT PRIMARY KEY, provider TEXT NOT NULL, identity TEXT,
    last_attempt INTEGER, last_success INTEGER, next_check INTEGER NOT NULL DEFAULT 0,
    error TEXT, incomplete INTEGER NOT NULL DEFAULT 1, auth_failures INTEGER NOT NULL DEFAULT 0,
    cursor TEXT, listing_done INTEGER NOT NULL DEFAULT 0,
    lease TEXT, lease_until INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS pilae_reply_checkpoints (
    account_id TEXT NOT NULL, scope TEXT NOT NULL, sync_token TEXT NOT NULL,
    PRIMARY KEY(account_id,scope));
  CREATE TABLE IF NOT EXISTS pilae_reply_conversations (
    account_id TEXT NOT NULL, conversation_id TEXT NOT NULL, participants TEXT NOT NULL,
    unsupported INTEGER NOT NULL, pending INTEGER NOT NULL DEFAULT 1, cursor TEXT,
    PRIMARY KEY(account_id,conversation_id));
  CREATE TABLE IF NOT EXISTS pilae_reply_identities (
    account_id TEXT NOT NULL,target_id TEXT NOT NULL,participant_id TEXT NOT NULL,
    PRIMARY KEY(account_id,target_id),UNIQUE(account_id,participant_id));
  CREATE TABLE IF NOT EXISTS pilae_reply_messages (
    account_id TEXT NOT NULL, conversation_id TEXT NOT NULL, message_id TEXT NOT NULL,
    sender TEXT NOT NULL, occurred_at INTEGER NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL,
    PRIMARY KEY(account_id,conversation_id,message_id));
  CREATE TABLE IF NOT EXISTS pilae_reply_decisions (
    account_id TEXT NOT NULL,conversation_id TEXT NOT NULL,message_id TEXT NOT NULL,reason TEXT NOT NULL,
    PRIMARY KEY(account_id,conversation_id,message_id));
  CREATE TABLE IF NOT EXISTS pilae_reply_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, account_id TEXT NOT NULL,
    target_id TEXT NOT NULL, run_id TEXT NOT NULL, payload TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS campaign_outcome_events (
    workflow_id TEXT NOT NULL,target_id TEXT NOT NULL,kind TEXT NOT NULL,
    occurred_at TEXT NOT NULL,source TEXT NOT NULL,
    PRIMARY KEY(workflow_id,target_id,kind,occurred_at));`);
  db.transaction(()=> {
  if (!(db.prepare('PRAGMA table_info(pilae_reply_accounts)').all() as {name:string}[]).some(c=>c.name==='coverage_gap')) {
    db.exec('ALTER TABLE pilae_reply_accounts ADD COLUMN coverage_gap INTEGER NOT NULL DEFAULT 0');
  }
  }).immediate();
}
export type State = {
  account_id: string; provider: string; identity: string | null; cursor: string | null;
  coverage_gap: number; listing_done: number; last_attempt: number | null; last_success: number | null;
  next_check: number; error: string | null; incomplete: number; auth_failures: number;
};
export function state(db: DB, id: string): State | undefined {
  return db.prepare(`SELECT account_id,provider,identity,cursor,listing_done,last_attempt,last_success,
    next_check,error,incomplete,auth_failures,coverage_gap FROM pilae_reply_accounts WHERE account_id=?`).get(id) as State | undefined;
}
// Provider ownership survives restarts. Changing providers requires an explicit drained handover.
export function acquire(db: DB, id: string, provider: string, now: number): string | null {
  return db.transaction(() => {
    db.prepare('INSERT OR IGNORE INTO pilae_reply_accounts(account_id,provider) VALUES(?,?)').run(id, provider);
    const token = randomUUID();
    const changed = db.prepare(`UPDATE pilae_reply_accounts SET lease=?,lease_until=?
      WHERE account_id=? AND provider=? AND lease_until<=?`).run(token, now + 120_000, id, provider, now);
    return changed.changes ? token : null;
  }).immediate();
}
export function fenced(db: DB, id: string, token: string, now: number, action: () => void) {
  db.transaction(() => {
    if (!db.prepare('SELECT 1 FROM pilae_reply_accounts WHERE account_id=? AND lease=? AND lease_until>?').get(id,token,now)) throw Error('lease_lost');
    action();
    db.prepare('UPDATE pilae_reply_accounts SET lease_until=? WHERE account_id=? AND lease=?').run(now+120_000,id,token);
  }).immediate();
}
export function release(db: DB, id: string, token: string) {
  db.prepare('UPDATE pilae_reply_accounts SET lease=NULL,lease_until=0 WHERE account_id=? AND lease=?').run(id,token);
}
