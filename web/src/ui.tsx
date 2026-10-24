import { createContext, useCallback, useContext, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { age, fullName, label } from './api.ts';

// ---------- icons (inline, stroke-based) ----------
const P: Record<string, string> = {
  today: 'M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z',
  inbox: 'M22 12h-6l-2 3h-4l-2-3H2M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  chart: 'M3 3v18h18M7 15l4-4 3 3 5-6',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  user: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.35-4.35',
  check: 'M20 6 9 17l-5-5',
  alert: 'M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0zM12 9v4M12 17h.01',
  lock: 'M19 11H5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2zM7 11V7a5 5 0 0 1 10 0v4',
  plus: 'M12 5v14M5 12h14',
  pulse: 'M22 12h-4l-3 9L9 3l-3 9H2',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
};
export function Icon({ name, size = 18 }: { name: keyof typeof P | string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={P[name] ?? ''} />
    </svg>
  );
}

/** Index for staggered entrance animations. */
export const si = (i: number) => ({ '--i': i }) as CSSProperties;

// ---------- toasts ----------
type Toast = { id: number; text: string; tone?: 'bad'; out?: boolean };
const ToastCtx = createContext<(text: string, tone?: 'bad') => void>(() => {});
export const useToast = () => useContext(ToastCtx);
export function Toasts({ children }: { children: ReactNode }) {
  const [list, setList] = useState<Toast[]>([]);
  const seq = useRef(0);
  const push = useCallback((text: string, tone?: 'bad') => {
    const id = ++seq.current;
    setList((l) => [...l.slice(-3), { id, text, tone }]);
    setTimeout(() => setList((l) => l.map((t) => (t.id === id ? { ...t, out: true } : t))), 4000);
    setTimeout(() => setList((l) => l.filter((t) => t.id !== id)), 4300);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {list.map((t) => <div key={t.id} className={`toast ${t.tone ?? ''} ${t.out ? 'out' : ''}`}><Icon name={t.tone ? 'alert' : 'check'} />{t.text}</div>)}
      </div>
    </ToastCtx.Provider>
  );
}

// ---------- small pieces ----------
export const Skeleton = ({ rows = 4, h = 18 }: { rows?: number; h?: number }) => (
  <div style={{ display: 'grid', gap: 10 }}>{Array.from({ length: rows }, (_, i) => <div key={i} className="skel" style={{ height: h, width: `${92 - ((i * 17) % 30)}%` }} />)}</div>
);

export const Empty = ({ children }: { children: ReactNode }) => <div className="empty"><Icon name="check" size={26} />{children}</div>;

/** Animate a number to its new value; plain text if motion is reduced. */
export function CountUp({ value, suffix = '' }: { value: number | null | undefined; suffix?: string }) {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    if (value === null || value === undefined) return;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { setShown(value); return; }
    const start = performance.now(), from = 0, dur = 650;
    let raf = 0;
    const tick = (t: number) => {
      const k = Math.min(1, (t - start) / dur);
      setShown(from + (value - from) * (1 - Math.pow(1 - k, 3)));
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  if (value === null || value === undefined) return <>–</>;
  return <>{Number.isInteger(value) ? Math.round(shown) : shown.toFixed(1)}{suffix}</>;
}

export function Kpi({ v, l, tone, suffix }: { v: number | null | undefined; l: string; tone?: string; suffix?: string }) {
  return <div className={`kpi ${tone ?? ''}`}><b><CountUp value={v} suffix={suffix} /></b><span>{l}</span></div>;
}

/** Who this is, shown the same way on every clinical screen: name, date of birth, ID, allergies. */
export function PatientBanner({ p, allergies = [], restricted, extra }: { p: any; allergies?: any[]; restricted?: boolean; extra?: ReactNode }) {
  const n = fullName(p);
  const initials = n.split(' ').map((w: string) => w[0]).slice(0, 2).join('');
  return (
    <div className="patient-banner">
      <div className="avatar">{initials}</div>
      <div>
        <div className="name">{n} {restricted && <span className="chip bad"><Icon name="lock" size={12} />Restricted</span>}</div>
        <div className="ids">
          <span><b>DOB</b>{p.birthDate} ({age(p.birthDate)} y)</span>
          <span><b>Sex</b>{p.gender}</span>
          <span><b>ID</b>{p.identifier?.[0]?.value ?? '—'}</span>
        </div>
      </div>
      <div className="allergy-strip">
        {allergies.length ? allergies.map((a) => <span key={a.id} className="chip bad"><Icon name="alert" size={12} />{label(a.code)}</span>) : <span className="chip ok">No known allergies recorded</span>}
        {extra}
      </div>
    </div>
  );
}
