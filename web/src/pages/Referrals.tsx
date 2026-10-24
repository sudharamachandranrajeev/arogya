import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { day, get, post, type User } from '../api.ts';
import { Empty, Icon, Skeleton, si, useToast } from '../ui.tsx';

const STEPS = [['sent', 'Sent'], ['acknowledged', 'Acknowledged'], ['booked', 'Booked'], ['report', 'Report back']] as const;

export function Referrals({ user }: { user: User }) {
  const [rows, setRows] = useState<any[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const load = () => get('/api/referrals-out').then(setRows);
  useEffect(() => { load(); }, []);
  const canUpdate = ['clinician', 'nurse', 'reception'].includes(user.role);
  return (
    <>
      <div className="page-head"><div><h2>Referrals out</h2><div className="sub">{rows ? `${rows.length} open · ${rows.filter((r) => r.overdueDays).length} waiting past their deadline · chased automatically from the scheduling inbox` : 'Loading…'}</div></div></div>
      <div className="card">
        {!rows ? <Skeleton rows={6} h={34} /> : !rows.length ? <Empty>Every referral has come back.</Empty> : <div className="stagger" style={{ display: 'grid', gap: 8 }}>{rows.map((r, i) => (
          <div key={r.id} className="ref-row" style={si(i)}>
            <div className="row">
              <div className="grow"><Link to={`/patients/${r.patientId}`}><b>{r.patientName || 'Patient'}</b></Link> <span className="muted">→</span> <b>{r.to}</b> <span className="muted">· {r.service} · sent {day(r.sent)}</span>
                {r.priority !== 'routine' && <span className="chip warn" style={{ marginLeft: 6 }}>{r.priority}</span>}</div>
              <span className={`chip ${r.overdueDays ? 'bad' : ''}`}>{r.overdueDays ? `No ${r.waitingFor.replace(/^an? |^the /, '')} · ${r.overdueDays} d late` : `Waiting for ${r.waitingFor} by ${r.dueDate}`}</span>
              {canUpdate && <button className="sm" onClick={() => setOpen(open === r.id ? null : r.id)}>Update</button>}
            </div>
            <Steps stage={r.stage} />
            {open === r.id && <Update r={r} done={() => { setOpen(null); load(); }} />}
          </div>))}</div>}
      </div>
    </>
  );
}

export function Steps({ stage }: { stage: string }) {
  const at = STEPS.findIndex(([k]) => k === stage);
  return <div className="steps">{STEPS.map(([k, l], i) => <div key={k} className={`step ${i <= at ? 'done' : ''} ${i === at + 1 ? 'next' : ''}`}><span className="dot" />{l}</div>)}</div>;
}

function Update({ r, done }: { r: any; done: () => void }) {
  const [note, setNote] = useState('');
  const toast = useToast();
  const next = STEPS.slice(STEPS.findIndex(([k]) => k === r.stage) + 1);
  const go = (stage: string, msg: string) => post(`/api/referrals-out/${r.id}/stage`, { stage, note }).then(() => { toast(msg); done(); }).catch((e) => toast(e.message, 'bad'));
  return (
    <div className="merge-box">
      {r.notes.length > 0 && <ul className="small" style={{ margin: '0 0 8px', paddingLeft: 18 }}>{r.notes.map((n: any, i: number) => <li key={i}>{day(n.time)} · {n.text} <span className="muted">({n.authorString})</span></li>)}</ul>}
      <div className="row">
        <input className="grow" autoFocus placeholder="Note, e.g. phoned, booked for 12 Nov with Dr Rao" value={note} onChange={(e) => setNote(e.target.value)} />
        {next.map(([k, l]) => <button key={k} className={k === next[0][0] ? 'primary sm' : 'sm'} onClick={() => go(k, `${l} recorded`)}>{k === 'report' ? 'Report received' : l}</button>)}
        <button className="sm ghost danger" disabled={note.trim().length < 3} title="Give the reason in the note" onClick={() => go('rejected', 'Rejection sent back to the referrer')}>Rejected</button>
      </div>
    </div>
  );
}
