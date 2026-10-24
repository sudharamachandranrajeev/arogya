import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { get, post, type User } from '../api.ts';
import { Empty, Icon, Kpi, Skeleton, si, useToast } from '../ui.tsx';

export function Dashboard({ user }: { user: User }) {
  const [k, setK] = useState<any>(null);
  const [stuck, setStuck] = useState<any[]>([]);
  const [rules, setRules] = useState<any[]>([]);
  const loadRules = () => get('/api/safety/alert-rules').then(setRules).catch(() => {});
  useEffect(() => {
    get('/api/kpi').then(setK);
    get('/api/stuck-work').then(setStuck).catch(() => {});
    loadRules();
  }, []);
  if (!k) return <div className="card"><Skeleton rows={6} h={40} /></div>;
  const w = k.waitingList, a = k.appointments, i = k.inbox;
  return (
    <>
      <div className="page-head"><div><h2>Dashboard</h2><div className="sub">Last {k.sinceDays} days · waiting list is live</div></div></div>
      <h3>Access and waiting</h3>
      <div className="kpis stagger">
        {[<Kpi v={w.size} l="Waiting list" />, <Kpi v={w.averageWaitDays} l="Average wait (days)" />, <Kpi v={w.longestWaitDays} l="Longest wait (days)" tone={w.longestWaitDays > 126 ? 'warn' : ''} />,
          <Kpi v={w.breached} l="Past target" tone={w.breached ? 'bad' : 'ok'} />, <Kpi v={w.breachingSoon} l="Past target within 14 days" tone={w.breachingSoon ? 'warn' : 'ok'} />,
          <Kpi v={w.withinTargetPct} suffix="%" l="Within target" tone={w.withinTargetPct < 80 ? 'warn' : 'ok'} />].map((x, n) => <div key={n} style={si(n)}>{x}</div>)}
      </div>
      <h3 className="section">Appointments</h3>
      <div className="kpis stagger">
        {[<Kpi v={a.attended} l="Attended" />, <Kpi v={a.dna} l="Did not attend" />, <Kpi v={a.dnaRatePct} suffix="%" l="DNA rate" tone={a.dnaRatePct > 10 ? 'bad' : 'ok'} />,
          <Kpi v={a.cancelled} l="Cancelled" />, <Kpi v={a.lostSlots} l="Slots lost" tone={a.lostSlots ? 'warn' : ''} />].map((x, n) => <div key={n} style={si(n)}>{x}</div>)}
      </div>
      <h3 className="section">Work and safety</h3>
      <div className="kpis stagger">
        {[<Kpi v={i.open} l="Open inbox items" />, <Kpi v={i.overdue} l="Past their deadline" tone={i.overdue ? 'bad' : 'ok'} />, <Kpi v={i.resultTurnaroundHours} suffix=" h" l="Result turnaround" />,
          <Kpi v={k.safety.alertOverrides} l="Safety alert overrides" />, <Kpi v={k.safety.prescriptions} l="Prescriptions" />].map((x, n) => <div key={n} style={si(n)}>{x}</div>)}
      </div>
      <div className="grid section">
        <div className="card">
          <h3>Stuck work <span className="chip bad">{stuck.length}</span></h3>
          {!stuck.length ? <Empty>Nothing past its deadline.</Empty> : <div className="table-wrap"><table>
            <thead><tr><th>Item</th><th>Queue</th><th className="num">Age</th></tr></thead>
            <tbody>{stuck.slice(0, 12).map((s) => <tr key={s.id}><td><span className="chip">{s.kind}</span> {s.patientId ? <Link to={`/patients/${s.patientId}`}>{s.subject}</Link> : s.subject}</td><td className="muted">{s.pool.startsWith('user:') ? 'personal' : s.pool}</td><td className="num"><span className="chip bad">{s.ageDays} d / {s.slaDays} d</span></td></tr>)}</tbody>
          </table></div>}
        </div>
        <div className="card">
          <h3>Safety alert rules</h3>
          <div className="muted small" style={{ marginBottom: 8 }}>A rule overridden almost every time trains people to ignore alerts. A clinician can stop it interrupting: it still shows, but no longer blocks. Allergy alerts always interrupt.</div>
          {!rules.length ? <Empty>No interruptive alerts in the last 180 days.</Empty> : <div className="table-wrap"><table>
            <thead><tr><th>Rule</th><th className="num">Fired</th><th className="num">Overridden</th>{user.role === 'clinician' && <th />}</tr></thead>
            <tbody>{rules.map((r) => <RuleRow key={r.rule} r={r} canTune={user.role === 'clinician'} done={loadRules} />)}</tbody>
          </table></div>}
        </div>
      </div>
    </>
  );
}

function RuleRow({ r, canTune, done }: { r: any; canTune: boolean; done: () => void }) {
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  const toast = useToast();
  const tunable = /^(interaction|dose|duplicate): /.test(r.rule);
  const act = (url: string, body: object, ok: string) => post(url, body).then(() => { toast(ok); setAsking(false); setReason(''); done(); }).catch((e) => toast(e.message, 'bad'));
  return (
    <>
      <tr>
        <td>{r.rule} {r.review && !r.quiet && <span className="chip warn" title="Overridden more than 95% of the time: review whether it helps">review</span>}
          {r.quiet && <span className="chip" title={`${r.quiet.name ?? ''}: ${r.quiet.reason}`}><Icon name="check" size={11} />not interrupting</span>}</td>
        <td className="num">{r.fired}</td><td className="num">{r.overridePct}%</td>
        {canTune && <td className="num">{!tunable ? null : r.quiet
          ? <button className="sm" onClick={() => act('/api/safety/alert-rules/restore', { rule: r.rule }, 'Rule interrupts again')}>Interrupt again</button>
          : <button className="sm ghost" onClick={() => setAsking(!asking)}>Stop interrupting</button>}</td>}
      </tr>
      {asking && <tr><td colSpan={4}>
        <div className="row"><input className="grow" autoFocus placeholder="Clinical reason, e.g. co-prescribed routinely in heart failure clinic with potassium checks" value={reason} onChange={(e) => setReason(e.target.value)} />
          <button className="primary sm" disabled={reason.trim().length < 10} onClick={() => act('/api/safety/alert-rules/quiet', { rule: r.rule, reason }, 'Rule no longer interrupts')}>Confirm</button></div>
      </td></tr>}
    </>
  );
}
