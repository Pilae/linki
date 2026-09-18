import type { Page, Locator } from "playwright";
import { linkedinLabel } from "./labels";

export class WeeklyLimitError extends Error {}
export class AlreadyConnectedError extends Error {}
export class PendingInviteError extends Error {}

/**
 * Sends a LinkedIn connection request without a note.
 * Navigates to the profile page and clicks the Connect button.
 * Throws WeeklyLimitError if the weekly limit popup appears.
 * Throws AlreadyConnectedError / PendingInviteError if already in that state.
 */
export async function sendConnectionRequest(page: Page, linkedinUrl: string): Promise<void> {
  await page.goto(linkedinUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(2000 + Math.random() * 1000);

  if (/\/(login|uas\/login|checkpoint|authwall|challenge)(?:[/?#]|$)/i.test(page.url()) ||
      await page.locator('input[type="password"]:visible').count()) {
    throw new Error("LinkedIn login or verification is required. Complete it manually before retrying; no invitation was attempted.");
  }

  const topCard = await getConnectionProfileCard(page, linkedinUrl);
  if (await topCard.getByText(linkedinLabel("firstDegree")).filter({visible:true}).count()) throw new AlreadyConnectedError("Already connected");

  // Share the same scoped matcher before sending and when confirming the result.
  if (await pendingInvitation(topCard).count()) throw new PendingInviteError("Invitation already pending");

  // Scope actions to this profile, never navigation or suggested profiles.
  const directConnect = topCard.locator('a[href*="custom-invite"]:visible')
    .or(topCard.getByRole('button', {name: linkedinLabel("invite")}))
    .or(topCard.getByRole('link', {name: linkedinLabel("invite")}))
    .or(topCard.getByRole('button', {name: linkedinLabel("connect")}))
    .or(topCard.getByRole('link', {name: linkedinLabel("connect")}));
  if (await directConnect.count() === 1) {
    // Normal click respects overlays rather than bypassing them via URL navigation.
    await directConnect.click({timeout:5000});
  } else if (await directConnect.count() > 1) {
    throw new Error("Multiple connection actions in the profile header. Review the profile manually; no invitation was attempted.");
  } else {
    // Include the icon-only overflow selector used by newer action bars (upstream #15).
    // Keep every candidate in the verified card; never fall back to page-wide actions.
    const more = topCard.getByRole('button', {
      name: linkedinLabel("more"),
    }).or(topCard.locator('button[data-x--lead-actions-bar-overflow-menu]')).filter({ visible: true });
    if (await more.count() !== 1 || !await more.isVisible()) throw new Error("No unique More button in the profile header. LinkedIn layout or language is unsupported; no invitation was attempted.");
    await more.click({timeout:5000});
    const menus=page.locator('[role="menu"]:visible, [role="listbox"]:visible');
    await menus.first().waitFor({state:'visible',timeout:5000});
    if(await menus.count()!==1)throw new Error("Multiple open menus; review the profile manually before retrying.");
    if(await menus.getByText(linkedinLabel("pending")).filter({visible:true}).count())throw new PendingInviteError("Invitation already pending");
    const connect = menus.getByRole('menuitem', { name: linkedinLabel("connect") })
      .or(menus.getByRole('option', { name: linkedinLabel("connect") }))
      .or(menus.getByRole('button', { name: linkedinLabel("connect") }))
      .filter({ visible: true });
    if(await connect.count()!==1)throw new Error("No unique Connect action in the profile menu. Review the profile manually before retrying.");
    await connect.click({timeout:5000});
  }

  await page.waitForTimeout(1000);

  // LinkedIn can show the limit immediately after Connect, before a send dialog.
  const limitPopup = page.locator('div[class*="ip-fuse-limit-alert__warning"]');
  if (await limitPopup.count() > 0) throw new WeeklyLimitError("Weekly connection limit reached");

  // Click "Send without a note" / "Send now"
  const sendBtn = page.locator('[role="dialog"]:visible')
    .getByRole('button', {name: linkedinLabel("sendWithoutNote")});
  if (await sendBtn.count() === 1) {
    await sendBtn.click({timeout:5000});
    await page.waitForTimeout(1500);
  }

  else {
    throw new Error("Invitation confirmation was not found or was ambiguous. Outcome unconfirmed: check LinkedIn before retrying.");
  }

  // The limit can also appear after the send action.
  if (await limitPopup.count() > 0) throw new WeeklyLimitError("Weekly connection limit reached");

  // Check for error toast
  const errorToast = page.locator('div[data-test-artdeco-toast-item-type="error"]:visible');
  if (await errorToast.count() > 0) {
    const msg = await errorToast.innerText();
    throw new Error(`Connection error: ${msg.trim()}`);
  }
  const confirmed = pendingInvitation(topCard).or(page.getByText(linkedinLabel("invitationSent")));
  try {
    await confirmed.first().waitFor({state:'visible',timeout:5000});
  } catch {
    throw new Error("Invitation outcome is unconfirmed. Check LinkedIn before retrying; no sent status was recorded.");
  }

}

/** Resolve only the visited profile card; never expand to main or the sidebar. */
export async function getConnectionProfileCard(page: Page, linkedinUrl: string) {
  const url = new URL(linkedinUrl);
  const match = url.pathname.match(/^\/in\/([^/]+)\/?$/);
  if (!match || !["www.linkedin.com", "linkedin.com"].includes(url.hostname)) throw new Error("Unsupported LinkedIn profile URL");
  const marker = `ProfileVerificationTriggerRef-${decodeURIComponent(match[1])}`;
  // Observed newer layout: h2 nested inside this profile-specific marker.
  const modern = page.locator(`[componentkey=${JSON.stringify(marker)}]:visible`)
    .filter({has:page.locator('h2')}).locator('xpath=ancestor::section[1]');
  const legacy = page.locator('main section:visible').filter({has:page.locator('h1')});
  const card = await modern.count() ? modern : legacy;
  if (await card.count() !== 1 || !await card.isVisible()) {
    throw new Error("LinkedIn profile header was not found or was ambiguous. The session may need verification or the layout is unsupported; no invitation was attempted.");
  }
  return card;
}

// LinkedIn expands the accessible name to include the withdrawal action and recipient.
// Match the status prefix, scoped to this profile, without clicking withdrawal controls.
function pendingInvitation(card: Locator) {
  const name = linkedinLabel("pending");
  return card.getByRole('button', {name}).or(card.getByRole('link', {name}));
}
