# Preserve ordinary LinkedIn login sessions

The password/verification login path previously visited Sales Navigator before
saving cookies, even for accounts without a Sales Navigator subscription. An
authorized diagnostic on a regular account returned a successful identity check
before that visit and after restoring the pre-visit storage state. The same
identity request redirected immediately after the Sales Navigator visit. This
isolates that navigation as the trigger in this observed case; it does not
establish that every account is affected.

The login persistence function now verifies the ordinary authenticated identity
endpoint and saves the session without visiting Sales Navigator. Missing cookies,
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

The two new tests fail against the original deployed session source and pass
against the corrected implementation. They simulate cookie invalidation on a
Sales Navigator visit and ensure rejected sessions cannot be marked connected.
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

A subsequent operator login on the corrected local server saved a fresh session
and passed the new identity check, but a later independent restoration returned
302 followed by 401. Removing the Sales Navigator visit is therefore insufficient
to establish durable authentication. The initial diagnostic established a temporal
failure after that visit, not its exclusive causal role. A follow-up diagnostic
without Sales Navigator separates page settling, context closure, and browser
restart. The remaining cause is unconfirmed; live validation is not complete.
Full reply attribution remains blocked; this patch does not install the reply
extension.
