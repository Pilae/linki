# Pilae LinkedIn reply detection (draft)

This is an independent Pilae extension, disabled by default. It stores replies and campaign evidence without sending messages, creating runs, or restarting outreach. It is fixture-tested, not validated against a real LinkedIn inbox. Do not enable accounts until the operator explicitly approves reading their conversations.

## Architecture investigation

Inspected on 2026-09-21:

- `lib/premium.ts` declares `RepliesSurface.shouldSyncInbox`, `syncAccountInbox`, and `classifyAndDispatch`. It optionally requires `@/ee` and returns null if unavailable. No premium reader, GraphQL implementation, cursor algorithm, classifier or dispatch implementation is present in this checkout or the inspected local container. The referenced `docs/OPEN_CORE.md` is also absent. There is no basis to claim those internals work here.
- `lib/linkedin/runner.ts` originally called premium inbox sync only for authenticated accounts with running campaigns, after an early return when there were no active runs. It stopped all unfinished tracks when either target-level reply timestamp existed.
- `lib/db.ts` contains `targets.last_replied_at`, `targets.messaging_urn`, `accounts.inbox_synced_at`, and the email reply store. Its historical comment describes name-based messaging identity discovery; this extension deliberately does not trust that field. No public LinkedIn message/cursor store was found.
- `pages/api/inbox/index.ts` reports target timestamps and email reply rows. `thread.ts` fetches IMAP email. Neither is an independently working LinkedIn conversation reader. Pilae events use a separate authenticated route and do not stamp the global target timestamp.
- `lib/linkedin/session.ts` provides encrypted stored sessions and `getSessionContext(accountId)`, explicitly supporting `ctx.request`. This is the reader's server-side transport. Existing browser fingerprints, storage and account isolation are retained. No alternate cookie store, account connection flow, license bypass, or premium source is introduced.
- The runtime at localhost:3456 was `pilae-linki:arm64-enrollment`, with only its data directory bind-mounted; it was not rebuilt or restarted. Existing Twenty and adapter containers were not deployed or restarted.

The public [messaging endpoint reference](https://github.com/vicnaum/linkedin-toolkit/blob/main/references/endpoints.md) informed the experimental GraphQL envelope and cursor design. No implementation was copied. It is third-party evidence, not verification of our account. Query hashes, participant shapes, CSRF behavior and message pagination still require an authorized capture. Missing or changed shapes fail as incomplete instead of reporting an empty inbox. Linki's existing Sustainable Use License remains in force; this work grants no additional hosting rights.

## Boundaries

| Module | Responsibility |
| --- | --- |
| `contracts.ts` | Reader pages, normalized identities/messages, safe errors, versioned events |
| `reader.ts` | Read-only server-side session requests and strict response parsing |
| `store.ts` | Namespaced SQLite schema, persistent ownership, expiring leases and fenced writes |
| `sync.ts` | Account synchronization, durable page checkpoints and recovery |
| `campaigns.ts` | Exact matching, outbound evidence, events, and run-scoped stop-on-reply |
| `runtime.ts` | Disabled-by-default account selection, scheduling and premium compatibility |
| `pages/api/pilae/replies/index.ts` | Authenticated stored event/health reads and manual Check replies |

Only three existing shared files have hooks: `instrumentation.ts`, `lib/linkedin/runner.ts`, and `lib/campaign-metrics.ts`. `lib/premium.ts` is unchanged. The integration repository owns Twenty projection. Merge conflicts should be smaller with this boundary, but cannot be eliminated.

### Identity and attribution

Each account's first successfully read mailbox identity is pinned. A different identity requires operator investigation and blocks further automatic polling. Conversation and message keys include account IDs. Participants must resolve to exact profile URNs and, for URL matching, an explicit profile link. Display names and legacy `messaging_urn` never participate. Group conversations and conversations without exactly two distinct participants including the mailbox owner are excluded and counted.

A recipient must match exactly one target enrolled under that account, through an exact stored member URN or exact canonical profile URL. The first exact match pins the participant URN to the account/target in `pilae_reply_identities`; subsequent checks use that binding and cannot silently rebind a reused profile URL. Profile URLs can change: unresolved identities remain unassigned; there is no fuzzy fallback. Inbound messages require a different participant sender and a normal message type. System events and outbound messages cannot create reply events.

Attribution additionally requires a successful Message/InMail log after enrollment, before the inbound message, and an outbound message in that same conversation within 60 seconds of the success log. More than one eligible run is ambiguous and creates no campaign event. This conservative evidence rule can miss legitimate replies when logs/identities are missing, clocks drift, or multiple campaigns contacted the same person. Diagnostics expose these decisions; they are not silently counted as zero replies.

Verified replies emit one immutable event per account/conversation/message, insert a `linkedin_reply` campaign outcome, and skip unfinished tracks of the attributed run. Completed/failed/skipped tracks and run status are preserved. The runner hook checks the run-scoped event before executing a step, preserving the existing cross-channel stop policy. Already executing sends cannot be canceled; this PR makes no zero-race guarantee and never sends anything itself. Legacy premium/email timestamp behavior is unchanged.

### Persistence, recovery and health

Migrations create only `pilae_reply_*` tables and the existing campaign outcome table if absent. Conversation listing and message pagination have independent durable cursors. Each received page, its message IDs, attribution and next cursor commit in one SQLite immediate transaction. A failed page is retried from its previous checkpoint. After restart, pending conversations finish before listing continues. Older outbound evidence arriving on a later message page re-evaluates stored inbound messages.

A fresh completed cycle restarts listing from the first page; deduplication makes overlapping scans safe and catches new activity on subsequent cycles. No timestamp-only high-water mark drops same-time messages. Each check processes at most 20 pages, continuing unfinished work after one minute. Normal checks are every 15 minutes, independent of campaign status. Reads have 20-second timeouts, no redirects and no immediate retries. Transport/rate failures wait 15 minutes. Authentication/identity failures stop automatic retries until manual review; manual checks are limited to once per minute.

Health exposes last attempt, last fully completed supported-inbox scan, next eligible check, authentication failures, an incomplete flag, and safe error codes. A next-check time is eligibility, not a guarantee; authentication/identity errors suspend scheduling. A null health row means never checked. Unsupported conversations and per-message attribution reasons are separate diagnostics. `last_success` means reading the supported INBOX scope completed, not that every inbox message could be attributed or that archived/request/spam conversations were checked. Message pages whose completeness metadata is unknown fail closed.

Current scope is INBOX one-to-one text messages. Groups, archived/spam/request-only conversations, unknown attachment/event shapes, and Sales Navigator-specific inboxes are not claimed as supported. Full rescans can be expensive for large inboxes; approval should start with a small account and inspect pagination before broad use. A read can be incomplete even when some events were safely committed. Read errors do not erase the previous successful-check timestamp.

Leases expire after two minutes and writes check a fencing token. A stale worker cannot commit. Persistent account provider ownership is distinct from the expiring lease. Premium is preferred when present, and the wrapped premium runner uses the same ownership/lease table. Pilae polling is disabled whenever a premium reply provider is loaded. An existing owner is never automatically switched, even after a lease expires. This prevents one provider from taking over while another has an uncertain in-flight request.

Provider handover is an operator workflow: stop all Linki processes for the database, verify no workers remain, back up the database, change the account's `provider` (`pilae` or `premium`) and clear its lease, then restart with only the intended provider. Retain historical events. Opaque premium implementation behavior cannot be fenced internally; no claim is made about unknown premium workers outside this public runner hook. All deployed writers must use this boundary; mixed old/new deployments are unsupported.

### API and Twenty

Open `/pilae/linkedin-replies` in Linki for per-account status, attribution diagnostics, stored event pagination and the **Check replies** button. The page uses existing Linki sign-in and never receives service credentials.

`GET /api/pilae/replies?account=ACCOUNT_ID&after=0` returns `{version:1,status,diagnostics,events,next,hasMore}`. Read 100-event pages until `hasMore` is false. Store the cursor with consumed events, not before them. IDs are stable SHA-256 identifiers, not CRM record UUIDs. Events carry account, conversation, message, target, workflow and run identifiers plus channel, kind, timestamp and body. Bodies are personal data; protect the database and backups. No cookie or session material is returned.

`POST /api/pilae/replies?account=ACCOUNT_ID` is the manual **Check replies** operation, using exactly the same synchronizer as the scheduler. Both operations require Linki authentication. Browser POSTs also require same-origin JSON; server callers use `x-internal-secret`. Account input and pagination are validated. Disabled accounts return an explicit disabled reason. There is no public enqueue endpoint or unauthenticated health bypass. The existing application auth model grants signed-in users account-wide access; this is not new tenant/RBAC isolation.

Companion changes are in `../pilae-linki-app/adapter/linkedin-replies/`. Its ingestion reads stored events only, checkpoints pages transactionally, retains unmapped events, maps exact Linki target IDs to Twenty People, and reuses the existing channel-aware reducer/timeline projection. It neither polls LinkedIn nor copies provider logic. Manual overrides, protected statuses, disabled automation and email state remain authoritative. Local tests cover those rules. The running adapter has not been restarted with these changes.

## Reproduce safely

Node 22 or 24, locked dependencies and writable temporary storage are required:

```sh
cd /Users/theguywithouth/Documents/pilae/local/repos/linki
npm ci
node --test pilae/linkedin-replies/tests/*.test.cjs pilae/contributions/*.test.cjs
npx tsc --noEmit --incremental false
npx eslint 'pilae/linkedin-replies/*.ts' pages/api/pilae/replies/index.ts
```

After a production build, `node pilae/linkedin-replies/tests/runtime-smoke.cjs` starts a disposable instance at port 3491 and verifies authentication and the disabled Check replies UI. It creates one synthetic disconnected account and never loads existing data.

Fixtures use in-memory or temporary SQLite databases, synthetic identities, fake session responses, and no LinkedIn access. Existing browser fixtures abort all network requests; on macOS they need permission to launch Chromium.

For a fresh empty local server, use another port and database. Do not run the integration's general startup script against existing services just to test this PR:

```sh
cd /Users/theguywithouth/Documents/pilae/local/repos/linki
REPLY_TEST_DIR=$(mktemp -d)
export LINKI_DB_PATH="$REPLY_TEST_DIR/linki.db"
export PILAE_REPLY_ACCOUNT_IDS=''
export NEXTAUTH_URL='http://localhost:3491'
export NEXT_TELEMETRY_DISABLED=1
npm run dev -- --hostname 127.0.0.1 --port 3491
```

Use the normal application sign-in flow on this empty instance for authenticated manual API testing. Do not copy the existing database, cookies or connected accounts. A test API call with no authentication must return 401. Stop with Ctrl-C; remove only the disposable directory when finished.

For companion fixtures (no SDK apply, Docker restart or CRM writes):

```sh
cd /Users/theguywithouth/Documents/pilae/local/repos/pilae-linki-app
node --test adapter/core.test.mjs adapter/account-auth.test.mjs adapter/linkedin-replies/ingest.test.mjs
./node_modules/.bin/vitest run --config vitest.unit.config.ts
./node_modules/.bin/tsgo --noEmit -p tsconfig.spec.json
```

## Remaining real-account validation

Enabling `PILAE_REPLY_ACCOUNT_IDS` authorizes the server to read those accounts as soon as it starts. Leave it empty until explicit approval. `PILAE_REPLY_CONVERSATIONS_QUERY` and `PILAE_REPLY_MESSAGES_QUERY` must contain current query IDs of the form `messengerConversations.<32 hex>` and `messengerMessages.<32 hex>`. No guessed/default query hashes are shipped. An approved session capture must confirm the query variables, identity references, normal/system messages and terminal/continuation cursors before configuration. Missing configuration records an incomplete check.

After approval, validate one bounded account: identity, empty/outbound-only inbox, old versus new inbound, pagination through older outbound evidence, archived/group exclusions, expired session, manual check and restart recovery. Credential entry and challenges remain with the operator. Do not send messages or invitations or launch campaigns as a test. Fixture success does not verify real LinkedIn protocol compatibility or premium internals. Automated access can trigger LinkedIn restrictions; pacing and self-hosting do not remove that risk.

See [contribution rules](../contributions/README.md) for keeping this Pilae-only.
