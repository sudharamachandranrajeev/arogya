import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { get, post, time, type User } from '../api.ts';
import { Empty, Icon, Skeleton, si, useToast } from '../ui.tsx';

const isoDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const STATUS: Record<string, [string, string]> = { booked: ['Booked', ''], arrived: ['Arrived', 'info'], fulfilled: ['Seen', 'ok'], noshow: ['Did not attend', 'bad'] };

export function Today({ user }: { user: User }) {
  const [date, setDate] = useState(isoDay(new Date()));
  const [all, setAll] = useState(!user.practitionerId);
  const [list, setList] = useState<any[] | null>(null);
  const toast = useToast();
  const nav = useNavigate();
  const load = () => get(`/api/today?date=${date}${all ? '&all=1' : ''}`).then(setList);
  useEffect(() => { setList(null); load(); }, [date, all]);
  const shift = (n: number) => { const d = new Date(date + 'T12:00'); d.setDate(d.getDate() + n); setDate(isoDay(d)); };
  const set = async (a: any, status: string, msg: string) => {
    await post(`/api/appointments/${a.id}/status`, { status });
    toast(msg); load();
  };
  const now = Date.now();
  const n = (s: string) => list?.filter((a) => a.status === s).length ?? 0;
  const label = date === isoDay(new Date()) ? 'Today' : new Date(date + 'T12:00').toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  return (
    <>
      <div className="page-head">
        <div><h2>{label}</h2><div className="sub">{list ? `${list.length} appointments · ${n('arrived')} waiting · ${n('fulfilled')} seen · ${n('noshow')} did not attend` : 'Loading…'}</div></div>
        <div className="row center">
          {user.practitionerId && <button className="ghost" onClick={() => setAll(!all)}>{all ? 'Show my clinic' : 'Show whole clinic'}</button>}
          <button onClick={() => shift(-1)} aria-label="Previous day">‹</button>
          <button onClick={() => setDate(isoDay(new Date()))}>Today</button>
          <button onClick={() => shift(1)} aria-label="Next day">›</button>
        </div>
      </div>
      {!list ? <div className="card"><Skeleton rows={5} h={42} /></div> : !list.length ? <div className="card"><Empty>No appointments on this day.</Empty></div> : (
        <div className="timeline stagger">
          {list.map((a, i) => {
            const live = Date.parse(a.start) <= now && Date.parse(a.end) > now;
            const [st, tone] = STATUS[a.status] ?? [a.status, ''];
            return (
              <div key={a.id} style={si(i)} className={`slot ${a.status === 'fulfilled' || a.status === 'noshow' ? 'done' : ''} ${live ? 'now' : ''}`}>
                <div className="time">{time(a.start)}<small>{time(a.end)}</small></div>
                <div>
                  <div className="row center" style={{ gap: 8 }}>
                    <Link className="who" to={`/patients/${a.patientId}${a.status === 'arrived' ? `?appt=${a.id}` : ''}`}>{a.patientName || 'Unnamed patient'}</Link>
                    <span className={`chip ${tone}`}>{st}</span>
                    {a.status === 'booked' && a.confirmed && <span className="chip ok" title={`Confirmed by text ${time(a.confirmed)}`}><Icon name="check" size={12} />Confirmed</span>}
                    {a.allergies > 0 && <span className="chip bad"><Icon name="alert" size={12} />{a.allergies} allerg{a.allergies > 1 ? 'ies' : 'y'}</span>}
                    {a.status === 'booked' && a.dnaRisk && a.dnaRisk.risk >= 0.3 && <span className="chip warn" title={a.dnaRisk.reasons.join('; ')}>No-show risk {Math.round(a.dnaRisk.risk * 100)}%</span>}
                  </div>
                  <div className="muted small">{a.service}</div>
                </div>
                <div className="acts">
                  {a.status === 'booked' && <button className="sm" onClick={() => set(a, 'arrived', `${a.patientName} checked in`)}><Icon name="check" size={14} />Arrived</button>}
                  {a.status === 'booked' && Date.parse(a.start) < now && <button className="sm danger" onClick={() => set(a, 'noshow', `${a.patientName} marked as did not attend`)}>DNA</button>}
                  {['clinician', 'nurse'].includes(user.role) && (a.status === 'arrived' || a.status === 'booked') && <button className="sm primary" onClick={() => nav(`/patients/${a.patientId}?appt=${a.id}`)}>Start visit</button>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
