// Requires npm run build. Starts only an empty disposable instance, never the sandbox.
const {spawn}=require('node:child_process'),{once}=require('node:events'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {encode}=require('next-auth/jwt'),Database=require('better-sqlite3'),{chromium}=require('playwright');
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pilae-reply-runtime-')),secret=randomUUID(),internal=randomUUID(),port=3491,origin=`http://127.0.0.1:${port}`;
 const server=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port',String(port)],{cwd:path.resolve(__dirname,'../../..'),env:{...process.env,LINKI_DB_PATH:path.join(dir,'fixture.db'),PILAE_REPLY_ACCOUNT_IDS:'',NEXTAUTH_SECRET:secret,NEXTAUTH_URL:origin,INTERNAL_API_SECRET:internal,NEXT_TELEMETRY_DISABLED:'1'},stdio:'ignore'});
 let browser;
 try {
  let ready=false;
  for(let i=0;i<60;i++){if(server.exitCode!==null)throw Error('Isolated server exited (port may already be occupied)');try{const r=await fetch(origin+'/api/pilae/replies?account=fixture');if(r.status===401){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,500));}
  assert.ok(ready,'server ready');
  const id=randomUUID(),db=new Database(path.join(dir,'fixture.db'));
  db.prepare('INSERT INTO accounts(id,name,email,is_authenticated) VALUES(?,?,?,0)').run(id,'Synthetic reply account','replies@example.test');db.close();
  const endpoint=origin+'/api/pilae/replies?account='+id;
  const health=await fetch(endpoint,{headers:{'x-internal-secret':internal}});assert.equal(health.status,200);assert.equal((await health.json()).status,null);
  const manual=await fetch(endpoint,{method:'POST',headers:{'x-internal-secret':internal,'Content-Type':'application/json'},body:'{}'});assert.equal((await manual.json()).reason,'not_enabled');
  browser=await chromium.launch({headless:true});const context=await browser.newContext();
  await context.addCookies([{name:'next-auth.session-token',value:await encode({token:{name:'Fixture User',email:'fixture@example.test',sub:randomUUID()},secret}),url:origin,httpOnly:true,sameSite:'Lax'}]);
  const session=await (await context.request.get(origin+'/api/auth/session')).json();assert.equal(session.user?.email,'fixture@example.test','synthetic session accepted');
  const page=await context.newPage();await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin+'/pilae/linkedin-replies');await page.getByRole('combobox').selectOption(id);
  await page.getByRole('heading',{name:'Never checked',exact:true}).waitFor();
  await page.getByRole('button',{name:'Check replies',exact:true}).click();await page.getByRole('status').filter({hasText:'not_enabled'}).waitFor();
  await page.getByText('No stored reply events on this page.',{exact:false}).waitFor();
  assert.deepEqual(errors,[]);
  await page.screenshot({path:path.join(dir,'reply-status.png'),fullPage:true});
  console.log(JSON.stringify({passed:true,realAccounts:false,outreach:false,screenshot:path.join(dir,'reply-status.png')}));
 }finally{
  if(browser)await browser.close();const closed=once(server,'exit');server.kill('SIGTERM');await closed;
  // Keep the non-sensitive screenshot; dispose the synthetic DB files only.
  for(const name of ['fixture.db','fixture.db-wal','fixture.db-shm'])fs.rmSync(path.join(dir,name),{force:true});
 }
})().catch(e=>{console.error(e.message);process.exitCode=1;});
