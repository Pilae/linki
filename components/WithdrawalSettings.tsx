import { useEffect, useState } from 'react';
export default function WithdrawalSettings({ workflowId }: { workflowId: string }) {
  const [enabled, setEnabled] = useState(false), [wasEnabled, setWasEnabled] = useState(false);
  const [days, setDays] = useState('30'), [existing, setExisting] = useState('');
  const [ready, setReady] = useState(false), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const [jobs, setJobs] = useState<Array<{ invitation_id: string; target_id: string; profile_url: string; status: string; reason: string }>>([]);
  const url = `/api/workflows/${workflowId}/withdrawals`;
  useEffect(() => {
    let cancelled = false;
    fetch(url).then(async r => { if (!r.ok) throw Error('Could not load withdrawal settings'); return r.json(); }).then(s => {
      if (cancelled) return;
      setEnabled(!!s.enabled); setWasEnabled(!!s.enabled); setDays(String(s.days)); setJobs(s.jobs); setReady(true);
    }).catch(e => { if (!cancelled) setMessage(e.message); });
    return () => { cancelled = true; };
  }, [url]);
  async function save() {
    setBusy(true); setMessage('');
    try {
      const r = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled, days: Number(days), ...(enabled && !wasEnabled ? { existing } : {}) }) });
      const s = await r.json(); if (!r.ok) throw Error(s.error);
      setWasEnabled(!!s.enabled); setExisting(''); setMessage('Withdrawal settings saved.');
    } catch (e) { setMessage(e instanceof Error ? e.message : 'Save failed'); }
    finally { setBusy(false); }
  }
  return <details className="border border-base-300 rounded-lg p-4 my-4">
    <summary className="font-semibold cursor-pointer">Invitation withdrawal settings</summary>
    <fieldset disabled={!ready || busy} className="mt-3 space-y-3">
      <label className="flex items-center gap-2"><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />Withdraw unanswered invitations</label>
      <label className="flex items-center gap-2 flex-wrap">Withdraw invitations that haven’t been accepted after
        <input aria-label="Withdrawal delay in days" className="input input-bordered input-sm w-24" type="number" min="1" max="365" step="1" value={days} onChange={e => setDays(e.target.value)} /> days.</label>
      <p className="text-sm">Eligible N × 24 hours after the verified send time; withdrawal may occur later during the next successful check. Only invitations with verified campaign, recipient and account ownership qualify.</p>
      <p className="text-sm">Changing the delay recalculates pending work. Disabling cancels work that has not started. Paused campaigns suspend withdrawals; completed campaigns continue. Stopping, archiving or deleting cancels pending work. An action already started must still be verified.</p>
      {enabled && !wasEnabled && <label className="block text-sm">Apply to
        <select aria-label="Existing invitations" className="select select-bordered select-sm ml-2" value={existing} onChange={e => setExisting(e.target.value)}>
          <option value="" disabled>Choose explicitly…</option>
          <option value="future_only">Future invitations only</option>
          <option value="include_verified">Include existing verified campaign invitations</option>
        </select>
      </label>}
      <p className="text-sm">Withdrawals cannot be undone. LinkedIn may prevent reinviting the same person for up to three weeks. Linki will not automatically resend or continue the LinkedIn sequence; email progress is preserved.</p>
      <button className="btn btn-sm" disabled={enabled && !wasEnabled && !existing} onClick={save}>Save withdrawal settings</button>
    </fieldset>
    {message && <p role="status" className="mt-2 text-sm">{message}</p>}
    {jobs.length > 0 && <ul className="mt-3 text-sm">{jobs.map(j => <li key={j.invitation_id}>{j.profile_url}: {j.status.replaceAll('_', ' ')}{j.reason ? ` — ${j.reason}` : ''}</li>)}</ul>}
  </details>;
}
