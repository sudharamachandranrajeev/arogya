import { openDb } from './db.ts';
import { buildApp } from './app.ts';
import { readFileSync, writeFileSync } from 'node:fs';
import { createUser } from './auth.ts';
import { backup, restore } from './backup.ts';
import { loadKey } from './secrets.ts';
import { outbound } from './referrals.ts';
import { runReminders } from './reminders.ts';
import { runIntegrity } from './integrity.ts';
import { audit } from './audit.ts';

loadKey();
const db = await openDb();
const args = process.argv.slice(2);

if (args[0] === 'backup' || args[0] === 'restore') {
  const pass = process.env.AROGYA_BACKUP_PASSPHRASE ?? '';
  if (!args[1] || !pass) { console.error(`usage: AROGYA_BACKUP_PASSPHRASE=... main.ts ${args[0]} <file>`); process.exit(2); }
  if (args[0] === 'backup') { writeFileSync(args[1], await backup(db, pass), { mode: 0o600 }); console.log(`backup written to ${args[1]}`); }
  else console.log('restored', await restore(db, readFileSync(args[1]), pass));
  await db.close();
  process.exit(0);
}

if (args[0] === 'check') {
  const r = await runIntegrity(db);
  for (const c of r.checks) console.log(`${c.status.toUpperCase().padEnd(4)} ${c.name}: ${c.summary}${c.items?.length ? `\n       ${c.items.join('\n       ')}` : ''}`);
  if (r.anchor) console.log(`\nAudit head #${r.anchor.seq} ${r.anchor.hash}\nKeep this line somewhere outside the server: a later head must still contain it.`);
  await audit(db, { username: 'cli', action: 'integrity-check', detail: { status: r.status } });
  await db.close();
  process.exit(r.status === 'fail' ? 1 : 0);
}

if (args[0] === 'reset-mfa') {
  // For a restore onto a server without the old key file: sealed two-step secrets cannot be opened, so people enrol again.
  if (!args[1]) { console.error('usage: main.ts reset-mfa <username>'); process.exit(2); }
  const r = (await db.query('update users set totp_secret=null, totp_pending=null, totp_last_step=null where username=$1 returning id', [args[1].toLowerCase()])).rows;
  await db.query('delete from sessions where user_id = any($1::text[])', [r.map((x) => x.id)]);
  await audit(db, { username: 'cli', action: 'user-update', detail: { username: args[1], resetMfa: true } });
  console.log(r.length ? `two-step verification reset for ${args[1]}` : `no user ${args[1]}`);
  await db.close();
  process.exit(r.length ? 0 : 1);
}

if (args[0] === 'adduser') {
  const [, username, role, name, password] = args;
  if (!password) { console.error('usage: main.ts adduser <username> <role> "<full name>" <password>'); process.exit(2); }
  await createUser(db, { username, role: role as any, name, password });
  console.log(`created ${username}`);
  await db.close();
  process.exit(0);
}

if ((await db.query('select 1 from users limit 1')).rows.length === 0) {
  if (process.env.AROGYA_DEMO === '1') await (await import('./seed.ts')).seed(db);
  else if (process.env.AROGYA_ADMIN_PASSWORD) await createUser(db, { username: 'admin', name: 'Administrator', role: 'admin', password: process.env.AROGYA_ADMIN_PASSWORD });
  else console.warn('No users yet. Set AROGYA_ADMIN_PASSWORD (12+ characters) or AROGYA_DEMO=1, or run: node server/main.ts adduser admin admin "Administrator" <password>');
}

const app = await buildApp(db, { secureCookies: process.env.AROGYA_SECURE_COOKIES === '1' });
const port = Number(process.env.PORT ?? 8080);
await app.listen({ port, host: process.env.HOST ?? '127.0.0.1' });
// Background work: reminders go out and silent referrals get chased without anyone remembering to.
// Each job runs on its own, so one failing never stops the others.
const job = (name: string, fn: () => Promise<unknown>) => async () => {
  try { await fn(); } catch (e) { console.error(`${name} failed:`, (e as Error).message); }
};
const jobs = [job('reminders', () => runReminders(db)), job('referral chasing', () => outbound(db))];
const housekeeping = async () => { for (const j of jobs) await j(); };
setInterval(housekeeping, 5 * 60_000).unref();
void housekeeping();
// Daily integrity check; the result shows on the administration page.
const integrity = job('integrity check', async () => {
  const r = await runIntegrity(db);
  await audit(db, { username: 'system', action: 'integrity-check', detail: { status: r.status, failed: r.checks.filter((c) => c.status !== 'ok').map((c) => c.key) } });
  if (r.status === 'fail') console.error(`integrity check FAILED: ${r.checks.filter((c) => c.status === 'fail').map((c) => c.name).join(', ')}`);
});
setInterval(integrity, 24 * 3600_000).unref();
setTimeout(integrity, 60_000).unref();
console.log(`Arogya listening on http://${process.env.HOST ?? '127.0.0.1'}:${port}`);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await app.close(); await db.close(); process.exit(0); });
