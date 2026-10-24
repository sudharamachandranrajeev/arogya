import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { age, api, day, get, type User } from '../api.ts';
import { Empty, Icon, Skeleton, si, useToast } from '../ui.tsx';

const STATUS: Record<string, [string, string]> = { never: ['bad', 'Never recorded'], overdue: ['bad', 'Overdue'], due: ['warn', 'Due soon'] };

export function Recalls({ user }: { user: User }) {
  const [rows, setRows] = useState<any[] | null>(null);
  const [rule, setRule] = useState('');
  const [editing, setEditing] = useState(false);
  const nav = useNavigate();
  const canBook = ['clinician', 'nurse', 'reception'].includes(user.role);
  const load = () => get('/api/recalls').then(setRows);
  useEffect(() => { load(); }, []);
  const rules = [...new Set((rows ?? []).map((r) => r.rule))];
  const shown = (rows ?? []).filter((r) => !rule || r.rule === rule);
  const book = (r: any) => nav(`/schedule?${new URLSearchParams({ patient: r.patientId, name: r.patientName, service: r.service, reason: `Recall: ${r.rule}` })}`);
  return (
    <>
      <div className="page-head">
        <div><h2>Recalls</h2><div className="sub">{rows ? `${rows.filter((r) => r.status !== 'due').length} overdue or never done · ${rows.filter((r) => r.status === 'due').length} due within a month · ${rows.filter((r) => r.booked).length} already booked` : 'Loading…'}</div></div>
        <div className="row">
          {['', ...rules].map((s) => <button key={s} className={`sm ${rule === s ? 'primary' : 'ghost'}`} onClick={() => setRule(s)}>{s || 'All'}</button>)}
          {['clinician', 'manager'].includes(user.role) && <button className="sm" onClick={() => setEditing(!editing)}><Icon name="list" size={14} />{editing ? 'Close rules' : 'Rules'}</button>}
        </div>
      </div>
      {editing && <Rules onSaved={() => { setEditing(false); load(); }} />}
      <div className="card">
        {!rows ? <Skeleton rows={8} h={28} /> : !shown.length ? <Empty>Everyone's monitoring is up to date.</Empty> : <div className="table-wrap"><table>
          <thead><tr><th>Patient</th><th>Monitoring</th><th>Last done</th><th>Status</th><th /></tr></thead>
          <tbody className="stagger">{shown.slice(0, 300).map((r, i) => {
            const [tone, text] = STATUS[r.status];
            return (
              <tr key={r.patientId + r.ruleId} style={si(i)}>
                <td><Link to={`/patients/${r.patientId}`}><b>{r.patientName}</b></Link> <span className="muted small">{age(r.birthDate)} y</span></td>
                <td>{r.rule}</td>
                <td className="muted">{r.lastDone ? day(r.lastDone) : '—'}</td>
                <td><span className={`chip ${tone}`}>{text}{r.status === 'overdue' && ` ${r.overdueDays} d`}{r.status === 'due' && ` ${r.dueDate}`}</span></td>
                <td className="num">{r.booked ? <span className="chip ok"><Icon name="check" size={12} />Booked {day(r.booked)}</span>
                  : canBook && <button className="sm" onClick={() => book(r)}>Book</button>}</td>
              </tr>
            );
          })}</tbody>
        </table></div>}
      </div>
    </>
  );
}

const terms = (s: string) => s.split(',').map((t) => t.trim()).filter(Boolean);

function Rules({ onSaved }: { onSaved: () => void }) {
  const [rules, setRules] = useState<any[] | null>(null);
  const [services, setServices] = useState<string[]>([]);
  const [err, setErr] = useState('');
  const toast = useToast();
  useEffect(() => {
    get('/api/settings/recalls').then((r) => setRules(r.map((x: any) => ({ ...x, condition: x.condition.join(', '), test: x.test.join(', ') }))));
    get('/api/clinic-sessions').then((s) => setServices([...new Set<string>(s.map((x: any) => x.service))]));
  }, []);
  if (!rules) return <div className="card"><Skeleton rows={3} /></div>;
  const set = (i: number, k: string, v: any) => setRules(rules.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  const save = async () => {
    setErr('');
    try {
      await api('PUT', '/api/settings/recalls', rules.map((r) => ({ ...r, id: r.id || r.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), condition: terms(r.condition), test: terms(r.test), everyDays: Number(r.everyDays) })));
      toast('Recall rules saved'); onSaved();
    } catch (e: any) { setErr(e.message); }
  };
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <h3>Recall rules</h3>
      <div className="muted small" style={{ marginBottom: 10 }}>A person with an active condition matching a <b>condition</b> term needs a result matching a <b>test</b> term every so many days. Terms match a code exactly or any part of the name; separate them with commas. Set intervals from your local protocol.</div>
      <div className="table-wrap"><table>
        <thead><tr><th>Name</th><th>Condition terms</th><th>Test terms</th><th className="num">Every (days)</th><th>Book into</th><th /></tr></thead>
        <tbody>{rules.map((r, i) => (
          <tr key={i}>
            <td><input value={r.name} onChange={(e) => set(i, 'name', e.target.value)} /></td>
            <td><input value={r.condition} onChange={(e) => set(i, 'condition', e.target.value)} /></td>
            <td><input value={r.test} onChange={(e) => set(i, 'test', e.target.value)} /></td>
            <td><input type="number" min={1} max={3650} style={{ width: 90 }} value={r.everyDays} onChange={(e) => set(i, 'everyDays', e.target.value)} /></td>
            <td><select value={r.service} onChange={(e) => set(i, 'service', e.target.value)}><option value="">Any clinic</option>{services.map((s) => <option key={s}>{s}</option>)}</select></td>
            <td><button className="sm ghost danger" aria-label={`Remove ${r.name}`} onClick={() => setRules(rules.filter((_, j) => j !== i))}>Remove</button></td>
          </tr>))}</tbody>
      </table></div>
      {err && <div className="err">{err}</div>}
      <div className="row" style={{ marginTop: 10 }}>
        <button onClick={() => setRules([...rules, { id: '', name: '', condition: '', test: '', everyDays: 365, service: '' }])}><Icon name="plus" size={14} />Add rule</button>
        <button className="primary" onClick={save}>Save rules</button>
      </div>
    </div>
  );
}
