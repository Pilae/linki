# Campaign analytics

After `npm ci`, run `node tests/campaign-metrics.cjs`.
Tests use real in-memory SQLite and synthetic records, without network access.

Coverage includes unique recipient denominators, multiple campaign attribution,
historical/missing connection dates, replies predating sends, incomplete tracks,
idempotent event recovery, runner/log deduplication, visit activity, and legacy
InMail timestamps that also populate message_sent_at.

Totals are lifetime campaign totals; the date selector applies to charts. Current
connections and connections dated after invitations are separate measures.
Replies reflect recorded data, not proof that an inbox was recently checked.
Target-level reply snapshots are attributed only when the target has one campaign.
This deliberately understates ambiguous replies rather than guessing attribution.

The campaign_outcome_events table is created additively on first use. Success logs
are recovered idempotently; target snapshots are used only for a single campaign
and an outcome on or after enrollment. This cannot reconstruct unavailable history
or prove delivery. No acceptance-sync PR dependency is required.
