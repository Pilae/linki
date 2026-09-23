const {test}=require('node:test'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {readSnapshot,parseInvitationPage,newSentInvitation,LinkedinWithdrawalProvider,findWithdrawalControl}=require('./load-withdrawals.cjs').loader()('lib/withdrawals/linkedin');
const sent=Date.now()-40*86400000,sender='urn:li:fs_miniProfile:sender';
const invitation={invitation_urn:'urn:li:fs_relInvitation:0',sender_urn:sender,recipient_urn:'urn:li:fs_miniProfile:0',sent_at:sent,profile_url:'https://www.linkedin.com/in/synthetic-0'};
function response(start,count=1,mutate){const included=[],elements=[];for(let n=start;n<Math.min(count,start+100);n++){
 const view={entityUrn:`urn:li:fs_relSentInvitationView:${n}`,$type:'com.linkedin.voyager.relationships.invitation.SentInvitationViewV2','*invitation':`urn:li:fs_relInvitation:${n}`};
 const item={entityUrn:view['*invitation'],$type:'com.linkedin.voyager.relationships.invitation.Invitation',mailboxItemId:`urn:li:invitation:${n}`,'*fromMember':sender,'*toMember':`urn:li:fs_miniProfile:${n}`,invitee:{'*miniProfile':`urn:li:fs_miniProfile:${n}`},sentTime:sent};
 const profile={entityUrn:item['*toMember'],$type:'com.linkedin.voyager.identity.shared.MiniProfile',publicIdentifier:`synthetic-${n}`};
 if(mutate)mutate(item,profile,n);included.push(view,item,profile);elements.push(view.entityUrn);
 }return {data:{metadata:{invitationType:'CONNECTION'},'*elements':elements,paging:{start,count:100,links:[]}},included};}
function row(name='Synthetic',href=invitation.profile_url,extra='',display=name){return `<div role="listitem" ${extra}><a href="${href}">${name}</a><p>${display}</p><a href="#" aria-label="Retirer l’invitation envoyée à ${name}" onclick="document.querySelector('[role=dialog]').style.display='block';return false">Retirer</a></div>`;}
test('observed response and DOM contracts: verified snapshots, exact profile binding and safe rejection',async t=>{
 const browser=await chromium.launch({headless:true});t.after(()=>browser.close());
 for(const scenario of ['pending','accepted','absent','email-mixed','email-only','email-mutated','105-records','count-mismatch','changing-same-count','duplicate-recipient','unresolved-recipient','wrong-account','unresolved-sender','missing-terminal','duplicate-row','wrong-row-profile','conflicting-row-id','action-name-conflict','wrong-dialog','cancelled','changed-at-confirmation','success'])await t.test(scenario,async()=>{
 const context=await browser.newContext();await context.addCookies([{name:'JSESSIONID',value:'synthetic',domain:'.linkedin.com',path:'/'}]);
 let pending=scenario!=='absent'&&scenario!=='email-only',clicks=0,firstPages=0;const offsets=[];
 const count=()=>pending?(scenario==='105-records'?105:1):0;
 const email=scenario.startsWith('email-');const totalCount=()=>count()+(email?1:0);
 await context.route('**/*',async r=>{const u=new URL(r.request().url());
  if(u.pathname==='/fixture-confirm'){clicks++;pending=false;return r.fulfill({json:{}})}
  if(u.pathname==='/voyager/api/me'){const id=scenario==='wrong-account'?'urn:li:fs_miniProfile:other':sender;return r.fulfill({json:{data:{'*miniProfile':id},included:scenario==='unresolved-sender'?[]:[{entityUrn:id,$type:'com.linkedin.voyager.identity.shared.MiniProfile',publicIdentifier:'synthetic-sender'}]}})}
  if(u.pathname.includes('sentInvitationViewsV2')){const start=Number(u.searchParams.get('start'));offsets.push(start);if(start===0)firstPages++;const changed=scenario==='changed-at-confirmation'&&firstPages>=5;
   const p=response(start,count(),(item,profile,n)=>{if(scenario==='changing-same-count'&&firstPages>=2||changed)item.sentTime=sent-1;if(scenario==='unresolved-recipient')delete item['*toMember'];if(scenario==='duplicate-recipient'&&n===1){item['*toMember']='urn:li:fs_miniProfile:0';item.invitee['*miniProfile']=item['*toMember'];profile.publicIdentifier='synthetic-0'}});
   if(email&&start===0){const e=response(1,2);const item=e.included[1];delete item['*toMember'];item.toMember=null;item.invitee={email:scenario==='email-mutated'&&firstPages>=2?'changed@example.test':'synthetic@example.test',$type:'com.linkedin.voyager.relationships.invitation.EmailInvitee'};e.included.pop();p.data['*elements'].push(...e.data['*elements']);p.included.push(...e.included)}
   if(email&&start>0){p.data={elements:[],paging:{start,count:100,links:[]},$type:'com.linkedin.restli.common.CollectionResponse'};p.included=[]}
   if(scenario==='duplicate-recipient')Object.assign(p,response(start,pending?2:0,(item,profile,n)=>{if(n===1){item['*toMember']='urn:li:fs_miniProfile:0';item.invitee['*miniProfile']=item['*toMember'];profile.publicIdentifier='synthetic-0'}}));
   if(scenario==='missing-terminal'&&start>0){const again=response(0);again.data.paging.start=start;return r.fulfill({json:again})}
   return r.fulfill({json:p});
  }
  if(u.pathname.startsWith('/in/'))return r.fulfill({contentType:'text/html; charset=utf-8',body:`<main><section><h1>Synthetic</h1><span>${scenario==='accepted'?'1st':'2nd'}</span></section></main>`});
  if(u.pathname.includes('invitation-manager')){const total=scenario==='count-mismatch'?2:scenario==='duplicate-recipient'?2:totalCount();return r.fulfill({contentType:'text/html; charset=utf-8',body:`<main><a href="/mynetwork/invitation-manager/sent/CONNECTION/">Personnes (${total})</a><div data-testid="lazy-column" data-component-type="LazyColumn">${pending?row('Synthetic',scenario==='wrong-row-profile'?'https://www.linkedin.com/in/other':invitation.profile_url,scenario==='conflicting-row-id'?'data-urn="wrong"':'',scenario==='action-name-conflict'?'Wrong':'Synthetic'):''}${scenario==='duplicate-row'?row('Same name'):''}</div><aside>${row('Synthetic','https://www.linkedin.com/in/sidebar')}</aside><div role="dialog" style="display:none"><button aria-label="Retirer l’invitation envoyée à ${scenario==='wrong-dialog'?'Wrong':'Synthetic'}" onclick="fetch('/fixture-confirm',{method:'POST'}).then(()=>{document.querySelector('main>a').textContent='Personnes (0)';this.parentElement.remove()})">Retirer</button></div></main>`})}
  return r.abort();
 });
 const page=await context.newPage(),provider=new LinkedinWithdrawalProvider(page);
 try{
 if(['count-mismatch','changing-same-count','duplicate-recipient','unresolved-recipient','wrong-account','unresolved-sender','missing-terminal','email-mutated'].includes(scenario)){await assert.rejects(readSnapshot(page));assert.equal(clicks,0);return;}
 const snap=await readSnapshot(page);assert.equal(snap.invitations.length,count());
 if(email){assert.equal(snap.excludedEmails.length,1);assert.ok(!JSON.stringify(snap).includes('synthetic@example.test'));if(scenario==='email-mixed'){await findWithdrawalControl(page,invitation,snap);assert.equal((await provider.inspect(invitation)).state,'pending')}else{assert.equal((await provider.inspect({...invitation,invitation_urn:'urn:li:fs_relInvitation:1'})).state,'ambiguous');assert.equal(newSentInvitation(snap,snap,invitation.profile_url,sent-1,sent+1),null)}assert.equal(clicks,0);return;}
 if(scenario==='105-records'){assert.deepEqual(offsets,[0,100,200,0,100,200]);return;}
 if(['duplicate-row','wrong-row-profile','conflicting-row-id','action-name-conflict'].includes(scenario)){await assert.rejects(findWithdrawalControl(page,invitation,snap));assert.equal(clicks,0);return;}
 if(['pending','accepted','absent'].includes(scenario)){assert.equal((await provider.inspect(invitation)).state,scenario);assert.equal(clicks,0);return;}
 // Reset the scan counter to target the final snapshot inside withdraw (scan 5).
 firstPages=0;
 if(['wrong-dialog','cancelled','changed-at-confirmation'].includes(scenario)){await assert.rejects(provider.withdraw(invitation,()=>scenario!=='cancelled'),scenario==='wrong-dialog'?/confirmation is ambiguous/:scenario==='cancelled'?/cancelled by campaign/:/Exact invitation changed/);assert.equal(clicks,0)}
 else{await provider.withdraw(invitation,()=>true);assert.equal(clicks,1);assert.equal((await provider.inspect(invitation)).state,'absent')}
 }finally{await context.close()}
 });
});

test('email records require a strict known shape and cannot hide malformed members',()=>{
 const make=()=>{const p=response(0);const item=p.included[1];delete item['*toMember'];item.toMember=null;item.invitee={$type:'com.linkedin.voyager.relationships.invitation.EmailInvitee',email:'synthetic@example.test'};return p};
 assert.equal(parseInvitationPage(make(),sender,0).excludedEmails.length,1);
 const excluded=parseInvitationPage(make(),sender,0).excludedEmails;
 assert.equal(newSentInvitation({sender_urn:sender,invitations:[],excludedEmails:excluded},{sender_urn:sender,invitations:[invitation]},invitation.profile_url,sent-1,sent+1),null,'email-to-member identity reuse is not a new campaign send');
 for(const change of [i=>i['*toMember']=invitation.recipient_urn,i=>i.invitee['*miniProfile']=invitation.recipient_urn,i=>i.invitee.$type='unknown',i=>i.invitee.email='',i=>i['*fromMember']='other',i=>i.sentTime=null,i=>i.toMember={entityUrn:invitation.recipient_urn}]){const p=make();change(p.included[1]);assert.throws(()=>parseInvitationPage(p,sender,0))}
});
