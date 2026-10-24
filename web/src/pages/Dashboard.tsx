import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { get } from '../api.ts';
import { Empty, Kpi, Skeleton, si } from '../ui.tsx';

export function Dashboard() {
  const [k, setK] = useState<any>(null);
  const [stuck, setStuck] = useState<any[]>([]);
  const [rules, setRules] = useState<any[]>([]);
  useEffect(() => {
    get('/api/kpi').then(setK);
    get('/api/stuck-work').then(setStuck).catch(() => {});
    get('/api/safety/alert-rules').then(setRules).catch(() => {});
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
          {!rules.length ? <Empty>No interruptive alerts in the last 180 days.</Empty> : <div className="table-wrap"><table>
            <thead><tr><th>Rule</th><th className="num">Fired</th><th className="num">Overridden</th></tr></thead>
            <tbody>{rules.map((r) => <tr key={r.rule}><td>{r.rule} {r.review && <span className="chip warn" title="Overridden more than 95% of the time: review whether it helps">review</span>}</td><td className="num">{r.fired}</td><td className="num">{r.overridePct}%</td></tr>)}</tbody>
          </table></div>}
        </div>
      </div>
    </>
  );
}
