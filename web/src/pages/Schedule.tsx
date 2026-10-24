import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { get, post, type User } from '../api.ts';
import { Empty, Icon, Skeleton, si, useToast } from '../ui.tsx';

export function Schedule({ user }: { user: User }) {
  const [wl, setWl] = useState<any[] | null>(null);
  const [sel, setSel] = useState<any>(null);
  const [slots, setSlots] = useState<any[] | null>(null);
  const [back, setBack] = useState<any[]>([]);
  const [risk, setRisk] = useState<any>(null);
  const [filter, setFilter] = useState('');
  const [err, setErr] = useState('');
  const toast = useToast();
  const canBook = ['clinician', 'nurse', 'reception'].includes(user.role);
  const [params, setParams] = useSearchParams();
  const load = () => { get('/api/waiting-list').then(setWl); get('/api/backfill').then(setBack); };
  useEffect(load, []);
  // Arriving from a recall: book that patient straight away, with no referral behind it.
  useEffect(() => {
    const patientId = params.get('patient');
    if (patientId) { pick({ patientId, patientName: params.get('name') ?? '', service: params.get('service') ?? '', reason: params.get('reason') ?? undefined }); setParams({}, { replace: true }); }
  }, []);
  const pick = async (w: any) => {
    setSel(w); setErr(''); setRisk(null); setSlots(null);
    setSlots((await get(`/api/slots?days=21&service=${encodeURIComponent(w.service)}`)).filter((s: any) => s.free).slice(0, 15));
    get(`/api/patients/${w.patientId}/dna-risk?leadDays=14`).then(setRisk).catch(() => {});
  };
  const reserve = async (s: any) => {
    try {
      await post('/api/appointments/book', { patientId: sel.patientId, patientName: sel.patientName, practitionerId: s.practitionerId, start: s.start, end: s.end, service: sel.service || s.service, referralId: sel.id, reason: sel.reason });
      toast(`${sel.patientName} booked ${s.start.slice(0, 10)} at ${s.start.slice(11, 16)}`);
      setSel(null); setSlots(null); load();
    } catch (e: any) { setErr(e.message); pick(sel); }
  };
  const shown = (wl ?? []).filter((w) => !filter || w.service === filter);
  const services = [...new Set((wl ?? []).map((w) => w.service))];
  return (
    <>
      <div className="page-head">
        <div><h2>Waiting list</h2><div className="sub">{wl ? `${wl.length} waiting · ${wl.filter((w) => w.breached).length} past target · longest first by breach date` : 'Loading…'}</div></div>
        <div className="row">{['', ...services].map((s) => <button key={s} className={`sm ${filter === s ? 'primary' : 'ghost'}`} onClick={() => setFilter(s)}>{s || 'All services'}</button>)}</div>
      </div>
      {back.length > 0 && <div className="banner warn"><Icon name="today" /><div><b>A slot was freed.</b> Call first: {back.slice(0, 3).map((b) => `${b.patientName} (${b.service}, ${b.breached ? 'past target' : `${b.daysToBreach} d left`})`).join(' · ')}</div></div>}
      <div className="split">
        <div className="card">
          {!wl ? <Skeleton rows={8} h={28} /> : !shown.length ? <Empty>No one waiting.</Empty> : <div className="table-wrap"><table>
            <thead><tr><th>Patient</th><th>Service</th><th>Priority</th><th className="num">Waiting</th><th>Target</th><th /></tr></thead>
            <tbody className="stagger">{shown.map((w, i) => (
              <tr key={w.id} style={{ ...si(i), background: sel?.id === w.id ? 'var(--brand-soft)' : undefined }}>
                <td><Link to={`/patients/${w.patientId}`}><b>{w.patientName}</b></Link></td><td>{w.service}</td>
                <td><span className={`chip ${w.priority === 'routine' ? '' : 'warn'}`}>{w.priority}</span></td>
                <td className="num">{w.waitingDays} d</td>
                <td><span className={`chip ${w.breached ? 'bad' : w.daysToBreach <= 14 ? 'warn' : 'ok'}`}>{w.breached ? `${-w.daysToBreach} d over` : `${w.daysToBreach} d left`}</span></td>
                <td className="num">{canBook && <button className="sm" onClick={() => pick(w)}>Book</button>}</td>
              </tr>))}</tbody>
          </table></div>}
        </div>
        <div className="card" style={{ position: 'sticky', top: 20 }}>
          {!sel ? <><h3>Book</h3><div className="muted">Pick someone from the list. Free slots for their service appear here.</div></> : (
            <>
              <h3>Free slots</h3>
              <div style={{ fontWeight: 600, fontSize: 16 }}>{sel.patientName}</div>
              <div className="muted small" style={{ marginBottom: 10 }}>{[sel.service || 'Any clinic', sel.priority, sel.reason].filter(Boolean).join(' · ')}</div>
              {risk && <div className={`banner ${risk.risk >= 0.3 ? 'warn' : 'info'}`}><Icon name="alert" /><div>No-show risk {Math.round(risk.risk * 100)}%{risk.reasons.length ? `: ${risk.reasons.join('; ')}` : ''}{risk.risk >= 0.3 && '. Consider a reminder call or an earlier slot.'}</div></div>}
              {err && <div className="err">{err}</div>}
              {!slots ? <Skeleton rows={4} h={34} /> : !slots.length ? <div className="muted">No free slots in the next 3 weeks for {sel.service}. Add clinic sessions in Admin.</div> : (
                <div className="stagger" style={{ display: 'grid', gap: 6 }}>{slots.map((s, i) => (
                  <button key={s.start + s.practitionerId} style={{ ...si(i), justifyContent: 'space-between' }} onClick={() => reserve(s)}>
                    <span>{new Date(s.start).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })} · <b>{s.start.slice(11, 16)}</b></span><span className="muted small">{s.location}</span>
                  </button>))}</div>
              )}
              <button className="ghost sm" style={{ marginTop: 10 }} onClick={() => setSel(null)}>Cancel</button>
            </>
          )}
        </div>
      </div>
    </>
  );
}
