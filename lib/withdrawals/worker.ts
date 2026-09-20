import { eligibility, event, reconcile, stopLinkedinTrack, MAX_ATTEMPTS, type Db, type Invitation } from './store';
import { withLinkedinExecution } from './lock';
export type Observation = { state: 'pending' | 'accepted' | 'absent' | 'ambiguous'; checked_at: number; sender_urn: string; invitation_urn: string; recipient_urn: string; sent_at: number };
export interface WithdrawalProvider {
  inspect(i: Invitation): Promise<Observation>;
  // Must verify identity again and invoke authorize immediately before the irreversible click.
  withdraw(i: Invitation, authorize: () => boolean): Promise<void>;
}
function matches(i: Invitation, o: Observation, now: number) {
  return o.sender_urn === i.sender_urn && o.checked_at <= now && now - o.checked_at < 30_000 &&
    o.invitation_urn === i.invitation_urn && o.recipient_urn === i.recipient_urn && o.sent_at === i.sent_at;
}
export async function processWithdrawals(db: Db, account: string, provider: WithdrawalProvider, clock = Date.now) {
  return withLinkedinExecution(db, account, async () => {
    reconcile(db, clock());
    // Any previous 'checking' row now belongs to a dead process: lock acquisition proved that.
    db.prepare(`UPDATE invitation_withdrawals SET status='verification_required',reason='Worker interrupted; verify before retry'
      WHERE account_id=? AND status='checking'`).run(account);
    const jobs = db.prepare(`SELECT * FROM invitation_withdrawals WHERE account_id=?
      AND status IN ('queued','verification_required') AND next_check_at<=? AND due_at<=?
      AND checks<6 ORDER BY due_at LIMIT 5`).all(account, clock(), clock()) as
      Array<{ invitation_id: string; attempts: number; action_started: number; checks: number }>;
    for (const job of jobs) {
      const i = db.prepare('SELECT * FROM campaign_invitations WHERE id=?').get(job.invitation_id) as Invitation;
      const eligible = () => eligibility(db, db.prepare('SELECT * FROM campaign_invitations WHERE id=?').get(i.id) as Invitation, clock()).allowed;
      if (!eligible() && !job.action_started) continue;
      const set = (status: string, reason: string) => db.prepare(`UPDATE invitation_withdrawals
        SET status=?,reason=?,updated_at=?,next_check_at=? WHERE invitation_id=?`)
        .run(status, reason, clock(), clock() + 3600_000 * Math.min(24, 2 ** job.checks), i.id);
      const uncertain = (reason: string) => db.transaction(() => {
        if (!job.action_started && !eligible()) {
          set('cancelled', 'Eligibility changed before withdrawal started');
          return;
        }
        set('verification_required', reason);
        stopLinkedinTrack(db, i, 'Invitation withdrawal needs verification');
        event(db, i, 'invitation_withdrawal_verification_required', reason, clock());
      }).immediate();
      const finish = (o: Observation) => {
        if (!matches(i, o, clock()) || o.state === 'ambiguous') return false;
        if (o.state === 'accepted') {
          db.transaction(() => {
            db.prepare("UPDATE campaign_invitations SET state='accepted' WHERE id=?").run(i.id);
            set('accepted', 'Connection accepted; no withdrawal');
          }).immediate();
          return true;
        }
        if (o.state === 'absent') {
          db.transaction(() => {
            const status = job.action_started ? 'withdrawn' : 'absent';
            db.prepare('UPDATE campaign_invitations SET state=? WHERE id=?').run(status, i.id);
            set(status, job.action_started ? 'Invitation withdrawn; absence verified' : 'Invitation no longer pending; cause unknown');
            stopLinkedinTrack(db, i, job.action_started ? 'Invitation withdrawn' : 'Invitation no longer pending — cause unknown');
            event(db, i, job.action_started ? 'invitation_withdrawn' : 'invitation_absent',
              job.action_started ? 'Withdrawal attempted; invitation verified no longer pending.' : 'Invitation absent before withdrawal; no withdrawal claimed.', clock());
          }).immediate();
          return true;
        }
        return false;
      };
      db.prepare("UPDATE invitation_withdrawals SET status='checking',checks=checks+1 WHERE invitation_id=?").run(i.id);
      try {
        const before = await provider.inspect(i);
        if (finish(before)) continue;
        if (!matches(i, before, clock()) || before.state !== 'pending') { uncertain('Exact invitation could not be verified'); continue; }
        if (!eligible()) { set(job.action_started ? 'verification_required' : 'cancelled', 'Eligibility changed; no withdrawal'); continue; }
        if (job.attempts >= MAX_ATTEMPTS) { uncertain('Retry limit reached; manual verification required'); continue; }
        await provider.withdraw(i, () => {
          // Synchronous transaction is the linearization point: disabling before this cancels;
          // disabling after it cannot undo an already-started external operation.
          return db.transaction(() => {
            if (!eligible()) return false;
            db.prepare('UPDATE invitation_withdrawals SET action_started=1,attempts=attempts+1 WHERE invitation_id=?').run(i.id);
            job.action_started = 1;
            stopLinkedinTrack(db, i, 'Invitation withdrawal needs verification');
            return true;
          }).immediate();
        });
        const after = await provider.inspect(i);
        if (!finish(after)) uncertain('Withdrawal unconfirmed; fresh verification required before retry');
      } catch (e) {
        uncertain(e instanceof Error ? e.message : 'Withdrawal verification failed');
      }
    }
  });
}
