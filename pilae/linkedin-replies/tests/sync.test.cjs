const {test}=require('node:test'),assert=require('node:assert/strict'),Database=require('better-sqlite3');
const {loader}=require('./load.cjs');const load=loader();
const {synchronize}=load('pilae/linkedin-replies/sync.ts');
const {migrate,state,acquire,fenced,release}=load('pilae/linkedin-replies/store.ts');
const {SyncError}=load('pilae/linkedin-replies/contracts.ts');
const now=Date.parse('2026-09-21T10:00:00Z'),sent=now-120000;
function fixture(filename=':memory:'){
 const db=new Database(filename);db.exec(`CREATE TABLE IF NOT EXISTS targets(id TEXT,linkedin_url TEXT,linkedin_member_urn TEXT);
 CREATE TABLE IF NOT EXISTS runs(id TEXT,workflow_id TEXT,account_id TEXT,status TEXT);
 CREATE TABLE IF NOT EXISTS run_profiles(id TEXT,run_id TEXT,target_id TEXT,created_at TEXT);
 CREATE TABLE IF NOT EXISTS logs(run_id TEXT,target_id TEXT,level TEXT,message TEXT,created_at TEXT);
 CREATE TABLE IF NOT EXISTS run_profile_tracks(id TEXT,run_profile_id TEXT,state TEXT,error_message TEXT);`);
 if(!db.prepare('SELECT 1 FROM targets').get()) {
 db.prepare('INSERT INTO targets VALUES(?,?,?)').run('target','https://www.linkedin.com/in/alice','urn:li:member:123');
 for(const account of ['a','b']){
 db.prepare('INSERT INTO runs VALUES(?,?,?,?)').run('run-'+account,'workflow-'+account,account,'completed');
 db.prepare('INSERT INTO run_profiles VALUES(?,?,?,?)').run('rp-'+account,'run-'+account,'target',new Date(sent-1000).toISOString());
 db.prepare('INSERT INTO logs VALUES(?,?,?,?,?)').run('run-'+account,'target','info','Message sent',new Date(sent).toISOString());
 for(const status of ['pending','completed'])db.prepare('INSERT INTO run_profile_tracks VALUES(?,?,?,NULL)').run(status+account,'rp-'+account,status);
 }}migrate(db);
 const c={id:'conversation',participants:[{id:'self'},{id:'alice',profileUrl:'https://www.linkedin.com/in/alice/'}],group:false};
 const out={id:'out',sender:'self',at:sent,kind:'message',body:'Hello'};
 const inbound={id:'in',sender:'alice',at:sent+10000,kind:'message',body:'Synthetic reply'};
 const calls=[];
 const reader={identity:async()=> 'self',conversations:async cursor=>{calls.push(['list',cursor]);return {items:[c],next:null};},messages:async(id,cursor)=>{calls.push(['messages',cursor]);return {items:[inbound,out],next:null};}};
 return {db,c,out,inbound,reader,calls,events:()=>db.prepare('SELECT * FROM pilae_reply_events').all()};
}
test('completed campaigns are checked, duplicate delivery deduplicates, stop is account/run scoped',async()=>{
 const f=fixture();await synchronize(f.db,'a',f.reader,()=>now);await synchronize(f.db,'a',f.reader,()=>now+1000);
 assert.equal(f.events().length,1);assert.equal(state(f.db,'a').incomplete,0);assert.equal(state(f.db,'a').last_success,now+1000);
 assert.equal(f.db.prepare("SELECT state FROM run_profile_tracks WHERE id='pendinga'").get().state,'skipped');
 assert.equal(f.db.prepare("SELECT state FROM run_profile_tracks WHERE id='pendingb'").get().state,'pending');
 assert.equal(f.db.prepare("SELECT state FROM run_profile_tracks WHERE id='completeda'").get().state,'completed');
 assert.equal(JSON.parse(f.events()[0].payload).channel,'linkedin');f.db.close();
});
test('outbound, old inbound, system, groups, ambiguous and display-name-only identities do not produce replies',async()=>{
 for(const mode of ['outbound','old','system','group','ambiguous','name']){
 const f=fixture();if(mode==='group')f.c.group=true;
 if(mode==='ambiguous') {f.db.exec("INSERT INTO targets VALUES('duplicate','https://www.linkedin.com/in/alice',NULL);INSERT INTO run_profiles VALUES('dup','run-a','duplicate','2026-09-20')");}
 if(mode==='name')f.c.participants[1]={id:'alice',displayName:'Alice'};
 f.reader.messages=async()=>({items:mode==='outbound'?[f.out]:[f.out,{...f.inbound,...(mode==='old'?{at:sent-1}:{}),...(mode==='system'?{kind:'system'}:{})}],next:null});
 await synchronize(f.db,'a',f.reader,()=>now);assert.equal(f.events().length,0,mode);f.db.close();
 }
});
test('message and conversation pagination; later historical outbound page resolves pending inbound',async()=>{
 const f=fixture();f.reader.conversations=async cursor=>({items:cursor?[]:[f.c],next:cursor?null:'page2'});
 f.reader.messages=async(id,cursor)=>({items:cursor?[f.out]:[f.inbound],next:cursor?null:'older'});
 await synchronize(f.db,'a',f.reader,()=>now);assert.equal(f.events().length,1);assert.equal(state(f.db,'a').incomplete,0);f.db.close();
});
test('interrupted synchronization persists cursor across process/database restart',async()=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'reply-test-')),file=path.join(dir,'fixture.db');
 let f=fixture(file);f.reader.messages=async()=>({items:[f.inbound],next:'older'});
 await synchronize(f.db,'a',f.reader,()=>now,2);assert.equal(state(f.db,'a').error,'page_budget');assert.equal(f.events().length,0);f.db.close();
 f=fixture(file);f.reader.messages=async(id,cursor)=>{assert.equal(cursor,'older');return {items:[f.out],next:null};};
 await synchronize(f.db,'a',f.reader,()=>now+60000);assert.equal(f.events().length,1);assert.equal(state(f.db,'a').incomplete,0);f.db.close();fs.rmSync(dir,{recursive:true});
});
test('partial errors never advance failed cursor or overwrite last successful check',async()=>{
 const f=fixture();await synchronize(f.db,'a',f.reader,()=>now);
 f.reader.messages=async()=>{throw new SyncError('authentication');};await synchronize(f.db,'a',f.reader,()=>now+1000);
 const s=state(f.db,'a');assert.equal(s.last_success,now);assert.equal(s.last_attempt,now+1000);assert.equal(s.incomplete,1);assert.equal(s.auth_failures,1);assert.equal(s.error,'authentication');f.db.close();
});
test('overlapping manual/background checks share lease and immutable provider ownership',async()=>{
 const f=fixture();let unblock;f.reader.identity=()=>new Promise(r=>{unblock=r;});const first=synchronize(f.db,'a',f.reader,()=>now);
 const second=await synchronize(f.db,'a',f.reader,()=>now);assert.equal(second.busy,true);assert.equal(acquire(f.db,'a','premium',now+500000),null);
 unblock('self');await first;assert.equal(f.events().length,1);f.db.close();
});
test('expired worker cannot commit; session identity changes fail closed',async()=>{
 const f=fixture();const old=acquire(f.db,'a','pilae',now),fresh=acquire(f.db,'a','pilae',now+121000);
 assert.throws(()=>fenced(f.db,'a',old,now+121001,()=>assert.fail('stale writer')));release(f.db,'a',old);
 assert.equal(acquire(f.db,'a','pilae',now+121002),null);release(f.db,'a',fresh);
 await synchronize(f.db,'a',f.reader,()=>now+122000);f.reader.identity=async()=> 'other';await synchronize(f.db,'a',f.reader,()=>now+123000);
 assert.equal(state(f.db,'a').error,'identity_changed');f.db.close();
});
test('account and conversation deduplication keys do not collide',async()=>{
 const f=fixture();await synchronize(f.db,'a',f.reader,()=>now);await synchronize(f.db,'b',f.reader,()=>now);
 assert.equal(f.events().length,2);assert.notEqual(f.events()[0].id,f.events()[1].id);f.db.close();
});
test('repeated cursor remains incomplete',async()=>{
 const f=fixture();f.reader.messages=async()=>({items:[f.inbound],next:'loop'});
 await synchronize(f.db,'a',f.reader,()=>now);assert.equal(state(f.db,'a').error,'incomplete');assert.equal(state(f.db,'a').last_success,null);f.db.close();
});
test('campaign ambiguity is visible and never assigned to an arbitrary run',async()=>{
 const f=fixture();f.db.exec("INSERT INTO runs VALUES('another','another-workflow','a','completed');INSERT INTO run_profiles SELECT 'rp-another','another','target',created_at FROM run_profiles WHERE id='rp-a';INSERT INTO logs SELECT 'another',target_id,level,message,created_at FROM logs WHERE run_id='run-a'");
 await synchronize(f.db,'a',f.reader,()=>now);assert.equal(f.events().length,0);assert.equal(f.db.prepare("SELECT reason FROM pilae_reply_decisions WHERE message_id='in'").get().reason,'ambiguous_campaign');f.db.close();
});
test('failure during projection rolls back messages and cursor together and retries without loss',async()=>{
 const f=fixture(),prepare=f.db.prepare.bind(f.db);let fail=true;
 f.db.prepare=(sql)=>{if(fail&&sql.startsWith('INSERT OR IGNORE INTO pilae_reply_events')){fail=false;throw Error('Injected write failure');}return prepare(sql);};
 await synchronize(f.db,'a',f.reader,()=>now);assert.equal(f.db.prepare('SELECT count(*) AS n FROM pilae_reply_messages').get().n,0);assert.equal(state(f.db,'a').last_success,null);
 await synchronize(f.db,'a',f.reader,()=>now+60000);assert.equal(f.events().length,1);assert.equal(state(f.db,'a').incomplete,0);f.db.close();
});
test('recipient URN is pinned and cannot silently rebind a reused profile URL',async()=>{
 const f=fixture();await synchronize(f.db,'a',f.reader,()=>now);
 f.c.participants[1].id='replacement';f.reader.messages=async()=>({items:[f.out,{...f.inbound,id:'replacement-message',sender:'replacement'}],next:null});
 await synchronize(f.db,'a',f.reader,()=>now+60000);assert.equal(f.events().length,1);
 assert.equal(f.db.prepare('SELECT participant_id FROM pilae_reply_identities').get().participant_id,'alice');f.db.close();
});
test('sync snapshots retain messages and checkpoints; coverage gap survives an interrupted cycle',async()=>{
 const f=fixture();f.c.messages=[f.inbound];
 f.reader.conversations=async()=>({items:[f.c],next:null,coverage:'partial',syncToken:'snapshot'});
 await synchronize(f.db,'a',f.reader,()=>now,1);
 assert.equal(f.db.prepare('SELECT count(*) AS n FROM pilae_reply_messages').get().n,1);
 assert.equal(state(f.db,'a').cursor,null);assert.equal(state(f.db,'a').coverage_gap,1);
 assert.equal(f.db.prepare('SELECT sync_token FROM pilae_reply_checkpoints').get().sync_token,'snapshot');
 f.reader.messages=async()=>({items:[f.out],next:null});
 await synchronize(f.db,'a',f.reader,()=>now+60000);
 assert.equal(f.events().length,1);assert.equal(state(f.db,'a').last_success,null);assert.equal(state(f.db,'a').incomplete,1);
 assert.equal(state(f.db,'a').error,'incomplete');
 await synchronize(f.db,'a',f.reader,()=>now+120000);assert.equal(f.events().length,1);f.db.close();
});
test('internal profile URL resolution must match participant identity before attribution',async()=>{
 for(const mismatch of [false,true]) {
 const f=fixture();f.c.participants[1].profileUrl='https://www.linkedin.com/in/ACofixture';
 f.reader.resolveProfile=async url=>{assert.equal(url,f.c.participants[1].profileUrl);return {id:mismatch?'other':'alice',profileUrl:'https://www.linkedin.com/in/alice'};};
 await synchronize(f.db,'a',f.reader,()=>now);
 assert.equal(f.events().length,mismatch?0:1);if(mismatch)assert.equal(state(f.db,'a').error,'identity_changed');f.db.close();
 }
});
test('partial message pages preserve previous success and do not manufacture outbound evidence',async()=>{
 const f=fixture();f.reader.messages=async()=>({items:[f.inbound],next:null,coverage:'partial',syncToken:'messages-sync'});
 await synchronize(f.db,'a',f.reader,()=>now);
 assert.equal(f.events().length,0);assert.equal(state(f.db,'a').last_success,null);assert.equal(state(f.db,'a').incomplete,1);
 assert.equal(f.db.prepare('SELECT sync_token FROM pilae_reply_checkpoints').get().sync_token,'messages-sync');f.db.close();
});
test('schema upgrade preserves existing account state and is idempotent',()=>{
 const db=new Database(':memory:');db.exec(`CREATE TABLE pilae_reply_accounts (
 account_id TEXT PRIMARY KEY,provider TEXT NOT NULL,identity TEXT,last_attempt INTEGER,last_success INTEGER,
 next_check INTEGER NOT NULL DEFAULT 0,error TEXT,incomplete INTEGER NOT NULL DEFAULT 1,auth_failures INTEGER NOT NULL DEFAULT 0,
 cursor TEXT,listing_done INTEGER NOT NULL DEFAULT 0,lease TEXT,lease_until INTEGER NOT NULL DEFAULT 0);
 INSERT INTO pilae_reply_accounts(account_id,provider,last_success,cursor) VALUES('a','pilae',123,'resume');`);
 migrate(db);migrate(db);assert.equal(state(db,'a').last_success,123);assert.equal(state(db,'a').cursor,'resume');assert.equal(state(db,'a').coverage_gap,0);db.close();
});
