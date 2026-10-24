import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ago, get, post, type User } from '../api.ts';
import { Empty, Icon, Skeleton, si, useToast } from '../ui.tsx';

const KINDS = ['all', 'result', 'referral', 'chase', 'message', 'backfill'];

export function Inbox({ user, onCount }: { user: User; onCount: (n: number) => void }) {
  const [tasks, setTasks] = useState<any[] | null>(null);
  const [leaving, setLeaving] = useState<Set<string>>(new Set());
  const [kind, setKind] = useState('all');
  const toast = useToast();
  const load = () => get('/api/inbox').then((t) => { setTasks(t); onCount(t.length); });
  useEffect(() => { load(); const t = setInterval(load, 30000); return () => clearInterval(t); }, []);
  const done = async (t: any) => {
    setLeaving((s) => new Set(s).add(t.id));
    await post(`/api/inbox/${t.id}/done`, {});
    setTimeout(load, 220);
  };
  if (!tasks) return <div className="card"><Skeleton rows={6} h={30} /></div>;
  const normals = tasks.filter((t) => t.kind === 'result' && t.normal);
  const canAck = ['clinician', 'nurse'].includes(user.role);
  const shown = tasks.filter((t) => kind === 'all' || t.kind === kind);
  return (
    <>
      <div className="page-head">
        <div><h2>Inbox</h2><div className="sub">{tasks.length} open · {tasks.filter((t) => t.priority === 'urgent').length} urgent · {tasks.filter((t) => t.overdue).length} overdue</div></div>
        <div className="row">{KINDS.map((k) => <button key={k} className={`sm ${kind === k ? 'primary' : 'ghost'}`} onClick={() => setKind(k)}>{k} {k !== 'all' && <span className="muted">{tasks.filter((t) => t.kind === k).length}</span>}</button>)}</div>
      </div>
      {canAck && normals.length > 0 && (
        <div className="banner info"><Icon name="check" /><div className="grow">{normals.length} normal result{normals.length > 1 ? 's' : ''} need only acknowledgement. Abnormal results stay in your list.</div>
          <button className="primary" onClick={async () => {
            setLeaving(new Set(normals.map((t) => t.id)));
            const r = await post('/api/inbox/bulk-ack');
            toast(`${r.acknowledged} normal results acknowledged`);
            setTimeout(load, 240);
          }}>Acknowledge all normal</button></div>
      )}
      <div className="card">
        {!shown.length ? <Empty>Nothing waiting. Well done.</Empty> : (
          <div className="table-wrap"><table>
            <thead><tr><th>Type</th><th>Patient / item</th><th>Queue</th><th className="num">Waiting</th><th /></tr></thead>
            <tbody className="stagger">
              {shown.map((t, i) => (
                <tr key={t.id} style={si(i)} className={leaving.has(t.id) ? 'leaving' : ''}>
                  <td><div className="row center" style={{ gap: 4 }}>
                    <span className={`chip ${t.priority === 'urgent' ? 'bad' : t.normal ? 'ok' : 'brand'} ${t.escalated ? 'pulse' : ''}`}>{t.kind}{t.normal ? ' · normal' : ''}</span>
                    {t.escalated && <span className="chip bad" title="Critical result not closed within an hour">escalated</span>}
                    {t.overdue && <span className="chip warn">overdue</span>}
                  </div></td>
                  <td>{t.patientId ? <Link to={`/patients/${t.patientId}`}>{t.subject}</Link> : t.subject}</td>
                  <td className="muted">{t.pool.startsWith('user:') ? 'mine' : t.pool}</td>
                  <td className="num muted">{ago(t.createdAt)}</td>
                  <td className="num"><button className="sm" onClick={() => done(t)}><Icon name="check" size={14} />Done</button></td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </div>
    </>
  );
}
