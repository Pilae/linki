const {test} = require('node:test'), assert = require('node:assert/strict'), DB = require('better-sqlite3');
const {mkdtempSync,rmSync} = require('node:fs'), {tmpdir,hostname} = require('node:os'), {join} = require('node:path');
const load = require('./load-withdrawals.cjs').loader();
const store = load('lib/withdrawals/store'), {processWithdrawals} = load('lib/withdrawals/worker'), {withLinkedinExecution} = load('lib/withdrawals/lock');
const now = Date.parse('2026-09-21T12:00:00Z'), sent = now - 30 * store.DAY;
function fixture(t, file=':memory:') {
  const db = new DB(file); t.after(()=>{if(db.open)db.close()}); db.pragma('foreign_keys=ON');
  db.exec(`CREATE TABLE workflows(id TEXT PRIMARY KEY,is_archived INTEGER DEFAULT 0);
  CREATE TABLE accounts(id TEXT PRIMARY KEY); CREATE TABLE targets(id TEXT PRIMARY KEY,linkedin_url TEXT,connected_at TEXT,degree INTEGER);
  CREATE TABLE runs(id TEXT PRIMARY KEY,workflow_id TEXT,account_id TEXT,status TEXT);
  CREATE TABLE run_profiles(id TEXT PRIMARY KEY,run_id TEXT,target_id TEXT);
  CREATE TABLE run_profile_tracks(id TEXT PRIMARY KEY,run_profile_id TEXT,track TEXT,state TEXT,error_message TEXT,next_step_at TEXT);
  INSERT INTO workflows(id) VALUES('w'); INSERT INTO accounts VALUES('a');
  INSERT INTO targets VALUES('t','https://www.linkedin.com/in/synthetic',NULL,NULL);
  INSERT INTO runs VALUES('r','w','a','running'); INSERT INTO run_profiles VALUES('rp','r','t');
  INSERT INTO run_profile_tracks VALUES('li','rp','linkedin','in_progress',NULL,'later'),('em','rp','email','in_progress',NULL,'later');`);
  store.initWithdrawals(db);
  store.recordInvitation(db,{workflow_id:'w',run_id:'r',target_id:'t',account_id:'a',sender_urn:'sender',recipient_urn:'recipient',profile_url:'https://www.linkedin.com/in/synthetic',invitation_urn:'invite',sent_at:sent},now);
  store.configure(db,'w',{enabled:true,days:30,existing:'include_verified'},now);
  return db;
}
const invitation=db=>db.prepare('SELECT * FROM campaign_invitations').get();
const job=db=>db.prepare('SELECT * FROM invitation_withdrawals').get();
const track=(db,id)=>db.prepare('SELECT * FROM run_profile_tracks WHERE id=?').get(id);
function provider(db, states=['pending','absent'], hook) {
  let clicks=0,reads=0;
  return {get clicks(){return clicks},get reads(){return reads},inspect:async i=>{const state=states[Math.min(reads++,states.length-1)]; return {state,checked_at:now,sender_urn:i.sender_urn,invitation_urn:i.invitation_urn,recipient_urn:i.recipient_urn,sent_at:i.sent_at}},withdraw:async(i,authorize)=>{if(hook)await hook();if(!authorize())throw Error('Cancelled');clicks++}};
}
test('delay boundary and server validation including explicit retroactive choice',t=>{
 const db=fixture(t);const i=invitation(db);
 assert.equal(store.eligibility(db,i,now-1).allowed,false); assert.equal(store.eligibility(db,i,now).allowed,true);
 for(const days of [0,-1,366,1.5,'30',NaN,null])assert.throws(()=>store.configure(db,'w',{enabled:true,days},now));
 assert.throws(()=>store.configure(db,'w',{enabled:'true',days:30},now));
 store.configure(db,'w',{enabled:false,days:30},now);assert.equal(job(db).status,'cancelled');
 assert.throws(()=>store.configure(db,'w',{enabled:true,days:30},now),/Choose/);
 store.configure(db,'w',{enabled:true,days:30,existing:'future_only'},now);assert.equal(job(db).status,'cancelled');
 store.configure(db,'w',{enabled:false,days:30},now);store.configure(db,'w',{enabled:true,days:30,existing:'include_verified'},now);
 assert.equal(job(db).status,'queued');store.configure(db,'w',{enabled:true,days:31},now);assert.equal(job(db).due_at,sent+31*store.DAY);
});
test('confirmed pending withdrawal ends only LinkedIn track and emits one durable event',async t=>{
 const db=fixture(t),p=provider(db);await processWithdrawals(db,'a',p,()=>now);
 assert.equal(p.clicks,1);assert.equal(job(db).status,'withdrawn');assert.equal(track(db,'li').error_message,'Invitation withdrawn');assert.equal(track(db,'em').state,'in_progress');
 await processWithdrawals(db,'a',p,()=>now);assert.equal(p.clicks,1);assert.equal(db.prepare('SELECT count(*) n FROM invitation_withdrawal_events').get().n,1);
 assert.equal(db.prepare('SELECT count(*) n FROM run_profiles').get().n,1);
});
for(const state of ['accepted','absent','ambiguous'])test(`${state} is never a withdrawal success without an attempt`,async t=>{
 const db=fixture(t),p=provider(db,[state]);await processWithdrawals(db,'a',p,()=>now);
 assert.equal(p.clicks,0);assert.equal(job(db).status,state==='ambiguous'?'verification_required':state);
 assert.equal(db.prepare("SELECT count(*) n FROM invitation_withdrawal_events WHERE kind='invitation_withdrawn'").get().n,0);
});
for(const field of ['sender_urn','invitation_urn','recipient_urn','sent_at','checked_at'])test(`reject mismatched or stale ${field}`,async t=>{
 const db=fixture(t),p=provider(db);const inspect=p.inspect;p.inspect=async i=>({...await inspect(i),[field]:field==='checked_at'?now-31000:field==='sent_at'?sent-1:'wrong'});
 await processWithdrawals(db,'a',p,()=>now);assert.equal(p.clicks,0);assert.equal(job(db).status,'verification_required');
});
for(const change of ["UPDATE targets SET degree=1","UPDATE targets SET connected_at='2026-09-20'","UPDATE runs SET account_id='other'","UPDATE runs SET workflow_id='other'","UPDATE targets SET linkedin_url='https://www.linkedin.com/in/other'","INSERT INTO runs VALUES('r2','w','other','completed'); INSERT INTO run_profiles VALUES('rp2','r2','t')"])
 test(`ownership/acceptance rejects ${change}`,async t=>{const db=fixture(t),p=provider(db);db.exec(change);await processWithdrawals(db,'a',p,()=>now);assert.equal(p.clicks,0)});
for(const [change,clicks] of [["UPDATE runs SET status='completed'",1],["UPDATE runs SET status='paused'",0],["UPDATE runs SET status='failed'",0],["INSERT INTO withdrawal_stopped_runs VALUES('r')",0],["UPDATE workflows SET is_archived=1",0],["DELETE FROM runs",0],["DELETE FROM workflows",0],["DELETE FROM run_profiles",0]])
 test(`lifecycle: ${change}`,async t=>{const db=fixture(t),p=provider(db);db.exec(change);await processWithdrawals(db,'a',p,()=>now);assert.equal(p.clicks,clicks)});
test('disable or acceptance racing after precheck prevents click',async t=>{
 for(const change of [db=>store.configure(db,'w',{enabled:false,days:30},now),db=>db.exec('UPDATE targets SET degree=1'),db=>db.exec("UPDATE runs SET status='paused'")]){
 const db=fixture(t),p=provider(db,['pending','absent'],()=>change(db));await processWithdrawals(db,'a',p,()=>now);assert.equal(p.clicks,0);
 }
});
test('deduplication and ambiguous ownership cannot overwrite original owner',t=>{
 const db=fixture(t),i=invitation(db);store.recordInvitation(db,i,now);assert.equal(db.prepare('SELECT count(*) n FROM campaign_invitations').get().n,1);
 store.recordInvitation(db,{...i,run_id:'other'},now);assert.equal(invitation(db).state,'ownership_ambiguous');assert.equal(job(db).status,'cancelled');
});
test('unconfirmed outcomes verify before retry, bounded clicks/checks',async t=>{
 const db=fixture(t);let time=now;const p=provider(db,['pending']);p.inspect=async i=>({state:'pending',checked_at:time,sender_urn:i.sender_urn,invitation_urn:i.invitation_urn,recipient_urn:i.recipient_urn,sent_at:i.sent_at});
 for(let n=0;n<10;n++){await processWithdrawals(db,'a',p,()=>time);time+=25*3600_000}
 assert.equal(p.clicks,3);assert.equal(job(db).checks,6);assert.equal(job(db).status,'verification_required');assert.equal(track(db,'li').state,'skipped');assert.equal(track(db,'em').state,'in_progress');
});
test('restart after external effect reconciles without second click, even disabled',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'linki-withdrawals-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,'synthetic.db');
 let db=fixture(t,path);db.exec("UPDATE invitation_withdrawals SET status='checking',action_started=1,attempts=1");db.close();db=new DB(path);t.after(()=>db.close());
 store.initWithdrawals(db);store.configure(db,'w',{enabled:false,days:30},now);
 const p=provider(db,['absent']);await processWithdrawals(db,'a',p,()=>now);assert.equal(p.clicks,0);assert.equal(job(db).status,'withdrawn');
});
test('two DB handles serialize acceptance/outreach/withdrawal and recover dead owner',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'linki-lock-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const db=fixture(t,join(dir,'db'));const db2=new DB(join(dir,'db'));t.after(()=>db2.close());
 let release;const held=withLinkedinExecution(db,'a',()=>new Promise(r=>release=r));
 const p=provider(db2);assert.equal(await processWithdrawals(db2,'a',p,()=>now),undefined);assert.equal(await withLinkedinExecution(db2,'b',async()=>123),undefined);assert.equal(p.reads,0);release();await held;
 db.prepare('INSERT INTO linkedin_execution_locks VALUES(?,?,?,?)').run('linkedin-global','dead',hostname(),2147483647);
 await processWithdrawals(db2,'a',p,()=>now);assert.equal(p.clicks,1);
});
test('unknown host lock is never stolen on timeout',async t=>{const db=fixture(t);db.prepare('INSERT INTO linkedin_execution_locks VALUES(?,?,?,?)').run('linkedin-global','unknown','foreign-host',99999);assert.equal(await withLinkedinExecution(db,'a',async()=>true),undefined)});
test('provider failure before/after external click remains verification required',async t=>{
 for(const after of [false,true]){const db=fixture(t),p=provider(db);p.withdraw=async(i,authorize)=>{if(after)assert.equal(authorize(),true);throw Error('Synthetic lost response')};await processWithdrawals(db,'a',p,()=>now);assert.equal(job(db).status,'verification_required');assert.equal(job(db).action_started,after?1:0)}
});
test('paused jobs cannot starve another completed campaign in the account queue',async t=>{
 const db=fixture(t);db.exec("UPDATE runs SET status='paused'");
 for(let n=2;n<=6;n++){
  db.prepare('INSERT INTO workflows(id) VALUES(?)').run('w'+n);
  db.prepare('INSERT INTO runs VALUES(?,?,?,?)').run('r'+n,'w'+n,'a',n===6?'completed':'paused');
  db.prepare('INSERT INTO targets VALUES(?,?,NULL,NULL)').run('t'+n,'https://www.linkedin.com/in/synthetic'+n);
  db.prepare('INSERT INTO run_profiles VALUES(?,?,?)').run('rp'+n,'r'+n,'t'+n);
  store.recordInvitation(db,{...invitation(db),workflow_id:'w'+n,run_id:'r'+n,target_id:'t'+n,profile_url:'https://www.linkedin.com/in/synthetic'+n,recipient_urn:'recipient'+n,invitation_urn:'invite'+n},now);
  store.configure(db,'w'+n,{enabled:true,days:30,existing:'include_verified'},now);
 }
 const p=provider(db);await processWithdrawals(db,'a',p,()=>now);assert.equal(p.clicks,1);
 assert.equal(db.prepare("SELECT count(*) n FROM invitation_withdrawals WHERE status='suspended'").get().n,5);
 db.exec("UPDATE runs SET status='running' WHERE id='r'");store.reconcile(db,now);assert.equal(job(db).status,'queued');
});
test('last-pass crash stays visible as verification required, never reattempted',async t=>{
 const db=fixture(t),p=provider(db);db.exec("UPDATE invitation_withdrawals SET status='checking',checks=6,attempts=3,action_started=1");
 await processWithdrawals(db,'a',p,()=>now);assert.equal(job(db).status,'verification_required');assert.equal(p.clicks,0);assert.equal(p.reads,0);
});
test('disable cancels even uncertain jobs without an action and preserves their retry budget',async t=>{
 const db=fixture(t),p=provider(db,['ambiguous']);await processWithdrawals(db,'a',p,()=>now);
 store.configure(db,'w',{enabled:false,days:30},now);assert.equal(job(db).status,'cancelled');assert.equal(job(db).checks,1);
});
test('actual unenroll API cancels queued withdrawal, including terminal tracks and retry reset',async t=>{
 for(const terminal of [false,true]){
 const db=fixture(t);if(terminal)db.exec("UPDATE run_profile_tracks SET state='completed'");
 const api=require('./load-withdrawals.cjs').loader({'@/lib/db':{getDb:()=>db}})('pages/api/runs/[id]/unenroll').default;
 const res={status(n){this.code=n;return this},json(x){this.body=x;return this}};
 api({method:'POST',query:{id:'r'},body:{target_id:'t'}},res);assert.equal(res.body.ok,true);assert.equal(job(db).status,'cancelled');
 db.exec("UPDATE run_profile_tracks SET state='in_progress',error_message=NULL");
 const p=provider(db);await processWithdrawals(db,'a',p,()=>now);assert.equal(p.clicks,0);assert.equal(p.reads,0);
 }
});
test('legacy manual unenrollment is also a veto',async t=>{const db=fixture(t);db.exec("UPDATE run_profile_tracks SET state='skipped',error_message='Manually unenrolled'");const p=provider(db);await processWithdrawals(db,'a',p,()=>now);assert.equal(p.clicks,0)});
test('disable committed before settings transaction requires a fresh explicit choice',t=>{
 const db=fixture(t),tx=db.transaction.bind(db);let injected=false;
 db.transaction=fn=>{const wrapped=tx(fn);return {...wrapped,immediate(...args){if(!injected){injected=true;db.prepare('UPDATE withdrawal_settings SET enabled=0').run()}return wrapped.immediate(...args)}}};
 assert.throws(()=>store.configure(db,'w',{enabled:true,days:30},now),/Choose/);
 assert.equal(store.settings(db,'w').enabled,0);
});
test('unresponsive read times out and releases the account lock without a click',async t=>{
 const db=fixture(t);let closed=0;
 const {readJson}=load('lib/withdrawals/linkedin');
 const page={url:()=> 'https://www.linkedin.com/mynetwork/',locator:()=>({count:async()=>0}),evaluate:()=>new Promise(()=>{}),close:async()=>{closed++}};
 const p={inspect:async()=>readJson(page,'/voyager/api/me',20),withdraw:async()=>assert.fail('must never click')};
 await processWithdrawals(db,'a',p,()=>now);assert.equal(closed,1);assert.equal(job(db).status,'verification_required');
 assert.equal(await withLinkedinExecution(db,'other',async()=>42),42);
});
