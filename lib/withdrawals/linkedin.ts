import type { Page } from 'playwright';
import { getConnectionProfileCard } from '../linkedin/connect';
import { linkedinLabel } from '../linkedin/labels';
import type { Invitation } from './store';
import type { Observation, WithdrawalProvider } from './worker';
export interface RemoteInvitation { invitation_urn: string; sender_urn: string; recipient_urn: string; sent_at: number; profile_url: string }
export interface Snapshot { sender_urn: string; invitations: RemoteInvitation[] }
const SENT = 'https://www.linkedin.com/mynetwork/invitation-manager/sent/';
const canonical = (s: string) => { const u = new URL(s); if (!['www.linkedin.com','linkedin.com'].includes(u.hostname) || !/^\/in\/[^/]+\/?$/.test(u.pathname)) throw Error('Unsupported recipient URL'); return `https://www.linkedin.com${u.pathname.replace(/\/$/, '')}`; };
const urn = (x: unknown): string => typeof x === 'string' ? x : '';
type Entity = Record<string, unknown>;
/** Strict normalized Voyager schema. Unsupported/missing entities are not an empty list.
 * This parser is deliberately fixture-bounded; live layouts require explicit validation. */
export function parseInvitationPage(json: unknown, sender: string, start: number) {
  const j = json as { data?: { elements?: unknown[]; paging?: { start?: number; total?: number } }; included?: Entity[] };
  if (!j?.data || !Array.isArray(j.data.elements) || !Array.isArray(j.included) || j.data.paging?.start !== start ||
      !Number.isSafeInteger(j.data.paging.total) || j.data.paging.total! < 0) throw Error('Unrecognized sent-invitations response');
  const byUrn = new Map(j.included.map(e => [urn(e.entityUrn), e]));
  if (byUrn.size !== j.included.length || byUrn.has('')) throw Error('Ambiguous invitation entities');
  const invitations: RemoteInvitation[] = [];
  for (const ref of j.data.elements) {
    const view = typeof ref === 'string' ? byUrn.get(ref) : ref as Entity;
    const item = byUrn.get(urn(view?.['*invitation'] || view?.invitation)) || view;
    if (!item || item.$type !== 'com.linkedin.voyager.relationships.Invitation') throw Error('Unrecognized invitation type');
    const senderUrn = urn(item['*inviter'] || item.inviter), recipientUrn = urn(item['*invitee'] || item.invitee);
    const recipient = byUrn.get(recipientUrn);
    const sent = item.sentTime;
    if (senderUrn !== sender || !recipient || typeof recipient.publicIdentifier !== 'string' ||
        !Number.isSafeInteger(sent) || (sent as number) <= 0 || (sent as number) > Date.now() || !urn(item.entityUrn)) throw Error('Incomplete invitation identity or timestamp');
    invitations.push({ invitation_urn: urn(item.entityUrn), sender_urn: senderUrn, recipient_urn: recipientUrn,
      sent_at: sent as number, profile_url: canonical(`https://www.linkedin.com/in/${encodeURIComponent(recipient.publicIdentifier)}`) });
  }
  return { invitations, total: j.data.paging.total! };
}
async function wall(page: Page) {
  if (/\/(login|authwall|checkpoint|challenge|uas)(?:[/?#]|$)/i.test(page.url()) || await page.locator('input[type="password"]:visible').count())
    throw Error('LinkedIn authentication or verification required; complete it manually');
}
async function readJson(page: Page, path: string): Promise<unknown> {
  await wall(page);
  return page.evaluate(async path => {
    const csrf = document.cookie.split('; ').find(x => x.startsWith('JSESSIONID='))?.slice(11).replace(/"/g, '');
    if (!csrf) throw Error('Missing authenticated session');
    const r = await fetch(path, { credentials: 'include', cache: 'no-store', headers: { 'csrf-token': csrf, accept: 'application/vnd.linkedin.normalized+json+2.1', 'x-restli-protocol-version': '2.0.0' } });
    if (!r.ok || r.redirected) throw Error('Invitation verification unavailable');
    return r.json();
  }, path);
}
async function readSender(page: Page): Promise<string> {
  const me = await readJson(page, '/voyager/api/me') as { data?: { miniProfile?: { entityUrn?: string }; '*miniProfile'?: string }; miniProfile?: { entityUrn?: string } };
  const sender = me.data?.miniProfile?.entityUrn || me.data?.['*miniProfile'] || me.miniProfile?.entityUrn;
  if (!sender?.startsWith('urn:li:fs_miniProfile:')) throw Error('Sending account identity unavailable');
  return sender;
}
export async function readSnapshot(page: Page, navigate = true): Promise<Snapshot> {
  const started = Date.now();
  if (navigate) await page.goto(SENT, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const sender = await readSender(page);
  const invitations: RemoteInvitation[] = [];
  let total: number | undefined;
  for (let start = 0; start < 2000; start += 100) {
    const parsed = parseInvitationPage(await readJson(page,
      `/voyager/api/relationships/sentInvitationViewsV2?count=100&invitationType=CONNECTION&q=invitationType&start=${start}`), sender, start);
    if (total !== undefined && total !== parsed.total) throw Error('Invitation list changed during verification');
    total = parsed.total;
    invitations.push(...parsed.invitations);
    if (new Set(invitations.map(i => i.invitation_urn)).size !== invitations.length) throw Error('Duplicate invitation identity');
    if (invitations.length === total) {
      if (await readSender(page) !== sender) throw Error('Account changed during invitation verification');
      if (Date.now() - started >= 30_000) throw Error('Invitation snapshot too old; verify again later');
      return { sender_urn: sender, invitations };
    }
    if (parsed.invitations.length !== 100 || invitations.length > total) throw Error('Incomplete invitation list');
  }
  throw Error('Invitation verification page limit reached');
}
export function newSentInvitation(before: Snapshot, after: Snapshot, url: string, started: number, ended: number) {
  if (before.sender_urn !== after.sender_urn) return null;
  const profile = canonical(url);
  if (before.invitations.some(i => i.profile_url === profile)) return null;
  const found = after.invitations.filter(i => i.profile_url === profile && !before.invitations.some(b => b.invitation_urn === i.invitation_urn));
  return found.length === 1 && found[0].sent_at >= started && found[0].sent_at <= ended ? found[0] : null;
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
    const matches = snap.invitations.filter(x => x.invitation_urn === i.invitation_urn && x.recipient_urn === i.recipient_urn && x.sent_at === i.sent_at);
    if (snap.sender_urn !== i.sender_urn || matches.length !== 1) throw Error('Invitation changed before withdrawal');
    // Only a row exposing the exact provider identity is supported. Never click a
    // person-name-only match, profile Pending, or Remove connection action.
    const id = JSON.stringify(i.invitation_urn);
    const row = this.page.locator(`[data-invitation-id=${id}], [data-urn=${id}]`).filter({ visible: true });
    if (await row.count() !== 1) throw Error('Exact invitation row unavailable; layout needs validation');
    const link = row.locator('a[href*="/in/"]');
    const hrefs = await link.evaluateAll(nodes => nodes.map(n => (n as HTMLAnchorElement).href));
    if (!hrefs.length || hrefs.some(h => canonical(h) !== canonical(i.profile_url))) throw Error('Recipient row is ambiguous');
    const button = row.getByRole('button', { name: /^(Withdraw|Retirer)$/ });
    if (await button.count() !== 1) throw Error('Unique invitation withdrawal action unavailable');
    await button.click({ timeout: 5000 });
    const dialog = this.page.getByRole('dialog').filter({ visible: true });
    const confirm = dialog.getByRole('button', { name: /^(Withdraw|Retirer)$/ });
    if (await dialog.count() !== 1 || await confirm.count() !== 1) throw Error('Withdrawal confirmation is ambiguous');
    await wall(this.page);
    // Preserve the dialog while rechecking account + exact invitation through read-only requests.
    const final = await readSnapshot(this.page, false);
    if (final.sender_urn !== i.sender_urn || final.invitations.filter(x =>
      x.invitation_urn === i.invitation_urn && x.recipient_urn === i.recipient_urn && x.sent_at === i.sent_at).length !== 1)
      throw Error('Exact invitation changed at confirmation');
    if (!authorize()) throw Error('Withdrawal cancelled by campaign change');
    await confirm.click({ timeout: 5000 });
  }
}
