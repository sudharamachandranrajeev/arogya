import { useEffect, useState } from 'react';
import { get, api, post } from '../api.ts';

export function Admin() {
  const [users, setUsers] = useState<any[]>([]);
  const [audit, setAudit] = useState<any[]>([]);
  const [chain, setChain] = useState<any>(null);
  const [sessions, setSessions] = useState<any[]>([]);
  const [targets, setTargets] = useState<Record<string, number>>({});
  const [nu, setNu] = useState({ username: '', name: '', role: 'clinician', password: '' });
  const [ns, setNs] = useState({ practitionerId: '', service: '', weekday: 1, start: '09:00', end: '13:00', slotMins: 20 });
  const [err, setErr] = useState('');
  const load = () => {
    get('/api/users').then(setUsers); get('/api/audit?limit=50').then(setAudit); get('/api/clinic-sessions').then(setSessions); get('/api/settings/targets').then(setTargets);
  };
  useEffect(load, []);
  const guard = (f: () => Promise<any>) => async () => { setErr(''); try { await f(); load(); } catch (e: any) { setErr(e.message); } };
  return (
    <>
      <h2>Administration</h2>
      {err && <div className="err">{err}</div>}
      <h3>Users</h3>
      <div className="card">
        <table><tbody>{users.map((u) => <tr key={u.id}><td>{u.name}</td><td>{u.username}</td><td>{u.role}</td><td>{u.active ? 'active' : 'disabled'}</td>
          <td><button onClick={guard(() => api('PATCH', `/api/users/${u.id}`, { active: !u.active }))}>{u.active ? 'Disable' : 'Enable'}</button></td></tr>)}</tbody></table>
        <div className="row" style={{ marginTop: 10 }}>
          <label>Username<input value={nu.username} onChange={(e) => setNu({ ...nu, username: e.target.value })} /></label>
          <label>Name<input value={nu.name} onChange={(e) => setNu({ ...nu, name: e.target.value })} /></label>
          <label>Role<select value={nu.role} onChange={(e) => setNu({ ...nu, role: e.target.value })}>{['admin', 'clinician', 'nurse', 'reception', 'manager', 'biller'].map((r) => <option key={r}>{r}</option>)}</select></label>
          <label>Password (12+)<input type="password" value={nu.password} onChange={(e) => setNu({ ...nu, password: e.target.value })} /></label>
          <button className="primary" onClick={guard(() => post('/api/users', nu))}>Add user</button>
        </div>
      </div>
      <h3>Waiting-time targets (days)</h3>
      <div className="card row">
        {Object.keys(targets).map((k) => <label key={k}>{k}<input type="number" style={{ width: 80 }} value={targets[k]} onChange={(e) => setTargets({ ...targets, [k]: Number(e.target.value) })} /></label>)}
        <button onClick={guard(() => api('PUT', '/api/settings/targets', targets))}>Save</button>
      </div>
      <h3>Clinic sessions</h3>
      <div className="card">
        <table><tbody>{sessions.map((s) => <tr key={s.id}><td>{['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][s.weekday]}</td><td>{s.start_time}–{s.end_time}</td><td>{s.service}</td><td>{s.slot_mins} min</td>
          <td><button className="danger" onClick={guard(() => api('DELETE', `/api/clinic-sessions/${s.id}`))}>Remove</button></td></tr>)}</tbody></table>
        <div className="row" style={{ marginTop: 10 }}>
          <label>Practitioner ID<input value={ns.practitionerId} onChange={(e) => setNs({ ...ns, practitionerId: e.target.value })} /></label>
          <label>Service<input value={ns.service} onChange={(e) => setNs({ ...ns, service: e.target.value })} /></label>
          <label>Weekday (0=Sun)<input type="number" min={0} max={6} style={{ width: 70 }} value={ns.weekday} onChange={(e) => setNs({ ...ns, weekday: Number(e.target.value) })} /></label>
          <label>From<input value={ns.start} onChange={(e) => setNs({ ...ns, start: e.target.value })} style={{ width: 70 }} /></label>
          <label>To<input value={ns.end} onChange={(e) => setNs({ ...ns, end: e.target.value })} style={{ width: 70 }} /></label>
          <button onClick={guard(() => post('/api/clinic-sessions', ns))}>Add session</button>
        </div>
      </div>
      <h3>Audit trail <button style={{ marginLeft: 8 }} onClick={async () => setChain(await get('/api/audit/verify'))}>Verify integrity</button> {chain && <span className={`chip ${chain.ok ? 'ok' : 'bad'}`}>{chain.ok ? `intact, ${chain.checked} entries` : `broken at #${chain.brokenAt}`}</span>}</h3>
      <div className="card"><table><thead><tr><th>Time</th><th>User</th><th>Action</th><th>Record</th><th>Reason</th></tr></thead>
        <tbody>{audit.map((a) => <tr key={a.seq}><td>{String(a.at).slice(0, 19).replace('T', ' ')}</td><td>{a.username}</td><td>{a.action}</td><td>{a.resource_type} {a.resource_id?.slice(0, 8)}</td><td>{a.reason}</td></tr>)}</tbody></table></div>
    </>
  );
}
