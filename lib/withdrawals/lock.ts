import { hostname } from 'os';
import { randomUUID } from 'crypto';
import type { Db } from './store';
const host = hostname();
function dead(pid: number) {
  try { process.kill(pid, 0); return false; }
  catch (e) { return (e as NodeJS.ErrnoException).code === 'ESRCH'; }
}
/** No expiring lease: a stalled worker must never resume after another took over.
 * Recover only a proven-dead local process. Unknown hosts/PID reuse fail closed.
 * The global key also protects legacy contact-wide acceptance fields across accounts. */
export async function withLinkedinExecution<T>(db: Db, account: string, fn: () => Promise<T>): Promise<T | undefined> {
  const owner = randomUUID(), keys = ['linkedin-global', `account:${account}`];
  const acquired = db.transaction(() => {
    for (const key of keys) {
      const held = db.prepare('SELECT host,pid FROM linkedin_execution_locks WHERE key=?').get(key) as { host: string; pid: number } | undefined;
      if (held && !(held.host === host && dead(held.pid))) return false;
    }
    for (const key of keys) db.prepare('INSERT OR REPLACE INTO linkedin_execution_locks VALUES(?,?,?,?)').run(key, owner, host, process.pid);
    return true;
  }).immediate();
  if (!acquired) return undefined;
  try { return await fn(); }
  finally { db.prepare('DELETE FROM linkedin_execution_locks WHERE owner=?').run(owner); }
}
