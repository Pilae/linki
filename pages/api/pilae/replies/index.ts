import type { NextApiRequest, NextApiResponse } from 'next';
import { timingSafeEqual } from 'node:crypto';
import { getToken } from 'next-auth/jwt';
import { getDb } from '@/lib/db';
import { checkAccount } from '@/pilae/linkedin-replies/runtime';
import { migrate, state } from '@/pilae/linkedin-replies/store';
export default async function handler(req:NextApiRequest,res:NextApiResponse) {
  res.setHeader('Cache-Control','no-store');
  const supplied=Buffer.from(typeof req.headers['x-internal-secret']==='string'?req.headers['x-internal-secret']:''),expected=Buffer.from(process.env.INTERNAL_API_SECRET||'');
  const internal=expected.length>0 && supplied.length===expected.length && timingSafeEqual(supplied,expected);
  if(!internal && !await getToken({req,secret:process.env.NEXTAUTH_SECRET})) return res.status(401).json({error:'Not authenticated'});
  if(!['GET','POST'].includes(req.method||'')) return res.status(405).end();
  // Browser mutations require same-origin JSON; service calls use server credentials.
  if(req.method==='POST' && !internal) {
    const origin=process.env.NEXTAUTH_URL ? new URL(process.env.NEXTAUTH_URL).origin : null;
    if(!origin || req.headers.origin!==origin || !req.headers['content-type']?.startsWith('application/json')) return res.status(403).end();
  }
  const account=req.query.account;
  if(typeof account!=='string' || !/^[a-zA-Z0-9-]{1,100}$/.test(account)) return res.status(400).json({error:'Valid account required'});
  const db=getDb();migrate(db);
  if(!db.prepare('SELECT 1 FROM accounts WHERE id=?').get(account)) return res.status(404).end();
  if(req.method==='POST') {
    const s=state(db,account);
    if(s?.last_attempt && Date.now()-s.last_attempt<60_000) return res.status(429).json({error:'Wait one minute before checking again'});
    return res.json(await checkAccount(account));
  }
  const after=req.query.after===undefined ? 0 : Number(req.query.after);
  if(!Number.isSafeInteger(after)||after<0) return res.status(400).end();
  const rows=db.prepare('SELECT sequence,payload FROM pilae_reply_events WHERE account_id=? AND sequence>? ORDER BY sequence LIMIT 100').all(account,after) as {sequence:number;payload:string}[];
  const diagnostics={
    unsupportedConversations:(db.prepare('SELECT COUNT(*) AS n FROM pilae_reply_conversations WHERE account_id=? AND unsupported=1').get(account) as {n:number}).n,
    decisions:db.prepare('SELECT reason,COUNT(*) AS count FROM pilae_reply_decisions WHERE account_id=? GROUP BY reason').all(account),
  };
  return res.json({version:1,diagnostics,status:state(db,account)||null,events:rows.map(r=>JSON.parse(r.payload)),next:rows.at(-1)?.sequence||after,hasMore:rows.length===100});
}
