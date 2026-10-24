import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { age, fullName, get, post, type User } from '../api.ts';

export function Patients({ user }: { user: User }) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<any[]>([]);
  const [adding, setAdding] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  useEffect(() => {
    if (q.trim().length < 2) { setRows([]); return; }
    const t = setTimeout(() => get(`/api/search/patients?q=${encodeURIComponent(q)}`).then(setRows), 200);
    return () => clearTimeout(t);
  }, [q]);
  const canAdd = ['clinician', 'nurse', 'reception'].includes(user.role);
  return (
    <>
      <h2>Patients</h2>
      <div className="row" style={{ marginBottom: 12 }}>
        <input ref={input} style={{ flex: 1, minWidth: 240 }} placeholder="Name, ID number, phone or date of birth (YYYY-MM-DD)" value={q} onChange={(e) => setQ(e.target.value)} />
        {canAdd && <button onClick={() => setAdding(!adding)}>{adding ? 'Cancel' : 'New patient'}</button>}
      </div>
      {adding && <Register onDone={() => setAdding(false)} />}
      <div className="card">
        <table>
          <thead><tr><th>Name</th><th>Age</th><th>Sex</th><th>ID</th><th>Phone</th></tr></thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id}>
                <td><Link to={`/patients/${p.id}`}>{fullName(p)}</Link></td>
                <td>{age(p.birthDate)}</td><td>{p.gender}</td>
                <td>{p.identifier?.[0]?.value}</td><td>{p.telecom?.find((t: any) => t.system === 'phone')?.value}</td>
              </tr>
            ))}
            {q.length >= 2 && !rows.length && <tr><td colSpan={5} className="muted">No match.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Register({ onDone }: { onDone: () => void }) {
  const [f, setF] = useState({ given: '', family: '', birthDate: '', gender: 'female', phone: '', identifier: '' });
  const [dups, setDups] = useState<any[]>([]);
  const [err, setErr] = useState('');
  const nav = useNavigate();
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  const save = async (force: boolean) => {
    setErr('');
    try {
      if (!force) {
        const d = await post('/api/patients/check-duplicate', f);
        if (d.length) { setDups(d); return; }
      }
      const p = await post('/fhir/Patient', {
        resourceType: 'Patient', active: true, name: [{ family: f.family, given: [f.given] }], gender: f.gender, birthDate: f.birthDate,
        identifier: f.identifier ? [{ system: 'urn:arogya:mrn', value: f.identifier }] : undefined,
        telecom: f.phone ? [{ system: 'phone', value: f.phone }] : undefined,
      });
      onDone(); nav(`/patients/${p.id}`);
    } catch (e: any) { setErr(e.message); }
  };
  return (
    <div className="card">
      <div className="row">
        <label>Given name<input value={f.given} onChange={set('given')} /></label>
        <label>Family name<input value={f.family} onChange={set('family')} /></label>
        <label>Date of birth<input type="date" value={f.birthDate} onChange={set('birthDate')} /></label>
        <label>Sex<select value={f.gender} onChange={set('gender')}><option>female</option><option>male</option><option>other</option><option>unknown</option></select></label>
        <label>Phone<input value={f.phone} onChange={set('phone')} /></label>
        <label>ID number<input value={f.identifier} onChange={set('identifier')} /></label>
      </div>
      {dups.length > 0 && (
        <div className="banner warn" style={{ marginTop: 10 }}>
          Possible duplicate. Open the existing record unless you are sure this is a different person.
          <ul>{dups.map((d) => <li key={d.id}><Link to={`/patients/${d.id}`}>{fullName(d)}</Link> · {d.birthDate} · {d.why}</li>)}</ul>
          <button onClick={() => save(true)}>Register anyway</button>
        </div>
      )}
      {err && <div className="err">{err}</div>}
      <p><button className="primary" disabled={!f.family || !f.given || !f.birthDate} onClick={() => save(false)}>Register</button></p>
    </div>
  );
}
