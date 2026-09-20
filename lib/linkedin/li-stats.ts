import type { Page } from "playwright";
import { parseLocalizedInteger, parseParenthesizedCount, readConnectionsCount } from "./counts";

export interface LinkedInStats {
  connections: number | null;
  pending: number | null;
  profile_views: number | null;
}

export async function scrapeLinkedInStats(page: Page): Promise<LinkedInStats> {
  await page.goto("https://www.linkedin.com/mynetwork/invite-connect/connections/", {
    waitUntil: "domcontentloaded", timeout: 30000,
  });
  await page.waitForTimeout(2500);
  const connections = await readConnectionsCount(page);

  await page.goto("https://www.linkedin.com/mynetwork/invitation-manager/sent/", {
    waitUntil: "domcontentloaded", timeout: 30000,
  });
  await page.waitForTimeout(2500);
  const sentTab = page.locator('a[href*="/invitation-manager/sent/CONNECTION/"]').first();
  const sentText = await sentTab.textContent({ timeout: 8000 }).catch(() => null);
  const pending = sentText === null ? null : parseParenthesizedCount(sentText);

  await page.goto("https://www.linkedin.com/analytics/profile-views/", {
    waitUntil: "domcontentloaded", timeout: 30000,
  });
  await page.waitForTimeout(3000);
  // The observed overview has a single numeric-only paragraph before its chart.
  // If LinkedIn adds another, the metric is ambiguous and remains unknown.
  const numericCounts = (await page.locator("main p").allTextContents())
    .map(parseLocalizedInteger).filter((value): value is number => value !== null);
  const profile_views = numericCounts.length === 1 ? numericCounts[0] : null;

  return { connections, pending, profile_views };
}
