const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),Module=require('node:module'),ts=require('typescript');
const {execFileSync}=require('node:child_process'),{pathToFileURL}=require('node:url');
test('Twenty patched extraction and reducer preserve cross-channel statuses and acceptance',async t=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'withdrawal-twenty-'));t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
 fs.cpSync(path.join(__dirname,'../integrations/twenty/fixtures'),temp,{recursive:true});
 // Test the exact companion patch, not a parallel implementation.
 const patch=fs.readFileSync(path.join(__dirname,'../integrations/twenty/withdrawals.patch'),'utf8');
 const portions=patch.split(/(?=^--- a\/)/m).filter(p=>!p.startsWith('--- a/adapter/core.mjs'));
 execFileSync('git',['apply','--unsafe-paths','-'],{cwd:temp,input:portions.join('')});
 const {extractEvents}=await import(pathToFileURL(path.join(temp,'adapter/events.mjs')).href);
 const m=new Module(path.join(temp,'rules.cjs'));m._compile(ts.transpileModule(fs.readFileSync(path.join(temp,'src/shared/outreach-rules.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,path.join(temp,'rules.cjs'));
 const kinds=['invitation_withdrawn','invitation_absent','invitation_withdrawal_verification_required'];
 const input={withdrawal_events:kinds.map((kind,n)=>({id:'event-'+n,invitation_id:'invitation',workflow_id:'campaign',target_id:'target',account_id:'account',kind,occurred_at:1789980000000+n,body:kind}))};
 const events=extractEvents('person','target',input);assert.equal(events.length,3);assert.deepEqual(extractEvents('person','target',input),events);
 assert.deepEqual(extractEvents('person','foreign-target',input),[]);assert.ok(events.every(e=>e.channel==='linkedin'&&e.body.includes('account: account')));
 for(const status of ['REPLIED','MEETING_BOOKED','DO_NOT_CONTACT','NOT_INTERESTED','FIRST_OUTREACH_SENT','TO_CONTACT']){
  const person={outreachAutomationEnabled:true,outreachStatus:status,linkedinConnectionState:'INVITATION_SENT',outreachChannelState:{email:{lastOutboundAt:'2026-09-20T10:00:00Z',custom:'preserve'}}};
  const result=m.exports.reduceOutreach(person,events);assert.equal(result.outreachStatus,status);assert.equal(result.linkedinConnectionState,'INVITATION_SENT');assert.equal(result.outreachLastOutboundAt,null);assert.equal(result.outreachLastInboundAt,null);assert.equal(result.outreachLastContactAt,null);assert.deepEqual(result.outreachChannelState.email,person.outreachChannelState.email);assert.equal(Object.keys(result.outreachChannelState.linkedin.withdrawalEvents).length,3);
 }
 const connected={outreachAutomationEnabled:false,outreachStatus:'CUSTOM',linkedinConnectionState:'CONNECTED'};
 assert.equal(m.exports.reduceOutreach(connected,events).linkedinConnectionState,'CONNECTED');assert.equal(m.exports.reduceOutreach(connected,events).outreachStatus,'CUSTOM');
});
