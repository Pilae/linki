export type OutreachEvent={id:string;channel:string;kind:string;occurred_at:string;body:string;source_key:string;person_id:string};
const maxDate=(a:string|null|undefined,b:string|null|undefined)=>!a?b:!b?a:Date.parse(a)>=Date.parse(b)?a:b;
export function reduceOutreach(person:any,events:OutreachEvent[]){
 const state=person.outreachSyncState||{},channels={...(person.outreachChannelState||{})};
 let outbound=person.outreachLastOutboundAt,inbound=person.outreachLastInboundAt,contact=person.outreachLastContactAt,connection=person.linkedinConnectionState;
 const ordered=[...events].sort((a,b)=>a.occurred_at.localeCompare(b.occurred_at)||a.id.localeCompare(b.id));
 for(const e of ordered){const c={...(channels[e.channel]||{})};
  if(e.kind==='outbound_sent'){outbound=maxDate(outbound,e.occurred_at);c.lastOutboundAt=maxDate(c.lastOutboundAt,e.occurred_at);}
  if(e.kind==='reply_received'){inbound=maxDate(inbound,e.occurred_at);c.lastInboundAt=maxDate(c.lastInboundAt,e.occurred_at);}
  if(e.kind==='connection_accepted'){connection='CONNECTED';c.connectionAcceptedAt=maxDate(c.connectionAcceptedAt,e.occurred_at);}
  if(e.kind==='invitation_sent'){connection=connection==='CONNECTED'?connection:'INVITATION_SENT';c.invitationSentAt=maxDate(c.invitationSentAt,e.occurred_at);}
  if(e.kind==='error'&&(!c.lastErrorAt||Date.parse(e.occurred_at)>=Date.parse(c.lastErrorAt))){c.lastErrorAt=e.occurred_at;c.lastError=e.body;}
  channels[e.channel]=c;
 }
 contact=maxDate(contact,maxDate(inbound,outbound));
 const manualOverride=!!state.manualOverride||(state.lastAppliedStatus!==undefined&&state.lastAppliedStatus!==person.outreachStatus);
 let status=person.outreachStatus;
 const protectedStatus=['DO_NOT_CONTACT','NOT_INTERESTED','MEETING_BOOKED','REPLIED'];
 if(person.outreachAutomationEnabled&&!manualOverride&&!protectedStatus.includes(status)){
  if(inbound)status='REPLIED';
  else if(outbound&&(!status||['TO_CONTACT','CONNECTION_ACCEPTED'].includes(status)))status='FIRST_OUTREACH_SENT';
  else if(connection==='CONNECTED'&&(!status||status==='TO_CONTACT'))status='CONNECTION_ACCEPTED';
 }
 // Follow-up numbering is not inferred from cross-channel message counts or incomplete logs.
 return {outreachStatus:status,outreachLastOutboundAt:outbound||null,outreachLastInboundAt:inbound||null,outreachLastContactAt:contact||null,linkedinConnectionState:connection||'',outreachChannelState:channels,outreachSyncState:{...state,lastAppliedStatus:status??null,manualOverride,replyNeedsReview:!!inbound,eventCount:events.length,ruleVersion:1}};
}
