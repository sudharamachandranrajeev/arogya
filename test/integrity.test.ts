import { test } from 'node:test';
import assert from 'node:assert/strict';
import { patient, setup } from './helpers.ts';
import { localIso } from '../server/scheduling.ts';
import { sign } from '../server/reminders.ts';

const R = { meta: { security: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-Confidentiality', code: 'R' }] } };
const obs = (pid: string, text: string) => ({ resourceType: 'Observation', status: 'final', code: { text }, subject: { reference: `Patient/${pid}` } });
const WHY = { 'x-break-glass-reason': 'Covering clinician, patient in clinic now' };

test('restricted records stay protected whatever the query, write or deletion', async () => {
  const { as } = await setup();
  const doc = await as('clinician');
  const desk = await as('reception');
  const open = (await doc('POST', '/fhir/Patient', patient('Open', 'Olu'))).body;
  const secret = (await doc('POST', '/fhir/Patient', patient('Secret', 'Sam', R))).body;
  await doc('POST', '/fhir/Observation', obs(open.id, 'Weight'));
  await doc('POST', '/fhir/Observation', obs(secret.id, 'HIV viral load'));

  // Query spellings that used to slip past the scoped check.
  for (const q of [`patient=${open.id},${secret.id}`, `patient=Foo/${secret.id}`, `subject=Patient/${secret.id}`])
    assert.equal((await doc('GET', `/fhir/Observation?${q}`)).status, 403, q);
  const all = (await doc('GET', '/fhir/Observation')).body;
  assert.deepEqual(all.entry.map((e: any) => e.resource.code.text), ['Weight']);
  assert.equal((await doc('GET', `/fhir/Observation?patient=${secret.id}`, undefined, WHY)).body.entry.length, 1);

  // Registration search shows a restricted (R) patient only as name and birth date, and a very restricted (V) one not at all.
  await doc('PUT', `/fhir/Patient/${secret.id}`, { ...secret, telecom: [{ system: 'phone', value: '07700900999' }], address: [{ city: 'Safehouse' }] }, WHY);
  const vee = (await doc('POST', '/fhir/Patient', patient('Secret', 'Val', { meta: { security: [{ code: 'V' }] } }))).body;
  const found = (await desk('GET', '/api/search/patients?q=Secret')).body;
  assert.deepEqual(found.map((x: any) => x.id), [secret.id]);
  assert.equal(found[0].restricted, true);
  assert.doesNotMatch(JSON.stringify(found), /Safehouse|07700900999|ID-Secret/);
  assert.equal((await desk('GET', '/api/search/patients?q=Secret', undefined, WHY)).body.length, 2);
  assert.doesNotMatch(JSON.stringify((await desk('POST', '/api/patients/check-duplicate', { family: 'Secret', given: 'Sam', birthDate: '1980-01-01' })).body), /Safehouse|Val/);
  void vee;

  // A blind PUT cannot lift the restriction: it needs a reason, and only clinicians can change labels.
  assert.equal((await desk('PUT', `/fhir/Patient/${secret.id}`, { ...patient('Secret', 'Sam'), id: secret.id })).status, 403);
  assert.equal((await desk('PUT', `/fhir/Patient/${secret.id}`, { ...patient('Secret', 'Sam'), id: secret.id }, WHY)).status, 200);
  assert.equal((await doc('GET', `/fhir/Patient/${secret.id}`)).status, 403, 'labels survived the reception update');

  // Deleting the patient does not unprotect what points at it.
  assert.equal((await doc('DELETE', `/fhir/Patient/${secret.id}`)).status, 403);
  assert.equal((await doc('DELETE', `/fhir/Patient/${secret.id}`, undefined, WHY)).status, 204);
  assert.equal((await doc('GET', '/fhir/Observation')).body.entry.length, 1);
  assert.equal((await doc('GET', `/fhir/Patient/${secret.id}/_history/1`)).status, 403);

  // Bulk export follows read rights and two-step verification; small side doors are closed.
  assert.equal((await (await as('admin'))('GET', '/api/export/Observation')).status, 403);
  assert.equal((await doc('GET', '/api/export/Observation')).status, 403, 'needs two-step verification');
  assert.equal((await (await as('biller'))('GET', `/api/patients/${open.id}/dna-risk`)).status, 403);
});

test('no double booking through any path, and appointment times must be real', async () => {
  const { as, db } = await setup();
  const doc = await as('clinician');
  const desk = await as('reception');
  const p = (await doc('POST', '/fhir/Patient', patient())).body;
  const q = (await doc('POST', '/fhir/Patient', patient('Other', 'Q'))).body;
  const pr = (await doc('POST', '/fhir/Practitioner', { resourceType: 'Practitioner', name: [{ family: 'Rao' }] })).body;
  const s = new Date(Date.now() + 3 * 86400_000); s.setHours(10, 0, 0, 0);
  const slot = { practitionerId: pr.id, start: localIso(s), end: localIso(new Date(s.getTime() + 20 * 60_000)), service: 'GP' };
  const a1 = (await desk('POST', '/api/appointments/book', { ...slot, patientId: p.id })).body;
  await desk('POST', `/api/appointments/${a1.id}/status`, { status: 'cancelled' });
  assert.equal((await desk('POST', '/api/appointments/book', { ...slot, patientId: q.id })).status, 201);
  assert.equal((await desk('POST', `/api/appointments/${a1.id}/status`, { status: 'booked' })).status, 409, 'un-cancelling onto a taken slot');

  // Same instant written with a different offset still clashes; raw FHIR writes are checked too.
  const utc = { start: new Date(s.getTime() + 5 * 60_000).toISOString(), end: new Date(s.getTime() + 15 * 60_000).toISOString() };
  const raw = { resourceType: 'Appointment', status: 'booked', ...utc, participant: [{ actor: { reference: `Patient/${p.id}` } }, { actor: { reference: `Practitioner/${pr.id}` } }] };
  assert.equal((await doc('POST', '/fhir/Appointment', raw)).status, 409);
  assert.equal((await doc('POST', '/fhir/Appointment', { ...raw, start: 'next tuesday' })).status, 422);
  assert.equal((await db.query(`select count(*)::int n from resources where type='Appointment' and data->>'status'='booked'`)).rows[0].n, 1);
});

test('an older merge cannot be undone while a later merge holds its records', async () => {
  const { as } = await setup();
  const doc = await as('clinician');
  const [x, y, z] = await Promise.all(['X', 'Y', 'Z'].map(async (n) => (await doc('POST', '/fhir/Patient', patient(`Twin${n}`))).body));
  const why = 'Same person, confirmed with photo ID';
  const m1 = (await doc('POST', '/api/patients/merge', { keepId: y.id, mergeId: x.id, reason: why })).body;
  const m2 = (await doc('POST', '/api/patients/merge', { keepId: z.id, mergeId: y.id, reason: why })).body;
  assert.equal((await doc('POST', `/api/merges/${m1.id}/undo`)).status, 409);
  assert.equal((await doc('POST', `/api/merges/${m2.id}/undo`)).status, 200);
  assert.equal((await doc('POST', `/api/merges/${m1.id}/undo`)).status, 200);
});

test('integrity check finds tampering, stale indexes and broken references, and the index can be rebuilt', async () => {
  const { as, db } = await setup();
  const admin = await as('admin');
  const doc = await as('clinician');
  const p = (await doc('POST', '/fhir/Patient', patient('Check', 'Ida'))).body;
  const o = (await doc('POST', '/fhir/Observation', obs(p.id, 'Pulse'))).body;
  assert.equal((await doc('POST', '/api/admin/integrity')).status, 403);
  const status = async () => Object.fromEntries((await admin('POST', '/api/admin/integrity')).body.checks.map((c: any) => [c.key, c.status]));

  let s = await status();
  for (const k of ['audit', 'schema', 'key', 'index', 'history', 'refs', 'tasks', 'booking']) assert.equal(s[k], 'ok', k);
  assert.equal(s.backup, 'warn');

  // A search index that lost rows hides the record from searches.
  await db.query(`delete from search_idx where type='Observation' and id=$1`, [o.id]);
  // A record changed behind the store's back no longer matches its history.
  await db.query(`update resources set data = jsonb_set(data, '{status}', '"amended"') where type='Patient' and id=$1`, [p.id]);
  // A reference to nothing.
  await doc('POST', '/fhir/Observation', obs('no-such-patient', 'Orphan'));
  const r = (await admin('POST', '/api/admin/integrity')).body;
  const by = Object.fromEntries(r.checks.map((c: any) => [c.key, c]));
  assert.equal(r.status, 'fail');
  assert.equal(by.index.status, 'fail');
  assert.ok(by.index.items.includes(`Observation/${o.id}`));
  assert.equal(by.history.status, 'fail');
  assert.equal(by.refs.status, 'fail');
  assert.doesNotMatch(JSON.stringify(r), /Pulse|Ida/, 'ids only, no clinical content');

  assert.ok((await admin('POST', '/api/admin/integrity/reindex')).body.reindexed >= 3);
  s = await status();
  assert.equal(s.index, 'ok');
  assert.equal((await admin('GET', '/api/admin/integrity')).body.status, 'fail', 'last report kept: references and history still need people');

  // Rows cut from the end of the audit trail leave the chain valid, but the head from the last check is gone.
  await db.query('delete from audit where seq > (select max(seq) - 3 from audit)');
  s = await status();
  assert.equal(s.audit, 'ok');
  assert.equal(s['audit-head'], 'fail');
});

test('two-way replies: confirm, cancel to backfill, stop, anything else to reception; signed and fresh only', async () => {
  const { as, db, app } = await setup();
  const admin = await as('admin');
  const doc = await as('clinician');
  const desk = await as('reception');
  const saved = (await admin('PUT', '/api/settings/reminders', { enabled: true, hoursBefore: 48, webhookUrl: 'http://127.0.0.1:9/sms', clinicName: 'Main clinic', twoWay: true })).body;
  const mk = async (n: string, phone: string) => (await doc('POST', '/fhir/Patient', patient(n, 'Pat', { telecom: [{ system: 'phone', value: phone }] }))).body;
  const appt = async (p: any, h: number) => {
    const s = new Date(Date.now() + h * 3600_000);
    const a = (await doc('POST', '/fhir/Appointment', { resourceType: 'Appointment', status: 'booked', start: localIso(s), end: localIso(new Date(s.getTime() + 600_000)), participant: [{ actor: { reference: `Patient/${p.id}` } }] })).body;
    await db.query(`insert into outbox(id,appointment_id,patient_id,channel,to_addr,body,status,sent_at) values ($1,$2,$3,'sms',$4,'x','sent',now())`, [`o-${a.id}`, a.id, p.id, p.telecom[0].value]);
    return a;
  };
  const ann = await mk('Ann', '07700 900111'), ben = await mk('Ben', '07700900222'), cat = await mk('Cat', '+44 7700 900333'), dev = await mk('Dev', '07700900444');
  const [aA, aB, , aD] = [await appt(ann, 20), await appt(ben, 21), await appt(cat, 22), await appt(dev, 23)];

  const reply = async (b: object, o: { ts?: number; secret?: string } = {}) => {
    const raw = JSON.stringify(b), ts = String(o.ts ?? Math.floor(Date.now() / 1000));
    const r = await app.inject({ method: 'POST', url: '/api/reminders/reply', payload: raw, headers: { 'content-type': 'application/json', 'x-arogya-timestamp': ts, 'x-arogya-signature': sign(o.secret ?? saved.secret, `${ts}.${raw}`) } });
    return { status: r.statusCode, body: r.json() };
  };
  assert.equal((await reply({ from: '07700900111', text: 'C' }, { secret: 'wrong' })).status, 401);
  assert.equal((await reply({ from: '07700900111', text: 'C' }, { ts: Math.floor(Date.now() / 1000) - 600 })).status, 401, 'replayed later');

  assert.equal((await reply({ messageId: 'm1', from: '447700900111', text: ' yes ' })).body.action, 'confirmed');
  assert.equal((await reply({ messageId: 'm1', from: '447700900111', text: ' yes ' })).body.action, 'duplicate');
  assert.equal((await reply({ inReplyTo: `o-${aB.id}`, text: 'X' })).body.action, 'cancelled');
  assert.equal((await reply({ from: '07700900333', text: 'STOP' })).body.action, 'stopped');
  assert.equal((await reply({ from: '07700900444', text: 'Can I come at 3 instead?' })).body.action, 'message');
  assert.equal((await reply({ from: '07000000000', text: 'Who is this?' })).body.action, 'unmatched');

  assert.ok((await doc('GET', `/fhir/Appointment/${aA.id}`)).body.extension.some((e: any) => e.url === 'urn:arogya:patient-confirmed'));
  assert.equal((await doc('GET', `/fhir/Appointment/${aB.id}`)).body.status, 'cancelled');
  assert.ok((await doc('GET', `/fhir/Patient/${cat.id}`)).body.extension.some((e: any) => e.url === 'urn:arogya:no-reminders'));
  const inbox = (await desk('GET', '/api/inbox')).body as any[];
  assert.ok(inbox.some((t) => t.kind === 'backfill'));
  assert.ok(inbox.some((t) => t.kind === 'message' && t.refId === aD.id && /3 instead/.test(t.subject)));
  assert.ok(inbox.some((t) => t.kind === 'message' && /…0000/.test(t.subject)));
  assert.equal((await desk('GET', '/api/reminders/outbox')).body.find((m: any) => m.id === `o-${aA.id}`).reply, 'confirmed');

  // The desk can turn reminders back on (or off) when the patient asks.
  assert.equal((await desk('PUT', `/api/patients/${cat.id}/reminders`, { off: false })).status, 200);
  assert.equal((await doc('GET', `/fhir/Patient/${cat.id}`)).body.extension, undefined);
  assert.equal((await (await as('biller'))('PUT', `/api/patients/${cat.id}/reminders`, { off: true })).status, 403);
});
