// Offline fixtures copied from the LinkedIn UI, with personal names replaced.
const assert=require('node:assert/strict');
const {loadLinkedIn}=require('./load-linkedin.cjs');
const {sendConnectionRequest}=loadLinkedIn('connect');
const {visitProfile}=loadLinkedIn('visit');
const {LINKEDIN_LABELS,linkedinLabel}=loadLinkedIn('labels');
const {chromium}=require('playwright');
const fixtures=require('./linkedin-global-labels.json');
const esc=s=>s.replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;');
const url='https://www.linkedin.com/in/synthetic-fixture';
(async()=>{let passed=0;const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||undefined,args:['--no-sandbox']});try{
 for(const f of fixtures){
  assert.equal(LINKEDIN_LABELS[f.locale].invitationSent,undefined);
  for(const [key,value] of Object.entries({firstDegree:f.firstDegree,invite:f.invite.replace('{recipient}','Synthetic'),more:f.more,pending:f.expandedPending.replace('{recipient}','Synthetic'),sendWithoutNote:f.sendWithoutNote})){
   assert(linkedinLabel(key).test(value),`${f.locale}: ${key} ${value}`);passed++;
  }
  for(const degree of f.otherDegrees){assert(linkedinLabel('otherDegree').test(degree),`${f.locale}: ${degree}`);passed++;}
  const page=await browser.newPage();await page.route('**/*',r=>r.abort());page.waitForTimeout=async()=>{};
  let html='';page.goto=async()=>page.setContent(html);
  const invite=esc(f.invite.replace('{recipient}','Synthetic'));
  const pending=esc(f.expandedPending.replace('{recipient}','Synthetic'));
  const script=`<script>window.sent=0;window.wrong=0;function dialog(){document.body.insertAdjacentHTML('beforeend',${JSON.stringify(`<div role="dialog"><button onclick="send()">${esc(f.sendWithoutNote)}</button><button onclick="window.wrong++">Unverified add note</button></div>`)});}function send(){window.sent++;document.querySelector('[role=dialog]').remove();document.querySelector('h1').insertAdjacentHTML('afterend',${JSON.stringify(`<a href="#" aria-label="${pending}">${esc(f.expandedPending.split(',')[0])}</a>`)});}function menu(){document.body.insertAdjacentHTML('beforeend',${JSON.stringify(`<div role="menu"><a role="menuitem" href="/preload/custom-invite/?vanityName=synthetic-fixture" aria-label="${invite}" onclick="event.preventDefault();dialog()">${esc(f.connect)}</a></div>`)});}</script>`;
  const card=action=>`<main><section><h1>Synthetic Person</h1>${action}</section></main><aside><button onclick="window.wrong++">${esc(f.connect)}</button></aside>${script}`;
  for(const action of [`<button aria-label="${invite}" onclick="dialog()">${esc(f.connect)}</button>`,`<button onclick="menu()">${esc(f.more)}</button>`]){
   html=card(action);try{await sendConnectionRequest(page,url)}catch(error){throw new Error(`${f.locale}: ${action}: ${error.message}`)}assert.equal(await page.evaluate(()=>window.sent),1);assert.equal(await page.evaluate(()=>window.wrong),0);passed++;
  }
  html=card(`<a href="#" aria-label="${pending}">${esc(f.expandedPending.split(',')[0])}</a>`);await assert.rejects(sendConnectionRequest(page,url),/already pending/);passed++;
  html=card(`<span>${esc(f.firstDegree)}</span><button onclick="window.wrong++">${esc(f.connect)}</button>`);await assert.rejects(sendConnectionRequest(page,url),/Already connected/);passed++;
  assert.deepEqual(await visitProfile(page,url),{isFirstDegree:true,messagingUrn:null});passed++;
  for(const degree of f.otherDegrees){html=card(`<span>${esc(degree)}</span>`);assert.deepEqual(await visitProfile(page,url),{isFirstDegree:false,messagingUrn:null});passed++;}
  await page.close();
 }
 console.log(JSON.stringify({passed,locales:fixtures.length,network:'disabled',realAccountUsed:false}));
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
