import { test } from 'node:test';
import assert from 'node:assert/strict';
import { patient, setup } from './helpers.ts';
import { verifyChain } from '../server/audit.ts';

test('unauthenticated requests are refused; cookie writes need the CSRF header', async () => {
  const { app } = await setup();
  assert.equal((await app.inject({ url: '/fhir/Patient' })).statusCode, 401);
  const login = await app.inject({ method: 'POST', url: '/api/login', payload: { username: 'admin', password: 'correct-horse-battery' } });
  assert.equal(login.statusCode, 200);
  const cookie = login.headers['set-cookie'] as string;
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Strict/i);
  const c = cookie.split(';')[0];
  assert.equal((await app.inject({ method: 'POST', url: '/fhir/Organization', headers: { cookie: c }, payload: { resourceType: 'Organization' } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: '/fhir/Organization', headers: { cookie: c, 'x-requested-with': 'arogya' }, payload: { resourceType: 'Organization' } })).statusCode, 201);
});

test('login lockout after repeated failures', async () => {
  const { app } = await setup();
  for (let i = 0; i < 5; i++) assert.equal((await app.inject({ method: 'POST', url: '/api/login', payload: { username: 'nurse', password: 'wrong-wrong-wrong' } })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/api/login', payload: { username: 'nurse', password: 'correct-horse-battery' } })).statusCode, 429);
});

test('FHIR create/read/update/search/history with version conflict', async () => {
  const { as } = await setup();
  const doc = await as('clinician');
  const c = await doc('POST', '/fhir/Patient', patient('Nair', 'Asha'));
  assert.equal(c.status, 201);
  const id = c.body.id;
  assert.equal((await doc('GET', `/fhir/Patient/${id}`)).body.name[0].family, 'Nair');
  const u = await doc('PUT', `/fhir/Patient/${id}`, { ...c.body, gender: 'female' }, { 'if-match': 'W/"1"' });
  assert.equal(u.body.meta.versionId, '2');
  assert.equal((await doc('PUT', `/fhir/Patient/${id}`, { ...c.body, gender: 'male' }, { 'if-match': 'W/"1"' })).status, 412);
  const s = await doc('GET', '/fhir/Patient?family=nai&gender=female');
  assert.equal(s.body.total, 1);
  assert.equal((await doc('GET', '/fhir/Patient?family:exact=nai')).body.total, 0);
  assert.equal((await doc('GET', '/fhir/Patient?birthdate=1980-01-01')).body.total, 1);
  assert.equal((await doc('GET', '/fhir/Patient?bogus=1')).status, 400);
  assert.equal((await doc('GET', `/fhir/Patient/${id}/_history`)).body.total, 2);
  assert.equal((await doc('POST', '/fhir/Patient', { resourceType: 'Patient' })).status, 422);
  // SQL-ish input is just a value
  assert.equal((await doc('GET', "/fhir/Patient?family=x'%20or%201=1--")).body.total, 0);
});

test('roles: reception cannot read clinical data, manager cannot write', async () => {
  const { as } = await setup();
  const doc = await as('clinician');
  const p = (await doc('POST', '/fhir/Patient', patient())).body;
  await doc('POST', '/fhir/Condition', { resourceType: 'Condition', code: { text: 'Asthma' }, subject: { reference: `Patient/${p.id}` } });
  const rec = await as('reception');
  assert.equal((await rec('GET', '/fhir/Condition')).status, 403);
  assert.equal((await rec('GET', '/fhir/Patient')).status, 200);
  assert.equal((await rec('GET', `/api/patients/${p.id}/summary`)).status, 403);
  const mgr = await as('manager');
  assert.equal((await mgr('POST', '/fhir/Patient', patient())).status, 403);
  assert.equal((await (await as('nurse'))('POST', '/fhir/MedicationRequest', { resourceType: 'MedicationRequest', status: 'active', intent: 'order', medicationCodeableConcept: { text: 'x' }, subject: { reference: 'Patient/1' } })).status, 403);
});

test('restricted records need a break-glass reason, which is audited', async () => {
  const { as, db } = await setup();
  const doc = await as('clinician');
  const p = (await doc('POST', '/fhir/Patient', patient('Vip', 'Very', { meta: { security: [{ code: 'R' }] } }))).body;
  assert.equal((await doc('GET', `/fhir/Patient/${p.id}`)).status, 403);
  const ok = await doc('GET', `/fhir/Patient/${p.id}`, undefined, { 'x-break-glass-reason': 'Covering on call, patient admitted' });
  assert.equal(ok.status, 200);
  const row = (await db.query("select reason from audit where action='read' and patient_id=$1", [p.id])).rows[0];
  assert.match(row.reason, /Covering/);
  const hidden = await doc('GET', '/fhir/Patient?family=vip');
  assert.equal(hidden.body.entry.length, 0); // restricted patients vanish from unscoped search
  const shown = await doc('GET', '/fhir/Patient?family=vip', undefined, { 'x-break-glass-reason': 'Covering on call, patient admitted' });
  assert.equal(shown.body.entry.length, 1);
});

test('audit chain verifies and detects tampering', async () => {
  const { as, db } = await setup();
  const doc = await as('clinician');
  await doc('POST', '/fhir/Patient', patient());
  await doc('GET', '/fhir/Patient');
  assert.equal((await verifyChain(db)).ok, true);
  await db.query("update audit set username='someone-else' where seq=(select min(seq) from audit)");
  const v = await verifyChain(db);
  assert.equal(v.ok, false);
});
