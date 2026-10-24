import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { age, fullName, get, post, type User } from '../api.ts';
import { Icon, si, useToast } from '../ui.tsx';

export function Patients({ user }: { user: User }) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<any[]>([]);
  const [adding, setAdding] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  useEffect(() => {
    if (q.trim().length < 2) { setRows([]); return; }
    const t = setTimeout(() => get(`/api/search/patients?q=${encodeURIComponent(q)}`).then(setRows), 180);
    return () => clearTimeout(t);
  }, [q]);
  const canAdd = ['clinician', 'nurse', 'reception'].includes(user.role);
  return (
    <>
      <div className="page-head"><div><h2>Patients</h2><div className="sub">Search by name, ID, phone or date of birth (YYYY-MM-DD)</div></div>
        {canAdd && <button className={adding ? '' : 'primary'} onClick={() => setAdding(!adding)}><Icon name="plus" size={16} />{adding ? 'Close' : 'Register patient'}</button>}</div>
      <div className="row" style={{ marginBottom: 14 }}>
        <div className="search"><Icon name="search" /><input ref={input} placeholder="e.g. asha nair 1980-01-01" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      </div>
      {adding && <Register onDone={() => setAdding(false)} />}
      {(rows.length > 0 || q.length >= 2) && (
        <div className="card">
          <div className="table-wrap"><table>
            <thead><tr><th>Name</th><th>Date of birth</th><th>Sex</th><th>ID</th><th>Phone</th></tr></thead>
            <tbody className="stagger">
              {rows.map((p, i) => (
                <tr key={p.id} style={si(i)}>
                  <td><Link to={`/patients/${p.id}`}><b>{fullName(p)}</b></Link> {p.meta?.security?.length ? <span className="chip bad"><Icon name="lock" size={11} /></span> : null}</td>
                  <td>{p.birthDate} <span className="muted">({age(p.birthDate)})</span></td><td>{p.gender}</td>
                  <td>{p.identifier?.[0]?.value}</td><td>{p.telecom?.find((t: any) => t.system === 'phone')?.value}</td>
                </tr>
              ))}
              {q.length >= 2 && !rows.length && <tr><td colSpan={5} className="muted">No match. Check spelling, or search by date of birth.</td></tr>}
            </tbody>
          </table></div>
        </div>
      )}
    </>
  );
}

function Register({ onDone }: { onDone: () => void }) {
  const [f, setF] = useState({ given: '', family: '', birthDate: '', gender: 'female', phone: '', identifier: '' });
  const [dups, setDups] = useState<any[]>([]);
  const [err, setErr] = useState('');
  const nav = useNavigate();
  const toast = useToast();
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  const save = async (force: boolean) => {
    setErr('');
    try {
      if (!force) {
        const d = await post('/api/patients/check-duplicate', f);
        if (d.length) { setDups(d); return; }
      }
      const p = await post('/fhir/Patient', {
        resourceType: 'Patient', active: true, name: [{ family: f.family.trim(), given: [f.given.trim()] }], gender: f.gender, birthDate: f.birthDate,
        identifier: f.identifier ? [{ system: 'urn:arogya:mrn', value: f.identifier.trim() }] : undefined,
        telecom: f.phone ? [{ system: 'phone', value: f.phone.trim() }] : undefined,
      });
      toast(`${f.given} ${f.family} registered`);
      onDone(); nav(`/patients/${p.id}`);
    } catch (e: any) { setErr(e.message); }
  };
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <h3>New patient</h3>
      <div className="row">
        <label>Given name<input value={f.given} onChange={set('given')} /></label>
        <label>Family name<input value={f.family} onChange={set('family')} /></label>
        <label>Date of birth<input type="date" max={new Date().toISOString().slice(0, 10)} value={f.birthDate} onChange={set('birthDate')} /></label>
        <label>Sex<select value={f.gender} onChange={set('gender')}><option>female</option><option>male</option><option>other</option><option>unknown</option></select></label>
        <label>Phone<input value={f.phone} onChange={set('phone')} inputMode="tel" /></label>
        <label>ID number<input value={f.identifier} onChange={set('identifier')} /></label>
      </div>
      {dups.length > 0 && (
        <div className="banner warn" style={{ marginTop: 12 }}><Icon name="alert" />
          <div className="grow">Possible duplicate. Open the existing record unless you are sure this is a different person.
            <ul style={{ margin: '6px 0' }}>{dups.map((d) => <li key={d.id}><Link to={`/patients/${d.id}`}>{fullName(d)}</Link> · {d.birthDate} · {d.why}</li>)}</ul></div>
          <button onClick={() => save(true)}>Different person: register</button>
        </div>
      )}
      {err && <div className="err">{err}</div>}
      <div className="row" style={{ marginTop: 12 }}><button className="primary" disabled={!f.family || !f.given || !f.birthDate} onClick={() => save(false)}>Register</button></div>
    </div>
  );
}
