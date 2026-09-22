# Automatic invitation withdrawal (Pilae draft)

Campaigns expose **Withdraw unanswered invitations**, disabled by default, with an
integer delay of 1–365 days. `PUT /api/workflows/:id/withdrawals` validates
`{ enabled, days, existing }`; GET returns the setting and recent queue outcomes.
The UI is on the campaign detail page. Settings belong to the workflow and cover
its runs; eligibility and actions belong to the particular sending account.

## Timing and lifecycle

Eligibility begins at the verified provider send timestamp plus N × 24 hours
(UTC elapsed time, not calendar dates). Execution occurs during a later successful
runner check within the account's configured active hours and working days; it is not guaranteed at the threshold. The runner checks maintenance
before its “no running campaigns” exit, including after natural completion.

Every transition from disabled to enabled requires an explicit choice:

- `future_only`: only invitations sent at or after this enablement qualify.
- `include_verified`: also consider existing **verified campaign invitation records**.
  Legacy contact timestamps, logs and a Pending button cannot establish ownership.
  There is no legacy backfill or automatic adoption of manually sent invitations.

Changing the delay recalculates queued eligibility from the original send time.
Shortening it can make an already-included invitation immediately eligible.
Disabling cancels work not yet started. Re-enabling requires the choice again.
The previous setting is read inside the write transaction, so a concurrent disable
cannot be undone by a stale delay save without a new explicit inclusion choice.
A disabled setting never authorizes another withdrawal, including a retry.

| Campaign state | Behavior |
| --- | --- |
| Running | Process eligible invitations |
| Naturally completed | Continue processing |
| Paused or not started | Suspend; resume recalculates eligibility |
| Explicitly stopped or failed | Cancel; the run's durable stop marker remains even if restarted |
| Archived | Cancel while archived; unarchiving reevaluates the existing policy |
| Manually unenrolled prospect | Cancel; durable run/target opt-out survives track retries, including completed tracks |
| Deleted run/workflow or removed enrollment | Cancel; keep invitation/queue/event audit records |

Linki's existing Stop operation is `PATCH /api/runs/:id` with `status: completed`.
That API now writes a separate stop marker; the runner's natural completion does
not. Thus stop and completion are distinguishable without changing the legacy
run-status CHECK constraint. Manual Unenroll writes a separate durable run/target
marker because the existing API retains the enrollment row. Legacy tracks marked
“Manually unenrolled” also veto withdrawals. Retrying tracks in the same run does
not clear this opt-out; there is no automatic re-enrollment into withdrawal.

Disabling, stopping or deletion cannot undo an external action already started.
Such jobs remain available for **read-only verification**, even after deletion;
no new attempt is permitted unless all eligibility checks pass. Pausing after an
action started likewise permits verification only. The synchronous authorization
transaction immediately before the confirmation click defines “started.”

## Evidence and LinkedIn interaction

The send path compares complete, authenticated sent-invitation snapshots before
and after a successful send. It records an invitation only when a unique new
provider invitation identifies the sender, recipient and provider send timestamp
within that operation's time window. An unchanged/preexisting invitation is not
adopted. Failed or unsupported evidence collection does not label the invitation
withdrawal-capable; the send path logs that limitation.

The records hold workflow, run, target, local account, sender URN, recipient URN,
invitation URN, exact target URL and verified timestamp. Conflicting attribution
marks ownership ambiguous. Other runs for the same target/URL and other recorded
invitations to the recipient prevent automatic withdrawal, even if an old run is
complete. This intentionally sacrifices coverage to avoid cross-campaign or
cross-account mistakes. Existing contact-level acceptance evidence is an additional
veto; absence of acceptance is never permission.

This fork had no existing withdrawal function or premium withdrawal surface.
The implementation reuses its authenticated Playwright session, profile-card
resolver and localized connection-degree labels. It does not import missing `ee/`
code, alter licensing or solve/bypass authentication challenges.

`lib/withdrawals/linkedin.ts` supports one **synthetic-fixture-tested** normalized
sent-invitation response schema and exact-identity DOM row contract. It performs
read-only authenticated Voyager requests in the existing browser context, then
uses the normal row Withdraw button and confirmation dialog. These internal
response and DOM contracts are not official supported LinkedIn APIs and **have
not passed real-account validation**. The authorized read-only probe below confirmed
that the current response and DOM fail closed.
No name-only, sidebar, profile Pending, or Remove connection fallback exists.
Unsupported languages/actions, missing identity attributes, pagination truncation,
list changes, authentication walls and ambiguous profile cards stop the action.

A fresh complete list and positive profile evidence distinguish:

- **Accepted**: first-degree evidence vetoes withdrawal, even with a stale pending row.
- **Pending**: exact sender, invitation, recipient and timestamp match.
- **Absent**: complete list excludes both that invitation and another invitation to
  the recipient; the exact profile also has a positive non-first-degree badge.
- **Ambiguous**: insufficient or conflicting evidence; verification required.

The provider verifies identity again in the confirmation dialog and the worker
rechecks current database eligibility immediately before the irreversible click.
Success requires a subsequent reliable “no longer pending” observation. A vanished
row, missing button, click response, timeout or missing acceptance timestamp alone
is insufficient. Absence before any attempt is recorded as “Invitation no longer
pending — cause unknown”, never as successful withdrawal. An acceptance racing
with an attempt is recorded as accepted, not withdrawn. The provider never invokes
connection removal.

## Queue, recovery and outcomes

SQLite maintains a unique job per account/invitation record. Each account batch
processes at most five jobs, with at most three attempted confirmations and six
verification passes per job, using exponential delays of 1–24 hours. Exhausted
jobs remain visibly `verification_required`; changing the delay or re-enabling
cannot reset their retry budget. No unattended “reset retry” endpoint is provided.
A later successful check must precede any repeat attempt.

Acceptance sync (manual and scheduled), outreach step execution and withdrawal
share durable database locks. An account key scopes ownership; a global key also
serializes accounts because existing Linki acceptance fields are contact-wide.
This is intentionally more restrictive than independent account parallelism.
Locks have no expiry: a stalled process cannot wake after lease takeover and act.
A same-host PID proven dead can be recovered; live/PID-reused/foreign-host locks
fail closed. A stranded live-process lock requires stopping that process first.
Read-only provider requests have a 15-second browser abort and host deadline;
snapshots share a 30-second total budget. Timeout closes the evidence page, rejects
late responses and releases the execution lock through the worker cleanup path.
An unresponsive optional pre-send snapshot can therefore fail that outreach step
when its page closes, but cannot indefinitely block every account.
Do not share this SQLite database between hosts or mix old and new worker builds.

A crash after authorization leaves `action_started` durable. Restart changes
`checking` to verification-required, verifies first, and either reconciles the
observed result or makes a bounded attempt only while the policy still allows it.
Queue/settings and terminal outcome/event/track updates use SQLite transactions.
Audit evidence survives campaign deletion.

Confirmed withdrawal gives the LinkedIn track the explicit outcome **Invitation
withdrawn**. Uncertain action outcomes stop that track with **Invitation withdrawal
needs verification**. Neither outcome removes list membership, increments a
message step, clears send timestamps, resends, nor stops the email track. The
runner checks the durable guard after acquiring its lock, including after a manual
retry reset. Automatic resending remains prohibited indefinitely; this feature
is not a reinvitation scheduler.

## Twenty integration

`GET /api/targets/:id` exposes durable `withdrawal_events`, each with account and
campaign attribution. `integrations/twenty/withdrawals.patch` adds these events to
the existing adapter snapshot/extractor and reducer. The companion patch is kept
here because `pilae-linki-app` is local material inside the company-brain checkout,
not a separately versioned repository. It has not been applied to the running app.
It changes only three existing files and preserves the concurrent reply feature.

Events have deterministic adapter IDs. Withdrawal, absence and verification-required
are LinkedIn history, not outbound messages, replies or acceptance. They do not
change sales status, last-contact timestamps, email channel state, or the shared
connection state (which may describe another account or a later acceptance).
The reducer keeps account/campaign detail in each event's body and history entry.

## Reproduce without accounts

Use Node 24 and a separate checkout of the PR. Do not mount an existing database,
`.env`, authenticated browser profile, or session files. The tests create temporary
SQLite databases, use synthetic identities, and intercept every fixture browser
request; they never access a real invitation or start the outreach runner.

```sh
npm ci
npx playwright install chromium
node --test tests/withdrawals.test.cjs tests/withdrawal-api.test.cjs tests/withdrawal-browser.test.cjs tests/withdrawal-twenty.test.cjs
node --test tests/enrollment.test.cjs
node tests/accepted-sync.cjs
node tests/campaign-metrics.cjs
npx tsc --noEmit
npx eslint lib/withdrawals components/WithdrawalSettings.tsx 'pages/api/workflows/[id]/withdrawals.ts'
LINKI_DB_PATH="$(mktemp -d)/synthetic.db" NEXTAUTH_SECRET=synthetic-build-only npm run build
```

On macOS the Chromium fixture requires a host process allowed to launch Chromium;
it still uses a disposable browser context with no user profile. Container runs
can use `--network none` with preinstalled packages/browser binaries. The existing
navigation and language regression suites are described in `tests/`.

For the Twenty companion patch, work in an **isolated copy** of the integration.
First use `git apply --check /absolute/path/to/linki/integrations/twenty/withdrawals.patch`,
then apply there. `baseline-sha256.json` records the inspected source files; if the
baseline changed, review the small diff rather than overwrite concurrent work.
Run its existing `npm test` (or `yarn test`) after application. The Linki-side Twenty
fixture applies the exact extraction/reducer patch to synthetic baseline files and
checks idempotence, accepted connections and cross-channel status preservation.
Do not run its sandbox deployment or authentication scripts for this verification.

## LinkedIn restrictions (official sources checked 2026-09-21)

LinkedIn permits withdrawal before acceptance through the Sent invitations UI and
a confirmation dialog. Withdrawn invitations cannot be restored; reinviting that
member may be unavailable for **up to three weeks**. The recipient is not notified,
and reminder emails stop. LinkedIn also states that bulk withdrawal is unavailable.
See [Withdraw an invitation](https://www.linkedin.com/help/linkedin/answer/a568295/withdraw-an-invitation?lang=en).

Withdrawing pending invitations does **not** lift an invitation restriction. See
[Invitation limit reached](https://www.linkedin.com/help/linkedin/answer/a550555).
Do not treat this feature as a limit workaround or assume immediate reinvitation.

## Remaining real-account validation

This is a Pilae-only draft, not a production release. After the synthetic checks,
one specifically authorized invitation was withdrawn through the existing signed-in
LinkedIn UI. The target-specific success notification and refreshed non-first-degree
profile confirmed that manual result. No account was connected, outreach sent,
campaign policy enabled, or service deployed.

That invitation had no campaign-owned ledger record. This was a manual UI test,
not a queue/provider end-to-end test; no ownership or timestamp was fabricated.
The observed French UI uses a named withdrawal link and a target-specific dialog
button, differing from the synthetic provider contract. The subsequent read-only probe below confirmed automatic incompatibility with
the observed account; the implementation must continue to fail closed. Before enabling
on a real account, verify the normalized schema, sender identity, timestamp units,
pagination and exact invitation-row attributes using read-only observations with
the owner's authorization. Unsupported contracts must remain blocked until
captured, reviewed and covered by sanitized fixtures. A live withdrawal requires
explicit user approval naming that specific invitation and sending account.
Acceptance-versus-withdrawal races and post-action consistency have only been
exercised synthetically; no claim of live LinkedIn compatibility is made.

## Delivery validation

The 43-test withdrawal suite covers policy boundaries and invalid payloads, exact/accepted/
absent/ambiguous states, ownership conflicts, lifecycle changes, queue deduplication,
SQLite lock contention, restart recovery, partial failures and bounded verification.
Regression cases cover actual manual unenrollment (including completed tracks and
retry resets), a disable racing with a settings save, and a stalled browser read
releasing the global/account lock without a click. It also tests the real schema/API handlers, the intercepted browser confirmation
flow, and the exact Twenty extraction/reducer patch. Paused jobs are suspended
outside the runnable batch so they cannot starve completed campaigns.

Existing enrollment, acceptance, campaign metrics, connection navigation, profile,
localized counts and login fixtures were rerun. The companion patch passed the
current integration's unit and adapter suites in an isolated copy (8 unit and 34
adapter tests). TypeScript, focused ESLint and a production build pass. The build
retains the pre-existing optional `ee/` resolution warning and the nested-workspace
root warning; no premium code was installed to silence them.

## Read-only provider validation — 2026-09-22

**Result: incompatible with the observed account; do not enable automatic withdrawal.**
The probe exercised `readJson` and `readSnapshot` from commit `0c7f637` using the
existing Linki sandbox session. SQLite was opened read-only, no campaigns were
running, and the probe blocked all non-GET/HEAD/OPTIONS browser requests. No worker,
send, withdrawal, confirmation, login or session-save function was called. A
separate read-only DOM inspection in the owner's Chrome session corroborated the
row mismatch. No production code or configuration was deployed.

| Check | Observation |
| --- | --- |
| Account identity | `/voyager/api/me` returned 200; `data["*miniProfile"]` resolved to the expected account in `included` |
| Actual provider snapshot | Rejected with `Unrecognized sent-invitations response` |
| Collection references | Live `data["*elements"]`; parser expects `data.elements` |
| Invitation entity | Live type `com.linkedin.voyager.relationships.invitation.Invitation`; parser expects `com.linkedin.voyager.relationships.Invitation` |
| Identity references | Live `*fromMember`, `*toMember`, nested `invitee.*miniProfile`; distinct `fs_relInvitation` entity and `mailboxItemId` invitation URNs |
| Send timestamp | Sampled `sentTime` values were positive integer, plausible epoch milliseconds; send-operation provenance was not tested |
| Pagination | Offsets 0, 100, 200 returned 100, 58, 0 references; `paging` had count/start/links but no total |
| Exact row identity | Loaded rows exposed neither `data-invitation-id` nor `data-urn` |
| Withdrawal action | French UI exposed a named link, not the provider's exact-name button |

The observed page counts are a bounded diagnostic, not proof of snapshot
consistency under concurrent changes. The probe did not establish the complete
sender/recipient/identity invariant for every invitation. `inspect` cannot classify
pending, accepted or absent invitations until snapshot parsing succeeds. No
campaign ownership was inferred from these existing invitations.

Synthetic reconstructions now test rejection of the observed response (including
an empty later page) and zero clicks on the observed row layout. They intentionally
do not make this layout actionable. Before dry-run scheduling, support needs a
reviewed mapping for the live identity references, a completeness/consistency rule
without `paging.total`, and a proven binding from invitation identity to its UI
row. Merely accepting `*elements`, using a name or adopting relative UI dates would
not satisfy those requirements.
