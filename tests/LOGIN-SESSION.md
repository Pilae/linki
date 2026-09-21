# Preserve ordinary LinkedIn login sessions

The password/verification login path previously visited Sales Navigator before
saving cookies, even for accounts without a Sales Navigator subscription. An
authorized diagnostic on a regular account returned a successful identity check
before that visit and after restoring the pre-visit storage state. The same
identity request redirected immediately after the Sales Navigator visit. This
isolates that navigation as the trigger in this observed case; it does not
establish that every account is affected.

The login persistence function now waits briefly for feed bootstrap, verifies the
ordinary authenticated identity endpoint, snapshots the session, closes the login
context, and checks the same identity in a fresh browser process before saving
its cookies. The two contexts in this flow do not use the account simultaneously.
It does not visit Sales Navigator. Missing cookies, redirects, HTTP failures and
malformed identity responses reject persistence.
Requests have a 15-second timeout, no redirects and no immediate retries. Errors
shown to callers contain no request URLs or session values. Stored credentials
are not overwritten on failed verification. This changes password/OTP/app-approval
login persistence, not cookie-paste or the separate visible-browser login flow.

Sales Navigator-specific initialization is not performed by ordinary login.
Sales Navigator import behavior has not been validated by this change.

## Regression tests

```sh
node --test tests/login-session.test.cjs tests/enrollment.test.cjs
node tests/accepted-sync.cjs
node tests/campaign-metrics.cjs
node tests/login-signals.cjs
npx tsc --noEmit --incremental false
npx eslint lib/linkedin/session.ts
```

The regression tests verify the feed wait, serial context closure before browser
launch, restored identity check and refusal to save rejected or mismatched
sessions. The earlier tests reproduced the
Sales Navigator failure; a later authorized diagnostic showed that a settled
session also survived context closure and fresh-browser restoration.
The existing enrollment tests, acceptance/metrics fixtures and 12 network-disabled
browser login-signal assertions also pass. TypeScript, scoped lint and a build
of the patched local image pass. The build retains the missing optional `ee/`
warning.

## Live validation boundary

The diagnostic was operator-run with hidden password entry and user-handled app
approval. It printed only status/identity-match booleans and made no application
database writes. No messages or invitations were sent and no campaign was started
or restarted. The login-only fix was installed on the local sandbox using its
existing image and browser version; its previous container is retained for
rollback. Production was not changed.

A subsequent operator login with only the Sales Navigator removal saved a fresh
session and passed an immediate identity check, but a later independent restore
returned 302 followed by 401. A later bounded diagnostic let the feed settle
and confirmed identity both after login-context closure and in a fresh browser
process (200 in all four stages). This supports waiting and validating a fresh
browser before saving. A subsequent operator login on the revised local image passed the immediate
validation and was saved at 13:04 UTC, but a read-only identity check at 13:06
returned 302 followed by 401. A later timed check opened two contexts for the
same saved session: both passed immediately, then both redirected at 30 seconds;
a page-first check reached login. This test could itself have affected the
session, so it does not isolate the cause.

Two subsequent operator-run, read-only diagnostics kept one context at a time.
The first remained on the feed at 0, 30 and 120 seconds. The second saved state
in memory, closed the original browser, then restored it into a new browser;
the restored feed remained authenticated at 0, 30 and 120 seconds. Neither
diagnostic wrote to the application database, sent outreach or ran a campaign.
The overlap in the previous login verification is therefore a leading cause to
test, not a confirmed LinkedIn policy or proof that the revised Linki flow works.
The revised local app passed its production build and was installed only in the
localhost test container, with the previous container retained for rollback.
The first read-only watcher timed out without a new operator login and made no
LinkedIn requests. In the next operator-run login, Linki saved a new session,
but a single restored context checked ten seconds later reached the login page
and lost its `li_at` cookie on the first feed navigation. Both campaigns remained
completed and there were no scheduled imports. Thus serializing the two
contexts alone did not fix the ordinary app path. The isolated diagnostic did
not call the identity API or perform a third restore after verification; those
differences remain hypotheses, not a diagnosed LinkedIn rejection reason.
The connected flag is still insufficient evidence of a durable session.
This patch does not install the reply extension. The specific reply was verified
separately through the operator's browser and replayed in an isolated database,
but automatic Linki polling remains blocked.

## Browser-page verification experiment

After PR #8 was installed locally with reply polling disabled, an operator-run,
Quentin-scoped query diagnostic restored the saved session into a new browser.
Navigation returned HTTP 200 but ended at LinkedIn login; `li_at` was present
before navigation and absent afterward. No message query was made. The diagnostic
blocked one non-GET request, so it does not isolate why the session was rejected.
The query and historical pagination remain unverified.

The next PR #10 iteration verifies the mailbox identity through a bounded
same-origin fetch inside the login page and the restored probe page, after the
probe navigates to the feed. It no longer uses the separate Playwright request
client for login verification. This addresses one untested difference between
the successful isolated page handoff and the failed ordinary app path; it is a
hypothesis, not a proven fix. Three login fixtures, related enrollment,
acceptance and metrics fixtures, TypeScript, scoped lint and production build
pass. A local-only image combining this iteration with PR #8 is installed on
localhost:3456 with reply polling disabled. It has not been tested with a fresh
real login; the prior PR #8-only container remains available for rollback. A
future live check must be performed by the operator, with password and app
approval handled by them.

The next operator attempts reached the feed after app approval, but Linki
returned its reusable-session error. The same saved session then redirected to
LinkedIn login before the Quentin message query ran. A fixed-stage log on the
next operator attempt showed failure on the original feed page, before a
snapshot or fresh-browser restore. The page path was the feed; the old log
does not distinguish a missing cookie, rejected identity request, malformed
response, or other check failure. The login path now logs a fixed reason code
as well as the stage, without account identifiers, URLs, response bodies,
cookies, or credentials. The browser still receives the same generic error.
A subsequent operator login is needed to observe the reason; the reply query
and pagination remain unverified.
