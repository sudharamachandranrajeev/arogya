import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { ApiError, fullName, get, post, type User } from './api.ts';
import { Icon, Toasts } from './ui.tsx';
import { Today } from './pages/Today.tsx';
import { Inbox } from './pages/Inbox.tsx';
import { Patients } from './pages/Patients.tsx';
import { Chart } from './pages/Chart.tsx';
import { Schedule } from './pages/Schedule.tsx';
import { Recalls } from './pages/Recalls.tsx';
import { Referrals } from './pages/Referrals.tsx';
import { Dashboard } from './pages/Dashboard.tsx';
import { Admin } from './pages/Admin.tsx';
import { Account, MfaSetup } from './pages/Account.tsx';

type Nav = { to: string; name: string; icon: string; key: string; roles: string[] };
const NAV: Nav[] = [
  { to: '/today', name: 'Today', icon: 'today', key: 't', roles: ['clinician', 'nurse', 'reception'] },
  { to: '/inbox', name: 'Inbox', icon: 'inbox', key: 'i', roles: ['clinician', 'nurse', 'reception', 'manager'] },
  { to: '/patients', name: 'Patients', icon: 'users', key: 'p', roles: ['admin', 'clinician', 'nurse', 'reception', 'biller'] },
  { to: '/schedule', name: 'Waiting list', icon: 'list', key: 'w', roles: ['clinician', 'nurse', 'reception', 'manager', 'admin'] },
  { to: '/recalls', name: 'Recalls', icon: 'repeat', key: 'r', roles: ['clinician', 'nurse', 'reception', 'manager'] },
  { to: '/referrals', name: 'Referrals out', icon: 'send', key: 'o', roles: ['clinician', 'nurse', 'reception', 'manager'] },
  { to: '/dashboard', name: 'Dashboard', icon: 'chart', key: 'd', roles: ['clinician', 'manager', 'admin'] },
  { to: '/admin', name: 'Admin', icon: 'shield', key: 'a', roles: ['admin'] },
  { to: '/account', name: 'My account', icon: 'user', key: 'm', roles: ['admin', 'clinician', 'nurse', 'reception', 'manager', 'biller'] },
];
/** Lock the screen after this much inactivity: patient data must not stay on an unattended display. */
const LOCK_AFTER_MS = 10 * 60_000;

function SignIn({ onUser, lockedAs }: { onUser: (u: User, mfaSetupRequired: boolean) => void; lockedAs?: User }) {
  const [username, setU] = useState(lockedAs?.username ?? '');
  const [password, setP] = useState('');
  const [code, setCode] = useState('');
  const [needCode, setNeedCode] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="auth">
      <form className="dialog" onSubmit={async (e) => {
        e.preventDefault(); setErr(''); setBusy(true);
        try { const r = await post('/api/login', { username, password, code: code || undefined }); onUser(r.user, !!r.mfaSetupRequired); }
        catch (x: any) { if (x instanceof ApiError && x.alerts?.mfaRequired) setNeedCode(true); else setErr(x.message); }
        finally { setBusy(false); }
      }}>
        <div className="brand"><div className="brand-mark"><Icon name="pulse" /></div>Arogya</div>
        {lockedAs ? <div className="banner info"><Icon name="lock" /><div>Screen locked. Sign in again as <b>{lockedAs.name}</b> to carry on where you were.</div></div>
          : <div className="sub">Sign in to continue</div>}
        {!lockedAs && <label>Username<input autoFocus value={username} onChange={(e) => setU(e.target.value)} autoComplete="username" /></label>}
        <label>Password<input autoFocus={!!lockedAs} type="password" value={password} onChange={(e) => setP(e.target.value)} autoComplete="current-password" /></label>
        {needCode && <label>Code from your authenticator app<input autoFocus inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} autoComplete="one-time-code" /></label>}
        {err && <div className="err">{err}</div>}
        <button className="primary" disabled={busy || !username || !password}>{busy ? 'Signing in…' : 'Sign in'}</button>
        <div className="lock-note">Every access to a patient record is logged.</div>
      </form>
    </div>
  );
}

function Palette({ links, onClose }: { links: Nav[]; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [pts, setPts] = useState<any[]>([]);
  const [on, setOn] = useState(0);
  const nav = useNavigate();
  useEffect(() => {
    if (q.trim().length < 2) { setPts([]); return; }
    const t = setTimeout(() => get(`/api/search/patients?q=${encodeURIComponent(q)}`).then(setPts).catch(() => setPts([])), 150);
    return () => clearTimeout(t);
  }, [q]);
  const items = [
    ...pts.slice(0, 8).map((p) => ({ label: fullName(p), hint: `${p.birthDate} · ${p.identifier?.[0]?.value ?? ''}`, icon: 'user', go: `/patients/${p.id}` })),
    ...links.filter((l) => l.name.toLowerCase().includes(q.toLowerCase())).map((l) => ({ label: `Go to ${l.name}`, hint: `g ${l.key}`, icon: l.icon, go: l.to })),
  ];
  const pick = (i: number) => { const it = items[i]; if (it) { nav(it.go); onClose(); } };
  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="dialog palette" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Command palette">
        <input autoFocus placeholder="Find a patient or jump to a page…" value={q}
          onChange={(e) => { setQ(e.target.value); setOn(0); }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setOn((o) => Math.min(o + 1, items.length - 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setOn((o) => Math.max(o - 1, 0)); }
            if (e.key === 'Enter') pick(on);
            if (e.key === 'Escape') onClose();
          }} />
        <ul>{items.map((it, i) => <li key={it.go + i} className={i === on ? 'on' : ''} onMouseEnter={() => setOn(i)} onClick={() => pick(i)}><Icon name={it.icon} size={16} />{it.label}<small>{it.hint}</small></li>)}
          {!items.length && <li className="muted">No match</li>}</ul>
        <div className="hint"><span><kbd>↑</kbd> <kbd>↓</kbd> move</span><span><kbd>Enter</kbd> open</span><span><kbd>Esc</kbd> close</span></div>
      </div>
    </div>
  );
}

function SideNav({ links, inboxCount }: { links: Nav[]; inboxCount: number }) {
  const loc = useLocation();
  const box = useRef<HTMLDivElement>(null);
  const [pill, setPill] = useState<{ y: number; h: number } | null>(null);
  // The highlight glides to the active page instead of jumping.
  useLayoutEffect(() => {
    const a = box.current?.querySelector<HTMLAnchorElement>('a.active');
    setPill(a ? { y: a.offsetTop, h: a.offsetHeight } : null);
  }, [loc.pathname, links.length]);
  return (
    <div className="nav" ref={box}>
      {pill && <div className="nav-pill" style={{ transform: `translateY(${pill.y}px)`, height: pill.h, top: 0 }} />}
      {links.map((l) => (
        <NavLink key={l.to} to={l.to} className={({ isActive }) => (isActive ? 'active' : '')}>
          <Icon name={l.icon} />{l.name}
          {l.to === '/inbox' && inboxCount > 0 && <span className="count" key={inboxCount}>{inboxCount}</span>}
        </NavLink>
      ))}
    </div>
  );
}

export function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [locked, setLocked] = useState<User | null>(null);
  const [mfaNeeded, setMfaNeeded] = useState(false);
  const [palette, setPalette] = useState(false);
  const [inboxCount, setInboxCount] = useState(0);
  const nav = useNavigate();
  const loc = useLocation();

  const refreshMe = useCallback(() => get('/api/me').then((r) => { setUser(r.user); setMfaNeeded(!!r.mfaSetupRequired); }).catch(() => setUser(null)), []);
  useEffect(() => { refreshMe(); }, [refreshMe]);

  const lock = useCallback(async () => {
    if (!user) return;
    await post('/api/logout').catch(() => {});
    setLocked(user); setUser(null); setPalette(false);
  }, [user]);

  useEffect(() => {
    const out = () => setUser((u) => { if (u) setLocked(u); return null; });
    const mfa = () => setMfaNeeded(true);
    addEventListener('arogya:signed-out', out);
    addEventListener('arogya:mfa-required', mfa);
    return () => { removeEventListener('arogya:signed-out', out); removeEventListener('arogya:mfa-required', mfa); };
  }, []);

  // Idle lock.
  useEffect(() => {
    if (!user) return;
    let t = setTimeout(lock, LOCK_AFTER_MS);
    const reset = () => { clearTimeout(t); t = setTimeout(lock, LOCK_AFTER_MS); };
    const evs = ['mousemove', 'keydown', 'pointerdown', 'scroll'];
    evs.forEach((e) => addEventListener(e, reset, { passive: true }));
    return () => { clearTimeout(t); evs.forEach((e) => removeEventListener(e, reset)); };
  }, [user, lock]);

  // Inbox badge.
  useEffect(() => {
    if (!user || mfaNeeded || !NAV[1].roles.includes(user.role)) return;
    const load = () => get('/api/inbox').then((t) => setInboxCount(t.length)).catch(() => {});
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [user, mfaNeeded, loc.pathname]);

  const links = user ? NAV.filter((l) => l.roles.includes(user.role)) : [];

  // Keyboard: Ctrl/Cmd+K palette, "/" patient search, "g x" go to page, Ctrl+Shift+L lock.
  useEffect(() => {
    let g = false;
    const h = (e: KeyboardEvent) => {
      const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement).tagName);
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((p) => !p); return; }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'l') { e.preventDefault(); lock(); return; }
      if (typing) return;
      if (e.key === '/') { e.preventDefault(); setPalette(true); return; }
      if (g) { const l = links.find((x) => x.key === e.key); if (l) nav(l.to); g = false; return; }
      if (e.key === 'g') { g = true; setTimeout(() => (g = false), 900); }
    };
    addEventListener('keydown', h);
    return () => removeEventListener('keydown', h);
  }, [nav, links, lock]);

  if (user === undefined) return null;
  if (!user) return <Toasts><SignIn lockedAs={locked ?? undefined} onUser={(u, mfa) => { setLocked(null); setMfaNeeded(mfa); setUser(u); if (!locked || locked.id !== u.id) nav('/'); }} /></Toasts>;
  if (mfaNeeded) return <Toasts><div className="auth"><MfaSetup forced onDone={() => { setMfaNeeded(false); refreshMe(); }} /></div></Toasts>;
  const home = links[0]?.to ?? '/account';
  return (
    <Toasts>
      <div className="shell">
        <nav className="side" aria-label="Main">
          <div className="brand"><div className="brand-mark"><Icon name="pulse" /></div><span>Arogya</span></div>
          <SideNav links={links} inboxCount={inboxCount} />
          <div className="side-foot">
            <div><div className="me">{user.name}</div>{user.role}{user.mfa && <> · <Icon name="shield" size={12} /> 2-step on</>}</div>
            <div><kbd>Ctrl</kbd> <kbd>K</kbd> find anything</div>
            <div className="row">
              <button className="sm" onClick={lock} title="Ctrl+Shift+L"><Icon name="lock" size={14} />Lock</button>
              <button className="sm ghost" onClick={async () => { await post('/api/logout'); setUser(null); }}><Icon name="logout" size={14} />Sign out</button>
            </div>
          </div>
        </nav>
        <main>
          <div className="page" key={loc.pathname}>
            <Routes location={loc}>
              <Route path="/" element={<Navigate to={home} replace />} />
              <Route path="/today" element={<Today user={user} />} />
              <Route path="/inbox" element={<Inbox user={user} onCount={setInboxCount} />} />
              <Route path="/patients" element={<Patients user={user} />} />
              <Route path="/patients/:id" element={<Chart user={user} />} />
              <Route path="/schedule" element={<Schedule user={user} />} />
              <Route path="/recalls" element={<Recalls user={user} />} />
              <Route path="/referrals" element={<Referrals user={user} />} />
              <Route path="/dashboard" element={<Dashboard user={user} />} />
              <Route path="/admin" element={<Admin user={user} />} />
              <Route path="/account" element={<Account user={user} onChange={refreshMe} />} />
              <Route path="*" element={<Navigate to={home} replace />} />
            </Routes>
          </div>
        </main>
      </div>
      {palette && <Palette links={links} onClose={() => setPalette(false)} />}
    </Toasts>
  );
}
