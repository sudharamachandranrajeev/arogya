import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fullName, get, post, type User } from '../api.ts';
import { Icon, Skeleton, si, useToast } from '../ui.tsx';

const ROLES = ['admin', 'clinician', 'nurse', 'reception', 'manager', 'biller'];

export function Admin({ user }: { user: User }) {
  const [users, setUsers] = useState<any[] | null>(null);
  const [audit, setAudit] = useState<any[]>([]);
  const [chain, setChain] = useState<any>(null);
  const [sessions, setSessions] = useState<any[]>([]);
  const [targets, setTargets] = useState<Record<string, number>>({});
  const [refDays, setRefDays] = useState<Record<string, number>>({});
  const [sec, setSec] = useState<string[]>([]);
  const [pracs, setPracs] = useState<any[]>([]);
  const [nu, setNu] = useState({ username: '', name: '', role: 'clinician', password: '' });
  const [ns, setNs] = useState({ practitionerId: '', service: '', weekday: 1, start: '09:00', end: '13:00', slotMins: 20 });
  const [pass, setPass] = useState('');
  const [err, setErr] = useState('');
  const toast = useToast();
  const load = () => {
    get('/api/users').then(setUsers); get('/api/audit?limit=60').then(setAudit); get('/api/clinic-sessions').then(setSessions);
    get('/api/settings/targets').then(setTargets); get('/api/settings/referral-days').then(setRefDays); get('/api/settings/security').then((s) => setSec(s.mfaRoles));
    get('/fhir/Practitioner?_count=200').then((b) => setPracs((b.entry ?? []).map((e: any) => e.resource)));
  };
  useEffect(load, []);
  const run = (f: () => Promise<any>, ok: string) => async () => { setErr(''); try { await f(); toast(ok); load(); } catch (e: any) { setErr(e.message); toast(e.message, 'bad'); } };
  return (
    <>
      <div className="page-head"><div><h2>Administration</h2><div className="sub">Users, security, clinic set-up and audit. Administrators cannot open clinical records.</div></div></div>
      {err && <div className="banner bad"><Icon name="alert" /><div>{err}</div></div>}
      <div className="card">
        <h3>Users</h3>
        {!users ? <Skeleton rows={4} /> : <div className="table-wrap"><table>
          <thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Two-step</th><th>Status</th><th /></tr></thead>
          <tbody className="stagger">{users.map((u, i) => <tr key={u.id} style={si(i)}><td><b>{u.name}</b></td><td>{u.username}</td><td>{u.role}</td>
            <td>{u.mfa ? <span className="chip ok">on</span> : <span className={`chip ${sec.includes(u.role) ? 'bad' : ''}`}>off</span>}</td>
            <td><span className={`dot ${u.active ? 'ok' : ''}`} /> {u.active ? 'active' : 'disabled'}</td>
            <td className="num"><div className="row" style={{ justifyContent: 'end' }}>
              {u.mfa && u.id !== user.id && <button className="sm ghost" onClick={run(() => api('PATCH', `/api/users/${u.id}`, { resetMfa: true }), `Two-step reset for ${u.username}`)}>Reset two-step</button>}
              {u.id !== user.id && <button className={`sm ${u.active ? 'danger' : ''}`} onClick={run(() => api('PATCH', `/api/users/${u.id}`, { active: !u.active }), `${u.username} ${u.active ? 'disabled and signed out' : 'enabled'}`)}>{u.active ? 'Disable' : 'Enable'}</button>}
            </div></td></tr>)}</tbody>
        </table></div>}
        <div className="row section">
          <label>Username<input value={nu.username} onChange={(e) => setNu({ ...nu, username: e.target.value })} /></label>
          <label>Full name<input value={nu.name} onChange={(e) => setNu({ ...nu, name: e.target.value })} /></label>
          <label>Role<select value={nu.role} onChange={(e) => setNu({ ...nu, role: e.target.value })}>{ROLES.map((r) => <option key={r}>{r}</option>)}</select></label>
          <label>First password (12+)<input type="password" autoComplete="new-password" value={nu.password} onChange={(e) => setNu({ ...nu, password: e.target.value })} /></label>
          <button className="primary" disabled={!nu.username || !nu.name || nu.password.length < 12} onClick={run(() => post('/api/users', nu).then(() => setNu({ username: '', name: '', role: 'clinician', password: '' })), 'User added')}><Icon name="plus" size={14} />Add user</button>
        </div>
      </div>

      <div className="grid section">
        <div className="card">
          <h3><Icon name="shield" size={14} /> Require two-step verification</h3>
          <div className="row">{ROLES.map((r) => <label key={r} style={{ display: 'flex', gap: 6, alignItems: 'center', color: 'var(--ink)' }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={sec.includes(r)} onChange={(e) => setSec(e.target.checked ? [...sec, r] : sec.filter((x) => x !== r))} />{r}</label>)}</div>
          <div className="muted small" style={{ margin: '8px 0' }}>People in these roles must set it up at their next sign-in before they can open records.</div>
          <button onClick={run(() => api('PUT', '/api/settings/security', { mfaRoles: sec }), 'Security policy saved')}>Save policy</button>
        </div>
        <div className="card">
          <h3>Encrypted backup</h3>
          <div className="muted small" style={{ marginBottom: 8 }}>Downloads every record, encrypted with your passphrase (AES-256-GCM). Without the passphrase the file cannot be read or restored. Keep both safe and separate. {!user.mfa && <b>Turn on two-step verification first.</b>}</div>
          <div className="row"><label className="grow">Passphrase (12+ characters)<input type="password" autoComplete="new-password" value={pass} onChange={(e) => setPass(e.target.value)} /></label>
            <button disabled={!user.mfa || pass.length < 12} onClick={async () => {
              const r = await fetch('/api/admin/backup', { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'arogya' }, body: JSON.stringify({ passphrase: pass }) });
              if (!r.ok) { toast('Backup failed', 'bad'); return; }
              const name = /filename="([^"]+)"/.exec(r.headers.get('content-disposition') ?? '')?.[1] ?? 'arogya.arogya-backup';
              const a = document.createElement('a'); a.href = URL.createObjectURL(await r.blob()); a.download = name; a.click();
              setPass(''); toast('Backup downloaded');
            }}>Download backup</button></div>
          <div className="muted small" style={{ marginTop: 6 }}>Restore on a new server: <code>AROGYA_BACKUP_PASSPHRASE=… node server/main.ts restore file</code></div>
        </div>
      </div>

      <div className="grid section">
        <div className="card">
          <h3>Waiting-time targets (days)</h3>
          <div className="row">{Object.keys(targets).map((k) => <label key={k}>{k}<input type="number" min={1} style={{ width: 84 }} value={targets[k]} onChange={(e) => setTargets({ ...targets, [k]: Number(e.target.value) })} /></label>)}
            <button onClick={run(() => api('PUT', '/api/settings/targets', targets), 'Targets saved')}>Save</button></div>
          <h3 className="section">Referrals out: chase after (days)</h3>
          <div className="row">{Object.keys(refDays).map((k) => <label key={k}>{k === 'acknowledge' ? 'no acknowledgement' : k === 'book' ? 'no appointment' : 'no report'}<input type="number" min={1} max={365} style={{ width: 84 }} value={refDays[k]} onChange={(e) => setRefDays({ ...refDays, [k]: Number(e.target.value) })} /></label>)}
            <button onClick={run(() => api('PUT', '/api/settings/referral-days', refDays), 'Referral deadlines saved')}>Save</button></div>
        </div>
        <div className="card">
          <h3>Clinic sessions</h3>
          {sessions.map((s) => <div key={s.id} className="list-item"><b style={{ width: 40 }}>{['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][s.weekday]}</b>{s.start_time}–{s.end_time}<span className="chip">{s.service}</span>
            <span className="muted small">{fullName(pracs.find((p) => p.id === s.practitioner_id)) || 'unknown'} · {s.slot_mins} min</span>
            <button className="sm ghost danger" style={{ marginLeft: 'auto' }} onClick={run(() => api('DELETE', `/api/clinic-sessions/${s.id}`), 'Session removed')}>Remove</button></div>)}
          <div className="row section">
            <label>Clinician<select value={ns.practitionerId} onChange={(e) => setNs({ ...ns, practitionerId: e.target.value })}><option value="">Choose…</option>{pracs.map((p) => <option key={p.id} value={p.id}>{fullName(p)}</option>)}</select></label>
            <label>Service<input value={ns.service} onChange={(e) => setNs({ ...ns, service: e.target.value })} /></label>
            <label>Day<select value={ns.weekday} onChange={(e) => setNs({ ...ns, weekday: Number(e.target.value) })}>{['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((d, i) => <option key={d} value={i}>{d}</option>)}</select></label>
            <label>From<input type="time" value={ns.start} onChange={(e) => setNs({ ...ns, start: e.target.value })} /></label>
            <label>To<input type="time" value={ns.end} onChange={(e) => setNs({ ...ns, end: e.target.value })} /></label>
            <label>Slot (min)<input type="number" min={5} style={{ width: 70 }} value={ns.slotMins} onChange={(e) => setNs({ ...ns, slotMins: Number(e.target.value) })} /></label>
            <button disabled={!ns.practitionerId || !ns.service} onClick={run(() => post('/api/clinic-sessions', ns), 'Session added')}>Add</button>
          </div>
        </div>
      </div>
      <Integrity />
      <Reminders />

      <div className="card section">
        <h3>Audit trail <button className="sm" onClick={async () => setChain(await get('/api/audit/verify'))}>Verify integrity</button>
          {chain && <span className={`chip ${chain.ok ? 'ok' : 'bad'}`}>{chain.ok ? `intact · ${chain.checked} entries` : `broken at #${chain.brokenAt}`}</span>}</h3>
        <div className="table-wrap"><table>
          <thead><tr><th>Time</th><th>User</th><th>Action</th><th>Record</th><th>Reason</th></tr></thead>
          <tbody>{audit.map((a) => <tr key={a.seq}><td className="muted">{String(a.at).slice(0, 19).replace('T', ' ')}</td><td>{a.username}</td><td>{a.action}</td>
            <td>{a.patient_id ? <Link to={`/patients/${a.patient_id}`}>{a.resource_type} · access report</Link> : a.resource_type}</td><td>{a.reason && <span className="chip bad">{a.reason}</span>}</td></tr>)}</tbody>
        </table></div>
      </div>
    </>
  );
}

const TONE: Record<string, string> = { ok: 'ok', warn: 'warn', fail: 'bad' };

/** System integrity: the last check (the server runs one daily), a button to run one now, and the one safe automatic repair. */
function Integrity() {
  const [r, setR] = useState<any>(undefined);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  useEffect(() => { get('/api/admin/integrity').then(setR); }, []);
  const run = async () => { setBusy(true); try { setR(await post('/api/admin/integrity')); } catch (e: any) { toast(e.message, 'bad'); } setBusy(false); };
  const reindex = async () => {
    setBusy(true);
    try { const x = await post('/api/admin/integrity/reindex'); toast(`Search index rebuilt for ${x.reindexed} records`); setR(await post('/api/admin/integrity')); } catch (e: any) { toast(e.message, 'bad'); }
    setBusy(false);
  };
  return (
    <div className="card section">
      <h3><Icon name="shield" size={14} /> System integrity
        {r && <span className={`chip ${TONE[r.status]}`}>{r.status === 'ok' ? 'all checks pass' : r.status === 'warn' ? 'needs attention' : 'problems found'}</span>}
        <button className="sm" style={{ marginLeft: 'auto' }} disabled={busy} onClick={run}>{busy ? 'Checking…' : 'Run check now'}</button></h3>
      <div className="muted small" style={{ marginBottom: 8 }}>Checks the audit trail, search index, version history, references between records, open work, double bookings, keys and backups. It runs every day; results name record ids only.
        {r && <> Last run {String(r.at).slice(0, 16).replace('T', ' ')} in {r.ms} ms.</>}</div>
      {r === undefined ? <Skeleton rows={4} /> : !r ? <div className="muted">No check has run yet.</div> : <div className="checks stagger">{r.checks.map((c: any, i: number) => (
        <div key={c.key} className={`check ${c.status}`} style={si(i)}>
          <span className={`dot ${TONE[c.status]}`} />
          <div className="grow"><b>{c.name}</b> <span className="muted">{c.summary}</span>
            {c.items?.length > 0 && <details><summary className="small">{c.items.length} shown</summary><ul className="small mono">{c.items.map((x: string) => <li key={x}>{x}</li>)}</ul></details>}</div>
          {c.key === 'index' && c.status !== 'ok' && <button className="sm primary" disabled={busy} onClick={reindex}>Rebuild index</button>}
        </div>))}</div>}
      {r?.anchor && <div className="muted small section">Audit head <code>#{r.anchor.seq} {r.anchor.hash.slice(0, 16)}…</code> — keep a copy of this outside the server; a later check must still contain it.</div>}
    </div>
  );
}

function Reminders() {
  const [f, setF] = useState<any>(null);
  const [box, setBox] = useState<any[]>([]);
  const [secret, setSecret] = useState('');
  const toast = useToast();
  const load = () => { get('/api/settings/reminders').then(setF); get('/api/reminders/outbox').then(setBox); };
  useEffect(load, []);
  if (!f) return <div className="card section"><Skeleton rows={4} /></div>;
  const save = (extra: object = {}) => api('PUT', '/api/settings/reminders', { ...f, ...extra })
    .then((r) => { if (r.secret) setSecret(r.secret); toast('Reminder settings saved'); load(); }).catch((e) => toast(e.message, 'bad'));
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.type === 'number' ? Number(e.target.value) : e.target.value });
  return (
    <div className="card section">
      <h3>Appointment reminders</h3>
      <div className="muted small" style={{ marginBottom: 8 }}>Texts go through your SMS gateway: Arogya POSTs <code>{'{id, channel, to, text}'}</code> as JSON with an <code>X-Arogya-Signature</code> HMAC-SHA256 header. Messages give only the date, time and clinic, never the service or reason. Restricted records and patients who opted out get none.</div>
      <div className="row">
        <label className="radio"><input type="checkbox" checked={f.enabled} onChange={set('enabled')} />Send reminders</label>
        <label>Hours before<input type="number" min={1} max={168} style={{ width: 84 }} value={f.hoursBefore} onChange={set('hoursBefore')} /></label>
        <label className="grow">Gateway URL (https)<input value={f.webhookUrl} onChange={set('webhookUrl')} placeholder="https://sms.example.org/send" /></label>
        <label>Clinic name<input value={f.clinicName} onChange={set('clinicName')} /></label>
        <label>Clinic phone<input value={f.clinicPhone} onChange={set('clinicPhone')} /></label>
        <label className="radio"><input type="checkbox" checked={!!f.twoWay} onChange={set('twoWay')} />Patients can reply</label>
      </div>
      {f.twoWay && <div className="muted small" style={{ marginTop: 8 }}>Replies: your gateway POSTs <code>{'{messageId, inReplyTo, from, text}'}</code> to <code>{location.origin}/api/reminders/reply</code> with <code>X-Arogya-Timestamp</code> (Unix seconds) and <code>X-Arogya-Signature</code> = HMAC-SHA256 of <code>timestamp.body</code>. C confirms, X cancels and offers the slot to the waiting list, STOP ends reminders; anything else goes to reception's inbox.</div>}
      {secret && <div className="banner warn" style={{ marginTop: 10 }}><Icon name="lock" /><div>Signing secret, shown once. Put it in your gateway now: <code className="secret">{secret}</code></div></div>}
      <div className="row" style={{ marginTop: 10 }}>
        <button className="primary" onClick={() => save()}>Save</button>
        {f.hasSecret && <button onClick={() => save({ rotate: true })}>New signing secret</button>}
        <button disabled={!f.enabled} onClick={() => api('POST', '/api/admin/reminders/run').then((r) => { toast(`${r.queued} queued · ${r.sent} sent · ${r.failed} failed`); load(); }).catch((e) => toast(e.message, 'bad'))}>Send due now</button>
      </div>
      {box.length > 0 && <div className="table-wrap section"><table>
        <thead><tr><th>Appointment</th><th>Patient</th><th>Status</th></tr></thead>
        <tbody>{box.slice(0, 20).map((m) => <tr key={m.id}><td>{String(m.start ?? '').slice(0, 16).replace('T', ' ')}</td><td>{m.patient ?? ''}</td>
          <td><span className={`chip ${m.status === 'sent' ? 'ok' : m.status === 'failed' ? 'bad' : m.status === 'skipped' ? '' : 'warn'}`}>{m.status}</span> <span className="muted small">{m.detail}</span>
            {m.reply && <span className={`chip ${m.reply === 'confirmed' ? 'ok' : m.reply === 'cancelled' ? 'warn' : 'info'}`} style={{ marginLeft: 6 }}>replied: {m.reply}</span>}</td></tr>)}</tbody>
      </table></div>}
    </div>
  );
}
