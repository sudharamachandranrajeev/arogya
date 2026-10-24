import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { day, get, post, type User } from '../api.ts';

export function Schedule({ user }: { user: User }) {
  const [wl, setWl] = useState<any[]>([]);
  const [sel, setSel] = useState<any>(null);
  const [slots, setSlots] = useState<any[]>([]);
  const [back, setBack] = useState<any[]>([]);
  const [risk, setRisk] = useState<any>(null);
  const [err, setErr] = useState('');
  const canBook = ['clinician', 'nurse', 'reception'].includes(user.role);
  const load = () => { get('/api/waiting-list').then(setWl); get('/api/backfill').then(setBack); };
  useEffect(load, []);
  const pick = async (w: any) => {
    setSel(w); setErr(''); setRisk(null);
    setSlots((await get(`/api/slots?days=21&service=${encodeURIComponent(w.service)}`)).filter((s: any) => s.free).slice(0, 12));
  };
  const reserve = async (s: any) => {
    try {
      await post('/api/appointments/book', { patientId: sel.patientId, patientName: sel.patientName, practitionerId: s.practitionerId, start: s.start, end: s.end, service: sel.service, referralId: sel.id });
      setSel(null); setSlots([]); load();
    } catch (e: any) { setErr(e.message); pick(sel); }
  };
  return (
    <>
      <h2>Waiting list <span className="chip">{wl.length}</span></h2>
      {back.length > 0 && <div className="banner warn">Freed slots: best candidates to call first — {back.slice(0, 3).map((b) => `${b.patientName} (${b.service}, ${Math.round(b.dna.risk * 100)}% DNA risk)`).join('; ')}</div>}
      <div className="grid" style={{ gridTemplateColumns: '2fr 1fr' }}>
        <div className="card">
          <table>
            <thead><tr><th>Patient</th><th>Service</th><th>Priority</th><th>Waiting</th><th>Breach</th><th /></tr></thead>
            <tbody>{wl.map((w) => (
              <tr key={w.id}>
                <td><Link to={`/patients/${w.patientId}`}>{w.patientName}</Link></td><td>{w.service}</td>
                <td><span className={`chip ${w.priority === 'urgent' || w.priority === 'asap' ? 'warn' : ''}`}>{w.priority}</span></td>
                <td>{w.waitingDays} d</td>
                <td><span className={`chip ${w.breached ? 'bad' : w.daysToBreach <= 14 ? 'warn' : 'ok'}`}>{w.breached ? `${-w.daysToBreach} d over` : `${w.daysToBreach} d left`}</span></td>
                <td>{canBook && <button onClick={() => pick(w)}>Book</button>}</td>
              </tr>))}</tbody>
          </table>
        </div>
        <div className="card">
          <h3>{sel ? `Slots for ${sel.patientName}` : 'Pick a patient to book'}</h3>
          {err && <div className="err">{err}</div>}
          {sel && !slots.length && <div className="muted">No free slots in 3 weeks for {sel.service}. Add clinic sessions in Admin.</div>}
          {slots.map((s) => <div key={s.start + s.practitionerId} className="row" style={{ marginBottom: 4 }}>
            <button onClick={() => reserve(s)}>{day(s.start)} {s.start.slice(11, 16)}</button><span className="muted">{s.location}</span></div>)}
          {sel && <button style={{ marginTop: 8 }} onClick={async () => setRisk(await get(`/api/patients/${sel.patientId}/dna-risk?leadDays=14`))}>Check no-show risk</button>}
          {risk && <div>Risk {Math.round(risk.risk * 100)}%<ul>{risk.reasons.map((r: string) => <li key={r}>{r}</li>)}</ul></div>}
        </div>
      </div>
    </>
  );
}
