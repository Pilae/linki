const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),Module=require('node:module'),ts=require('typescript');
function fixture({originalStatus=200,restoredStatus=200,restoredIdentity='urn:li:fs_miniProfile:fixture',missingCookie=false,transport=false}={}){
 const writes=[],calls=[],closures=[];let settled=false;
 const cookies=[{name:'JSESSIONID',value:'"ajax:fixture"'},...missingCookie?[]:[{name:'li_at',value:'fixture-secret'}]];
 const db={prepare:()=>({run:(...args)=>writes.push(args)})};
 const response=(status,identity)=>({status:()=>status,body:async()=>Buffer.from(JSON.stringify({data:{'*miniProfile':identity}})),dispose:async()=>{closures.push('response')}});
 const restored={cookies:async()=>cookies,storageState:async()=>({cookies,origins:[]}),request:{get:async()=>{calls.push('restored');return response(restoredStatus,restoredIdentity)}},close:async()=>{closures.push('context')}};
 const browser={newContext:async options=>{assert.equal(options.storageState.cookies.length,2);return restored;},close:async()=>{closures.push('browser')}};
 const source=fs.readFileSync(process.env.LOGIN_SESSION_SOURCE || require.resolve('../lib/linkedin/session.ts'),'utf8')+'\nexport {persistLogin};';
 const m=new Module(__filename);
 m.require=name=>name==='playwright-extra'?{chromium:{use(){},launch:async()=>{calls.push('launch');return browser}}}:name==='puppeteer-extra-plugin-stealth'?()=>({}):name==='@/lib/db'?{getDb:()=>db}:name==='@/lib/crypto'?{encryptSecret:s=>'encrypted:'+s}:name==='./login-signals'?{}:require(name);
 m._compile(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText,__filename);
 const ctx={cookies:async()=>cookies,storageState:async()=>({cookies,origins:[]}),close:async()=>{calls.push('login_closed');closures.push('login')},request:{get:async(url,options)=>{
  calls.push({url,options,settled});if(transport)throw Error('private-url-and-secret');return response(originalStatus,'urn:li:fs_miniProfile:fixture');
 }}};
 const page={waitForLoadState:async()=>{settled=true;}};
 return {persist:m.exports.persistLogin,ctx,page,writes,calls,closures};
}
test('closes the login context before verifying the same identity in a new browser',async()=>{
 const f=fixture();await f.persist('account',f.ctx,f.page);
 assert.deepEqual(f.calls.map(c=>typeof c==='string'?c:c.settled),[true,'login_closed','launch','restored']);
 assert.equal(f.writes.length,1);assert.equal(JSON.parse(f.writes[0][0].slice('encrypted:'.length)).cookies.length,2);
 assert.equal(f.calls[0].url,'https://www.linkedin.com/voyager/api/me');
 assert.equal(f.calls[0].options.maxRedirects,0);assert.equal(f.calls[0].options.timeout,15000);
 assert.equal(f.calls[0].options.headers['csrf-token'],'ajax:fixture');
 assert.ok(f.closures.includes('login'));assert.ok(f.closures.includes('context'));assert.ok(f.closures.includes('browser'));
});
test('failed restored check cannot mark an account connected',async()=>{
 for(const options of [{originalStatus:302},{originalStatus:401},{restoredStatus:302},{restoredStatus:401},{restoredStatus:429},{restoredIdentity:'urn:li:fs_miniProfile:someoneelse'},{missingCookie:true},{transport:true}]){
  const f=fixture(options);await assert.rejects(f.persist('account',f.ctx,f.page),e=>e.message.includes('did not confirm')&&!e.message.includes('private-url'));
  assert.equal(f.writes.length,0);
 }
});
