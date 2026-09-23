import {createHash} from 'node:crypto';
// Deterministic v4-shaped IDs make retries safe across restarts and CRM projection.
export function eventId(key){const h=createHash('sha256').update(key).digest('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;}
export function extractEvents(personId,targetId,s){
 const events=[];
 const add=(channel,kind,at,body,key)=>{if(!at)return;const d=new Date(/Z$|[+-]\d\d:\d\d$/.test(at)?at:at.replace(' ','T')+'Z');if(!Number.isFinite(+d))return;const source_key=`linki:${targetId}:${key}`;events.push({id:eventId(source_key),source_key,person_id:personId,channel,kind,occurred_at:d.toISOString(),body});};
 add('linkedin','invitation_sent',s.connection_requested_at,'Connection invitation recorded by Linki.','invitation:'+s.connection_requested_at);
 add('linkedin','connection_accepted',s.connected_at,'Connection detected by Linki; this may be an existing connection, not a newly accepted invitation.','connected:'+s.connected_at);
 add('linkedin','outbound_sent',s.message_sent_at,'LinkedIn message sent. Message text is unavailable from this endpoint.','message:'+s.message_sent_at);
 add('linkedin','outbound_sent',s.inmail_sent_at,'LinkedIn InMail sent. Message text is unavailable from this endpoint.','inmail:'+s.inmail_sent_at);
 add('linkedin','reply_received',s.last_replied_at,'LinkedIn reply detected. Reply text is unavailable from this endpoint.','reply:'+s.last_replied_at);
 add('email','reply_received',s.email_replied_at,s.reply?.channel==='email'||s.reply?.channel==='both'?(s.reply.body||s.reply.summary||'Email reply detected.'):'Email reply detected.','email-reply:'+s.email_replied_at);
 // Run endpoint only exposes its latest 100 logs; use available successful email logs,
 // never "Sending…" attempts or current mutable sequence text as message evidence.
 for(const run of s.progress||[])for(const log of run.logs||[]){if(log.level==='error')add('unknown','error',log.created_at,log.message,'log:'+log.id);else if(/^Email sent to /.test(log.message))add('email','outbound_sent',log.created_at,log.message,'log:'+log.id);}
 return events;
}
