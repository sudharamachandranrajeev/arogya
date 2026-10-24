import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { get, post, type User } from '../api.ts';

export function Inbox({ user }: { user: User }) {
  const [tasks, setTasks] = useState<any[]>([]);
  const [msg, setMsg] = useState('');
  const load = () => get('/api/inbox').then(setTasks);
  useEffect(() => { load(); const t = setInterval(load, 30000); return () => clearInterval(t); }, []);
  const normals = tasks.filter((t) => t.kind === 'result' && t.normal).length;
  const canAck = ['clinician', 'nurse'].includes(user.role);
  return (
    <>
      <h2>Inbox <span className="chip">{tasks.length}</span></h2>
      {canAck && normals > 0 && (
        <div className="card row">
          <span>{normals} normal result{normals > 1 ? 's' : ''} need no action beyond acknowledgement.</span>
          <button className="primary" onClick={async () => { const r = await post('/api/inbox/bulk-ack'); setMsg(`${r.acknowledged} acknowledged`); load(); }}>Acknowledge all normal results</button>
        </div>
      )}
      {msg && <div className="muted">{msg}</div>}
      <div className="card">
        <table>
          <thead><tr><th>Type</th><th>Patient / item</th><th>Queue</th><th>Waiting</th><th /></tr></thead>
          <tbody>
            {tasks.map((t) => (
              <tr key={t.id}>
                <td><span className={`chip ${t.priority === 'urgent' ? 'bad' : t.normal ? 'ok' : ''}`}>{t.kind}{t.normal ? ' · normal' : ''}</span></td>
                <td>{t.patientId ? <Link to={`/patients/${t.patientId}`}>{t.subject}</Link> : t.subject}</td>
                <td className="muted">{t.pool.startsWith('user:') ? 'mine' : t.pool}</td>
                <td className="muted">{Math.max(0, Math.round((Date.now() - Date.parse(t.createdAt)) / 3600000))} h</td>
                <td><button onClick={async () => { await post(`/api/inbox/${t.id}/done`, {}); load(); }}>Done</button></td>
              </tr>
            ))}
            {!tasks.length && <tr><td colSpan={5} className="muted">Nothing waiting.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
