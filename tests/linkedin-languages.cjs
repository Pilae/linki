// Offline behavior fixtures transcribed from LinkedIn, with recipient names replaced.
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {loadLinkedIn} = require('./load-linkedin.cjs');
const {sendConnectionRequest} = loadLinkedIn('connect');
const {visitProfile} = loadLinkedIn('visit');
const {LINKEDIN_LABELS, linkedinLabel} = loadLinkedIn('labels');
const fixtures = [
  ...require('./linkedin-european-labels.json'),
  ...require('./linkedin-global-labels.json'),
];
const url = 'https://www.linkedin.com/in/synthetic-fixture';
const escape = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');

(async () => {
  const browser = await chromium.launch({headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    args: ['--no-sandbox']});
  let passed = 0;
  try {
    assert.equal(fixtures.length, Object.keys(LINKEDIN_LABELS).length - 2);
    for (const fixture of fixtures) {
      const f = fixture;
      assert.equal(LINKEDIN_LABELS[f.locale].invitationSent, undefined);
      const invite = f.invite.replace('{recipient}', 'Synthetic');
      const pending = f.expandedPending.replace('{recipient}', 'Synthetic');
      for (const [key, value] of Object.entries({
        firstDegree: f.firstDegree, connect: f.connect, invite, more: f.more,
        pending, sendWithoutNote: f.sendWithoutNote,
      })) {
        assert(linkedinLabel(key).test(value), `${f.locale}: ${key}: ${value}`);
        if (key !== 'invite' && key !== 'pending') {
          assert(!LINKEDIN_LABELS[f.locale][key].test(`Unverified ${value}`), `${f.locale}: anchored ${key}`);
        }
        passed++;
      }
      for (const degree of f.otherDegrees) {
        assert(linkedinLabel('otherDegree').test(degree), `${f.locale}: ${degree}`);
        passed++;
      }

      const page = await browser.newPage();
      await page.route('**/*', route => route.abort());
      page.waitForTimeout = async () => {};
      let html = '';
      page.goto = async () => page.setContent(html);
      const inviteName = escape(invite);
      const pendingName = escape(pending);
      const script = `<script>
        window.sent = 0; window.wrong = 0;
        function dialog() { document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(
          `<div role="dialog"><button onclick="send()">${escape(f.sendWithoutNote)}</button><button onclick="window.wrong++">Add note</button></div>`
        )}); }
        function send() { window.sent++; document.querySelector('[role=dialog]').remove();
          document.querySelector('h1').insertAdjacentHTML('afterend', ${JSON.stringify(
            `<a href="#" aria-label="${pendingName}">${pendingName}</a>`
          )}); }
        function menu() { document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(
          `<div role="menu"><a role="menuitem" href="/preload/custom-invite/?vanityName=synthetic-fixture" aria-label="${inviteName}" onclick="event.preventDefault();dialog()">${escape(f.connect)}</a></div>`
        )}); }
        function buttonMenu() { document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(
          `<div role="menu"><button role="menuitem" aria-label="${inviteName}" onclick="dialog()">${escape(f.connect)}</button></div>`
        )}); }
      </script>`;
      const card = action => `<main><section><h1>Synthetic Person</h1>${action}</section></main><aside><button onclick="window.wrong++">Connect</button></aside>${script}`;

      for (const action of [
        `<button onclick="dialog()">${escape(f.connect)}</button>`,
        `<button aria-label="${inviteName}" onclick="dialog()">${escape(f.connect)}</button>`,
        `<button onclick="menu()">${escape(f.more)}</button>`,
        `<button onclick="buttonMenu()">${escape(f.more)}</button>`,
      ]) {
        html = card(action);
        try { await sendConnectionRequest(page, url); }
        catch (error) { throw new Error(`${f.locale}: ${action}: ${error.message}`); }
        assert.equal(await page.evaluate(() => window.sent), 1);
        assert.equal(await page.evaluate(() => window.wrong), 0);
        passed++;
      }
      html = card(`<a href="#" aria-label="${pendingName}" onclick="window.wrong++">${pendingName}</a>`);
      await assert.rejects(sendConnectionRequest(page, url), /already pending/);
      assert.equal(await page.evaluate(() => window.sent + window.wrong), 0);
      passed++;

      html = card(`<span>${escape(f.firstDegree)}</span><button onclick="window.wrong++">${escape(f.connect)}</button>`);
      await assert.rejects(sendConnectionRequest(page, url), /Already connected/);
      assert.equal(await page.evaluate(() => window.sent + window.wrong), 0);
      assert.deepEqual(await visitProfile(page, url), {isFirstDegree: true, messagingUrn: null});
      passed += 2;
      for (const degree of f.otherDegrees) {
        html = card(`<span>${escape(degree)}</span>`);
        assert.deepEqual(await visitProfile(page, url), {isFirstDegree: false, messagingUrn: null});
        passed++;
      }
      await page.close();
    }
    console.log(JSON.stringify({passed, locales: fixtures.length, network: 'disabled', realAccountUsed: false}));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
