# Validation record — 2026-09-21

No real LinkedIn conversation was accessed. No message/invitation was sent, campaign launched, account connected, existing sandbox restarted or production deployment performed.

## Implemented

Namespaced reader, durable account/conversation/message storage, pinned recipient identities, paginated synchronization, fenced leases and persistent provider ownership, independent scheduler, safe health/diagnostics, versioned reply events, campaign attribution and stop-on-reply hooks, authenticated manual API and `/pilae/linkedin-replies` status page. Shared upstream files changed: three. Premium implementation is absent; its public interface is preserved and its runner call is wrapped for ownership exclusion.

## Verified with synthetic evidence

- 18 reply fixtures pass (reader, synchronization, API/runtime boundary): duplicate delivery, conversation/message pages, older outbound evidence arriving later, disk/database restart, partial error, atomic rollback, overlapping checks, stale leases, premium exclusion, mailbox identity change, pinned recipient identity, ambiguous recipients/campaigns, group/system/outbound/old messages, completed campaigns and account isolation.
- Contribution guard fixture passes: clean generic change accepted; Pilae paths and shared integration changes without markers rejected.
- Existing enrollment (11 tests), acceptance-sync and campaign-metrics fixtures pass. Existing Chromium fixtures pass: connection navigation, 34-language labels, localized counts, login signals and profile handling. Network disabled for those browser fixtures.
- Linki TypeScript check, scoped ESLint and production build pass. Build retains existing warnings about inferred workspace root and missing optional `@/ee`. Initial sandboxed build/browser attempts could not launch worker processes; reruns with process permission passed.
- Disposable built-server smoke test passes: unauthenticated request rejected, server credential accepted, synthetic signed-in UI renders never-checked status, manual button reports disabled provider, and no browser page errors. Only a fresh fixture DB and a disconnected synthetic account were used. The initial UI test used an overly exact label selector; the corrected combobox locator passes.
- Twenty companion: 34 adapter tests and 8 unit tests pass; TypeScript passes. The reply ingestion covers page checkpoints, duplicate delivery, deferred exact mappings, account mismatch rejection and partial feed failure. Status tests preserve manual decisions and email activity.
- Company-brain document validator: 0 errors, 22 existing warnings; unrelated human edits left intact. Companion patch reverse-application check passes against the edited integration snapshot.

## Not verified

The experimental LinkedIn GraphQL reader has not been run against a real account. Current query IDs are deliberately not configured. Real participant/message envelopes, CSRF compatibility, pagination completeness, session restrictions, account-scale timing and stop-on-reply behavior during actual outreach remain unverified. Unsupported scopes and conservative attribution misses are described in the architecture guide. Premium internals are neither available nor tested.

The existing running Linki/Twenty/adapter services continue using their previous loaded code. The Linki draft PR versions only the fork changes. The Twenty companion exists in the ignored integration folder and in its reproducible `patches/linkedin-replies.patch`, SHA-256 `77853a32ac6abb23da0e612a165f0c3b14870eceddaeffa30dc2148e75b3630e`. It is not a separate Git repository or included as implementation code in Linki's PR.
