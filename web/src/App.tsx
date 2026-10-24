import { useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { get, post, type User } from './api.ts';
import { Inbox } from './pages/Inbox.tsx';
import { Patients } from './pages/Patients.tsx';
import { Chart } from './pages/Chart.tsx';
import { Schedule } from './pages/Schedule.tsx';
import { Dashboard } from './pages/Dashboard.tsx';
import { Admin } from './pages/Admin.tsx';

const NAV: Array<[string, string, string[]]> = [
  ['/inbox', 'Inbox', ['clinician', 'nurse', 'reception', 'manager']],
  ['/patients', 'Patients', ['admin', 'clinician', 'nurse', 'reception', 'biller']],
  ['/schedule', 'Schedule', ['clinician', 'nurse', 'reception', 'manager', 'admin']],
  ['/dashboard', 'Dashboard', ['clinician', 'manager', 'admin']],
  ['/admin', 'Admin', ['admin']],
];

function Login({ onUser }: { onUser: (u: User) => void }) {
  const [username, setU] = useState('');
  const [password, setP] = useState('');
  const [err, setErr] = useState('');
  return (
    <form className="login" onSubmit={async (e) => {
      e.preventDefault();
      try { onUser((await post('/api/login', { username, password })).user); } catch (x: any) { setErr(x.message); }
    }}>
      <h2>Arogya</h2>
      <div className="card">
        <label>Username<input autoFocus value={username} onChange={(e) => setU(e.target.value)} autoComplete="username" /></label>
        <label>Password<input type="password" value={password} onChange={(e) => setP(e.target.value)} autoComplete="current-password" /></label>
        {err && <div className="err">{err}</div>}
        <button className="primary">Sign in</button>
      </div>
    </form>
  );
}

export function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const nav = useNavigate();
  useEffect(() => { get('/api/me').then((r) => setUser(r.user)).catch(() => setUser(null)); }, []);
  // Keyboard-first: "/" jumps to patient search from anywhere outside a field.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) { e.preventDefault(); nav('/patients'); }
    };
    addEventListener('keydown', h);
    return () => removeEventListener('keydown', h);
  }, [nav]);

  if (user === undefined) return null;
  if (!user) return <Login onUser={(u) => { setUser(u); nav('/'); }} />;
  const links = NAV.filter(([, , roles]) => roles.includes(user.role));
  const home = links[0]?.[0] ?? '/patients';
  return (
    <div className="shell">
      <nav className="side">
        <h1>Arogya</h1>
        {links.map(([to, name]) => <NavLink key={to} to={to} className={({ isActive }) => (isActive ? 'active' : '')}>{name}</NavLink>)}
        <div className="who">
          {user.name}<br />{user.role}<br />
          <button onClick={async () => { await post('/api/logout'); setUser(null); }}>Sign out</button>
          <div style={{ marginTop: 8 }}>Press <kbd>/</kbd> to find a patient</div>
        </div>
      </nav>
      <main>
        <Routes>
          <Route path="/" element={<Navigate to={home} replace />} />
          <Route path="/inbox" element={<Inbox user={user} />} />
          <Route path="/patients" element={<Patients user={user} />} />
          <Route path="/patients/:id" element={<Chart user={user} />} />
          <Route path="/schedule" element={<Schedule user={user} />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/admin" element={<Admin />} />
        </Routes>
      </main>
    </div>
  );
}
