# LinkedIn automation language support

## Shared profile and invitation labels

[`lib/linkedin/labels.ts`](../lib/linkedin/labels.ts) is the registry for
English/French connection degrees, Connect/Invite, More, Pending, send-without-note
actions, and invitation-sent confirmations. Both `connect.ts` and `visit.ts` use
its matchers. It translates neither Linki's UI nor outbound messages.

Match supported labels together rather than selecting a dictionary from the
browser locale: the account's LinkedIn UI language can differ from that preference.
Keep profile, menu, and dialog scoping in the browser code. Prefer structural
signals such as the profile marker, custom-invite URL, and overflow data attribute.
Unknown or ambiguous evidence must stop an action, not imply connection or success.
Localized send actions now use accessible button names within the dialog instead
of English strings embedded in CSS selectors.

To add a language:

1. Capture its actual LinkedIn labels and accessible names. Do not assume a
   dictionary translation matches LinkedIn's wording.
2. Add a complete entry to `LINKEDIN_LABELS`. Preserve exact action names and
   intentionally limited status prefixes; escape regex punctuation.
3. Add offline fixtures for that language's profile badges, direct and overflow
   actions, pending/withdrawal names, send dialog, and post-send confirmation.
   Include ambiguity and unsupported-label cases.
4. Run both suites from [CONNECTION-HANDLING.md](CONNECTION-HANDLING.md).
   Synthetic fixtures establish matcher behavior, not live-account support.

Only English/French profile and invitation handling is covered here. The rest
of the automation still has the gaps below; this is not global French support.

## Audit of the open-core checkout

The audit examined all `lib/linkedin/` modules and searched the remaining tracked
TypeScript/JavaScript for browser automation. Source symbols below are navigation
anchors that survive line-number changes.

| Location | Language assumption and consequence | Required follow-up |
| --- | --- | --- |
| `connect.ts`: `sendConnectionRequest`, `pendingInvitation` | Degrees and action/status names were embedded English/French regexes and English attribute selectors. | Migrated to the registry in this PR; keep fixture coverage for each added language. |
| `visit.ts`: `visitProfile` | Localized degree badges determine connection state. Messaging recipients themselves use URNs. | Migrated to the same registry; missing/conflicting badges remain errors. |
| `session.ts`: `classifyLoginState` | Wrong-password/account errors are detected with English text. Other languages fall through to a generic login failure. | Add observed credential-error labels and login-state fixtures; retain URL, input, and checkpoint evidence. |
| `session.ts`: `awaitLoginApproval` | Remember-browser fallback searches for English `Yes` or German `Ja`, plus any submit button. French and other labels are absent. | Identify and scope the actual interstitial before adding observed confirmation labels; test that unrelated submit buttons are untouched. |
| `session.ts`: `classifyLoginState` CAPTCHA branch | `iframe[title*='captcha']` is a text-dependent fallback. Arkose URL and `#captcha-internal` are structural alternatives. | Prefer provider/element identity; fixture-test localized iframe titles before claiming coverage. |
| `session.ts`: `contextOptions`, `loginAccount` | Runtime/headless login and visible login pin `locale: 'en-US'`. This does not establish the account's UI language. | Keep fingerprint settings consistent. Do not change browser locale just to select labels; an account-locale setting would need a separate session migration. |
| `li-stats.ts`: `scrapeLinkedInStats` | English `connection`, `People (N)`, and `Profile viewers` determine displayed counts; missing labels silently become zero. | Add observed statistic labels or structured totals, and represent unreadable values as unknown rather than real zero. Test all three pages. |
| `li-stats.ts`: `parseNum`, pending-count regex | ASCII digits and digit stripping assume integer Western numerals; compact values such as `1.2K` are not valid input. | Define supported localized integer/compact formats and test them alongside grouping spaces, including nonbreaking spaces. |
| `sync-accepted.ts`: `syncAcceptedConnections` / `declaredTotal` | English `connections?` and `[\d.,]+` supply the completeness checksum. Localized labels or space-grouped numbers can prevent verification or produce a wrong count. | Share observed count labels and a validated number parser with stats. Preserve add-only behavior when the checksum is unknown; never enable cleanup using an unverified total. |
| `message.ts`: `resultNameMatches` | Name normalization strips everything outside `a-z`; non-Latin names become empty or lose meaningful distinctions. This is Unicode identity matching, not button translation. | Design and fixture-test conservative Unicode recipient verification, preferably using a profile ID. Do not loosen recipient matching with translations. |

`message.ts`'s compose input, recipient search field, and Send button use class
selectors rather than translated UI labels. Its live connection check inherits
the registry through `visitProfile`. `pending-invitations.ts` extracts `/in/`
URLs; `scraper.ts`, `enrich.ts`, and `profile-scrape.ts` primarily consume API
fields, URNs, URLs, and numeric timestamps. No translated action selectors were
found in those paths. Localized profile content is data, not selector evidence.
`resolve-account.ts` and the runner's scheduling logic do not require translated
LinkedIn labels. The runner's `No InMail credits left` comparison is a producer
error contract and must be checked with its producer.

The private premium implementation is absent from this checkout. Its InMail and
reply-detection paths, exposed through `lib/premium.ts`, remain unaudited. Review
them for action names, localized errors, timestamps, numbers, and recipient
matching before claiming complete language coverage.

Linki's own pages, notifications, API errors, and `lib/tour.ts` contain English
copy and lack a dedicated UI translation layer. Product UI translation is a
separate scope from recognizing LinkedIn's interface; it should not reuse this
automation registry.
