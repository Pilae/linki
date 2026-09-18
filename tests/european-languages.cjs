// Offline behavior fixtures from observed LinkedIn UI labels, never account data.
const assert = require('node:assert/strict');
const {loadLinkedIn} = require('./load-linkedin.cjs');
const {sendConnectionRequest} = loadLinkedIn('connect');
const {visitProfile} = loadLinkedIn('visit');
const {LINKEDIN_LABELS, linkedinLabel} = loadLinkedIn('labels');
const fixtures = require('./linkedin-european-labels.json');
const {chromium} = require('playwright');
const url = 'https://www.linkedin.com/in/synthetic-fixture';
const escape = s => s.replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;');
const card = action => `<main><section><h1>Synthetic Person</h1>${action}</section><aside><button onclick="window.wrong++">Connect</button></aside></main>`;
(async()=>{
 const browser = await chromium.launch({headless:true, executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||undefined,args:['--no-sandbox']});
 let passed=0;
 try {
  for (const f of fixtures) {
   assert.equal(LINKEDIN_LABELS[f.locale].invitationSent, undefined);
   for(const [key,value] of Object.entries({connect:f.connect,invite:f.invite.replace('{recipient}','Synthetic'),more:f.more,pending:f.expandedPending.replace('{recipient}','Synthetic'),sendWithoutNote:f.sendWithoutNote})) {
    assert(linkedinLabel(key).test(value),`${f.locale}: ${key}`);
    if(key !== 'invite') assert(!LINKEDIN_LABELS[f.locale][key].test('Unverified '+value),`${f.locale}: anchored ${key}`);
   }
   const page=await browser.newPage();
   await page.route('**/*',r=>r.abort());
   page.waitForTimeout=async()=>{};
   let html=''; page.goto=async()=>page.setContent(html);
   const invite=escape(f.invite.replace('{recipient}','Synthetic'));
   const pending=escape(f.expandedPending.replace('{recipient}','Synthetic'));
   // The dialog has both the observed send control and a decoy action.
   const script=`<script>window.sent=0;window.wrong=0;function dialog(){document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(`<div role="dialog"><button onclick="send()">${escape(f.sendWithoutNote)}</button><button onclick="window.wrong++">Add note</button></div>`)});}function send(){window.sent++;document.querySelector('[role=dialog]').remove();document.querySelector('h1').insertAdjacentHTML('afterend', ${JSON.stringify(`<a href="#" aria-label="${pending}">${escape(f.pending)}</a>`)});}function menu(){document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(`<div role="menu"><a role="menuitem" aria-label="${invite}" href="/preload/custom-invite/?vanityName=synthetic-fixture" onclick="event.preventDefault();dialog()">${escape(f.connect)}</a></div>`)});}</script>`;
   const menuScript = `<script>function inviteMenu(){document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(`<div role="menu"><button role="menuitem" aria-label="${invite}" onclick="dialog()">${escape(f.connect)}</button></div>`)});}</script>`;
   for(const action of [
    `<button onclick="dialog()">${escape(f.connect)}</button>`,
    `<button aria-label="${invite}" onclick="dialog()">${escape(f.connect)}</button>`,
    `<button onclick="menu()">${escape(f.more)}</button>`,
    `<button onclick="inviteMenu()">${escape(f.more)}</button>`,
   ]) {
    html=card(action)+script+menuScript;
    await sendConnectionRequest(page,url);
    assert.equal(await page.evaluate(()=>window.sent),1);
    assert.equal(await page.evaluate(()=>window.wrong),0);
    passed++;
   }
   html=card(`<a href="#" aria-label="${pending}" onclick="window.wrong++">${escape(f.pending)}</a>`)+script;
   await assert.rejects(sendConnectionRequest(page,url),/already pending/);
   assert.equal(await page.evaluate(()=>window.sent+window.wrong),0); passed++;
   html=card(`<span>· ${escape(f.firstDegree)}</span><button onclick="window.wrong++">${escape(f.connect)}</button>`)+script;
   await assert.rejects(sendConnectionRequest(page,url),/Already connected/);
   assert.equal(await page.evaluate(()=>window.sent+window.wrong),0); passed++;
   assert.deepEqual(await visitProfile(page,url),{isFirstDegree:true,messagingUrn:null}); passed++;
   for(const degree of f.otherDegrees) {
    html=card(`<span>·${escape(degree)}</span>`)+script;
    assert.deepEqual(await visitProfile(page,url),{isFirstDegree:false,messagingUrn:null}); passed++;
   }
   await page.close();
  }
  console.log(JSON.stringify({passed,locales:fixtures.length,network:'disabled',realAccountUsed:false}));
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
