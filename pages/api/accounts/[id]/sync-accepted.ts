import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { syncAcceptedConnections } from "@/lib/linkedin/sync-accepted";
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
    if (req.method !== "POST")
        return res.status(405).end();
    const id = req.query.id as string;
    const account = getDb().prepare("SELECT is_authenticated FROM accounts WHERE id=?").get(id) as {
        is_authenticated: number;
    } | undefined;
    if (!account)
        return res.status(404).json({ error: "Account not found" });
    if (!account.is_authenticated)
        return res.status(400).json({ error: "Account not authenticated" });
    try {
        const count = await syncAcceptedConnections(id);
        return res.json({ newly_accepted: count, source: "connections-list" });
    }
    catch {
        return res.status(502).json({ error: "Connection verification failed or was incomplete. Check account authentication and retry verification; no outreach was started." });
    }
}
