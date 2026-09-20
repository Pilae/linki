import type { Page } from "playwright";
import { getDb } from "@/lib/db";
import { getSessionPage, saveSessionState, markNeedsReauth } from "@/lib/linkedin/session";

/** Shared manual/scheduled detector. Only positive connections-list evidence marks
 * acceptance; absence never implies acceptance or removes a connection. */
const ACCEPTED_SYNC_INTERVAL_MS = 8 * 60 * 60 * 1000; // 8h — 3x per day
const PAGE_SIZE = 100;
const MAX_PAGES = 60; // safety cap (60 * 100 = 6000)
const DECORATION = "com.linkedin.voyager.dash.deco.web.mynetwork.ConnectionListWithProfile-16";

export function shouldSyncAccepted(accountId: string): boolean {
  const db = getDb();
  const row = db.prepare("SELECT accepted_sync_at FROM accounts WHERE id = ?").get(accountId) as
    | { accepted_sync_at: string | null }
    | undefined;
  if (!row?.accepted_sync_at) return true;
  return Date.now() - new Date(row.accepted_sync_at).getTime() >= ACCEPTED_SYNC_INTERVAL_MS;
}

interface ApiConnection {
  vanity: string | null;
  createdAt: number; // epoch ms
}

export async function syncAcceptedConnections(accountId: string): Promise<number> {
  const db = getDb();
  const page = await getSessionPage(accountId);
  let stamped = 0;

  try {
    // Read the declared total from the connections PAGE header (single nav, NO
    // scroll). This is also our login-wall check and an informational account count.
    await page.goto("https://www.linkedin.com/mynetwork/invite-connect/connections/", {
      waitUntil: "domcontentloaded",
      timeout: 35000,
    });
    await page.waitForTimeout(3500 + Math.random() * 1500);
    if (/\/login|\/authwall|\/checkpoint|\/uas\//.test(page.url())) {
      console.warn(`[sync-accepted] Session looks logged out (${page.url()}) — skipping`);
      throw new Error("LinkedIn login or verification required");
    }
    const declaredTotal = await page.evaluate(() => {
      const m = document.body.innerText.match(/([\d.,]+)\s+connections?/i);
      return m ? parseInt(m[1].replace(/[.,]/g, ""), 10) : null;
    });

    const waiting = db.prepare(`SELECT DISTINCT t.id, t.linkedin_url, t.connected_at, t.degree
      FROM targets t JOIN run_profiles rp ON rp.target_id=t.id
      JOIN runs r ON r.id=rp.run_id WHERE r.account_id=?
      AND t.connection_requested_at IS NOT NULL`).all(accountId) as Array<{
      id: string;
      linkedin_url: string;
      connected_at: string | null;
      degree: number | null;
    }>;
    const stampAccepted = db.prepare(
      "UPDATE targets SET degree = 1, connected_at = COALESCE(connected_at, ?) WHERE id = ?"
    );

    const seenVanities = new Set<string>();
    let newestSeen: number | null = null;
    let reachedEnd = false;

    for (let pageIdx = 0; pageIdx < MAX_PAGES; pageIdx++) {
      const conns = await fetchConnectionsPage(page, pageIdx * PAGE_SIZE, PAGE_SIZE);
      if (conns === null) {
        throw new Error(`LinkedIn connections API unavailable at offset ${pageIdx * PAGE_SIZE}; verification incomplete`);
      }
      if (conns.length === 0) {
        reachedEnd = true;
        break;
      } // end of list

      for (const c of conns) {
        if (c.vanity) seenVanities.add(c.vanity.toLowerCase());
        if (newestSeen === null || c.createdAt > newestSeen) newestSeen = c.createdAt;
        if (!c.vanity) continue;

        for (const m of waiting.filter(t => profileVanity(t.linkedin_url) === c.vanity?.toLowerCase())) {
          if (m.degree === 1 && m.connected_at) continue; // already correct
          stampAccepted.run(msToSqlite(c.createdAt), m.id);
          console.log(`[sync-accepted] Accepted: ${c.vanity}`);
          stamped++;
          m.degree = 1;
          m.connected_at = msToSqlite(c.createdAt);
        }
      }

      // Do not assume upstream pages are globally sorted by connection date.
      if (waiting.every(t => t.degree === 1 && t.connected_at || seenVanities.has(profileVanity(t.linkedin_url) || ''))) {
        reachedEnd = true;
        break;
      }
      await page.waitForTimeout(900 + Math.random() * 700); // gentle, API-only
    }

    if (!reachedEnd)
      throw new Error("Connection verification reached the page limit; verification incomplete");
    // Advance the boundary to the newest connection seen this run.
    if (newestSeen !== null) {
      db.prepare("UPDATE accounts SET connections_synced_through_ms = ? WHERE id = ?").run(newestSeen, accountId);
    }
    // Store the declared total for visibility (Settings shows LinkedIn's count).
    if (declaredTotal !== null) {
      db.prepare("UPDATE accounts SET li_connections = ? WHERE id = ?").run(declaredTotal, accountId);
    }
    console.log(`[sync-accepted] Stamped ${stamped} accepted (boundary=${newestSeen}).`);
    db.prepare("UPDATE accounts SET accepted_sync_at = datetime('now') WHERE id = ?").run(accountId);
  } finally {
    // B5 safety: only persist the session if still on a valid page.
    let url = "";
    try { url = page.url(); } catch { /* gone */ }
    try { await page.close(); } catch { /* ignore */ }
    if (/\/login|\/authwall|\/checkpoint|\/uas\//.test(url)) {
      console.warn(`[sync-accepted] Ended on a wall (${url}) — not persisting; flagging re-auth`);
      try { await markNeedsReauth(accountId); } catch { /* ignore */ }
    } else {
      try { await saveSessionState(accountId); } catch { /* ignore */ }
    }
  }

  return stamped;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function msToSqlite(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}

async function fetchConnectionsPage(page: Page, start: number, count: number): Promise<ApiConnection[] | null> {
  return page.evaluate(
    async ({ start, count, decoration }): Promise<ApiConnection[] | null> => {
      const cookies = document.cookie.split("; ").reduce((a: Record<string, string>, c) => {
        const i = c.indexOf("=");
        if (i > 0) a[c.slice(0, i)] = c.slice(i + 1);
        return a;
      }, {});
      const csrf = (cookies["JSESSIONID"] || "").replace(/"/g, "");
      const url =
        `https://www.linkedin.com/voyager/api/relationships/dash/connections` +
        `?decorationId=${decoration}&count=${count}&q=search&sortType=RECENTLY_ADDED&start=${start}`;
      let json: {
        included?: Array<{
          $type?: string;
          entityUrn?: string;
          createdAt?: number;
          connectedMember?: string;
          publicIdentifier?: string;
        }>;
      };
      try {
        const r = await fetch(url, {
          headers: {
            "csrf-token": csrf,
            "accept": "application/vnd.linkedin.normalized+json+2.1",
            "x-restli-protocol-version": "2.0.0",
            "x-li-lang": "en_US",
          },
          credentials: "include",
        });
        if (!r.ok) return null;
        json = await r.json();
      } catch {
        return null;
      }

      const included = json.included || [];
      const vanityByUrn: Record<string, string> = {};
      for (const x of included) {
        if ((x.$type || "").includes("identity.profile.Profile") && x.entityUrn && x.publicIdentifier) {
          vanityByUrn[x.entityUrn] = x.publicIdentifier;
        }
      }
      const out: ApiConnection[] = [];
      for (const x of included) {
        if ((x.$type || "").includes("relationships.Connection") && typeof x.createdAt === "number") {
          const memberUrn = x.connectedMember || null;
          out.push({
            createdAt: x.createdAt,
            vanity: memberUrn ? vanityByUrn[memberUrn] ?? null : null,
          });
        }
      }
      out.sort((a, b) => b.createdAt - a.createdAt);
      return out;
    },
    { start, count, decoration: DECORATION }
  );
}

export function profileVanity(value: string): string | null {
  try {
    const u = new URL(value);
    if (!['linkedin.com', 'www.linkedin.com'].includes(u.hostname)) return null;
    const m = u.pathname.match(/^\/in\/([^/]+)\/?$/);
    return m ? decodeURIComponent(m[1]).toLowerCase() : null;
  } catch {
    return null;
  }
}
