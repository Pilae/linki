import type Database from 'better-sqlite3';
/** Durable campaign-scoped evidence. Snapshot recovery is allowed only when a
 * target belongs to exactly one campaign and the outcome follows enrollment. */
export function campaignMetrics(db: Database.Database, workflowId: string, days = 30) {
    db.exec(`CREATE TABLE IF NOT EXISTS campaign_outcome_events (
    workflow_id TEXT NOT NULL,target_id TEXT NOT NULL,kind TEXT NOT NULL,
    occurred_at TEXT NOT NULL,source TEXT NOT NULL,
    PRIMARY KEY(workflow_id,target_id,kind,occurred_at))`);
    const enrollments = db.prepare(`SELECT rp.target_id,r.workflow_id,MIN(rp.created_at) AS enrolled_at
    FROM run_profiles rp JOIN runs r ON r.id=rp.run_id GROUP BY rp.target_id,r.workflow_id`).all() as {
        target_id: string;
        workflow_id: string;
        enrolled_at: string;
    }[];
    const members = enrollments.filter(e => e.workflow_id === workflowId);
    const targets = db.prepare('SELECT * FROM targets').all() as Record<string, any>[];
    const byId = new Map(targets.map(t => [t.id, t]));
    const stamp = (v: string | null | undefined) => { if (!v)
        return null; const d = new Date(/[zZ]$|[+-]\d\d:\d\d$/.test(v) ? v : v.replace(' ', 'T') + 'Z'); return Number.isFinite(+d) ? d.toISOString() : null; };
    const insert = db.prepare('INSERT OR IGNORE INTO campaign_outcome_events VALUES(?,?,?,?,?)');
    const logs = db.prepare(`SELECT l.* FROM logs l JOIN runs r ON r.id=l.run_id WHERE r.workflow_id=? ORDER BY l.created_at`).all(workflowId) as {
        target_id: string;
        message: string;
        created_at: string;
    }[];
    db.transaction(() => {
        for (const l of logs) {
            const kind = [['Connection request sent', 'invitation'], ['Message sent', 'message'], ['InMail sent', 'inmail'], ['Email sent', 'email']].find(([prefix]) => l.message.startsWith(prefix))?.[1];
            const at = stamp(l.created_at);
            if (kind && at && l.target_id && !db.prepare("SELECT 1 FROM campaign_outcome_events WHERE workflow_id=? AND target_id=? AND kind=? AND source='runner' AND ABS(julianday(occurred_at)-julianday(?))*86400<5").get(workflowId, l.target_id, kind, at))
                insert.run(workflowId, l.target_id, kind, at, 'success-log');
        }
        for (const e of members) {
            const t = byId.get(e.target_id);
            if (!t || enrollments.filter(x => x.target_id === e.target_id).length !== 1)
                continue;
            for (const [field, kind] of [['connection_requested_at', 'invitation'], ['message_sent_at', 'message'], ['inmail_sent_at', 'inmail']]) {
                if (kind === 'message' && t.inmail_sent_at && stamp(t.message_sent_at) === stamp(t.inmail_sent_at))
                    continue;
                const at = stamp(t[field]);
                if (!at || at < (stamp(e.enrolled_at) || ''))
                    continue;
                const existing = db.prepare('SELECT 1 FROM campaign_outcome_events WHERE workflow_id=? AND target_id=? AND kind=? LIMIT 1').get(workflowId, e.target_id, kind);
                if (!existing)
                    insert.run(workflowId, e.target_id, kind, at, 'single-campaign-recorded-outcome');
            }
        }
    })();
    const events = db.prepare('SELECT * FROM campaign_outcome_events WHERE workflow_id=? ORDER BY occurred_at').all(workflowId) as {
        target_id: string;
        kind: string;
        occurred_at: string;
    }[];
    const ids = (kind: string) => new Set(events.filter(e => e.kind === kind).map(e => e.target_id));
    const invitations = ids('invitation'), messages = ids('message'), inmails = ids('inmail'), emails = ids('email');
    const liRecipients = new Set([...messages, ...inmails]);
    const first = (id: string, kinds: string[]) => events.find(e => e.target_id === id && kinds.includes(e.kind))?.occurred_at;
    let accepted = 0, acceptanceUnknown = 0, liReplies = 0, emailReplies = 0;
    for (const id of invitations) {
        const t = byId.get(id), connected = stamp(t?.connected_at), sent = first(id, ['invitation']);
        if (t?.degree === 1) {
            if (sent && connected && connected >= sent)
                accepted++;
            else
                acceptanceUnknown++;
        }
    }
    for (const id of liRecipients) {
        const reply = stamp(byId.get(id)?.last_replied_at), sent = first(id, ['message', 'inmail']);
        if (reply && sent && reply >= sent && enrollments.filter(e => e.target_id === id).length === 1)
            liReplies++;
    }
    for (const id of emails) {
        const reply = stamp(byId.get(id)?.email_replied_at), sent = first(id, ['email']);
        if (reply && sent && reply >= sent && enrollments.filter(e => e.target_id === id).length === 1)
            emailReplies++;
    }
    const states = db.prepare(`SELECT rp.target_id,rt.state FROM run_profiles rp JOIN runs r ON r.id=rp.run_id LEFT JOIN run_profile_tracks rt ON rt.run_profile_id=rp.id WHERE r.workflow_id=?`).all(workflowId) as {
        target_id: string;
        state: string | null;
    }[];
    const completed = members.filter(e => { const s = states.filter(x => x.target_id === e.target_id); return s.length > 0 && s.every(x => x.state === 'completed'); }).length;
    const funnel = { total: members.length, connections_sent: invitations.size, connected: members.filter(e => byId.get(e.target_id)?.degree === 1).length, accepted, acceptance_unknown: acceptanceUnknown, messages_sent: messages.size, inmails_sent: inmails.size, li_recipients: liRecipients.size, li_replies: liReplies, emails_sent: emails.size, email_replies: emailReplies, completed };
    const activity = [];
    const kindKey: Record<string, string> = { invitation: 'connections', message: 'messages', inmail: 'inmails', email: 'emails' };
    for (let i = days - 1; i >= 0; i--) {
        const d = new Date();
        d.setUTCDate(d.getUTCDate() - i);
        const day = d.toISOString().slice(0, 10);
        const row: Record<string, any> = { day, visits: logs.filter(l => l.message.startsWith('Visited') && stamp(l.created_at)?.startsWith(day)).length, connections: 0, messages: 0, inmails: 0, emails: 0 };
        for (const e of events)
            if (e.occurred_at.startsWith(day) && kindKey[e.kind])
                row[kindKey[e.kind]]++;
        activity.push(row);
    }
    return { funnel, activity };
}
export function recordCampaignOutcome(db: Database.Database, runId: string, targetId: string, kind: 'invitation' | 'message' | 'inmail' | 'email') {
    db.exec(`CREATE TABLE IF NOT EXISTS campaign_outcome_events (workflow_id TEXT NOT NULL,target_id TEXT NOT NULL,kind TEXT NOT NULL,occurred_at TEXT NOT NULL,source TEXT NOT NULL,PRIMARY KEY(workflow_id,target_id,kind,occurred_at))`);
    const run = db.prepare('SELECT workflow_id FROM runs WHERE id=?').get(runId) as {
        workflow_id: string;
    } | undefined;
    if (!run)
        throw new Error('Missing run for outcome');
    db.prepare('INSERT OR IGNORE INTO campaign_outcome_events VALUES(?,?,?,?,?)').run(run.workflow_id, targetId, kind, new Date().toISOString(), 'runner');
}
