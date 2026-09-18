import type { Page } from "playwright";
import { getConnectionProfileCard } from "./connect";

/** Read the visited profile's explicit degree badge. A Message link alone is
 * not proof of connection; missing/unsupported markup is an unknown outcome. */
export async function visitProfile(page: Page, linkedinUrl: string): Promise<{ isFirstDegree: boolean; messagingUrn: string | null }> {
  await page.goto(linkedinUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(3000 + Math.random() * 2000);
  if (/\/(login|uas\/login|checkpoint|authwall|challenge)(?:[/?#]|$)/i.test(page.url()) ||
      await page.locator('input[type="password"]:visible').count()) {
    throw new Error("LinkedIn login or verification is required; connection status is unknown.");
  }
  const card = await getConnectionProfileCard(page, linkedinUrl);
  const first = card.getByText(/^[·•]?\s*(?:1st|1er)\s*$/i).filter({visible:true});
  const other = card.getByText(/^[·•]?\s*(?:2nd|2e|3rd|3e)\s*\+?\s*$/i).filter({visible:true});
  if (!await first.count()) {
    if (await other.count()) return {isFirstDegree:false,messagingUrn:null};
    throw new Error("LinkedIn connection badge could not be verified; no message attempted and connection status remains unchanged.");
  }
  if (await other.count()) throw new Error("Conflicting profile connection badges; review manually before messaging.");
  const hrefs = await card.locator('a[href*="/messaging/compose"]:visible').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('href')));
  const urns = new Set<string>();
  for (const href of hrefs) {
    if (!href) continue;
    const urn = new URL(href,'https://www.linkedin.com').searchParams.get('profileUrn');
    if (urn && /^urn:li:fsd_profile:[A-Za-z0-9_-]+$/.test(urn)) urns.add(urn);
  }
  if (urns.size>1) throw new Error("Conflicting profile messaging recipients; no message attempted.");
  return {isFirstDegree:true,messagingUrn:[...urns][0]??null};
}
