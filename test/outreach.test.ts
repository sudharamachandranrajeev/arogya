import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { patient, setup } from './helpers.ts';
import { localIso } from '../server/scheduling.ts';
import { deliver, queueDue, sign } from '../server/reminders.ts';

const DAY = 86400_000;

test('a referral to another provider is tracked to the report, and silence becomes a chase', async () => {
  const { as, db } = await setup();
  const doc = await as('clinician');
  const desk = await as('reception');
  const p = (await doc('POST', '/fhir/Patient', patient())).body;
  assert.equal((await desk('POST', '/api/referrals-out', { patientId: p.id, to: 'City Hospital Cardiology', service: 'Echocardiogram' })).status, 403);
  assert.equal((await doc('POST', '/api/referrals-out', { patientId: p.id, to: '', service: 'Echo' })).status, 422);
  const r = (await doc('POST', '/api/referrals-out', { patientId: p.id, patientName: 'Pat Test', to: 'City Hospital Cardiology', service: 'Echocardiogram', reason: 'New murmur' })).body;

  // Not on our own waiting list, and no triage task: it is someone else's queue.
  assert.equal((await doc('GET', '/api/waiting-list')).body.length, 0);
  assert.equal((await doc('GET', '/api/inbox')).body.length, 0);
  let list = (await desk('GET', '/api/referrals-out')).body;
  assert.equal(list[0].stage, 'sent');
  assert.equal(list[0].waitingFor, 'acknowledgement');
  assert.equal(list[0].overdueDays, 0);

  // Eight days of silence: one chase task for the admin team, not one per look.
  await db.query(`update resources set data = jsonb_set(data, '{authoredOn}', to_jsonb($2::text)) where id=$1`, [r.id, new Date(Date.now() - 8 * DAY).toISOString()]);
  list = (await desk('GET', '/api/referrals-out')).body;
  assert.equal(list[0].overdueDays, 1);
  await desk('GET', '/api/referrals-out');
  const chases = (await desk('GET', '/api/inbox')).body.filter((t: any) => t.kind === 'chase');
  assert.equal(chases.length, 1);
  assert.match(chases[0].subject, /City Hospital Cardiology/);

  // Reception records the acknowledgement; the chase closes itself.
  assert.equal((await desk('POST', `/api/referrals-out/${r.id}/stage`, { stage: 'acknowledged', note: 'Phoned, on their list' })).status, 200);
  assert.equal((await desk('GET', '/api/inbox')).body.filter((t: any) => t.kind === 'chase').length, 0);
  list = (await desk('GET', '/api/referrals-out')).body;
  assert.equal(list[0].waitingFor, 'an appointment');
  assert.equal(list[0].overdueDays, 0);

  assert.equal((await desk('POST', `/api/referrals-out/${r.id}/stage`, { stage: 'report', note: 'Normal echo' })).status, 200);
  assert.equal((await desk('GET', '/api/referrals-out')).body.length, 0);
  const done = (await doc('GET', `/fhir/ServiceRequest/${r.id}`)).body;
  assert.equal(done.status, 'completed');
  assert.deepEqual(done.note.map((n: any) => n.text), ['Acknowledged: Phoned, on their list', 'Report received: Normal echo']);
  assert.equal((await desk('POST', `/api/referrals-out/${r.id}/stage`, { stage: 'booked' })).status, 409);

  // A rejection goes back to the referrer as an urgent task.
  const r2 = (await doc('POST', '/api/referrals-out', { patientId: p.id, to: 'Community Podiatry', service: 'Foot review' })).body;
  await desk('POST', `/api/referrals-out/${r2.id}/stage`, { stage: 'rejected', note: 'Outside catchment' });
  const back = (await doc('GET', '/api/inbox')).body.find((t: any) => t.kind === 'referral');
  assert.equal(back.priority, 'urgent');
  assert.match(back.subject, /Outside catchment/);
});

test('reminders: one per appointment, nothing clinical, skipped with a reason, signed, retried', async (t) => {
  const { as, db } = await setup();
  const admin = await as('admin');
  const doc = await as('clinician');
  const received: Array<{ sig: string; body: string }> = [];
  let fail = true;
  const gw = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c)).on('end', () => {
      received.push({ sig: String(req.headers['x-arogya-signature']), body });
      res.statusCode = fail ? 503 : 202; res.end();
    });
  });
  await new Promise<void>((ok) => gw.listen(0, '127.0.0.1', ok));
  t.after(() => { gw.closeAllConnections(); gw.close(); });
  const url = `http://127.0.0.1:${(gw.address() as any).port}/sms`;

  assert.equal((await admin('PUT', '/api/settings/reminders', { enabled: true, hoursBefore: 48, webhookUrl: 'http://gateway.example/sms' })).status, 422);
  assert.equal((await admin('PUT', '/api/settings/reminders', { enabled: true, hoursBefore: 48, webhookUrl: '' })).status, 422);
  const saved = await admin('PUT', '/api/settings/reminders', { enabled: true, hoursBefore: 48, webhookUrl: url, clinicName: 'Main clinic', clinicPhone: '01234 567890' });
  assert.equal(saved.status, 200);
  const secret = saved.body.secret;
  assert.ok(secret?.length > 20);
  assert.equal((await admin('GET', '/api/settings/reminders')).body.secret, undefined);
  assert.equal((await admin('PUT', '/api/settings/reminders', { enabled: true, hoursBefore: 48, webhookUrl: url, clinicName: 'Main clinic', clinicPhone: '01234 567890' })).body.secret, undefined, 'secret is shown once');

  const mk = async (extra: object) => (await doc('POST', '/fhir/Patient', patient(`P${Math.random()}`, 'Pat', extra))).body;
  const withPhone = await mk({ telecom: [{ system: 'phone', value: '07700900001' }] });
  const noPhone = await mk({});
  const optedOut = await mk({ telecom: [{ system: 'phone', value: '07700900002' }], extension: [{ url: 'urn:arogya:no-reminders', valueBoolean: true }] });
  const restricted = await mk({ telecom: [{ system: 'phone', value: '07700900003' }], meta: { security: [{ code: 'R' }] } });
  const book = async (p: any, inHours: number) => {
    const s = new Date(Date.now() + inHours * 3600_000);
    return (await doc('POST', '/fhir/Appointment', { resourceType: 'Appointment', status: 'booked', start: localIso(s), end: localIso(new Date(s.getTime() + 20 * 60_000)), serviceType: [{ text: 'Sexual health' }], participant: [{ actor: { reference: `Patient/${p.id}` } }] })).body;
  };
  await book(withPhone, 24); await book(noPhone, 24); await book(optedOut, 24); await book(restricted, 24);
  await book(withPhone, 24 * 5); // outside the window

  assert.equal(await queueDue(db), 4);
  assert.equal(await queueDue(db), 0, 'never twice for one appointment');
  const box = (await db.query('select * from outbox order by created_at')).rows;
  assert.deepEqual(box.map((o: any) => o.status).sort(), ['queued', 'skipped', 'skipped', 'skipped']);
  assert.deepEqual(box.filter((o: any) => o.status === 'skipped').map((o: any) => o.detail).sort(), ['no phone number', 'patient asked not to get reminders', 'restricted record: no messages']);
  const q = box.find((o: any) => o.status === 'queued');
  assert.match(q.body, /Main clinic .* call 01234 567890/);
  assert.doesNotMatch(q.body, /Sexual health/);

  assert.deepEqual(await deliver(db), { sent: 0, failed: 1 });
  assert.equal((await db.query(`select status, attempts from outbox where id=$1`, [q.id])).rows[0].status, 'queued');
  fail = false;
  assert.deepEqual(await deliver(db), { sent: 1, failed: 0 });
  const last = received.at(-1)!;
  assert.equal(last.sig, sign(secret, last.body));
  assert.equal(JSON.parse(last.body).to, '07700900001');
  assert.equal((await (await as('reception'))('GET', '/api/reminders/outbox')).body.length, 4);
  assert.equal((await doc('GET', '/api/reminders/outbox')).status, 403);
});
