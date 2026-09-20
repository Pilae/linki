const assert=require('node:assert/strict');
const {loadLinkedIn}=require('./load-linkedin.cjs');
const {hasCaptchaSignal,hasInvalidCredentialSignal}=loadLinkedIn('login-signals');
const {chromium}=require('playwright');
(async()=>{const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||undefined,args:['--no-sandbox']});try{
 const page=await browser.newPage();await page.route('**/*',r=>r.abort());
 for(const [html,captcha,invalid] of [
  ['<iframe title="CAPTCHA localisé" src="https://client-api.arkoselabs.com/"></iframe>',true,false],
  ['<iframe title="Verificación" src="https://example.test/captcha/"></iframe>',true,false],
  ['<iframe title="验证码" src="https://example.test/other/"></iframe>',false,false],
  ['<input type="password" aria-invalid="true"><p>पासवर्ड गलत है</p>',false,true],
  ['<input type="email" aria-invalid="true"><p>خطأ</p>',false,true],
  ['<input type="password"><button type="submit">Oui</button>',false,false],
 ]){
  await page.setContent(html);assert.equal(await hasCaptchaSignal(page),captcha);assert.equal(await hasInvalidCredentialSignal(page),invalid);
 }
 console.log(JSON.stringify({passed:12,network:'disabled',realAccountUsed:false}));
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
