import type { Page } from 'playwright';
import { getConnectionProfileCard } from '../linkedin/connect';
import { linkedinLabel } from '../linkedin/labels';
import { hasCaptchaSignal } from '../linkedin/login-signals';
import type { Invitation } from './store';
import type { Observation, WithdrawalProvider } from './worker';
export interface RemoteInvitation { invitation_urn: string; sender_urn: string; recipient_urn: string; sent_at: number; profile_url: string }
export interface Snapshot { sender_urn: string; invitations: RemoteInvitation[] }
const SENT = 'https://www.linkedin.com/mynetwork/invitation-manager/sent/';
const canonical = (s: string) => { const u = new URL(s); if (!['www.linkedin.com','linkedin.com'].includes(u.hostname) || !/^\/in\/[^/]+\/?$/.test(u.pathname)) throw Error('Unsupported recipient URL'); return `https://www.linkedin.com${u.pathname.replace(/\/$/, '')}`; };
const urn = (x: unknown): string => typeof x === 'string' ? x : '';
type Entity = Record<string, unknown>;
/** Observed normalized schema plus the original explicit-total contract. Unknown
 * records are never treated as absence, even if another row looks actionable. */
export function parseInvitationPage(json: unknown, sender: string, start: number) {
  const j = json as { data?: Entity; included?: Entity[] };
  const data = j?.data, paging = data?.paging as Entity | undefined;
  const live = !!data && Object.hasOwn(data, '*elements');
  const refs = data?.[live ? '*elements' : 'elements'];
  const total = paging?.total;
  if (!data || !Array.isArray(refs) || !Array.isArray(j.included) || paging?.start !== start ||
      refs.length > 100 || (live && (Object.hasOwn(data, 'elements') || paging.count !== 100)) ||
      (!live && (!Number.isSafeInteger(total) || (total as number) < 0)) ||
      (total !== undefined && (!Number.isSafeInteger(total) || (total as number) < 0)))
    throw Error('Unrecognized sent-invitations response');
  if (live && refs.length && (data.metadata as Entity)?.invitationType !== 'CONNECTION')
    throw Error('Unsupported invitation collection');
  const byUrn = new Map(j.included.map(e => [urn(e?.entityUrn), e]));
  if (byUrn.size !== j.included.length || byUrn.has('')) throw Error('Ambiguous invitation entities');
  const invitations: RemoteInvitation[] = [];
  for (const ref of refs) {
    const view = typeof ref === 'string' ? byUrn.get(ref) : ref as Entity;
    if (live && (!view || view.$type !== 'com.linkedin.voyager.relationships.invitation.SentInvitationViewV2' ||
        !urn(view['*invitation']))) throw Error('Unsupported sent invitation view');
    const item = byUrn.get(urn(view?.['*invitation'] || view?.invitation)) || (!live ? view : undefined);
    const expectedType = live ? 'com.linkedin.voyager.relationships.invitation.Invitation' : 'com.linkedin.voyager.relationships.Invitation';
    if (!item || item.$type !== expectedType) throw Error('Unrecognized invitation type');
    const senderUrn = urn(live ? item['*fromMember'] : item['*inviter'] || item.inviter);
    const recipientUrn = urn(live ? item['*toMember'] : item['*invitee'] || item.invitee);
    const recipient = byUrn.get(recipientUrn), sent = item.sentTime;
    if (senderUrn !== sender || !senderUrn.startsWith('urn:li:fs_miniProfile:') ||
        !recipientUrn.startsWith('urn:li:fs_miniProfile:') || !recipient || typeof recipient.publicIdentifier !== 'string' ||
        !recipient.publicIdentifier || !Number.isSafeInteger(sent) || (sent as number) <= 0 ||
        (sent as number) > Date.now() || !urn(item.entityUrn)) throw Error('Incomplete invitation identity or timestamp');
    if (live && ((item.invitee as Entity)?.['*miniProfile'] !== recipientUrn ||
        !urn(item.entityUrn).startsWith('urn:li:fs_relInvitation:') ||
        !urn(item.mailboxItemId).startsWith('urn:li:invitation:') ||
        recipient.$type !== 'com.linkedin.voyager.identity.shared.MiniProfile')) throw Error('Conflicting invitation identity');
    invitations.push({ invitation_urn: urn(item.entityUrn), sender_urn: senderUrn, recipient_urn: recipientUrn,
      sent_at: sent as number, profile_url: canonical(`https://www.linkedin.com/in/${encodeURIComponent(recipient.publicIdentifier)}`) });
  }
  return { invitations, total: total as number | undefined, live };
}
async function wall(page: Page) {
  if (/\/(login|authwall|checkpoint|challenge|uas)(?:[/?#]|$)/i.test(page.url()) || await page.locator('input[type="password"]:visible').count() || await hasCaptchaSignal(page))
    throw Error('LinkedIn authentication or verification required; complete it manually');
}
export async function readJson(page: Page, path: string, timeoutMs = 15_000): Promise<unknown> {
  if (timeoutMs <= 0) throw Error('Invitation verification deadline exceeded');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Both a browser AbortSignal (headers AND body) and a host deadline: an
    // unresponsive renderer must not hold the non-expiring execution lock forever.
    return await Promise.race([
      (async () => {
        await wall(page);
        return page.evaluate(async ({ path, timeoutMs }) => {
          const csrf = document.cookie.split('; ').find(x => x.startsWith('JSESSIONID='))?.slice(11).replace(/"/g, '');
          if (!csrf) throw Error('Missing authenticated session');
          const r = await fetch(path, { signal: AbortSignal.timeout(timeoutMs), credentials: 'include', cache: 'no-store', headers: { 'csrf-token': csrf, accept: 'application/vnd.linkedin.normalized+json+2.1', 'x-restli-protocol-version': '2.0.0' } });
          if (!r.ok || r.redirected) throw Error('Invitation verification unavailable');
          return await r.json();
        }, { path, timeoutMs });
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          // Only read-only work can outlive this deadline. Close its page and never
          // retain a late response as evidence; no click lives in this promise.
          void page.close().catch(() => {});
          reject(Error('Invitation verification timed out'));
        }, timeoutMs);
      }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}
async function readSender(page: Page, timeoutMs = 15_000): Promise<string> {
  const me = await readJson(page, '/voyager/api/me', timeoutMs) as { included?: Entity[]; data?: { miniProfile?: { entityUrn?: string }; '*miniProfile'?: string }; miniProfile?: { entityUrn?: string } };
  const sender = me.data?.miniProfile?.entityUrn || me.data?.['*miniProfile'] || me.miniProfile?.entityUrn;
  if (!sender?.startsWith('urn:li:fs_miniProfile:')) throw Error('Sending account identity unavailable');
  if (me.data?.['*miniProfile']) {
    const profiles = me.included?.filter(x => x.entityUrn === sender) || [];
    if (profiles.length !== 1 || profiles[0].$type !== 'com.linkedin.voyager.identity.shared.MiniProfile' ||
        typeof profiles[0].publicIdentifier !== 'string' || !profiles[0].publicIdentifier)
      throw Error('Sending account reference is unresolved');
  }
  return sender;
}
async function sentCount(page: Page): Promise<number> {
  const countLink = page.locator('a[href*="/mynetwork/invitation-manager/sent/CONNECTION"]').filter({ visible: true });
  if (await countLink.count() !== 1) throw Error('Sent invitation count unavailable');
  const text = (await countLink.innerText({ timeout: 3000 })).trim();
  const match = text.match(/^(?:People|Personnes)\s*\((\d+)\)$/);
  if (!match) throw Error('Unsupported sent invitation count');
  return Number(match[1]);
}
export async function readSnapshot(page: Page, navigate = true): Promise<Snapshot> {
  const started = Date.now();
  const budget = () => Math.min(15_000, 30_000 - (Date.now() - started));
  if (navigate) await page.goto(SENT, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const sender = await readSender(page, budget());
  let schema: boolean | undefined;
  const scan = async () => {
    const invitations: RemoteInvitation[] = [];
    let expected: number | undefined, terminal = false;
    for (let start = 0; start < 2000; start += 100) {
      const parsed = parseInvitationPage(await readJson(page,
        `/voyager/api/relationships/sentInvitationViewsV2?count=100&invitationType=CONNECTION&q=invitationType&start=${start}`, budget()), sender, start);
      if (schema !== undefined && schema !== parsed.live) throw Error('Invitation schema changed');
      schema = parsed.live;
      const count = parsed.live ? await sentCount(page) : parsed.total!;
      if (expected !== undefined && expected !== count) throw Error('Invitation count changed');
      expected = count;
      if (parsed.total !== undefined && parsed.total !== expected) throw Error('Invitation count disagrees');
      if (terminal && parsed.invitations.length) throw Error('Invitation pagination did not terminate');
      invitations.push(...parsed.invitations);
      if (invitations.length > expected) throw Error('Invitation count disagrees');
      if (!parsed.invitations.length) {
        if (invitations.length !== expected) throw Error('Incomplete invitation list');
        return invitations;
      }
      terminal = parsed.invitations.length < 100;
    }
    throw Error('Invitation verification page limit reached');
  };
  // A short/empty page alone is not completeness evidence. Require independent
  // UI count (live schema), an empty terminal page, then an identical full scan.
  const first = await scan(), second = await scan();
  if (JSON.stringify(first) !== JSON.stringify(second)) throw Error('Invitation list changed during verification');
  for (const key of ['invitation_urn', 'recipient_urn', 'profile_url'] as const) {
    if (new Set(first.map(i => i[key])).size !== first.length) throw Error('Duplicate invitation identity or recipient');
  }
  if (await readSender(page, budget()) !== sender) throw Error('Account changed during invitation verification');
  if (Date.now() - started >= 30_000) throw Error('Invitation snapshot too old; verify again later');
  return { sender_urn: sender, invitations: first };
}
export function newSentInvitation(before: Snapshot, after: Snapshot, url: string, started: number, ended: number) {
  if (before.sender_urn !== after.sender_urn) return null;
  const profile = canonical(url);
  if (before.invitations.some(i => i.profile_url === profile)) return null;
  const found = after.invitations.filter(i => i.profile_url === profile && !before.invitations.some(b => b.invitation_urn === i.invitation_urn));
  return found.length === 1 && found[0].sent_at >= started && found[0].sent_at <= ended ? found[0] : null;
}
function exactInvitation(snap: Snapshot, i: RemoteInvitation) {
  const matches = snap.invitations.filter(x => x.invitation_urn === i.invitation_urn ||
    x.recipient_urn === i.recipient_urn || canonical(x.profile_url) === canonical(i.profile_url));
  if (snap.sender_urn !== i.sender_urn || matches.length !== 1 ||
      ['invitation_urn', 'sender_urn', 'recipient_urn', 'sent_at'].some(k => matches[0][k as keyof RemoteInvitation] !== i[k as keyof RemoteInvitation]) ||
      canonical(matches[0].profile_url) !== canonical(i.profile_url)) throw Error('Exact invitation changed');
}
/** Read-only row binding. A stable complete snapshot must contain exactly one
 * invitation for this canonical profile; the DOM must contain exactly one row
 * for it. Accessible names are a cross-check, never the identity lookup key. */
export async function findWithdrawalControl(page: Page, i: RemoteInvitation, snap: Snapshot) {
  exactInvitation(snap, i);
  await wall(page);
  if (new URL(page.url()).pathname.replace(/\/$/, '') !== '/mynetwork/invitation-manager/sent')
    throw Error('Not on sent invitations');
  const id = JSON.stringify(i.invitation_urn);
  const exact = page.locator(`[data-invitation-id=${id}], [data-urn=${id}]`).filter({ visible: true });
  let row = exact;
  let named = false;
  if (await exact.count() === 0) {
    named = true;
    const columns = page.locator('[data-testid="lazy-column"][data-component-type="LazyColumn"]');
    const rows = columns.getByRole('listitem');
    const find = () => rows.filter({ has: page.locator(`a[href=${JSON.stringify(canonical(i.profile_url))}], a[href=${JSON.stringify(canonical(i.profile_url) + '/')}]`) });
    row = find();
    // Load only the normal visible list; never guess hidden component/request IDs.
    for (let batch = 0; await row.count() === 0 && batch < 20; batch++) {
      const loaded = await rows.count();
      if (!loaded || loaded >= snap.invitations.length || loaded >= 2000) break;
      await rows.last().scrollIntoViewIfNeeded({ timeout: 3000 });
      try {
        await page.waitForFunction(n => document.querySelectorAll('[data-testid="lazy-column"][data-component-type="LazyColumn"] [role="listitem"]').length > n,
          loaded, { timeout: 2000 });
      } catch { break; }
      row = find();
    }
  }
  if (await row.count() !== 1 || !await row.isVisible()) throw Error('Exact invitation row unavailable or ambiguous');
  const hrefs = await row.locator('a[href*="/in/"]').evaluateAll(nodes => nodes.map(n => (n as HTMLAnchorElement).href));
  if (!hrefs.length || hrefs.some(h => canonical(h) !== canonical(i.profile_url))) throw Error('Recipient row is ambiguous');
  // If identity attributes are present, a conflicting identity is never ignored.
  for (const attr of ['data-invitation-id', 'data-urn']) {
    const value = await row.getAttribute(attr);
    if (value && value !== i.invitation_urn) throw Error('Conflicting row identity');
  }
  const button = named
    ? row.getByRole('link', { name: /^(?:Withdraw invitation (?:sent )?to |Retirer l’invitation envoyée à ).+/ })
    : row.getByRole('button', { name: /^(Withdraw|Retirer)$/ });
  if (await button.count() !== 1) throw Error('Unique invitation withdrawal action unavailable');
  const name = await button.getAttribute('aria-label');
  if (named) {
    const displayed = await row.locator('p').first().innerText({ timeout: 2000 });
    const recipientName = name?.replace(/^(?:Withdraw invitation (?:sent )?to |Retirer l’invitation envoyée à )/, '');
    if (!recipientName || displayed.trim() !== recipientName.trim()) throw Error('Withdrawal label conflicts with profile row');
  }
  return { button, name: named ? name : null };
}
export class LinkedinWithdrawalProvider implements WithdrawalProvider {
  constructor(private page: Page) {}
  async inspect(i: Invitation): Promise<Observation> {
    const snap = await readSnapshot(this.page);
    const exact = snap.invitations.filter(x => x.invitation_urn === i.invitation_urn);
    const base = { sender_urn: snap.sender_urn, invitation_urn: i.invitation_urn, recipient_urn: i.recipient_urn, sent_at: i.sent_at, checked_at: Date.now() };
    if (snap.sender_urn !== i.sender_urn) return { ...base, state: 'ambiguous' };
    // Positive first-degree evidence wins even if LinkedIn returns a stale pending row.
    await this.page.goto(i.profile_url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await wall(this.page);
    if (canonical(this.page.url()) !== canonical(i.profile_url) || await readSender(this.page) !== i.sender_urn)
      throw Error('Account or recipient changed during profile verification');
    const card = await getConnectionProfileCard(this.page, i.profile_url);
    if (await card.getByText(linkedinLabel('firstDegree')).filter({ visible: true }).count()) return { ...base, state: 'accepted' };
    if (exact.length === 1 && canonical(exact[0].profile_url) === canonical(i.profile_url) &&
        snap.invitations.filter(x => x.recipient_urn === i.recipient_urn).length === 1)
      return { ...base, ...exact[0], state: 'pending' };
    // Absence alone cannot distinguish acceptance from withdrawal: require a positive
    // non-first-degree badge in the exact profile header as well as the complete list.
    const nonConnection = card.getByText(linkedinLabel('otherDegree')).filter({ visible: true });
    if (!exact.length && !snap.invitations.some(x => x.recipient_urn === i.recipient_urn || canonical(x.profile_url) === canonical(i.profile_url)) && await nonConnection.count() === 1)
      return { ...base, state: 'absent' };
    return { ...base, state: 'ambiguous' };
  }
  async withdraw(i: Invitation, authorize: () => boolean) {
    const snap = await readSnapshot(this.page);
    exactInvitation(snap, i);
    const { name } = await findWithdrawalControl(this.page, i, snap);
    // Row loading can take time: refresh the exact remote evidence before opening
    // the dialog, and resolve the row again to reject replacement/duplicate rows.
    const fresh = await readSnapshot(this.page, false);
    exactInvitation(fresh, i);
    const rebound = await findWithdrawalControl(this.page, i, fresh);
    if (rebound.name !== name) throw Error('Invitation action changed');
    await rebound.button.click({ timeout: 5000 });
    const dialog = this.page.getByRole('dialog').filter({ visible: true });
    const confirm = dialog.getByRole('button', { name: name || /^(Withdraw|Retirer)$/, exact: !!name });
    if (await dialog.count() !== 1 || await confirm.count() !== 1) throw Error('Withdrawal confirmation is ambiguous');
    await wall(this.page);
    // Preserve the dialog while rechecking account + exact invitation through read-only requests.
    const final = await readSnapshot(this.page, false);
    exactInvitation(final, i);
    if (!authorize()) throw Error('Withdrawal cancelled by campaign change');
    await confirm.click({ timeout: 5000 });
  }
}
