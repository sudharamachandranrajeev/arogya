import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ApiError, ago, day, fullName, get, label, post, type Alert, type User } from '../api.ts';
import { Empty, Icon, PatientBanner, Skeleton, si, useToast } from '../ui.tsx';

const PHRASES: Record<string, string> = {
  '.htn': 'Hypertension review. BP today ___/___. Adherent to medication: ___. Side effects: ___. Plan: continue / adjust ___. Review in ___.',
  '.dm': 'Diabetes review. HbA1c ___. Feet checked: ___. Eyes screening up to date: ___. Plan: ___.',
  '.cont': 'Continence assessment. Symptoms: ___. Bladder diary reviewed: ___. Pelvic floor advice given: ___. Plan: ___.',
  '.nad': 'No abnormality detected. Safety-netting advice given.',
};
const expand = (s: string) => s.replace(/(\.\w+)(\s)$/, (m, k, sp) => (PHRASES[k] ? PHRASES[k] + sp : m));
const VITALS: Array<[string, string, string, string, string]> = [
  ['Systolic BP', '8480-6', 'mmHg', 'sys', 'Sys'], ['Diastolic BP', '8462-4', 'mmHg', 'dia', 'Dia'], ['Pulse', '8867-4', '/min', 'pulse', 'Pulse'],
  ['Weight', '29463-7', 'kg', 'wt', 'Weight'], ['Temperature', '8310-5', 'Cel', 'temp', 'Temp'],
];

export function Chart({ user }: { user: User }) {
  if (user.role === 'admin') return <AccessReport />;
  return <ClinicalChart user={user} />;
}

function ClinicalChart({ user }: { user: User }) {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const appt = params.get('appt');
  const [c, setC] = useState<any>(null);
  const [err, setErr] = useState('');
  const [reason, setReason] = useState('');
  const [askReason, setAskReason] = useState(false);
  const hdr = reason ? { 'x-break-glass-reason': reason } : undefined;
  const load = (h = hdr) => get(`/api/patients/${id}/summary`, h).then((d) => { setC(d); setAskReason(false); }).catch((e: ApiError) => {
    if (e.status === 403 && /Restricted/.test(e.message)) setAskReason(true); else setErr(e.message);
  });
  useEffect(() => { setC(null); setErr(''); setReason(''); load(undefined); }, [id]);
  if (err) return <div className="banner bad"><Icon name="alert" /><div>{err}</div></div>;
  if (askReason) return <BreakGlass onGo={(r) => { setReason(r); load({ 'x-break-glass-reason': r }); }} />;
  if (!c) return <div className="card"><Skeleton rows={8} /></div>;
  const p = c.patient;
  const clinical = ['clinician', 'nurse'].includes(user.role);
  const subject = { reference: `Patient/${id}`, display: fullName(p) };
  const restricted = p.meta?.security?.some((s: any) => s.code === 'R' || s.code === 'V');
  const replacedBy = p.link?.find((l: any) => l.type === 'replaced-by')?.other?.reference?.replace('Patient/', '');
  const refresh = () => load();
  const series = (rows: any[], name: string) => rows.filter((o) => label(o.code) === name && typeof o.valueQuantity?.value === 'number').slice(0, 12).reverse();
  return (
    <>
      <PatientBanner p={p} allergies={c.allergies} restricted={restricted}
        extra={appt && <span className="chip info"><Icon name="today" size={12} />Visit in progress</span>} />
      {replacedBy && <div className="banner bad"><Icon name="alert" /><div className="grow"><b>This record was merged.</b> Its notes, results and appointments now live in the record that replaced it. Do not add to this one.</div><Link className="btn primary" to={`/patients/${replacedBy}`}>Open current record</Link></div>}
      {c.due?.length > 0 && <div className="banner info"><Icon name="today" /><div><b>Due while the patient is here:</b> {c.due.map((d: any) => `${d.rule} (${d.status === 'never' ? 'never recorded' : d.status === 'overdue' ? `${d.overdueDays} days overdue` : `due ${d.dueDate}`})`).join(' · ')}</div></div>}
      {c.flags.map((f: any) => <div key={f.id} className="banner warn"><Icon name="alert" /><div>{label(f.code)}</div></div>)}
      {reason && <div className="banner bad"><Icon name="lock" /><div>Restricted record opened for: “{reason}”. This access is logged and may be reviewed.</div></div>}
      <div className="grid stagger">
        <div className="card lift" style={si(0)}>
          <h3>Problems</h3>
          {c.problems.map((x: any) => <div key={x.id} className="list-item">{label(x.code)}<span className="muted small" style={{ marginLeft: 'auto' }}>{day(x.onsetDateTime ?? x.recordedDate ?? x.meta?.lastUpdated)}</span></div>)}
          {!c.problems.length && <div className="muted">None recorded</div>}
          {clinical && <QuickAdd placeholder="Add a problem, e.g. Asthma" onAdd={(t) => post('/fhir/Condition', { resourceType: 'Condition', clinicalStatus: { coding: [{ code: 'active' }] }, code: { text: t }, subject, recordedDate: new Date().toISOString() }).then(refresh)} />}
        </div>
        <div className="card lift" style={si(1)}>
          <h3>Allergies</h3>
          {c.allergies.map((x: any) => <div key={x.id} className="list-item"><span className="dot bad" />{label(x.code)}{x.criticality === 'high' && <span className="chip bad" style={{ marginLeft: 'auto' }}>high risk</span>}</div>)}
          {!c.allergies.length && <div className="muted">None recorded — confirm with the patient</div>}
          {clinical && <QuickAdd placeholder="Add an allergy, e.g. Penicillin" onAdd={(t) => post('/fhir/AllergyIntolerance', { resourceType: 'AllergyIntolerance', clinicalStatus: { coding: [{ code: 'active' }] }, code: { text: t }, patient: subject, recordedDate: new Date().toISOString() }).then(refresh)} />}
        </div>
        <div className="card lift" style={si(2)}>
          <h3>Medications</h3>
          {c.meds.map((x: any) => <div key={x.id} className="list-item">{label(x.medicationCodeableConcept)}<span className="muted small" style={{ marginLeft: 'auto' }}>{day(x.authoredOn ?? x.meta?.lastUpdated)}</span></div>)}
          {!c.meds.length && <div className="muted">None recorded</div>}
          {user.role === 'clinician' && <Prescribe patientId={id!} subject={subject} hdr={hdr} done={refresh} />}
        </div>
        <div className="card lift" style={si(3)}>
          <h3>Vitals</h3>
          {['Systolic BP', 'Pulse', 'Weight'].map((n) => { const s = series(c.vitals, n); return s.length ? <Trend key={n} name={n} rows={s} /> : null; })}
          {!c.vitals.length && <div className="muted">None recorded</div>}
          {clinical && <Vitals subject={subject} done={refresh} />}
        </div>
        <div className="card lift" style={si(4)}>
          <h3>Results</h3>
          {c.labs.slice(0, 8).map((o: any) => {
            const i = o.interpretation?.[0]?.coding?.[0]?.code;
            return <div key={o.id} className="list-item"><span>{label(o.code)}</span><b>{o.valueQuantity?.value} <span className="muted small">{o.valueQuantity?.unit}</span></b>
              {i && i !== 'N' && <span className={`chip ${i.length > 1 ? 'bad' : 'warn'}`}>{i}</span>}<span className="muted small" style={{ marginLeft: 'auto' }}>{day(o.effectiveDateTime)}</span></div>;
          })}
          {!c.labs.length && <div className="muted">No results</div>}
        </div>
        <div className="card lift" style={si(5)}>
          <h3>Referrals and appointments</h3>
          {c.referrals.map((r: any) => <div key={r.id} className="list-item"><Icon name="list" size={15} />{label(r.code)}<span className={`chip ${r.priority === 'routine' ? '' : 'warn'}`}>{r.priority}</span><span className="muted small" style={{ marginLeft: 'auto' }}>{ago(r.authoredOn ?? r.meta.lastUpdated)} ago</span></div>)}
          {c.appts.slice(0, 5).map((a: any) => <div key={a.id} className="list-item"><Icon name="today" size={15} />{day(a.start)} {a.start.slice(11, 16)}<span className="chip">{a.status}</span></div>)}
          {!c.referrals.length && !c.appts.length && <div className="muted">None</div>}
          {clinical && <Refer subject={subject} done={refresh} />}
        </div>
      </div>
      {clinical && <NoteBox subject={subject} user={user} appt={appt} done={() => { if (appt) setParams({}); refresh(); }} />}
      <div className="section">
        <h3>Notes</h3>
        {c.notes.length ? <div className="stagger">{c.notes.map((n: any, i: number) => (
          <div key={n.id} className="card" style={si(i)}><div className="row center"><b>{n.title}</b><span className="muted small">{day(n.date)} · {n.author?.[0]?.display}</span></div>
            <div style={{ whiteSpace: 'pre-wrap', marginTop: 6 }}>{n.section?.[0]?.text?.div?.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&amp;/g, '&') ?? ''}</div></div>
        ))}</div> : <div className="card"><Empty>No notes yet.</Empty></div>}
      </div>
    </>
  );
}

function BreakGlass({ onGo }: { onGo: (reason: string) => void }) {
  const [r, setR] = useState('');
  return (
    <div className="overlay center">
      <div className="dialog" style={{ display: 'grid', gap: 12 }}>
        <h2><Icon name="lock" size={20} /> Restricted record</h2>
        <div>This patient's record is restricted. Open it only if you are involved in their care now. Your name, the time and your reason are logged and reviewed.</div>
        <label>Reason for access<textarea autoFocus style={{ minHeight: 70 }} value={r} onChange={(e) => setR(e.target.value)} placeholder="e.g. Covering clinic today, patient attending with chest pain" /></label>
        <div className="row"><button className="primary" disabled={r.trim().length < 10} onClick={() => onGo(r.trim())}>Open record</button><button className="ghost" onClick={() => history.back()}>Go back</button></div>
      </div>
    </div>
  );
}

function Trend({ name, rows }: { name: string; rows: any[] }) {
  const v = rows.map((o) => o.valueQuantity.value as number);
  const lo = Math.min(...v), hi = Math.max(...v), w = 120, h = 28;
  const pts = v.map((x, i) => `${(i / Math.max(1, v.length - 1)) * w},${h - 3 - ((x - lo) / (hi - lo || 1)) * (h - 6)}`).join(' ');
  const last = rows[rows.length - 1];
  return (
    <div className="list-item">
      <span>{name}</span>
      <svg width={w} height={h} style={{ marginLeft: 'auto', color: 'var(--brand)' }} aria-hidden><polyline points={pts} fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" /></svg>
      <b style={{ minWidth: 70, textAlign: 'right' }}>{last.valueQuantity.value} <span className="muted small">{last.valueQuantity.unit}</span></b>
    </div>
  );
}

function QuickAdd({ placeholder, onAdd }: { placeholder: string; onAdd: (t: string) => Promise<unknown> }) {
  const [t, setT] = useState('');
  const toast = useToast();
  return (
    <form className="row" style={{ marginTop: 10 }} onSubmit={async (e) => { e.preventDefault(); if (!t.trim()) return; await onAdd(t.trim()); toast(`${t.trim()} added`); setT(''); }}>
      <input className="grow" placeholder={placeholder} value={t} onChange={(e) => setT(e.target.value)} />
      <button disabled={!t.trim()}><Icon name="plus" size={14} /></button>
    </form>
  );
}

function Vitals({ subject, done }: { subject: any; done: () => void }) {
  const [v, setV] = useState<Record<string, string>>({});
  const toast = useToast();
  const entered = VITALS.filter(([, , , k]) => v[k]);
  return (
    <div className="row" style={{ marginTop: 10 }}>
      {VITALS.map(([, , u, k, short]) => <label key={k} style={{ width: 66 }}>{short}<input inputMode="decimal" title={u} placeholder={u} value={v[k] ?? ''} onChange={(e) => setV({ ...v, [k]: e.target.value.replace(/[^\d.]/g, '') })} /></label>)}
      <button disabled={!entered.length} onClick={async () => {
        const now = new Date().toISOString();
        await Promise.all(entered.map(([n, code, unit, k]) => post('/fhir/Observation', { resourceType: 'Observation', status: 'final', category: [{ coding: [{ code: 'vital-signs' }] }], code: { coding: [{ system: 'http://loinc.org', code, display: n }], text: n }, subject, effectiveDateTime: now, valueQuantity: { value: Number(v[k]), unit } })));
        toast(`${entered.length} vital sign${entered.length > 1 ? 's' : ''} saved`); setV({}); done();
      }}>Save</button>
    </div>
  );
}

function Prescribe({ patientId, subject, hdr, done }: { patientId: string; subject: any; hdr?: Record<string, string>; done: () => void }) {
  const [drug, setDrug] = useState('');
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [why, setWhy] = useState('');
  const [err, setErr] = useState('');
  const toast = useToast();
  useEffect(() => {
    if (drug.length < 4) { setAlerts([]); return; }
    const t = setTimeout(() => post('/api/meds/check', { patientId, medication: { medicationCodeableConcept: { text: drug } } }).then((r) => setAlerts(r.alerts)), 250);
    return () => clearTimeout(t);
  }, [drug]);
  const high = alerts.some((a) => a.severity === 'high');
  return (
    <div style={{ marginTop: 10 }}>
      <div className="row"><input className="grow" placeholder="Prescribe, e.g. Ramipril 5 mg daily" value={drug} onChange={(e) => setDrug(e.target.value)} />
        <button className="primary" disabled={!drug || (high && why.trim().length < 5)} onClick={async () => {
          setErr('');
          try {
            await post('/fhir/MedicationRequest', { resourceType: 'MedicationRequest', status: 'active', intent: 'order', medicationCodeableConcept: { text: drug }, subject, authoredOn: new Date().toISOString() }, { ...hdr, ...(high ? { 'x-override-reason': why } : {}) });
            toast(`${drug} prescribed`); setDrug(''); setAlerts([]); setWhy(''); done();
          } catch (e: any) { setErr(e.message); if (e.alerts) setAlerts(e.alerts); }
        }}>Prescribe</button></div>
      {alerts.map((a, i) => <div key={i} className={`banner ${a.severity === 'high' ? 'bad' : 'warn'}`} style={{ marginTop: 8, marginBottom: 0 }}><Icon name="alert" /><div><b>{a.severity === 'high' ? 'Stop and check' : 'Note'}:</b> {a.message}</div></div>)}
      {high && <input style={{ width: '100%', marginTop: 8 }} placeholder="Clinical reason to go ahead (required, logged)" value={why} onChange={(e) => setWhy(e.target.value)} />}
      {err && <div className="err">{err}</div>}
    </div>
  );
}

function Refer({ subject, done }: { subject: any; done: () => void }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ service: '', priority: 'routine', reason: '' });
  const toast = useToast();
  if (!open) return <button className="sm" style={{ marginTop: 10 }} onClick={() => setOpen(true)}><Icon name="plus" size={14} />Refer</button>;
  return (
    <div className="row" style={{ marginTop: 10 }}>
      <label className="grow">Service<input autoFocus value={f.service} onChange={(e) => setF({ ...f, service: e.target.value })} placeholder="e.g. Physiotherapy" /></label>
      <label>Priority<select value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}><option>routine</option><option>urgent</option><option>asap</option><option>stat</option></select></label>
      <label style={{ width: '100%' }}>Reason<input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></label>
      <button className="primary" disabled={!f.service} onClick={async () => {
        await post('/fhir/ServiceRequest', { resourceType: 'ServiceRequest', status: 'active', intent: 'order', category: [{ text: 'referral' }], priority: f.priority, code: { text: f.service }, reasonCode: f.reason ? [{ text: f.reason }] : undefined, subject, authoredOn: new Date().toISOString() });
        toast(`Referred to ${f.service}`); setOpen(false); setF({ service: '', priority: 'routine', reason: '' }); done();
      }}>Send referral</button>
      <button className="ghost" onClick={() => setOpen(false)}>Cancel</button>
    </div>
  );
}

function NoteBox({ subject, user, appt, done }: { subject: any; user: User; appt: string | null; done: () => void }) {
  const key = `arogya.draft.${subject.reference}`;
  const [text, setText] = useState(() => { try { return sessionStorage.getItem(key) ?? ''; } catch { return ''; } });
  const [title, setTitle] = useState('Consultation');
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  // Drafts survive a refresh or an idle lock within this browser tab only, never on the server unsigned.
  useEffect(() => { try { text ? sessionStorage.setItem(key, text) : sessionStorage.removeItem(key); } catch { /* storage blocked */ } }, [text]);
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const blanks = (text.match(/___/g) ?? []).length;
  return (
    <div className="card section">
      <h3>New note {appt && <span className="chip info">signing closes the visit</span>}</h3>
      <div className="row" style={{ marginBottom: 8 }}>
        <input value={title} onChange={(e) => setTitle(e.target.value)} />
        <span className="muted small">Shortcuts: {Object.keys(PHRASES).map((k) => <kbd key={k} style={{ marginRight: 4 }}>{k}</kbd>)} then space</span>
      </div>
      <textarea value={text} onChange={(e) => setText(expand(e.target.value))} placeholder="Short, problem-oriented note" />
      <div className="row center" style={{ marginTop: 8 }}>
        <button className="primary" disabled={!text.trim() || blanks > 0 || busy} onClick={async () => {
          setBusy(true);
          const now = new Date().toISOString();
          const enc = await post('/fhir/Encounter', { resourceType: 'Encounter', status: 'finished', class: { code: 'AMB' }, subject, period: { start: now, end: now }, ...(appt ? { appointment: [{ reference: `Appointment/${appt}` }] } : {}) });
          const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
          await post('/fhir/Composition', { resourceType: 'Composition', status: 'final', type: { text: 'Progress note' }, title, date: now, subject, encounter: { reference: `Encounter/${enc.id}` }, author: [{ ...(user.practitionerId ? { reference: `Practitioner/${user.practitionerId}` } : {}), display: user.name }], section: [{ title, text: { status: 'generated', div: `<div xmlns="http://www.w3.org/1999/xhtml">${esc}</div>` } }] });
          if (appt) await post(`/api/appointments/${appt}/status`, { status: 'fulfilled' });
          toast(appt ? 'Note signed and visit closed' : 'Note signed');
          setText(''); setBusy(false); done();
        }}>Sign note</button>
        <span className="muted small">{words} words{blanks > 0 && <span style={{ color: 'var(--warn)' }}> · fill {blanks} blank{blanks > 1 ? 's' : ''} (___) before signing</span>}</span>
      </div>
    </div>
  );
}

function AccessReport() {
  const { id } = useParams();
  const [p, setP] = useState<any>(null);
  const [rows, setRows] = useState<any[] | null>(null);
  useEffect(() => { get(`/fhir/Patient/${id}`).then(setP).catch(() => {}); get(`/api/patients/${id}/access-log`).then(setRows); }, [id]);
  return (
    <>
      {p && <PatientBanner p={p} />}
      <div className="page-head"><div><h2>Access report</h2><div className="sub">Every recorded access to this record, newest first. Administrators cannot see clinical content.</div></div>
        <button onClick={() => {
          const csv = ['time,user,name,role,action,record,reason', ...(rows ?? []).map((r) => [r.at, r.username, r.name, r.role, r.action, r.resource_type, r.reason].map((x) => `"${String(x ?? '').replace(/"/g, '""')}"`).join(','))].join('\n');
          const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = `access-${id}.csv`; a.click();
        }}>Export CSV</button></div>
      <div className="card">{!rows ? <Skeleton rows={6} /> : <div className="table-wrap"><table>
        <thead><tr><th>Time</th><th>User</th><th>Role</th><th>Action</th><th>Record</th><th>Reason</th></tr></thead>
        <tbody className="stagger">{rows.map((r, i) => <tr key={i} style={si(i)}><td>{String(r.at).slice(0, 19).replace('T', ' ')}</td><td>{r.name ?? r.username}</td><td>{r.role}</td><td>{r.action}</td><td>{r.resource_type}</td><td>{r.reason && <span className="chip bad">{r.reason}</span>}</td></tr>)}</tbody>
      </table></div>}</div>
    </>
  );
}
