import { useEffect, useState } from 'react';
import { get } from '../api.ts';

const K = ({ v, l, tone }: { v: any; l: string; tone?: string }) => <div className={`kpi ${tone ?? ''}`}><b>{v ?? '–'}</b><span>{l}</span></div>;

export function Dashboard() {
  const [k, setK] = useState<any>(null);
  useEffect(() => { get('/api/kpi').then(setK); }, []);
  if (!k) return <div className="muted">Loading…</div>;
  const w = k.waitingList, a = k.appointments, i = k.inbox;
  return (
    <>
      <h2>Dashboard <span className="muted" style={{ fontSize: 14 }}>last {k.sinceDays} days</span></h2>
      <h3>Access and waiting</h3>
      <div className="kpis">
        <K v={w.size} l="Waiting list" /><K v={w.averageWaitDays} l="Average wait (days)" /><K v={w.longestWaitDays} l="Longest wait (days)" />
        <K v={w.breached} l="Breached target" tone={w.breached ? 'bad' : 'ok'} /><K v={w.breachingSoon} l="Breaching within 14 days" tone={w.breachingSoon ? 'warn' : 'ok'} />
        <K v={w.withinTargetPct === null ? null : `${w.withinTargetPct}%`} l="Within target" />
      </div>
      <h3>Appointments</h3>
      <div className="kpis">
        <K v={a.attended} l="Attended" /><K v={a.dna} l="Did not attend" /><K v={a.dnaRatePct === null ? null : `${a.dnaRatePct}%`} l="DNA rate" tone={a.dnaRatePct > 10 ? 'bad' : ''} />
        <K v={a.cancelled} l="Cancelled" /><K v={a.lostSlots} l="Slots lost" tone={a.lostSlots ? 'warn' : ''} />
      </div>
      <h3>Inbox and safety</h3>
      <div className="kpis">
        <K v={i.open} l="Open inbox items" /><K v={`${i.resultTurnaroundHours} h`} l="Result turnaround" /><K v={k.safety.alertOverrides} l="Safety alert overrides" /><K v={k.safety.prescriptions} l="Prescriptions" />
      </div>
      <h3>Inbox by type</h3>
      <div className="card"><table><thead><tr><th>Type</th><th>Open</th><th>Avg age (days)</th><th>Normal results</th></tr></thead>
        <tbody>{Object.entries(i.byKind).map(([n, v]: any) => <tr key={n}><td>{n}</td><td>{v.open}</td><td>{v.avgAgeDays}</td><td>{v.normalResults}</td></tr>)}</tbody></table></div>
    </>
  );
}
