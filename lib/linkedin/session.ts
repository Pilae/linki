import { chromium } from "playwright-extra";
import type { Browser, BrowserContext, Page } from "playwright";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { getDb } from "@/lib/db";
import { encryptSecret, decryptSecret } from "@/lib/crypto";
import { hasCaptchaSignal, hasInvalidCredentialSignal } from "./login-signals";

chromium.use(StealthPlugin());

let browser: Browser | null = null;
const contexts: Map<string, BrowserContext> = new Map();

const HEADLESS = process.env.HEADLESS !== "false";
const CHROMIUM_PATH = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

const LAUNCH_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
];

/**
 * Shared browser-context fingerprint. Login and runtime MUST use the identical
 * options so the LinkedIn session is BORN under the exact fingerprint it will
 * later be used with — a mismatch (or a drift) triggers a forced re-auth.
 */
function contextOptions(storageState?: object) {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    storageState: storageState as any,
    viewport: { width: 1920, height: 1080 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    locale: "en-US",
    timezoneId: "America/New_York",
    permissions: ["clipboard-read", "clipboard-write"] as ("clipboard-read" | "clipboard-write")[],
  };
}

async function getBrowser(headless = HEADLESS): Promise<Browser> {
  // B1: if the cached browser is disconnected, CLOSE it before relaunching.
  // Without this, a dead-but-not-reaped chromium process tree is orphaned on
  // every relaunch (the leak behind the Jun 2026 zombie pile-up).
  if (browser && !browser.isConnected()) {
    try { await browser.close(); } catch { /* already gone */ }
    browser = null;
  }
  if (!browser) {
    browser = await chromium.launch({
      headless,
      executablePath: CHROMIUM_PATH,
      args: LAUNCH_ARGS,
    });
  }
  return browser;
}

async function getOrCreateContext(accountId: string): Promise<BrowserContext> {
  const db = getDb();
  const account = db.prepare("SELECT * FROM accounts WHERE id = ?").get(accountId) as
    | { cookies_json: string | null; email: string }
    | undefined;

  if (!account) throw new Error(`Account ${accountId} not found`);

  if (!contexts.has(accountId)) {
    const b = await getBrowser();

    let storageState: object | undefined;
    if (account.cookies_json) {
      try {
        storageState = JSON.parse(decryptSecret(account.cookies_json)!);
      } catch {
        // Invalid storage state — will need re-auth
      }
    }

    const ctx = await b.newContext(contextOptions(storageState));

    // Auto-evict from map when context closes for any reason (crash, session expiry, etc.)
    ctx.on("close", () => { if (contexts.get(accountId) === ctx) contexts.delete(accountId); });

    contexts.set(accountId, ctx);
  }

  return contexts.get(accountId)!;
}

/** Returns the BrowserContext for an account (for API calls via ctx.request) */
export async function getSessionContext(accountId: string): Promise<BrowserContext> {
  try {
    return await getOrCreateContext(accountId);
  } catch {
    // First attempt failed — evict and retry once with a fresh context
    contexts.delete(accountId);
    return getOrCreateContext(accountId);
  }
}

// B6 (Jul 2026 CPU-spike incident): closing a Playwright page doesn't mean the
// underlying Chromium renderer OS process has actually exited — under CPU
// contention on the 2-vCPU prod box, teardown was observed lagging 60-90s
// behind page.close(). If the runner loop (or a concurrent MCP/API call)
// opens its next page immediately after, two renderer processes end up alive
// at once, which is enough to peg both cores and starve sibling containers'
// healthchecks (NocoDB/Chatwoot flapping). Fix: serialize ALL page opens
// app-wide through one queue, and hold the queue for a teardown buffer after
// each page.close() before letting the next one through. PAGE_MAX_HOLD_MS is
// a safety valve so a caller that forgets to close its page can't wedge the
// whole app's browser access forever.
const PAGE_TEARDOWN_GAP_MS = 3000;
const PAGE_MAX_HOLD_MS = 120_000;
let pageQueueTail: Promise<void> = Promise.resolve();

/** Returns a new Page from the account's browser context */
export async function getSessionPage(accountId: string): Promise<Page> {
  let releaseTurn!: () => void;
  const myTurn = new Promise<void>(r => { releaseTurn = r; });
  const previousTail = pageQueueTail;
  pageQueueTail = myTurn;
  await previousTail;

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    releaseTurn();
  };
  const safetyTimer = setTimeout(release, PAGE_MAX_HOLD_MS);

  let page: Page;
  try {
    const ctx = await getOrCreateContext(accountId);
    try {
      page = await ctx.newPage();
    } catch {
      // B2: context was dead — CLOSE it before recreating so its underlying
      // browser process isn't left orphaned, then retry once with a fresh one.
      try { await ctx.close(); } catch { /* already gone */ }
      contexts.delete(accountId);
      const freshCtx = await getOrCreateContext(accountId);
      page = await freshCtx.newPage();
    }
  } catch (err) {
    clearTimeout(safetyTimer);
    release();
    throw err;
  }

  const originalClose = page.close.bind(page);
  page.close = (async (options?: Parameters<Page["close"]>[0]) => {
    try {
      return await originalClose(options);
    } finally {
      clearTimeout(safetyTimer);
      setTimeout(release, PAGE_TEARDOWN_GAP_MS);
    }
  }) as Page["close"];

  return page;
}

export async function saveSessionState(accountId: string): Promise<void> {
  const ctx = contexts.get(accountId);
  if (!ctx) return;
  const db = getDb();
  const state = await ctx.storageState();
  db.prepare("UPDATE accounts SET cookies_json = ?, is_authenticated = 1 WHERE id = ?").run(
    encryptSecret(JSON.stringify(state)),
    accountId
  );
}

export async function closeSession(accountId: string): Promise<void> {
  const ctx = contexts.get(accountId);
  if (ctx) {
    await ctx.close();
    contexts.delete(accountId);
  }
}

/**
 * B4: flag an account as logged out / needing re-auth. Clears is_authenticated
 * so the runner stops working a dead session (no more 30s-timeout fail-loop),
 * and drops the live context. The user re-authenticates from Settings.
 */
export async function markNeedsReauth(accountId: string): Promise<void> {
  const db = getDb();
  db.prepare("UPDATE accounts SET is_authenticated = 0 WHERE id = ?").run(accountId);
  try { await closeSession(accountId); } catch { /* ignore */ }
  console.warn(`[session] account ${accountId} flagged needs-reauth (session logged out)`);
}

/**
 * Opens a visible browser, navigates to LinkedIn login, and waits for the user
 * to complete login manually. Returns when the user reaches /feed.
 * Saves the full storage state to DB and marks account as authenticated.
 */
export async function authenticateAccount(accountId: string): Promise<void> {
  const db = getDb();
  const account = db.prepare("SELECT * FROM accounts WHERE id = ?").get(accountId) as
    | { email: string }
    | undefined;
  if (!account) throw new Error(`Account ${accountId} not found`);

  // Close any existing context for this account — start fresh
  await closeSession(accountId);

  // Always launch a VISIBLE browser for manual login
  const visibleBrowser = await chromium.launch({
    headless: false,
    executablePath: CHROMIUM_PATH,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  });

  try {
    const ctx = await visibleBrowser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      locale: "en-US",
      timezoneId: "America/New_York",
    });

    const page = await ctx.newPage();
    await page.goto("https://www.linkedin.com/login");

    // Pre-fill email to save the user a step
    try {
      await page.waitForSelector("input#username", { timeout: 5000 });
      await page.fill("input#username", account.email);
    } catch {
      // Input not found — page may have redirected already
    }

    // Wait up to 3 minutes for the user to complete login and reach /feed
    await page.waitForURL("**/feed/**", { timeout: 180_000 });

    // Save full storage state (cookies + localStorage) to DB
    const state = await ctx.storageState();
    db.prepare("UPDATE accounts SET cookies_json = ?, is_authenticated = 1 WHERE id = ?").run(
      encryptSecret(JSON.stringify(state)),
      accountId
    );

    await ctx.close();
  } finally {
    await visibleBrowser.close();
  }
}

// ─── Server-side headless login ───────────────────────────────────────────────
// Logs in directly on the server (no screen) so the session is born under the
// SAME pinned Chromium fingerprint the runner uses, and so ALL cookies — incl.
// httpOnly ones like li_ep_auth_context (the Sales Nav seat cookie that
// document.cookie cannot read) — are captured. A login from a datacenter IP
// almost always triggers an email/SMS PIN, so it's a two-step flow: start
// (email+password) → maybe a challenge → verify (code).

export type LoginResult =
  | { status: "authenticated" }
  | { status: "challenge"; kind: "otp" | "app" | "captcha" | "unknown"; message: string }
  | { status: "error"; message: string };

type PendingLogin = { ctx: BrowserContext; page: Page; createdAt: number };
const pendingLogins: Map<string, PendingLogin> = new Map();
const PENDING_TTL_MS = 10 * 60_000;

// PIN/verification-code input. Named ids first, then type-based fallbacks for
// LinkedIn's React checkpoint pages (which use dynamic ids). Safe: the login
// page itself has no tel/one-time-code input to misfire on.
const PIN_SELECTOR =
  "input[name='pin'], #input__email_verification_pin, input[autocomplete='one-time-code']:visible, input[type='tel']:visible";

async function clearPendingLogin(accountId: string): Promise<void> {
  const p = pendingLogins.get(accountId);
  if (p) {
    pendingLogins.delete(accountId);
    try { await p.ctx.close(); } catch { /* already gone */ }
  }
}

function sweepPendingLogins(): void {
  const now = Date.now();
  for (const [id, p] of pendingLogins) {
    if (now - p.createdAt > PENDING_TTL_MS) void clearPendingLogin(id);
  }
}

/** Save a login only after its settled session works in a fresh browser.
 * The URL reaching /feed/ does not mean its cookies are ready to persist.
 */
type LoginIdentityFailure = "navigation" | "feed_path" | "csrf_cookie" | "session_cookie" |
  "request" | "redirect" | "unauthorized" | "rate_limited" | "http_status" |
  "empty_body" | "invalid_json" | "identity" | "mismatch";
class LoginIdentityError extends Error {
  constructor(readonly reason: LoginIdentityFailure) { super("unverified_session"); }
}
function rejectIdentity(reason: LoginIdentityFailure): never { throw new LoginIdentityError(reason); }

async function loginIdentity(page: Page, navigate = false): Promise<string> {
  if (navigate) {
    const response = await page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded", timeout: 20_000 });
    if (!response || response.status() !== 200) rejectIdentity("navigation");
  }
  const pageLocation = new URL(page.url());
  if (pageLocation.origin !== "https://www.linkedin.com" || !/^\/feed\/?$/.test(pageLocation.pathname)) rejectIdentity("feed_path");
  const cookies = await page.context().cookies("https://www.linkedin.com");
  const csrf = cookies.find(cookie => cookie.name === "JSESSIONID")?.value;
  if (!csrf) rejectIdentity("csrf_cookie");
  if (!cookies.some(cookie => cookie.name === "li_at")) rejectIdentity("session_cookie");
  let result: {status: number; body: string | null};
  try { result = await page.evaluate(async token => {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch("/voyager/api/me", {
        method: "GET", credentials: "same-origin", redirect: "manual", signal: controller.signal,
        headers: {"csrf-token": token, "x-restli-protocol-version": "2.0.0", accept: "application/vnd.linkedin.normalized+json+2.1"},
      });
      if (response.type === "opaqueredirect" || response.redirected || response.url && new URL(response.url).origin !== globalThis.location.origin) return {status: 302, body: null};
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > 1_000_000 || !response.body) return {status: response.status, body: null};
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
      while (true) {
        const next = await reader.read(); if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > 1_000_000) { await reader.cancel(); return {status: response.status, body: null}; }
        chunks.push(next.value);
      }
      const joined = new Uint8Array(bytes); let offset = 0;
      for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
      return {status: response.status, body: new TextDecoder().decode(joined)};
    } finally { clearTimeout(timer); }
  }, csrf.replace(/^"|"$/g, "")); } catch { rejectIdentity("request"); }
  if (result.status === 302) rejectIdentity("redirect");
  if (result.status === 401 || result.status === 403) rejectIdentity("unauthorized");
  if (result.status === 429) rejectIdentity("rate_limited");
  if (result.status !== 200) rejectIdentity("http_status");
  if (!result.body) rejectIdentity("empty_body");
  let payload: {data?: Record<string, unknown>; errors?: unknown};
  try { payload = JSON.parse(result.body); } catch { rejectIdentity("invalid_json"); }
  const identity = payload?.data?.["*miniProfile"];
  if (payload?.errors || typeof identity !== "string" || !/^urn:li:fs_miniProfile:[A-Za-z0-9_-]+$/.test(identity)) rejectIdentity("identity");
  return identity;
}

async function persistLogin(accountId: string, ctx: BrowserContext, page: Page): Promise<void> {
  const message = "LinkedIn did not confirm a reusable session. Please sign in again and complete verification.";
  let probeBrowser: Browser | null = null;
  let probeContext: BrowserContext | null = null;
  let stage: "original_page" | "snapshot" | "restore" | "restored_page" | "save" = "original_page";
  try {
    // A short bounded wait lets feed bootstrap finish setting session cookies.
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
    const identity = await loginIdentity(page);
    stage = "snapshot";
    const state = await ctx.storageState();
    // Do not reuse the same LinkedIn session in two live contexts at once.
    // Close the login context before verifying the snapshot in a new browser.
    await closeSession(accountId);
    await ctx.close();
    stage = "restore";
    probeBrowser = await chromium.launch({headless:true,executablePath:CHROMIUM_PATH,args:LAUNCH_ARGS});
    probeContext = await probeBrowser.newContext(contextOptions(state));
    const probePage = await probeContext.newPage();
    stage = "restored_page";
    if (await loginIdentity(probePage, true) !== identity) rejectIdentity("mismatch");
    // Keep cookies refreshed by the validation request, if any.
    const verifiedState = await probeContext.storageState();
    stage = "save";
    const db = getDb();
    db.prepare("UPDATE accounts SET cookies_json = ?, is_authenticated = 1 WHERE id = ?").run(
      encryptSecret(JSON.stringify(verifiedState)), accountId
    );
  } catch (error) {
    // Never return transport errors containing URLs, headers or session material.
    const reason = error instanceof LoginIdentityError ? error.reason : "internal_error";
    console.warn(`[login] reusable session verification failed at ${stage}: ${reason}`);
    throw new Error(message);
  } finally {
    await probeContext?.close().catch(() => {});
    await probeBrowser?.close().catch(() => {});
  }
}

/**
 * Inspect the page after a login/verify submit and classify the outcome.
 * LinkedIn varies its challenge per attempt. A visible code input identifies
 * an OTP step; a checkpoint without a recognizable control stays unknown.
 */
async function classifyLoginState(page: Page): Promise<LoginResult> {
  const start = Date.now();
  const deadline = start + 20_000;
  while (Date.now() < deadline) {
    const url = page.url();
    if (/\/feed\//.test(url) || /linkedin\.com\/sales\//.test(url)) {
      return { status: "authenticated" };
    }

    // Email/SMS PIN entry
    const pin = page.locator(PIN_SELECTOR).first();
    if ((await pin.count()) > 0 && (await pin.isVisible().catch(() => false))) {
      return {
        status: "challenge",
        kind: "otp",
        message: "LinkedIn sent you a verification code (email or SMS). Enter it below.",
      };
    }

    if (/checkpoint\/challenge/.test(url)) {
      // CAPTCHA (Arkose / FunCaptcha) — cannot be solved headlessly
      if (await hasCaptchaSignal(page)) {
        return {
          status: "challenge",
          kind: "captcha",
          message: "LinkedIn requires a CAPTCHA, which can't be solved on the server. Use cookie paste instead.",
        };
      }
      // A settled checkpoint with no identifiable code input or CAPTCHA. The
      // challenge copy varies by language, so do not guess its mechanism.
      if (Date.now() - start > 4_000) {
        return {
          status: "challenge",
          kind: "unknown",
          message: "LinkedIn requires another verification step. If it is a device approval, approve it and check again. For other manual steps, use Paste cookies.",
        };
      }
    }

    // Use form validation state rather than English error sentences. An
    // unrecognized failure remains generic instead of misclassifying it.
    if (await hasInvalidCredentialSignal(page)) {
      return { status: "error", message: "LinkedIn rejected the login fields. Check your email and password." };
    }

    await page.waitForTimeout(800);
  }

  if (/checkpoint/.test(page.url())) {
    return {
      status: "challenge",
      kind: "unknown",
      message: "LinkedIn presented a security checkpoint. If it is a device approval, approve it and check again. For other manual steps, use Paste cookies.",
    };
  }
  return { status: "error", message: `Login did not complete. Current page: ${page.url()}` };
}

export async function startHeadlessLogin(
  accountId: string,
  email: string,
  password: string
): Promise<LoginResult> {
  sweepPendingLogins();
  await clearPendingLogin(accountId);

  const b = await getBrowser(true);
  const ctx = await b.newContext(contextOptions());
  const page = await ctx.newPage();
  try {
    await page.goto("https://www.linkedin.com/login", { waitUntil: "domcontentloaded", timeout: 30_000 });
    // LinkedIn's React login page uses dynamic ids — target by type+visibility
    // (old #username/#password kept as a fallback for the legacy layout).
    const emailInput = page.locator("input#username, input[type='email']:visible").first();
    await emailInput.waitFor({ state: "visible", timeout: 20_000 });
    await emailInput.fill(email);
    const passwordInput = page.locator("input#password, input[type='password']:visible").first();
    await passwordInput.fill(password);
    await Promise.all([
      page.waitForLoadState("domcontentloaded").catch(() => {}),
      passwordInput.press("Enter"),
    ]);

    const result = await classifyLoginState(page);
    console.log(`[login] start account=${accountId} -> ${result.status}${"kind" in result ? "/" + result.kind : ""} url=${page.url()}`);
    if (result.status === "authenticated") {
      await persistLogin(accountId, ctx, page);
      await ctx.close();
      return result;
    }
    if (result.status === "challenge" && result.kind !== "captcha") {
      pendingLogins.set(accountId, { ctx, page, createdAt: Date.now() });
      return result;
    }
    await ctx.close();
    return result;
  } catch (e) {
    console.log(`[login] start account=${accountId} ERROR ${(e as Error).message} url=${page.url()}`);
    try { await ctx.close(); } catch { /* ignore */ }
    return { status: "error", message: (e as Error).message };
  }
}

export async function submitLoginChallenge(accountId: string, code: string): Promise<LoginResult> {
  const p = pendingLogins.get(accountId);
  if (!p) return { status: "error", message: "No login in progress (it may have timed out — start again)." };

  const { ctx, page } = p;
  try {
    const pin = page.locator(PIN_SELECTOR).first();
    await pin.waitFor({ state: "visible", timeout: 15_000 });
    await pin.fill(code);
    await Promise.all([
      page.waitForLoadState("domcontentloaded").catch(() => {}),
      pin.press("Enter"),
    ]);

    const result = await classifyLoginState(page);
    console.log(`[login] verify account=${accountId} -> ${result.status}${"kind" in result ? "/" + result.kind : ""} url=${page.url()}`);
    if (result.status === "authenticated") {
      await persistLogin(accountId, ctx, page);
      await clearPendingLogin(accountId);
      return result;
    }
    if (result.status === "challenge" && result.kind !== "captcha") {
      p.createdAt = Date.now(); // keep the session alive for another step
      return result;
    }
    await clearPendingLogin(accountId);
    return result.status === "error"
      ? result
      : { status: "error", message: "Code rejected or login failed." };
  } catch (e) {
    await clearPendingLogin(accountId);
    return { status: "error", message: (e as Error).message };
  }
}

/**
 * Wait for a device/app-approval challenge to clear. Called after the user
 * approves the sign-in in their LinkedIn mobile app — the checkpoint page may
 * auto-advance to the feed. If still pending, return the challenge. Do not
 * click a generic submit button on an unidentified security interstitial.
 */
export async function awaitLoginApproval(accountId: string): Promise<LoginResult> {
  const p = pendingLogins.get(accountId);
  if (!p) return { status: "error", message: "No login in progress (it may have timed out — start again)." };

  const { ctx, page } = p;
  p.createdAt = Date.now();
  try {
    const reachedFeed = await page
      .waitForURL(/\/feed\/|linkedin\.com\/sales\//, { timeout: 50_000 })
      .then(() => true)
      .catch(() => false);

    if (!reachedFeed) console.info("[login] approval has not reached the feed; leaving checkpoint controls untouched");

    const result = await classifyLoginState(page);
    console.log(`[login] await account=${accountId} -> ${result.status}${"kind" in result ? "/" + result.kind : ""} url=${page.url()}`);
    if (result.status === "authenticated") {
      await persistLogin(accountId, ctx, page);
      await clearPendingLogin(accountId);
      return result;
    }
    if (result.status === "challenge" && result.kind !== "captcha") {
      p.createdAt = Date.now();
      return result;
    }
    await clearPendingLogin(accountId);
    return result;
  } catch (e) {
    await clearPendingLogin(accountId);
    return { status: "error", message: (e as Error).message };
  }
}
