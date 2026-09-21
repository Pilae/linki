# Preserve ordinary LinkedIn login sessions

The password/verification login path previously visited Sales Navigator before
saving cookies, even for accounts without a Sales Navigator subscription. An
authorized diagnostic on a regular account returned a successful identity check
before that visit and after restoring the pre-visit storage state. The same
identity request redirected immediately after the Sales Navigator visit. This
isolates that navigation as the trigger in this observed case; it does not
establish that every account is affected.

The login persistence function now waits briefly for feed bootstrap, verifies the
ordinary authenticated identity endpoint, snapshots the session, and checks the
same identity in a fresh browser process before saving its cookies. It does not
visit Sales Navigator. Missing cookies,
redirects, HTTP failures and malformed identity responses reject persistence.
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

The regression tests verify the feed wait, restored identity check and refusal
to save rejected or mismatched sessions. The earlier tests reproduced the
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
returned 302 followed by 401. Durable session restoration is therefore still
unresolved; the login UI's connected state is insufficient evidence. The exact
reason LinkedIn stops accepting the saved session has not been established.
This patch does not install the reply extension. The specific reply was verified
separately through the operator's browser and replayed in an isolated database,
but automatic Linki polling remains blocked.
