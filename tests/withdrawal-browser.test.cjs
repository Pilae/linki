const {test} = require('node:test'), assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {parseInvitationPage,newSentInvitation,LinkedinWithdrawalProvider,readSnapshot} = require('./load-withdrawals.cjs').loader()('lib/withdrawals/linkedin');
const sent=Date.now()-30*86400000;
const i={id:'synthetic',sender_urn:'urn:li:fs_miniProfile:sender',recipient_urn:'urn:li:fs_miniProfile:recipient',invitation_urn:'urn:li:invitation:synthetic',sent_at:sent,profile_url:'https://www.linkedin.com/in/synthetic'};
function payload(pending=true){return {data:{elements:pending?[i.invitation_urn]:[],paging:{start:0,total:pending?1:0}},included:pending?[
 {entityUrn:i.invitation_urn,$type:'com.linkedin.voyager.relationships.Invitation',inviter:i.sender_urn,invitee:i.recipient_urn,sentTime:sent},
 {entityUrn:i.recipient_urn,publicIdentifier:'synthetic'}]:[]}}
test('strict response parser, complete pagination, timestamp and send ownership evidence',()=>{
 const valid=payload();assert.equal(parseInvitationPage(valid,i.sender_urn,0).invitations.length,1);
 for(const value of [{},{included:[]},{data:{elements:[],paging:{start:0,total:1}}}, {...valid,included:[]}, {...valid,data:{...valid.data,paging:{start:100,total:1}}}])assert.throws(()=>parseInvitationPage(value,i.sender_urn,0));
 assert.throws(()=>parseInvitationPage(valid,'wrong-account',0));const future=payload();future.included[0].sentTime=Date.now()+86400000;assert.throws(()=>parseInvitationPage(future,i.sender_urn,0));
 const before={sender_urn:i.sender_urn,invitations:[]},after={sender_urn:i.sender_urn,invitations:[i]};
 assert.ok(newSentInvitation(before,after,i.profile_url,sent-1,sent+1));assert.equal(newSentInvitation(after,after,i.profile_url,sent-1,sent+1),null);
 assert.equal(newSentInvitation(before,after,i.profile_url,sent+1,sent+2),null);assert.equal(newSentInvitation({...before,sender_urn:'other'},after,i.profile_url,sent-1,sent+1),null);
});
// Reconstructed from the authorized 2026-09-22 read-only probe. All identities
// and timestamps are synthetic; no messages, session data or sharedSecret values.
test('observed normalized identity references are validated without inventing a total',()=>{
 const observed={data:{metadata:{invitationType:'CONNECTION'},'*elements':['urn:li:fs_relSentInvitationView:synthetic'],paging:{start:0,count:100,links:[]}},included:[
  {entityUrn:'urn:li:fs_relSentInvitationView:synthetic',$type:'com.linkedin.voyager.relationships.invitation.SentInvitationViewV2','*invitation':'urn:li:fs_relInvitation:synthetic'},
  {entityUrn:'urn:li:fs_relInvitation:synthetic',$type:'com.linkedin.voyager.relationships.invitation.Invitation','*fromMember':i.sender_urn,'*toMember':i.recipient_urn,invitee:{'*miniProfile':i.recipient_urn},mailboxItemId:i.invitation_urn,sentTime:sent},
  {entityUrn:i.recipient_urn,$type:'com.linkedin.voyager.identity.shared.MiniProfile',publicIdentifier:'synthetic'}
 ]};
 assert.equal(parseInvitationPage(observed,i.sender_urn,0).invitations[0].recipient_urn,i.recipient_urn);
 assert.equal(parseInvitationPage(observed,i.sender_urn,0).total,undefined);
 for(const change of [x=>x.included[1]['*fromMember']='wrong',x=>x.included[1].invitee['*miniProfile']='wrong',x=>x.included[1].sentTime=null,x=>x.included[1].sentTime=Date.now()+86400000,x=>x.included[0]['*invitation']='missing']){const bad=structuredClone(observed);change(bad);assert.throws(()=>parseInvitationPage(bad,i.sender_urn,0))}
 // An empty later page still lacks proof of completeness under the current contract.
 assert.equal(parseInvitationPage({data:{'*elements':[],paging:{start:200,count:100,links:[]}},included:[]},i.sender_urn,200).total,undefined);
});
test('isolated browser: exact pending row, confirmation, absence, ambiguous layouts and verification walls',async t=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||undefined});t.after(()=>browser.close());
 for(const scenario of ['success','accepted','observed-dom','missing-id','wrong-recipient','wrong-account','cancelled','unconfirmed','wall','changed-at-confirmation','incomplete-list']){
  const context=await browser.newContext();await context.addCookies([{name:'JSESSIONID',value:'synthetic-only',domain:'.linkedin.com',path:'/'}]);
  let pending=true,clicks=0,reads=0;
  await context.route('**/*',async route=>{
   const u=new URL(route.request().url());
   if(u.pathname==='/fixture-confirm'){clicks++;if(scenario!=='unconfirmed')pending=false;return route.fulfill({body:'{}',contentType:'application/json'})}
   if(u.pathname==='/voyager/api/me')return route.fulfill({json:{miniProfile:{entityUrn:scenario==='wrong-account'?'urn:li:fs_miniProfile:other':i.sender_urn}}});
   if(u.pathname.includes('sentInvitationViews')){reads++;const p=payload(scenario==='changed-at-confirmation'&&reads>=13?false:pending);if(scenario==='incomplete-list')p.data.paging.total=2;const start=Number(u.searchParams.get('start'));p.data.paging.start=start;if(start){p.data.elements=[];p.included=[]}return route.fulfill({json:p})}
   if(u.pathname.startsWith('/in/'))return route.fulfill({contentType:'text/html',body:`<main><section><h1>Synthetic</h1><span>${scenario==='accepted'?'1st':'2nd'}</span></section></main>`});
   if(u.pathname.includes('invitation-manager')&&scenario==='observed-dom')return route.fulfill({contentType:'text/html',body:`<div role="listitem" componentkey="synthetic"><a href="${i.profile_url}">Synthetic</a><p>Envoyé il y a 1 mois</p><a href="#" aria-label="Retirer l’invitation envoyée à Synthetic" onclick="fetch('/fixture-confirm',{method:'POST'});return false">Retirer</a></div>`});
   if(u.pathname.includes('invitation-manager'))return route.fulfill({contentType:'text/html',body:scenario==='wall'?'<input type="password">':`<li ${scenario==='missing-id'?'':`data-invitation-id="${i.invitation_urn}"`}><a href="https://www.linkedin.com/in/${scenario==='wrong-recipient'?'other':'synthetic'}">Synthetic</a><button onclick="document.querySelector('#dialog').style.display='block'">Withdraw</button></li><div id="dialog" role="dialog" style="display:none"><button onclick="fetch('/fixture-confirm',{method:'POST'}).then(()=>this.parentElement.remove())">Withdraw</button></div>`});
   return route.abort();
  });
  const page=await context.newPage(),p=new LinkedinWithdrawalProvider(page);
  if(['wall','incomplete-list','wrong-account'].includes(scenario)){await assert.rejects(p.inspect(i));assert.equal(clicks,0);await context.close();continue;}
  const before=await p.inspect(i);
  if(scenario==='accepted'||scenario==='wrong-account'){assert.equal(before.state,scenario==='accepted'?'accepted':'ambiguous');assert.equal(clicks,0);await context.close();continue;}
  assert.equal(before.state,'pending');
  if(['observed-dom','missing-id','wrong-recipient','cancelled','changed-at-confirmation'].includes(scenario)){await assert.rejects(p.withdraw(i,()=>scenario!=='cancelled'));assert.equal(clicks,0)}
  else {await p.withdraw(i,()=>true);const result=await p.inspect(i);assert.equal(result.state,scenario==='unconfirmed'?'pending':'absent');assert.equal(clicks,1)}
  await context.close();
 }
});
