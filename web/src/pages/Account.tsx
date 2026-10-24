import { useState } from 'react';
import qrcode from 'qrcode-generator';
import { post, type User } from '../api.ts';
import { Icon, useToast } from '../ui.tsx';

function Qr({ text }: { text: string }) {
  const q = qrcode(0, 'M');
  q.addData(text);
  q.make();
  return <div className="qr" dangerouslySetInnerHTML={{ __html: q.createSvgTag({ cellSize: 4, margin: 0, scalable: false }) }} />;
}

export function MfaSetup({ forced, onDone }: { forced?: boolean; onDone: () => void }) {
  const [s, setS] = useState<{ secret: string; uri: string } | null>(null);
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  const toast = useToast();
  return (
    <div className="dialog" style={{ display: 'grid', gap: 12, margin: forced ? undefined : 0, width: '100%', maxWidth: 520, boxShadow: forced ? undefined : 'none' }}>
      <h2><Icon name="shield" size={20} /> Two-step verification</h2>
      {forced && <div className="banner info"><Icon name="lock" /><div>Your role must use two-step verification before opening patient records.</div></div>}
      <div className="muted">Use an authenticator app (for example Aegis, Google Authenticator, Microsoft Authenticator or 1Password). Each sign-in will ask for a 6-digit code from it.</div>
      {!s ? <button className="primary" onClick={async () => setS(await post('/api/account/mfa/start'))}>Set up</button> : (
        <>
          <div className="row center" style={{ gap: 16, alignItems: 'center' }}>
            <Qr text={s.uri} />
            <div className="grow small">Scan the code, or type this key:<br /><code className="secret">{s.secret.match(/.{1,4}/g)!.join(' ')}</code></div>
          </div>
          <label>6-digit code from the app<input autoFocus inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} autoComplete="one-time-code" /></label>
          {err && <div className="err">{err}</div>}
          <button className="primary" disabled={code.length !== 6} onClick={async () => {
            setErr('');
            try { await post('/api/account/mfa/confirm', { code }); toast('Two-step verification is on'); onDone(); } catch (e: any) { setErr(e.message); }
          }}>Turn on</button>
        </>
      )}
    </div>
  );
}

export function Account({ user, onChange }: { user: User; onChange: () => void }) {
  const [pw, setPw] = useState({ current: '', next: '', again: '' });
  const [off, setOff] = useState('');
  const [err, setErr] = useState('');
  const toast = useToast();
  const weak = pw.next.length > 0 && pw.next.length < 12;
  return (
    <>
      <div className="page-head"><div><h2>My account</h2><div className="sub">{user.name} · {user.username} · {user.role}</div></div></div>
      <div className="grid">
        <div className="card">
          {user.mfa ? (
            <>
              <h3>Two-step verification <span className="chip ok">on</span></h3>
              <div className="muted" style={{ marginBottom: 10 }}>Sign-in asks for a code from your authenticator app. Lost your phone? Ask an administrator to reset it.</div>
              <div className="row"><label className="grow">Password to turn it off<input type="password" value={off} onChange={(e) => setOff(e.target.value)} /></label>
                <button className="danger" disabled={!off} onClick={async () => { try { await post('/api/account/mfa/disable', { password: off }); toast('Two-step verification turned off', 'bad'); setOff(''); onChange(); } catch (e: any) { toast(e.message, 'bad'); } }}>Turn off</button></div>
            </>
          ) : <MfaSetup onDone={onChange} />}
        </div>
        <div className="card">
          <h3>Change password</h3>
          <div style={{ display: 'grid', gap: 10 }}>
            <label>Current password<input type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} /></label>
            <label>New password (12 or more characters; a short sentence works well)<input type="password" autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} /></label>
            <label>New password again<input type="password" autoComplete="new-password" value={pw.again} onChange={(e) => setPw({ ...pw, again: e.target.value })} /></label>
            {weak && <div className="small" style={{ color: 'var(--warn)' }}>{12 - pw.next.length} more characters</div>}
            {pw.again && pw.again !== pw.next && <div className="small" style={{ color: 'var(--warn)' }}>The new passwords do not match</div>}
            {err && <div className="err">{err}</div>}
            <button className="primary" disabled={!pw.current || pw.next.length < 12 || pw.next !== pw.again} onClick={async () => {
              setErr('');
              try { await post('/api/account/password', { current: pw.current, next: pw.next }); toast('Password changed. Other sessions were signed out.'); setPw({ current: '', next: '', again: '' }); } catch (e: any) { setErr(e.message); }
            }}>Change password</button>
          </div>
        </div>
      </div>
      <div className="card section">
        <h3>Keyboard</h3>
        <div className="row" style={{ gap: 18 }}>
          <span><kbd>Ctrl</kbd> <kbd>K</kbd> or <kbd>/</kbd> find a patient or page</span>
          <span><kbd>g</kbd> then <kbd>t</kbd> <kbd>i</kbd> <kbd>p</kbd> <kbd>w</kbd> <kbd>d</kbd> go to Today, Inbox, Patients, Waiting list, Dashboard</span>
          <span><kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>L</kbd> lock the screen</span>
        </div>
      </div>
    </>
  );
}
