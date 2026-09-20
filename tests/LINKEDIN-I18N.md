# LinkedIn automation language support

## Shared profile and invitation labels

[`lib/linkedin/labels.ts`](../lib/linkedin/labels.ts) is the registry for
all 36 LinkedIn interface languages: connection degrees, Connect/Invite, More,
Pending, and send-without-note actions. Evidence is in the
[European](linkedin-european-labels.json) and
[other-language](linkedin-global-labels.json) fixtures. Invitation-sent toasts
remain verified only for English/French; other languages require the
profile-scoped pending state. Both `connect.ts` and `visit.ts` use these matchers. It translates neither Linki's UI nor outbound messages.

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
2. Add an observed entry to `LINKEDIN_LABELS`; leave unverified success toasts
   absent. Preserve exact action names and
   intentionally limited status prefixes; escape regex punctuation.
3. Add offline fixtures for that language's observed profile badges, direct
   and overflow actions, pending/withdrawal names, and send dialog. Test
   post-send confirmation by the pending state unless a success toast was
   separately observed. Include ambiguity and unsupported-label cases.
4. Run all suites from [CONNECTION-HANDLING.md](CONNECTION-HANDLING.md).
   Synthetic fixtures establish matcher behavior, not live-account support.

These labels cover profile and invitation handling. The rest of the automation
still has the gaps below; this is not full application language support.

### Live label evidence, 2026-09-18

The account-language dropdown, first-degree profile, suggested-profile actions
and degree badges, an existing pending invitation, and an unsent custom-invite
dialog were inspected in Chrome. The fixtures preserve literal visible labels
and accessible-name templates, replacing recipients with `{recipient}`. No
invitation or message was sent or withdrawn; the account language was restored
to French. Menu inspection also verified a `menuitem` with a recipient-specific
Invite name, visible Connect text, and a custom-invite URL.

The European locales are Czech, Danish, German, Greek, Spanish, Finnish,
Hungarian, Italian, Dutch, Norwegian, Polish, Brazilian Portuguese, Romanian,
Russian, Swedish, Turkish, and Ukrainian. LinkedIn offered `pt_BR`, not `pt_PT`. Only the
Danish third-degree badge was captured beyond first degree; no second-degree
translation was invented. Romanian pending wording is the observed “Între timp,”
even though it is an unusual translation. New locales confirm a send through
the profile-scoped pending state; their unobserved success toasts are omitted.

These are live label observations plus synthetic behavior tests, not live-send
validation. Existing profile-card layout constraints still apply.

### Remaining LinkedIn languages and count pages, 2026-09-20

The other 17 options in LinkedIn's selector were inspected on the same first-degree
profile, a suggested-person connection action, an existing pending invitation,
and an unsent invitation dialog: Arabic, Bengali, Persian, Hindi, Indonesian,
Hebrew, Japanese, Korean, Marathi, Malay, Punjabi, Telugu, Thai, Tagalog,
Vietnamese, simplified Chinese, and traditional Chinese. LinkedIn's option
values include legacy `in_ID` and `iw_IL`; the registry uses those exact values.
Some pages mix English and the selected language. No invitation or message was
sent. The account language was restored to French.

The connections header, sent-invitations `CONNECTION` tab, and profile-views
number were inspected in French; Arabic and Hindi count pages were also checked.
The count readers use observed component/URL structure and a strict integer
parser, returning `null` when missing or ambiguous. They do not claim that
LinkedIn never changes these layouts. A full accepted-connections pass may
unmark prior connections only when the pulled count matches a verified positive
header total. No live login error or security challenge was triggered to obtain
translated error messages; login handling now uses structural signals and
returns an unknown challenge rather than guessing or clicking a generic button.

## Audit of the open-core checkout

The audit examined all `lib/linkedin/` modules and searched the remaining tracked
TypeScript/JavaScript for browser automation. Source symbols below are navigation
anchors that survive line-number changes.

| Location | Language assumption and consequence | Required follow-up |
| --- | --- | --- |
| `connect.ts`: `sendConnectionRequest`, `pendingInvitation` | Degrees and action/status names were embedded English/French regexes and English attribute selectors. | Migrated to the registry in this PR; keep fixture coverage for each added language. |
| `visit.ts`: `visitProfile` | Localized degree badges determine connection state. Messaging recipients themselves use URNs. | Migrated to the same registry; missing/conflicting badges remain errors. |
| `session.ts`, `settings.tsx`: login classification | CAPTCHA identity and invalid login fields use structural signals; unrecognized challenges remain unknown and the form offers a generic login check rather than requesting an unobserved code. | Challenge screens and translated errors were not live-tested, so a login could still require manual intervention. |
| `session.ts`: `awaitLoginApproval` | Removed the broad Yes/Ja/submit fallback; unknown checkpoint controls are left untouched. | Reintroduce a click only after observing and testing a specific interstitial across languages. |
| `session.ts`: browser context | Login and runtime still pin `locale: 'en-US'` for a consistent fingerprint. | LinkedIn account language is independent of that browser preference. |
| `li-stats.ts`, `counts.ts` | Counts use a structural header, sent-tab URL, and unique numeric analytics paragraph; Unicode digits and grouping are validated. | Unknown metrics stay null and do not overwrite cached values. Recheck if LinkedIn changes the layout. |
| `sync-accepted.ts` | The full-pass checksum reads the same structural connections header. | Never clean up accepted status without a verified positive total and complete API pull. |
| `message.ts`: recipient fallback | Prefer an exact profile URL in a typeahead result; otherwise compare Unicode-normalized names at a full-name boundary. | URL-less same-name results remain a residual ambiguity; unrecognized names fail closed. |


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

[LinkedIn’s supported-language list](https://www.linkedin.com/help/linkedin/answer/a515744/langues-prises-en-charge?lang=fr) is the language inventory; profile observations came from the signed-in UI.
