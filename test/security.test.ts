import { test } from 'node:test';
import assert from 'node:assert/strict';
import { patient, setup, PW } from './helpers.ts';
import { currentStep, totp } from '../server/secrets.ts';
import { openMemoryDb } from '../server/db.ts';
import { backup, restore } from '../server/backup.ts';

const enrol = async (call: any) => {
  const s = (await call('POST', '/api/account/mfa/start')).body;
  assert.match(s.uri, /^otpauth:\/\/totp\/Arogya:/);
  assert.equal((await call('POST', '/api/account/mfa/confirm', { code: '000000' === totp(s.secret, currentStep()) ? '111111' : '000000' })).status, 422);
  assert.equal((await call('POST', '/api/account/mfa/confirm', { code: totp(s.secret, currentStep()) })).status, 200);
  return s.secret as string;
};

test('two-step login: code required, single use, seed sealed at rest', async () => {
  const { app, as, db } = await setup();
  const secret = await enrol(await as('clinician'));
  const raw = (await db.query("select totp_secret from users where username='clinician'")).rows[0].totp_secret;
  assert.match(raw, /^v1:/);
  assert.ok(!raw.includes(secret));
  const login = (code?: string) => app.inject({ method: 'POST', url: '/api/login', payload: { username: 'clinician', password: PW, code } });
  const noCode = await login();
  assert.equal(noCode.statusCode, 401);
  assert.equal(noCode.json().alerts.mfaRequired, true);
  // The step used at enrolment is spent; the next step's code works once.
  const next = totp(secret, currentStep() + 1);
  assert.equal((await login(next)).statusCode, 200);
  assert.equal((await login(next)).statusCode, 401);
});

test('roles can be forced to set up two-step verification', async () => {
  const { app, as } = await setup();
  const admin = await as('admin');
  assert.equal((await admin('PUT', '/api/settings/security', { mfaRoles: ['admin'] })).status, 422); // admin has no MFA yet
  assert.equal((await admin('PUT', '/api/settings/security', { mfaRoles: ['nurse'] })).status, 200);
  const nurse = await as('nurse');
  const blocked = await nurse('GET', '/fhir/Patient');
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.alerts.mfaSetupRequired, true);
  assert.equal((await nurse('GET', '/api/me')).body.mfaSetupRequired, true);
  // Sign-in says so up front, so the client never renders pages that would be refused.
  assert.equal((await app.inject({ method: 'POST', url: '/api/login', payload: { username: 'nurse', password: PW } })).json().mfaSetupRequired, true);
  await enrol(nurse);
  assert.equal((await nurse('GET', '/fhir/Patient')).status, 200);
  assert.equal((await nurse('POST', '/api/account/mfa/disable', { password: PW })).status, 403);
});

test('idle sessions expire; password change ends other sessions', async () => {
  const { app, as, db } = await setup();
  const doc = await as('clinician');
  assert.equal((await doc('GET', '/api/me')).body.user.username, 'clinician');
  await db.query("update sessions set last_seen = now() - interval '31 minutes'");
  assert.equal((await doc('GET', '/fhir/Patient')).status, 401);

  const a = (await app.inject({ method: 'POST', url: '/api/login', payload: { username: 'nurse', password: PW } })).json().token;
  const b = (await app.inject({ method: 'POST', url: '/api/login', payload: { username: 'nurse', password: PW } })).json().token;
  const ch = await app.inject({ method: 'POST', url: '/api/account/password', headers: { authorization: `Bearer ${a}` }, payload: { current: PW, next: 'a-brand-new-password' } });
  assert.equal(ch.statusCode, 200);
  assert.equal((await app.inject({ url: '/fhir/Patient', headers: { authorization: `Bearer ${a}` } })).statusCode, 200);
  assert.equal((await app.inject({ url: '/fhir/Patient', headers: { authorization: `Bearer ${b}` } })).statusCode, 401);
});

test('encrypted backup round-trips into an empty database and refuses a wrong passphrase', async () => {
  const { as, db } = await setup();
  const doc = await as('clinician');
  const p = (await doc('POST', '/fhir/Patient', patient('Backup', 'Bea'))).body;
  const file = await backup(db, 'long backup passphrase');
  assert.ok(!file.toString('latin1').includes('Backup')); // nothing readable
  await assert.rejects(backup(db, 'short'));
  const fresh = await openMemoryDb();
  await assert.rejects(restore(fresh, file, 'wrong passphrase!!'), /Wrong passphrase/);
  const counts = await restore(fresh, file, 'long backup passphrase');
  assert.equal(counts.resources, 1);
  const found = (await fresh.query("select id from search_idx where param='family' and val='backup'")).rows;
  assert.equal(found[0].id, p.id);
  await assert.rejects(restore(fresh, file, 'long backup passphrase'), /empty database/);
});

test('backup endpoint needs an admin with two-step on; access report lists who opened a record', async () => {
  const { as } = await setup();
  const admin = await as('admin');
  assert.equal((await admin('POST', '/api/admin/backup', { passphrase: 'long backup passphrase' })).status, 403);
  await enrol(admin);
  const r = await admin('POST', '/api/admin/backup', { passphrase: 'long backup passphrase' });
  assert.equal(r.status, 200);
  assert.match(String(r.res.headers['content-disposition']), /arogya-backup/);
  const doc = await as('clinician');
  const p = (await doc('POST', '/fhir/Patient', patient())).body;
  await doc('GET', `/api/patients/${p.id}/summary`);
  const log = (await admin('GET', `/api/patients/${p.id}/access-log`)).body;
  assert.ok(log.some((x: any) => x.action === 'open-chart' && x.username === 'clinician'));
  assert.equal((await doc('GET', `/api/patients/${p.id}/access-log`)).status, 403);
});
