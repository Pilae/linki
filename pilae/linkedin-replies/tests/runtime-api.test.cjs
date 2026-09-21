const {test}=require('node:test'),assert=require('node:assert/strict'),Database=require('better-sqlite3');
const {loader}=require('./load.cjs');
function fixture(premium=null){
 const db=new Database(':memory:');db.exec("CREATE TABLE accounts(id TEXT,is_authenticated INTEGER);INSERT INTO accounts VALUES('account',1)");
 let contexts=0;
 const load=loader({'@/lib/db':{getDb:()=>db},'@/lib/linkedin/session':{getSessionPage:async()=>{contexts++;throw Error('No live page permitted');}},'@/lib/premium':{premium},'next-auth/jwt':{getToken:async()=>null}});
 return {db,load,contexts:()=>contexts};
}
test('premium provider preserves its interface and excludes Pilae; ownership blocks cross-provider handover',async()=>{
 let calls=0;const f=fixture({replies:{syncAccountInbox:async()=>{calls++;return 3;}}});
 const runtime=f.load('pilae/linkedin-replies/runtime.ts');assert.equal((await runtime.checkAccount('account')).reason,'premium_provider');assert.equal(f.contexts(),0);
 assert.equal(await runtime.syncPremium('account'),3);assert.equal(calls,1);
 const store=f.load('pilae/linkedin-replies/store.ts');assert.equal(store.acquire(f.db,'account','pilae',Date.now()+500000),null);f.db.close();
});
test('manual endpoint rejects missing auth and malformed input; GET never reads LinkedIn',async()=>{
 const f=fixture();const handler=f.load('pages/api/pilae/replies/index.ts').default;
 const old=process.env.INTERNAL_API_SECRET;process.env.INTERNAL_API_SECRET='synthetic-test-secret';
 const call=async req=>{const res={code:200,setHeader(){},status(n){this.code=n;return this;},json(x){this.body=x;return this;},end(){return this;}};await handler(req,res);return res;};
 try{
 assert.equal((await call({method:'POST',headers:{},query:{account:'account'}})).code,401);
 const headers={'x-internal-secret':'synthetic-test-secret'};
 assert.equal((await call({method:'POST',headers,query:{account:['account']}})).code,400);
 assert.equal((await call({method:'GET',headers,query:{account:'account',after:'-1'}})).code,400);
 const health=await call({method:'GET',headers,query:{account:'account'}});assert.equal(health.code,200);assert.equal(health.body.status,null);assert.deepEqual(health.body.events,[]);assert.equal(f.contexts(),0);
 const manual=await call({method:'POST',headers,query:{account:'account'}});assert.equal(manual.body.disabled,true);assert.equal(f.contexts(),0);
 }finally{if(old===undefined)delete process.env.INTERNAL_API_SECRET;else process.env.INTERNAL_API_SECRET=old;f.db.close();}
});
test('scheduler checks enabled accounts with no runs and records session failure without starting outreach',async()=>{
 const f=fixture(),old=process.env.PILAE_REPLY_ACCOUNT_IDS,oldConversations=process.env.PILAE_REPLY_CONVERSATIONS_QUERY,oldMessages=process.env.PILAE_REPLY_MESSAGES_QUERY;
 process.env.PILAE_REPLY_ACCOUNT_IDS='account';process.env.PILAE_REPLY_CONVERSATIONS_QUERY='messengerConversations.'+'a'.repeat(32);process.env.PILAE_REPLY_MESSAGES_QUERY='messengerMessages.'+'b'.repeat(32);
 const original=global.setInterval;global.setInterval=()=>({unref(){}});
 try{
 f.load('pilae/linkedin-replies/runtime.ts').startReplyScheduler();await new Promise(resolve=>setImmediate(resolve));
 const s=f.load('pilae/linkedin-replies/store.ts').state(f.db,'account');assert.equal(f.contexts(),1);assert.equal(s.incomplete,1);assert.equal(s.last_success,null);assert.equal(s.error,'transport');
 }finally{global.setInterval=original;if(old===undefined)delete process.env.PILAE_REPLY_ACCOUNT_IDS;else process.env.PILAE_REPLY_ACCOUNT_IDS=old;if(oldConversations===undefined)delete process.env.PILAE_REPLY_CONVERSATIONS_QUERY;else process.env.PILAE_REPLY_CONVERSATIONS_QUERY=oldConversations;if(oldMessages===undefined)delete process.env.PILAE_REPLY_MESSAGES_QUERY;else process.env.PILAE_REPLY_MESSAGES_QUERY=oldMessages;f.db.close();}
});

test('provider handover is disabled explicitly and premium lock refusal is not a successful zero check',async()=>{
 const f=fixture(),old=process.env.PILAE_REPLY_ACCOUNT_IDS;process.env.PILAE_REPLY_ACCOUNT_IDS='account';
 try {
  const store=f.load('pilae/linkedin-replies/store.ts');store.migrate(f.db);const token=store.acquire(f.db,'account','premium',Date.now());store.release(f.db,'account',token);
  assert.equal((await f.load('pilae/linkedin-replies/runtime.ts').checkAccount('account')).reason,'provider_handover_required');assert.equal(f.contexts(),0);
 } finally {if(old===undefined)delete process.env.PILAE_REPLY_ACCOUNT_IDS;else process.env.PILAE_REPLY_ACCOUNT_IDS=old;f.db.close();}
 const p=fixture({replies:{syncAccountInbox:async()=>assert.fail('wrong provider')}}),store=p.load('pilae/linkedin-replies/store.ts');store.migrate(p.db);store.acquire(p.db,'account','pilae',Date.now());
 await assert.rejects(p.load('pilae/linkedin-replies/runtime.ts').syncPremium('account'),/ownership/);p.db.close();
});
