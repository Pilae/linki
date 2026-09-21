const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),Module=require('node:module'),ts=require('typescript');
function fixture({status=200,payload={data:{'*miniProfile':'urn:li:fs_miniProfile:fixture'}},missingCookie=false,transport=false}={}){
 const writes=[],calls=[];let valid=true,disposed=false;
 const db={prepare:()=>({run:(...args)=>writes.push(args)})};
 const source=fs.readFileSync(process.env.LOGIN_SESSION_SOURCE || require.resolve('../lib/linkedin/session.ts'),'utf8')+'\nexport {persistLogin};';
 const m=new Module(__filename);
 m.require=name=>name==='playwright-extra'?{chromium:{use(){}}}:name==='puppeteer-extra-plugin-stealth'?()=>({}):name==='@/lib/db'?{getDb:()=>db}:name==='@/lib/crypto'?{encryptSecret:s=>'encrypted:'+s}:name==='./login-signals'?{}:require(name);
 m._compile(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText,__filename);
 const cookies=[{name:'JSESSIONID',value:'"ajax:fixture"'},...missingCookie?[]:[{name:'li_at',value:'fixture-secret'}]];
 const ctx={cookies:async()=>cookies,storageState:async()=>({cookies:valid?cookies:[]}),request:{get:async(url,options)=>{
 calls.push({url,options});if(transport)throw Error('private-url-and-secret');return {status:()=>status,body:async()=>Buffer.from(JSON.stringify(payload)),dispose:async()=>{disposed=true;}};
 }}};
 const page={goto:async()=>{valid=false;},waitForTimeout:async()=>{}};
 return {persist:m.exports.persistLogin,ctx,page,writes,calls,disposed:()=>disposed};
}
test('regular login preserves working cookies without visiting Sales Navigator',async()=>{
 const f=fixture();await f.persist('account',f.ctx,f.page);
 assert.equal(f.writes.length,1);assert.equal(JSON.parse(f.writes[0][0].slice('encrypted:'.length)).cookies.length,2);
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].url,'https://www.linkedin.com/voyager/api/me');
 assert.equal(f.calls[0].options.maxRedirects,0);assert.equal(f.calls[0].options.timeout,15000);
 assert.equal(f.calls[0].options.headers['csrf-token'],'ajax:fixture');assert.equal(f.disposed(),true);
});
test('rejected or unverifiable sessions never overwrite stored credentials or mark connected',async()=>{
 for(const options of [{status:302},{status:401},{status:429},{payload:{}},{payload:{data:{'*miniProfile':'wrong'}}},{payload:{errors:[],data:{'*miniProfile':'urn:li:fs_miniProfile:fixture'}}},{missingCookie:true},{transport:true}]){
  const f=fixture(options);await assert.rejects(f.persist('account',f.ctx,f.page),e=>e.message.includes('did not confirm')&&!e.message.includes('private-url'));
  assert.equal(f.writes.length,0);
 }
});
