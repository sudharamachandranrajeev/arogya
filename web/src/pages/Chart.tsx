import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ApiError, age, day, entries, fullName, get, label, post, type Alert, type User } from '../api.ts';

const PHRASES: Record<string, string> = {
  '.htn': 'Hypertension review. BP today ___/___. Adherent to medication: ___. Side effects: ___. Plan: continue / adjust ___. Review in ___.',
  '.dm': 'Diabetes review. HbA1c ___. Feet checked: ___. Eyes screening up to date: ___. Plan: ___.',
  '.cont': 'Continence assessment. Symptoms: ___. Bladder diary reviewed: ___. Pelvic floor advice given: ___. Plan: ___.',
  '.nad': 'No abnormality detected. Safety-netting advice given.',
};
const expand = (s: string) => s.replace(/(\.\w+)(\s|$)/g, (m, k, sp) => (PHRASES[k] ? PHRASES[k] + sp : m));
const VITALS: Array<[string, string, string, string]> = [
  ['Systolic BP', '8480-6', 'mmHg', 'sys'], ['Diastolic BP', '8462-4', 'mmHg', 'dia'], ['Pulse', '8867-4', '/min', 'pulse'],
  ['Weight', '29463-7', 'kg', 'wt'], ['Temperature', '8310-5', 'Cel', 'temp'],
];

export function Chart({ user }: { user: User }) {
  const { id } = useParams();
  const [c, setC] = useState<any>(null);
  const [err, setErr] = useState('');
  const [reason, setReason] = useState('');
  const load = (r = reason) =>
    get(`/api/patients/${id}/summary`).then(setC).catch(async (e: ApiError) => {
      if (e.status === 403 && /Restricted/.test(e.message)) {
        const why = r || prompt('Restricted record. State your reason for access (logged):') || '';
        if (why.length < 10) { setErr('A reason of at least 10 characters is required.'); return; }
        setReason(why);
        const res = await fetch(`/api/patients/${id}/summary`, { headers: { 'x-break-glass-reason': why } });
        if (res.ok) setC(await res.json()); else setErr('Access refused');
      } else setErr(e.message);
    });
  useEffect(() => { load(''); }, [id]);
  if (err) return <div className="err">{err}</div>;
  if (!c) return <div className="muted">Loading…</div>;
  const p = c.patient;
  const clinical = ['clinician', 'nurse'].includes(user.role);
  const subject = { reference: `Patient/${id}`, display: fullName(p) };
  const hdr = reason ? { 'x-break-glass-reason': reason } : undefined;
  const refresh = () => load(reason);
  return (
    <>
      <h2>{fullName(p)} <span className="muted" style={{ fontSize: 15 }}>{age(p.birthDate)} y · {p.gender} · {p.birthDate} · {p.identifier?.[0]?.value}</span></h2>
      {c.flags.map((f: any) => <div key={f.id} className="banner">{label(f.code)}</div>)}
      {c.allergies.length > 0 && <div className="banner">Allergies: {c.allergies.map((a: any) => label(a.code)).join(', ')}</div>}
      <div className="grid">
        <div className="card"><h3>Problems</h3>{c.problems.map((x: any) => <div key={x.id}>{label(x.code)}</div>)}{!c.problems.length && <span className="muted">None recorded</span>}</div>
        <div className="card"><h3>Medications</h3>{c.meds.map((x: any) => <div key={x.id}>{label(x.medicationCodeableConcept)}</div>)}{!c.meds.length && <span className="muted">None recorded</span>}
          {clinical && user.role === 'clinician' && <Prescribe patientId={id!} subject={subject} hdr={hdr} done={refresh} />}</div>
        <div className="card"><h3>Vitals</h3>
          <table><tbody>{c.vitals.slice(0, 6).map((o: any) => <tr key={o.id}><td>{label(o.code)}</td><td>{o.valueQuantity?.value} {o.valueQuantity?.unit}</td><td className="muted">{day(o.effectiveDateTime)}</td></tr>)}</tbody></table>
          {clinical && <Vitals subject={subject} done={refresh} />}</div>
        <div className="card"><h3>Results</h3>
          <table><tbody>{c.labs.slice(0, 6).map((o: any) => { const i = o.interpretation?.[0]?.coding?.[0]?.code; return <tr key={o.id}><td>{label(o.code)}</td><td>{o.valueQuantity?.value} {o.valueQuantity?.unit}</td><td>{i && i !== 'N' && <span className={`chip ${i.length > 1 ? 'bad' : 'warn'}`}>{i}</span>}</td><td className="muted">{day(o.effectiveDateTime)}</td></tr>; })}</tbody></table></div>
        <div className="card"><h3>Open referrals</h3>{c.referrals.map((r: any) => <div key={r.id}>{label(r.code)} <span className="chip">{r.priority}</span> <span className="muted">{day(r.authoredOn)}</span></div>)}{!c.referrals.length && <span className="muted">None</span>}</div>
        <div className="card"><h3>Appointments</h3>{c.appts.slice(0, 6).map((a: any) => <div key={a.id}>{day(a.start)} {a.start.slice(11, 16)} <span className="chip">{a.status}</span></div>)}</div>
      </div>
      {clinical && <NoteBox subject={subject} user={user} done={refresh} />}
      <h3>Notes</h3>
      {c.notes.map((n: any) => <div key={n.id} className="card"><b>{n.title}</b> <span className="muted">{day(n.date)}</span><div style={{ whiteSpace: 'pre-wrap' }}>{n.section?.[0]?.text?.div?.replace(/<[^>]+>/g, '') ?? ''}</div></div>)}
    </>
  );
}

function Vitals({ subject, done }: { subject: any; done: () => void }) {
  const [v, setV] = useState<Record<string, string>>({});
  const entered = VITALS.filter(([, , , k]) => v[k]);
  return (
    <div className="row" style={{ marginTop: 8 }}>
      {VITALS.map(([n, , u, k]) => <label key={k} style={{ width: 70 }}>{n.replace('Temperature', 'Temp').replace('Systolic BP', 'Sys').replace('Diastolic BP', 'Dia')}<input inputMode="decimal" title={u} value={v[k] ?? ''} onChange={(e) => setV({ ...v, [k]: e.target.value })} /></label>)}
      <button disabled={!entered.length} onClick={async () => {
        const now = new Date().toISOString();
        await Promise.all(entered.map(([n, code, unit, k]) => post('/fhir/Observation', { resourceType: 'Observation', status: 'final', category: [{ coding: [{ code: 'vital-signs' }] }], code: { coding: [{ system: 'http://loinc.org', code, display: n }], text: n }, subject, effectiveDateTime: now, valueQuantity: { value: Number(v[k]), unit } })));
        setV({}); done();
      }}>Save</button>
    </div>
  );
}

function Prescribe({ patientId, subject, hdr, done }: { patientId: string; subject: any; hdr?: Record<string, string>; done: () => void }) {
  const [drug, setDrug] = useState('');
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [why, setWhy] = useState('');
  const [err, setErr] = useState('');
  const body = () => ({ resourceType: 'MedicationRequest', status: 'active', intent: 'order', medicationCodeableConcept: { text: drug }, subject, authoredOn: new Date().toISOString() });
  const check = async (text: string) => { setDrug(text); if (text.length > 3) setAlerts((await post('/api/meds/check', { patientId, medication: { medicationCodeableConcept: { text } } })).alerts); else setAlerts([]); };
  const high = alerts.some((a) => a.severity === 'high');
  return (
    <div style={{ marginTop: 8 }}>
      <div className="row"><input placeholder="Prescribe, e.g. Ramipril 5 mg daily" value={drug} onChange={(e) => check(e.target.value)} style={{ flex: 1 }} />
        <button className="primary" disabled={!drug || (high && why.length < 5)} onClick={async () => {
          try { await post('/fhir/MedicationRequest', body(), { ...hdr, ...(high ? { 'x-override-reason': why } : {}) }); setDrug(''); setAlerts([]); setWhy(''); done(); } catch (e: any) { setErr(e.message); }
        }}>Prescribe</button></div>
      {alerts.map((a, i) => <div key={i} className={`banner ${a.severity === 'high' ? '' : 'warn'}`}>{a.severity === 'high' ? 'Stop: ' : 'Note: '}{a.message}</div>)}
      {high && <input style={{ width: '100%' }} placeholder="Reason for overriding (required, logged)" value={why} onChange={(e) => setWhy(e.target.value)} />}
      {err && <div className="err">{err}</div>}
    </div>
  );
}

function NoteBox({ subject, user, done }: { subject: any; user: User; done: () => void }) {
  const [text, setText] = useState('');
  const [title, setTitle] = useState('Consultation');
  return (
    <div className="card">
      <h3>New note</h3>
      <div className="muted" style={{ marginBottom: 6 }}>Shortcuts: {Object.keys(PHRASES).join('  ')} then space</div>
      <input value={title} onChange={(e) => setTitle(e.target.value)} style={{ marginBottom: 6 }} />
      <textarea value={text} onChange={(e) => setText(expand(e.target.value))} placeholder="Short, problem-oriented note" />
      <div className="row" style={{ marginTop: 8 }}>
        <button className="primary" disabled={!text.trim()} onClick={async () => {
          const now = new Date().toISOString();
          const enc = await post('/fhir/Encounter', { resourceType: 'Encounter', status: 'finished', class: { code: 'AMB' }, subject, period: { start: now, end: now } });
          const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
          await post('/fhir/Composition', { resourceType: 'Composition', status: 'final', type: { text: 'Progress note' }, title, date: now, subject, encounter: { reference: `Encounter/${enc.id}` }, author: [{ reference: user.practitionerId ? `Practitioner/${user.practitionerId}` : undefined, display: user.name }], section: [{ title, text: { status: 'generated', div: `<div xmlns="http://www.w3.org/1999/xhtml">${esc}</div>` } }] });
          setText(''); done();
        }}>Sign note</button>
        <span className="muted">{text.trim().split(/\s+/).filter(Boolean).length} words</span>
      </div>
    </div>
  );
}
export { entries };
