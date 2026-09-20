const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {loader}=require('./load-withdrawals.cjs');
test('real migrations, default settings, API validation and manual stop survive restart',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'withdrawal-api-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const old=process.env.LINKI_DB_PATH;process.env.LINKI_DB_PATH=path.join(dir,'synthetic.db');t.after(()=>{if(old===undefined)delete process.env.LINKI_DB_PATH;else process.env.LINKI_DB_PATH=old});
 const load=loader({'@/lib/update-check':{scheduleUpdateCheck(){}}});let db=load('lib/db').getDb();
 db.prepare('INSERT INTO workflows(id,name) VALUES(?,?)').run('w','Synthetic only');
 db.prepare('INSERT INTO accounts(id,name,email) VALUES(?,?,?)').run('a','Synthetic unauthenticated','synthetic@example.invalid');
 db.prepare('INSERT INTO runs(id,workflow_id,account_id) VALUES(?,?,?)').run('r','w','a');
 const api=load('pages/api/workflows/[id]/withdrawals').default;
 function call(handler,method,body={},id='w'){const res={code:200,status(n){this.code=n;return this},json(b){this.body=b;return this},end(){return this}};handler({method,body,query:{id}},res);return res}
 assert.equal(call(api,'GET').body.enabled,0);assert.equal(call(api,'PUT',{enabled:true,days:30}).code,400);
 assert.equal(call(api,'PUT',{enabled:true,days:30,existing:'include_verified'}).code,200);
 assert.equal(call(api,'GET').body.enabled,1);assert.equal(call(api,'GET',{},'missing').code,404);assert.equal(call(api,'POST').code,405);
 const runApi=load('pages/api/runs/[id]/index').default;
 assert.equal(call(runApi,'PATCH',{status:'bogus'},'r').code,400);assert.equal(call(runApi,'PATCH',{status:'completed'},'r').code,200);
 assert.ok(db.prepare("SELECT 1 FROM withdrawal_stopped_runs WHERE run_id='r'").get());
 db.close();db=loader({'@/lib/update-check':{scheduleUpdateCheck(){}}})('lib/db').getDb();t.after(()=>db.close());
 assert.equal(db.prepare("SELECT enabled FROM withdrawal_settings WHERE workflow_id='w'").get().enabled,1);
 assert.ok(db.prepare("SELECT 1 FROM withdrawal_stopped_runs WHERE run_id='r'").get());
});
