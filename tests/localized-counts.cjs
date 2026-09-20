const assert=require('node:assert/strict');
const {loadLinkedIn}=require('./load-linkedin.cjs');
const {parseLocalizedInteger,parseLeadingCount,parseParenthesizedCount,isVerifiedCompleteCount}=loadLinkedIn('counts');
const {scrapeLinkedInStats}=loadLinkedIn('li-stats');
const {resultNameMatches}=loadLinkedIn('message');
const {chromium}=require('playwright');
for(const [input,want] of [['1 002',1002],['1.234',1234],['1,234',1234],['١٬٢٣٤',1234],['‏١٬٠٠٢‏',1002],['۱۲۳۴',1234],['१२३४',1234],['১২৩৪',1234],['੧੨੩੪',1234],['౧౨౩౪',1234],['๑๒๓๔',1234],['０１２３',123],['0',0],['1.2K',null],['1,2',null],['12 34',null],['not a count',null],['',null]])assert.equal(parseLocalizedInteger(input),want,input);
assert.equal(parseLeadingCount('1 002 relations'),1002);
assert.equal(parseLeadingCount('‏١٬٠٠٢‏ ‏زميل‏'),1002);
assert.equal(parseParenthesizedCount('Personnes (۱۳۶)'),136);
assert.equal(parseParenthesizedCount('People (1.2K)'),null);
for(const [full,pulled,declared,want] of [[true,1002,1002,true],[true,1001,1002,false],[true,1002,null,false],[true,0,0,false],[false,1002,1002,false]])assert.equal(isVerifiedCompleteCount(full,pulled,declared),want);
for(const [actual,target,want] of [['José Alvarez · CTO','Jose Alvarez',true],['李小龍\nEngineer','李小龍',true],['李小龍王\nEngineer','李小龍',false],['Анна Иванова · Manager','Анна Иванова',true],['Anna Ivanova','Анна Иванова',false],['Ann Smith','Anna Smith',false],['', '李小龍',false]])assert.equal(resultNameMatches(actual,target),want,actual);
(async()=>{const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||undefined,args:['--no-sandbox']});try{
 const page=await browser.newPage();await page.route('**/*',r=>r.abort());page.waitForTimeout=async()=>{};
 const contents=[
  '<div componentkey="ConnectionsPage_ConnectionsListHeader"><p>1 002&nbsp;relations</p></div>',
  '<a href="/mynetwork/invitation-manager/sent/CONNECTION/">Personnes (१३६)</a>',
  '<main><p>Who viewed your profile?</p><p>‏703‏</p><p>7 days</p></main>'
 ];
 let index=0;page.goto=async()=>{await page.setContent(contents[index++]);};
 assert.deepEqual(await scrapeLinkedInStats(page),{connections:1002,pending:136,profile_views:703});
 index=0;contents[0]='<p>unrecognized layout</p>';contents[1]='<a href="/mynetwork/invitation-manager/sent/CONNECTION/">People (1.2K)</a>';contents[2]='<main><p>123</p><p>456</p></main>';
 assert.deepEqual(await scrapeLinkedInStats(page),{connections:null,pending:null,profile_views:null});
 console.log(JSON.stringify({passed:32,network:'disabled',realAccountUsed:false}));
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
