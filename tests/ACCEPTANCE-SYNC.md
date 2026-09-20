# Acceptance synchronization

After `npm ci`, run `node tests/accepted-sync.cjs`.
The fixture uses real in-memory SQLite and a stubbed LinkedIn session. No account
cookies, network, invitations, or messages are used.

Coverage: exact canonical profile matching; account-scoped enrollment; an older
connection on a later page despite a newer stored boundary; absent profiles left
unchanged; historical connection date preservation; idempotent rechecks; and API
failure without a successful-sync timestamp.

The manual endpoint and scheduled runner share the same detector. Only positive
connections-list evidence updates a target. Positive results can remain if a
later page fails; incomplete scans do not advance accepted_sync_at. The existing
8-hour polling interval and runner scheduling conditions are unchanged. A stored
historical connection date is not proof that the current campaign caused it.
