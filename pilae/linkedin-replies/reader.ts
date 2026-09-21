import type { BrowserContext } from 'playwright';
import { SyncError, type Conversation, type Message, type Page, type Reader } from './contracts';

type ObjectValue = Record<string, unknown>;
function object(x: unknown): ObjectValue { if (!x || typeof x !== 'object' || Array.isArray(x)) throw new SyncError('incomplete'); return x as ObjectValue; }
function string(x: unknown): string { if (typeof x !== 'string' || !x.length || x.length>4096) throw new SyncError('incomplete'); return x; }
function array(x: unknown): unknown[] { if (!Array.isArray(x) || x.length>1000) throw new SyncError('incomplete'); return x; }
function encode(x: string) { return encodeURIComponent(x).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase()); }
function profile(x: unknown): string { const id=string(x); if (!/^urn:li:fsd_profile:[A-Za-z0-9_-]+$/.test(id)) throw new SyncError('incomplete'); return id; }
function graph(raw: unknown, roots: string[]) {
  const payload=object(raw); if (payload.errors) throw new SyncError('incomplete');
  const outer=object(payload.data), inner=outer.data ? object(outer.data) : outer;
  if(inner.errors) throw new SyncError('incomplete');
  const key=roots.find(k=>inner[k]); if (!key) throw new SyncError('incomplete');
  const root=object(inner[key]); const index=new Map(array(payload.included).map(v=>{const o=object(v);return [string(o.entityUrn),o] as const;}));
  const resolve=(v:unknown):ObjectValue=>typeof v==='string' ? object(index.get(v)) : object(v);
  const items=array(root['*elements'] ?? root.elements).map(resolve);
  const metadata=object(root.metadata);
  if (Object.hasOwn(metadata,'nextCursor')) {
    const next=metadata.nextCursor===null ? null : string(metadata.nextCursor);
    return {items,next,resolve};
  }
  // Observed sync snapshots contain recent items and newSyncToken, without historical
  // pagination evidence. Keep the items but never claim a complete inbox/history scan.
  if (Object.hasOwn(metadata,'newSyncToken')) return {
    items,next:null,resolve,coverage:'partial' as const,syncToken:string(metadata.newSyncToken),
  };
  throw new SyncError('incomplete');
}
function participant(value: ObjectValue, resolve: (v:unknown)=>ObjectValue) {
  const p = value.participantType ? object(value.participantType) : value;
  const member = p.member ? object(p.member) : p;
  const id=profile(value.hostIdentityUrn ?? member.hostIdentityUrn ?? member.profileUrn ?? member['*profile']);
  let profileUrl: string | undefined;
  if (typeof member.profileUrl==='string') profileUrl=member.profileUrl;
  else if(member['*profile']) {
    const data=resolve(member['*profile']);
    if(typeof data.publicIdentifier==='string' && /^[A-Za-z0-9_-]+$/.test(data.publicIdentifier)) profileUrl='https://www.linkedin.com/in/'+data.publicIdentifier;
  }
  return {id,profileUrl};
}
function message(m: ObjectValue, resolve: (v:unknown)=>ObjectValue): Message {
  const id=string(m.entityUrn), at=m.deliveredAt;
  if (typeof at!=='number' || !Number.isSafeInteger(at) || at<=0 || at>Date.now()+60_000) throw new SyncError('incomplete');
  if (m.systemMessage===true) return {id,at,sender:'system',kind:'system',body:''};
  const sender=participant(resolve(m['*sender'] ?? m.sender),resolve).id;
  const body=object(m.body).text;
  if (typeof body!=='string' || body.length>100_000) throw new SyncError('incomplete');
  return {id,at,sender,kind:'message',body};
}
export function parseConversations(raw: unknown): Page<Conversation> {
  const {items,resolve,...page}=graph(raw,['messengerConversationsByCategoryQuery','messengerConversationsByCategory','messengerConversationsBySyncToken']);
  return {...page,items:items.map(c=>{
    const participants=array(c['*conversationParticipants'] ?? c.conversationParticipants).map(v=>participant(resolve(v),resolve));
    if (new Set(participants.map(p=>p.id)).size!==participants.length) throw new SyncError('incomplete');
    const embedded=c.messages ? object(c.messages) : null;
    const messages=embedded ? array(embedded['*elements'] ?? embedded.elements).map(v=>message(resolve(v),resolve)) : undefined;
    return {id:string(c.entityUrn),participants,group:c.groupChat===true || participants.length!==2,messages};
  })};
}
export function parseMessages(raw: unknown): Page<Message> {
  const {items,resolve,...page}=graph(raw,['messengerMessagesBySyncToken','messengerMessagesByConversation']);
  return {...page,items:items.map(m=>message(m,resolve))};
}
/** Resolve only the requested profile, never the first unrelated included profile. */
export function parseProfile(raw: unknown) {
  const payload=object(raw),data=object(payload.data);
  if(payload.errors) throw new SyncError('incomplete');
  const refs=array(data['*elements']);
  if(refs.length!==1) throw new SyncError('incomplete');
  const id=profile(refs[0]);
  const matches=array(payload.included).map(object).filter(p=>p.entityUrn===id);
  if(matches.length!==1) throw new SyncError('incomplete');
  const slug=string(matches[0].publicIdentifier);
  if(!/^[A-Za-z0-9_-]+$/.test(slug)) throw new SyncError('incomplete');
  return {id,profileUrl:'https://www.linkedin.com/in/'+slug};
}
/** Server-only context; cookies are attached by Playwright, never serialized to callers. */
export class SessionReader implements Reader {
  private self: string | null=null;
  constructor(private context: BrowserContext, private queries: {conversations:string;messages:string}) {
    if(!/^messengerConversations\.[a-f0-9]{32}$/.test(queries.conversations) || !/^messengerMessages\.[a-f0-9]{32}$/.test(queries.messages)) throw new SyncError('incomplete');
  }
  private async get(path:string): Promise<unknown> {
    const cookies=await this.context.cookies('https://www.linkedin.com');
    const csrf=cookies.find(c=>c.name==='JSESSIONID')?.value;
    if(!csrf || !cookies.some(c=>c.name==='li_at')) throw new SyncError('authentication');
    // One bounded attempt; scheduling supplies retry/backoff. Never follow a login redirect.
    const response=await this.context.request.get('https://www.linkedin.com/voyager/api/'+path,{
      headers:{'csrf-token':csrf.replace(/^"|"$/g,''),'x-restli-protocol-version':'2.0.0',accept:'application/vnd.linkedin.normalized+json+2.1'},timeout:20_000,maxRedirects:0,
    });
    try {
      const status=response.status();
      if([301,302,303,307,308,401,403].includes(status)) throw new SyncError('authentication');
      if(status===429) throw new SyncError('rate_limited');
      if(status!==200) throw new SyncError('transport');
      const body=await response.body();
      if(body.length>8_000_000) throw new SyncError('incomplete');
      try{return JSON.parse(body.toString());}catch{throw new SyncError('incomplete');}
    } finally {await response.dispose();}
  }
  async identity() {
    const payload=object(await this.get('me')), data=object(payload.data);
    const ref=string(data['*miniProfile']);
    if(!/^urn:li:fs_miniProfile:[A-Za-z0-9_-]+$/.test(ref)) throw new SyncError('incomplete');
    this.self=profile(ref.replace('fs_miniProfile:','fsd_profile:'));
    return this.self;
  }
  async resolveProfile(url:string) {
    let parsed: URL;
    try { parsed=new URL(url); } catch { throw new SyncError('incomplete'); }
    if(parsed.protocol!=='https:' || !['linkedin.com','www.linkedin.com'].includes(parsed.hostname) || parsed.username || parsed.password || parsed.port || !/^\/in\/[A-Za-z0-9_-]+\/?$/.test(parsed.pathname)) throw new SyncError('incomplete');
    const slug=parsed.pathname.split('/')[2];
    const result=parseProfile(await this.get(`identity/dash/profiles?q=memberIdentity&memberIdentity=${encode(slug)}&decorationId=com.linkedin.voyager.dash.deco.identity.profile.FullProfileWithEntities-101`));
    // An internal /in/ACo... link must resolve back to the same immutable profile ID.
    if(slug.startsWith('ACo') && result.id!=='urn:li:fsd_profile:'+slug) throw new SyncError('identity_changed');
    return result;
  }
  async conversations(cursor:string|null) {
    if(!this.self) throw new SyncError('incomplete');
    return parseConversations(await this.get(`voyagerMessagingGraphQL/graphql?queryId=${this.queries.conversations}&variables=(query:(predicateUnions:List((conversationCategoryPredicate:(category:INBOX)))),count:20,mailboxUrn:${encode(this.self)}${cursor ? ',nextCursor:'+encode(cursor) : ''})`));
  }
  async messages(conversation:string,cursor:string|null) {
    return parseMessages(await this.get(`voyagerMessagingGraphQL/graphql?queryId=${this.queries.messages}&variables=(conversationUrn:${encode(conversation)}${cursor ? ',nextCursor:'+encode(cursor) : ''})`));
  }
}
