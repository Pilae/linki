// Explicitly invoked diagnostic, never imported by the server or scheduler.
// Uses existing saved session in memory. No login, session-save, worker or action calls.
const Database = require('better-sqlite3');
const { loader } = require('../tests/load-withdrawals.cjs');
const database = process.env.LINKI_DB_PATH;
const account = process.env.WITHDRAWAL_PROBE_ACCOUNT;
const expectedProfile = process.env.WITHDRAWAL_PROBE_EXPECTED_PROFILE;
if (!database || !account || !expectedProfile) throw Error('Set LINKI_DB_PATH, WITHDRAWAL_PROBE_ACCOUNT and WITHDRAWAL_PROBE_EXPECTED_PROFILE explicitly');
const db = new Database(database, { readonly: true, fileMustExist: true });
if (db.prepare("SELECT count(*) n FROM runs WHERE status='running'").get().n) throw Error('Stop: a campaign is running');
const load = loader({ '@/lib/db': { getDb: () => db } });
const session = load('lib/linkedin/session');
const { readJson, readSnapshot, parseInvitationPage, findWithdrawalControl } = load('lib/withdrawals/linkedin');
const report = { at: new Date().toISOString(), readOnly: true, blockedNonGet: 0 };
(async () => {
  let page;
  try {
    page = await session.getSessionPage(account);
    await page.context().route('**/*', route => {
      if (!['GET', 'HEAD', 'OPTIONS'].includes(route.request().method())) {
        report.blockedNonGet++;
        return route.abort();
      }
      return route.continue();
    });
    await page.goto('https://www.linkedin.com/mynetwork/invitation-manager/sent/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    const me = await readJson(page, '/voyager/api/me');
    const sender = me.data?.['*miniProfile'];
    const own = (me.included || []).filter(x => x.entityUrn === sender);
    if (own.length !== 1 || own[0].publicIdentifier !== expectedProfile) throw Error('Expected sending account not established');
    report.senderVerified = true;
    let snapshot;
    try {
      snapshot = await readSnapshot(page, false);
      report.snapshot = { valid: true, count: snapshot.invitations.length };
    } catch (e) {
      report.snapshot = { valid: false, error: e.message };
    }
    // Diagnose row resolution separately if a later unknown record blocks the full
    // catalog. A first-page result is explicitly NOT a complete/actionable snapshot.
    const first = snapshot || { sender_urn: sender, invitations: parseInvitationPage(
      await readJson(page, '/voyager/api/relationships/sentInvitationViewsV2?count=100&invitationType=CONNECTION&q=invitationType&start=0'), sender, 0).invitations };
    report.parsedRecords = first.invitations.length;
    if (first.invitations.length) {
      const control = await findWithdrawalControl(page, first.invitations[0], first);
      report.rowResolution = { unique: await control.button.count() === 1, namedControl: !!control.name, fullSnapshot: !!snapshot };
    }
  } catch (e) {
    report.error = String(e.message).split('\n')[0];
  } finally {
    if (page) await page.close().catch(() => {});
    await session.closeSession(account).catch(() => {});
    db.close();
    console.log(JSON.stringify(report, null, 2));
    // Session launches a shared browser; this standalone process owns it.
    process.exit(report.snapshot?.valid && !report.error ? 0 : 1);
  }
})();
