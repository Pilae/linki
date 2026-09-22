const {test}=require('node:test'),assert=require('node:assert/strict');
const {SessionReader,parseConversations,parseMessages,parseHistoricalMessages,parseProfile}=require('./load.cjs').loader()('pilae/linkedin-replies/reader.ts');
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
test('opens authenticated feed and reads through its page, with no credential logging',async()=>{
 const calls=[];const page={goto:async(url,options)=>{calls.push({url,options});return {status:()=>200}},url:()=> 'https://www.linkedin.com/feed/',context:()=>({cookies:async()=>[{name:'li_at',value:'synthetic'},{name:'JSESSIONID',value:'"ajax:fixture"'}]}),evaluate:async(_fn,arg)=>{
 calls.push({path:arg.path,csrf:arg.csrf});return {status:200,body:JSON.stringify(arg.path==='me'?{data:{'*miniProfile':'urn:li:fs_miniProfile:self'}}:envelope('messengerConversationsByCategory',[]))};
 }};
 const reader=new SessionReader(page,{conversations:'messengerConversations.'+'a'.repeat(32),historyAnchor:'messengerMessages.'+'b'.repeat(32),historyPrevious:'messengerMessages.'+'c'.repeat(32)});
 assert.equal(await reader.identity(),self);await reader.conversations('cursor:(one)');
 assert.equal(calls[0].url,'https://www.linkedin.com/feed/');assert.equal(calls[0].options.timeout,20000);
 assert.equal(calls[1].csrf,'ajax:fixture');assert.ok(!JSON.stringify(calls).includes('synthetic'));
 assert.ok(calls[2].path.includes('cursor%3A%28one%29'));
});
test('expired session, redirects, rate limits and malformed responses have safe errors',async()=>{
 for(const [status,code] of [[401,'authentication'],[302,'authentication'],[429,'rate_limited'],[500,'transport']]){
 const page={goto:async()=>({status:()=>200}),url:()=> 'https://www.linkedin.com/feed/',context:()=>({cookies:async()=>[{name:'li_at',value:'secret'},{name:'JSESSIONID',value:'secret'}]}),evaluate:async()=>({status,body:null})};
 const reader=new SessionReader(page,{conversations:'messengerConversations.'+'a'.repeat(32),historyAnchor:'messengerMessages.'+'b'.repeat(32),historyPrevious:'messengerMessages.'+'c'.repeat(32)});
 await assert.rejects(reader.identity(),e=>e.code===code&&!e.message.includes('secret'));
 }
 const login={goto:async()=>({status:()=>200}),url:()=> 'https://www.linkedin.com/login'};
 await assert.rejects(new SessionReader(login,{conversations:'messengerConversations.'+'a'.repeat(32),historyAnchor:'messengerMessages.'+'b'.repeat(32),historyPrevious:'messengerMessages.'+'c'.repeat(32)}).identity(),e=>e.code==='authentication');
});
test('page transport makes one same-origin GET with a bounded response',async()=>{
 const previous=global.fetch,calls=[];
 global.fetch=async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify({data:{'*miniProfile':'urn:li:fs_miniProfile:self'}}),{status:200});};
 const page={goto:async()=>({status:()=>200}),url:()=> 'https://www.linkedin.com/feed/',context:()=>({cookies:async()=>[{name:'li_at',value:'fixture'},{name:'JSESSIONID',value:'"ajax:fixture"'}]}),evaluate:async(fn,arg)=>fn(arg)};
 try {
  const reader=new SessionReader(page,{conversations:'messengerConversations.'+'a'.repeat(32),historyAnchor:'messengerMessages.'+'b'.repeat(32),historyPrevious:'messengerMessages.'+'c'.repeat(32)});
  assert.equal(await reader.identity(),self);assert.equal(calls.length,1);assert.equal(calls[0].url,'/voyager/api/me');
  assert.equal(calls[0].options.credentials,'same-origin');assert.equal(calls[0].options.redirect,'manual');
  assert.equal(calls[0].options.headers['csrf-token'],'ajax:fixture');
 } finally {global.fetch=previous;}
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
test('historical pages follow prevCursor and accept an empty terminal elements page',()=>{
 const node={entityUrn:'older',deliveredAt:1000000,'*sender':'participant',body:{text:'Synthetic'}};
 const first=envelope('messengerMessagesByAnchorTimestamp',[node],[participant]);
 first.data.data.messengerMessagesByAnchorTimestamp.metadata={nextCursor:'newer',prevCursor:'older:(one)'};
 assert.equal(parseHistoricalMessages(first,'messengerMessagesByAnchorTimestamp').next,'older:(one)');
 const terminal={data:{data:{messengerMessagesByConversation:{elements:[],metadata:{nextCursor:'newer',prevCursor:null}}}},included:[]};
 assert.deepEqual(parseHistoricalMessages(terminal,'messengerMessagesByConversation'),{items:[],next:null});
 const missing={data:{data:{messengerMessagesByConversation:{elements:[],metadata:{nextCursor:null}}}},included:[]};
 assert.throws(()=>parseHistoricalMessages(missing,'messengerMessagesByConversation'),e=>e.code==='incomplete');
 terminal.data.data.messengerMessagesByConversation.metadata.prevCursor='unexpected-more';
 assert.throws(()=>parseHistoricalMessages(terminal,'messengerMessagesByConversation'),e=>e.code==='incomplete');
});
test('history reader uses anchor then backward cursor on the same account page',async()=>{
 const paths=[],node={entityUrn:'older',deliveredAt:1000000,'*sender':'participant',body:{text:'Synthetic'}};
 const anchor=envelope('messengerMessagesByAnchorTimestamp',[node],[participant]);
 anchor.data.data.messengerMessagesByAnchorTimestamp.metadata={prevCursor:'older:(one)'};
 const terminal={data:{data:{messengerMessagesByConversation:{elements:[],metadata:{prevCursor:null}}}},included:[]};
 const page={goto:async()=>({status:()=>200}),url:()=> 'https://www.linkedin.com/feed/',
  context:()=>({cookies:async()=>[{name:'li_at',value:'synthetic'},{name:'JSESSIONID',value:'"ajax:fixture"'}]}),
  evaluate:async(_fn,arg)=>{paths.push(arg.path);return {status:200,body:JSON.stringify(paths.length===1?anchor:terminal)};}};
 const reader=new SessionReader(page,{conversations:'messengerConversations.'+'a'.repeat(32),historyAnchor:'messengerMessages.'+'b'.repeat(32),historyPrevious:'messengerMessages.'+'c'.repeat(32)});
 assert.equal((await reader.messages('urn:li:msg_conversation:(one)',null)).next,'older:(one)');
 assert.equal((await reader.messages('urn:li:msg_conversation:(one)','older:(one)')).next,null);
 assert.match(paths[0],/deliveredAt:\d+,countBefore:20,countAfter:0/);
 assert.ok(paths[0].includes('urn%3Ali%3Amsg_conversation%3A%28one%29'));
 assert.ok(paths[1].includes('prevCursor:older%3A%28one%29'));
 assert.ok(!paths[1].includes('nextCursor'));
});
test('canonical profile resolution follows the requested root identity only',()=>{
 const raw={data:{'*elements':[peer]},included:[{entityUrn:self,publicIdentifier:'wrong'},{entityUrn:peer,publicIdentifier:'alice'}]};
 assert.deepEqual(parseProfile(raw),{id:peer,profileUrl:'https://www.linkedin.com/in/alice'});
 assert.throws(()=>parseProfile({...raw,data:{'*elements':[peer,self]}}));
 assert.throws(()=>parseProfile({...raw,included:[raw.included[0]]}));
});
