import type { NextApiRequest, NextApiResponse } from 'next';
import { getDb } from '@/lib/db';
import { configure, settings } from '@/lib/withdrawals/store';
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const db = getDb(), id = req.query.id as string;
  if (!db.prepare('SELECT id FROM workflows WHERE id=?').get(id)) return res.status(404).json({ error: 'Campaign not found' });
  if (req.method === 'PUT') {
    try { return res.json(configure(db, id, req.body)); }
    catch (e) { return res.status(400).json({ error: e instanceof Error ? e.message : 'Invalid withdrawal settings' }); }
  }
  if (req.method !== 'GET') return res.status(405).end();
  return res.json({ ...settings(db, id), jobs: db.prepare(`SELECT i.id AS invitation_id,i.target_id,i.profile_url,j.status,j.due_at,j.reason,j.attempts,j.checks
    FROM campaign_invitations i JOIN invitation_withdrawals j ON j.invitation_id=i.id
    WHERE i.workflow_id=? ORDER BY j.updated_at DESC LIMIT 100`).all(id) });
}
