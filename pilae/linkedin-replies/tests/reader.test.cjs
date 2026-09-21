const {test}=require('node:test'),assert=require('node:assert/strict');
const {SessionReader,parseConversations,parseMessages,parseProfile}=require('./load.cjs').loader()('pilae/linkedin-replies/reader.ts');
const self='urn:li:fsd_profile:self',peer='urn:li:fsd_profile:peer';
const participant={entityUrn:'participant',hostIdentityUrn:peer,profileUrl:'https://www.linkedin.com/in/alice'};
function envelope(root,items,included=[],next=null){return {data:{data:{[root]:{'*elements':items.map(x=>x.entityUrn),metadata:{nextCursor:next}}}},included:[...items,...included]};}
test('normalizes referenced identities, rejects unknown/incomplete envelopes',()=>{
 const c={entityUrn:'conversation','*conversationParticipants':['participant','self']};
 assert.equal(parseConversations(envelope('messengerConversationsByCategory',[c],[participant,{entityUrn:'self',hostIdentityUrn:self}])).items[0].participants[0].id,peer);
 for(const raw of [{},{data:{data:{}}},{errors:[]},envelope('messengerConversationsByCategory',[c])])assert.throws(()=>parseConversations(raw));
 const msg={entityUrn:'message',deliveredAt:1000000,'*sender':'participant',body:{text:'Synthetic'}};
 assert.equal(parseMessages(envelope('messengerMessagesBySyncToken',[msg],[participant])).items[0].sender,peer);
 assert.throws(()=>parseMessages(envelope('messengerMessagesBySyncToken',[{...msg,deliveredAt:null}],[participant])));
});
test('uses account context GET with bounded timeout, cookie header only server-side and no redirects',async()=>{
 const calls=[];const context={cookies:async()=>[{name:'li_at',value:'synthetic'},{name:'JSESSIONID',value:'"ajax:fixture"'}],request:{get:async(url,options)=>{
 calls.push({url,options});return {status:()=>200,body:async()=>Buffer.from(JSON.stringify(url.endsWith('/me')?{data:{'*miniProfile':'urn:li:fs_miniProfile:self'}}:envelope('messengerConversationsByCategory',[]))),dispose:async()=>{}};
 }}};
 const reader=new SessionReader(context,{conversations:'messengerConversations.'+'a'.repeat(32),messages:'messengerMessages.'+'b'.repeat(32)});
 assert.equal(await reader.identity(),self);await reader.conversations('cursor:(one)');
 assert.equal(calls[0].options.maxRedirects,0);assert.equal(calls[0].options.timeout,20000);assert.equal(calls[0].options.headers['csrf-token'],'ajax:fixture');assert.ok(!JSON.stringify(calls).includes('synthetic'));
 assert.ok(calls[1].url.includes('cursor%3A%28one%29'));
});
test('expired session, redirects, rate limits and malformed responses have safe errors',async()=>{
 for(const [status,code] of [[401,'authentication'],[302,'authentication'],[429,'rate_limited'],[500,'transport']]){
 const context={cookies:async()=>[{name:'li_at',value:'secret'},{name:'JSESSIONID',value:'secret'}],request:{get:async()=>({status:()=>status,dispose:async()=>{}})}};
 const reader=new SessionReader(context,{conversations:'messengerConversations.'+'a'.repeat(32),messages:'messengerMessages.'+'b'.repeat(32)});
 await assert.rejects(reader.identity(),e=>e.code===code&&!e.message.includes('secret'));
 }
});
test('observed sync snapshot shape retains embedded messages without claiming history coverage',()=>{
 const peerNode={entityUrn:'participant',hostIdentityUrn:peer,participantType:{member:{profileUrl:'https://www.linkedin.com/in/ACofixture'}}};
 const msg={entityUrn:'reply',deliveredAt:1000000,'*sender':'participant',body:{text:'Synthetic reply'}};
 const c={entityUrn:'conversation',groupChat:false,'*conversationParticipants':['participant','self'],messages:{'*elements':['reply']}};
 const raw=envelope('messengerConversationsBySyncToken',[c],[peerNode,{entityUrn:'self',hostIdentityUrn:self},msg]);
 raw.data.data.messengerConversationsBySyncToken.metadata={newSyncToken:'opaque-sync-token'};
 const page=parseConversations(raw);
 assert.equal(page.coverage,'partial');assert.equal(page.next,null);assert.equal(page.syncToken,'opaque-sync-token');
 assert.equal(page.items[0].participants[0].id,peer);assert.equal(page.items[0].messages[0].sender,peer);
});
test('canonical profile resolution follows the requested root identity only',()=>{
 const raw={data:{'*elements':[peer]},included:[{entityUrn:self,publicIdentifier:'wrong'},{entityUrn:peer,publicIdentifier:'alice'}]};
 assert.deepEqual(parseProfile(raw),{id:peer,profileUrl:'https://www.linkedin.com/in/alice'});
 assert.throws(()=>parseProfile({...raw,data:{'*elements':[peer,self]}}));
 assert.throws(()=>parseProfile({...raw,included:[raw.included[0]]}));
});
