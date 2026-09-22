export async function register() {
  // Only run on the Node.js server runtime, not in the browser/edge
  if (process.env.NEXT_RUNTIME === "nodejs") {
    try {
      const { ensureGlobalRunnerStarted } = await import("@/lib/linkedin/runner");
      ensureGlobalRunnerStarted();
      const { startReplyScheduler } = await import("@/pilae/linkedin-replies/runtime");
      startReplyScheduler();
    } catch (err) {
      console.error("[instrumentation] Failed to start runner:", err);
    }
  }
}
