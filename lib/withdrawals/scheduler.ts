import { reconcile, type Db } from './store';
export interface WithdrawalSchedule {
  active_hours_start: number; active_hours_end: number; timezone: string; working_days: string;
}
export function isWithinSchedule(account: WithdrawalSchedule, date = new Date()): boolean {
  const timezone = account.timezone || 'UTC';
  let safeZone = timezone;
  try { Intl.DateTimeFormat(undefined, { timeZone: timezone }); } catch { safeZone = 'UTC'; }
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: safeZone, hour: 'numeric', minute: 'numeric', weekday: 'short', hour12: false }).formatToParts(date);
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
  const days: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  if (!(account.working_days || '1,2,3,4,5').split(',').map(Number).includes(days[get('weekday')] ?? 1)) return false;
  const hour = (parseInt(get('hour'), 10) % 24) + parseInt(get('minute'), 10) / 60;
  return hour >= (account.active_hours_start ?? 9) && hour < (account.active_hours_end ?? 18);
}
/** Same entry point used by the outreach runner and isolated scheduling tests.
 * The account callback creates its provider lazily; selecting a job is not authorization. */
export async function runWithdrawalMaintenance(db: Db, runAccount: (id: string) => Promise<void>, clock = Date.now) {
  const now = clock();
  reconcile(db, now);
  const accounts = db.prepare(`SELECT DISTINCT a.id,a.active_hours_start,a.active_hours_end,a.timezone,a.working_days FROM accounts a
    JOIN invitation_withdrawals j ON j.account_id=a.id
    WHERE a.is_authenticated=1 AND j.status IN ('queued','checking','verification_required')
    AND j.due_at<=? AND j.next_check_at<=? AND (j.checks<6 OR j.status='checking')`).all(now, now) as Array<{ id: string } & WithdrawalSchedule>;
  for (const account of accounts) {
    if (isWithinSchedule(account, new Date(now))) await runAccount(account.id);
  }
}
