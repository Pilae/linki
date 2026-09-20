# Connection handling fixtures

Install the repository dependencies with `npm ci`, then install a Playwright
Chromium build (`npx playwright install chromium`) or set
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to a compatible system Chromium.

```sh
node tests/connect-navigation.cjs
node tests/visit-profile.cjs
node tests/linkedin-languages.cjs
node tests/localized-counts.cjs
node tests/login-signals.cjs
```

All suites replace navigation with synthetic HTML and abort network requests.
They never load account cookies or contact LinkedIn. Assertions cover profile
scoping, observed LinkedIn-language actions, pending invitation detection, send
confirmation,
unknown/conflicting degree badges, and profile-scoped messaging recipients.

Supported labels are shared through `lib/linkedin/labels.ts`. See
[LINKEDIN-I18N.md](LINKEDIN-I18N.md) for the language-extension procedure and
the audit of remaining language assumptions throughout the automation.

The overflow selectors and alternative menu roles reconcile the connection
portion of upstream PR https://github.com/moaljumaa/linki/pull/15 (reviewed at
`ec7dfd0ad4066c1ea5887b013e8eefc7427a1db2`). Unlike its broad fallback, actions
remain inside a uniquely identified profile card and a unique open menu.
The Run now, schedule/cap bypass, and progress UI changes are not included.

Icon-only action controls are covered by fixtures on supported `/in/` profile
cards. This does not establish end-to-end Sales Navigator support: `/sales/lead/`
URLs and unrecognized profile cards remain unsupported. Live label inspection is
documented in LINKEDIN-I18N.md; live-send
validation is not part of these tests. Ambiguous post-click outcomes require
manual verification before retrying to avoid duplicate invitations.
