import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { age, fullName, get, post, type User } from '../api.ts';
import { Empty, Icon, Skeleton, si, useToast } from '../ui.tsx';

export function Patients({ user }: { user: User }) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<any[]>([]);
  const [adding, setAdding] = useState(false);
  const [dupes, setDupes] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  useEffect(() => {
    if (q.trim().length < 2) { setRows([]); return; }
    const t = setTimeout(() => get(`/api/search/patients?q=${encodeURIComponent(q)}`).then(setRows), 180);
    return () => clearTimeout(t);
  }, [q]);
  const canAdd = ['clinician', 'nurse', 'reception'].includes(user.role);
  const canMerge = ['clinician', 'reception'].includes(user.role);
  return (
    <>
      <div className="page-head"><div><h2>Patients</h2><div className="sub">Search by name, ID, phone or date of birth (YYYY-MM-DD)</div></div>
        <div className="row">{canMerge && <button className={dupes ? 'primary' : ''} onClick={() => setDupes(!dupes)}><Icon name="merge" size={16} />Possible duplicates</button>}
        {canAdd && <button className={adding ? '' : 'primary'} onClick={() => setAdding(!adding)}><Icon name="plus" size={16} />{adding ? 'Close' : 'Register patient'}</button>}</div></div>
      {dupes && <Duplicates />}
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

const card = (p: any) => [p.birthDate, p.gender, p.identifier?.map((i: any) => i.value).join(', '), p.telecom?.find((t: any) => t.system === 'phone')?.value].filter(Boolean).join(' · ');

function Duplicates() {
  const [pairs, setPairs] = useState<any[] | null>(null);
  const [merges, setMerges] = useState<any[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const [keep, setKeep] = useState('');
  const [reason, setReason] = useState('');
  const toast = useToast();
  const load = () => { get('/api/duplicates').then(setPairs); get('/api/merges').then(setMerges); };
  useEffect(load, []);
  const run = (f: () => Promise<any>, ok: string) => f().then(() => { toast(ok); setOpen(null); setReason(''); load(); }).catch((e) => toast(e.message, 'bad'));
  const name = (n: any) => n ? n.text ?? [n.given?.join(' '), n.family].filter(Boolean).join(' ') : 'unknown';
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <h3>Possible duplicates</h3>
      <div className="muted small" style={{ marginBottom: 10 }}>Records that look like the same person, with the reasons. Check with the patient or their ID before merging: a wrong merge puts one person's allergies and results in another's record. Restricted records are not listed.</div>
      {!pairs ? <Skeleton rows={3} h={40} /> : !pairs.length ? <Empty>No likely duplicates.</Empty> : <div className="stagger" style={{ display: 'grid', gap: 10 }}>{pairs.map((d, i) => (
        <div key={d.a.id + d.b.id} className="dup" style={si(i)}>
          <div className="row" style={{ alignItems: 'stretch' }}>
            {[d.a, d.b].map((p) => <div key={p.id} className="grow dup-side">
              <Link to={`/patients/${p.id}`}><b>{fullName(p)}</b></Link><div className="muted small">{card(p)}</div><div className="small">{p.records} linked records</div>
            </div>)}
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <span className={`chip ${d.score >= 0.8 ? 'bad' : 'warn'}`}>{Math.round(d.score * 100)}% match</span>
            {d.why.map((w: string) => <span key={w} className={`chip ${w.startsWith('different') ? 'ok' : ''}`}>{w}</span>)}
            <span className="grow" />
            <button className="sm ghost" onClick={() => run(() => post('/api/duplicates/dismiss', { a: d.a.id, b: d.b.id }), 'Marked as different people')}>Not the same person</button>
            <button className="sm" onClick={() => { setOpen(open === i ? null : i); setKeep(d.a.records >= d.b.records ? d.a.id : d.b.id); }}>Merge…</button>
          </div>
          {open === i && <div className="merge-box">
            <div className="small" style={{ marginBottom: 6 }}>Keep which record? Everything linked to the other one moves into it, and the other is retired. Old ID numbers stay searchable. You can undo this below.</div>
            <div className="row">{[d.a, d.b].map((p) => <label key={p.id} className="radio"><input type="radio" name={`keep${i}`} checked={keep === p.id} onChange={() => setKeep(p.id)} />Keep {fullName(p)} ({p.identifier?.[0]?.value})</label>)}</div>
            <div className="row" style={{ marginTop: 8 }}>
              <input className="grow" placeholder="How you confirmed it is the same person, e.g. checked photo ID and address" value={reason} onChange={(e) => setReason(e.target.value)} />
              <button className="primary" disabled={reason.trim().length < 10} onClick={() => run(() => post('/api/patients/merge', { keepId: keep, mergeId: keep === d.a.id ? d.b.id : d.a.id, reason }), 'Records merged')}>Merge records</button>
            </div>
          </div>}
        </div>))}</div>}
      {merges.length > 0 && <>
        <h3 className="section">Merge history</h3>
        <div className="table-wrap"><table>
          <thead><tr><th>When</th><th>Kept</th><th>Merged in</th><th>By</th><th>Reason</th><th /></tr></thead>
          <tbody>{merges.map((m) => <tr key={m.id}>
            <td className="muted">{String(m.at).slice(0, 16).replace('T', ' ')}</td>
            <td><Link to={`/patients/${m.keep_id}`}>{name(m.keep_name)}</Link></td><td><Link to={`/patients/${m.merged_id}`}>{name(m.merged_name)}</Link> <span className="muted small">{m.moved} records</span></td>
            <td>{m.by_name}</td><td className="muted">{m.reason}</td>
            <td className="num">{m.undone_at ? <span className="chip">undone</span> : <button className="sm" onClick={() => run(() => post(`/api/merges/${m.id}/undo`), 'Merge undone')}>Undo</button>}</td>
          </tr>)}</tbody>
        </table></div>
      </>}
    </div>
  );
}
