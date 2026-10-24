import { test } from 'node:test';
import assert from 'node:assert/strict';
import { patient, setup } from './helpers.ts';
import { localIso } from '../server/scheduling.ts';

const subj = (id: string) => ({ reference: `Patient/${id}` });
const rx = (id: string, text: string, extra: object = {}) =>
  ({ resourceType: 'MedicationRequest', status: 'active', intent: 'order', medicationCodeableConcept: { text }, subject: subj(id), ...extra });

test('prescribing: allergy and interaction stop the order until a reason is given; override is logged', async () => {
  const { as, db } = await setup();
  const doc = await as('clinician');
  const p = (await doc('POST', '/fhir/Patient', patient())).body;
  await doc('POST', '/fhir/AllergyIntolerance', { resourceType: 'AllergyIntolerance', clinicalStatus: { coding: [{ code: 'active' }] }, code: { text: 'Penicillin allergy' }, patient: subj(p.id) });
  const blocked = await doc('POST', '/fhir/MedicationRequest', rx(p.id, 'Amoxicillin 500 mg'));
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.alerts[0].kind, 'allergy');
  const ok = await doc('POST', '/fhir/MedicationRequest', rx(p.id, 'Amoxicillin 500 mg'), { 'x-override-reason': 'Tolerated before, allergy label wrong' });
  assert.equal(ok.status, 201);
  assert.equal((await db.query('select count(*)::int n from override_log')).rows[0].n, 1);

  await doc('POST', '/fhir/MedicationRequest', rx(p.id, 'Warfarin 3 mg'));
  const inter = await doc('POST', '/fhir/MedicationRequest', rx(p.id, 'Ibuprofen 400 mg'));
  assert.equal(inter.status, 409);
  assert.equal(inter.body.alerts.some((a: any) => a.kind === 'interaction'), true);
  // Unrelated safe drug is not interrupted.
  assert.equal((await doc('POST', '/fhir/MedicationRequest', rx(p.id, 'Atorvastatin 20 mg'))).status, 201);
});

test('prescribing: dose above daily maximum is a hard alert', async () => {
  const { as } = await setup();
  const doc = await as('clinician');
  const p = (await doc('POST', '/fhir/Patient', patient())).body;
  const r = await doc('POST', '/fhir/MedicationRequest', rx(p.id, 'Paracetamol', { dosageInstruction: [{ timing: { repeat: { frequency: 6, period: 1, periodUnit: 'd' } }, doseAndRate: [{ doseQuantity: { value: 1000, unit: 'mg' } }] }] }));
  assert.equal(r.status, 409);
  assert.equal(r.body.alerts[0].kind, 'dose');
});

test('results: auto-flagged, routed to the orderer, normals bulk-acknowledged, abnormals untouched', async () => {
  const { as, ids } = await setup();
  const doc = await as('clinician');
  const p = (await doc('POST', '/fhir/Patient', patient())).body;
  const obs = (v: number) => ({ resourceType: 'Observation', status: 'final', code: { text: 'HbA1c' }, subject: subj(p.id), valueQuantity: { value: v, unit: 'mmol/mol' }, referenceRange: [{ low: { value: 20 }, high: { value: 48 }, extension: [{ url: 'urn:arogya:critical-high', valueDecimal: 75 }] }] });
  const n = (await doc('POST', '/fhir/Observation', obs(40))).body;
  const h = (await doc('POST', '/fhir/Observation', obs(60))).body;
  const c = (await doc('POST', '/fhir/Observation', obs(90))).body;
  assert.equal(n.interpretation[0].coding[0].code, 'N');
  assert.equal(h.interpretation[0].coding[0].code, 'H');
  assert.equal(c.interpretation[0].coding[0].code, 'HH');
  const inbox = (await doc('GET', '/api/inbox')).body;
  assert.equal(inbox.length, 3);
  assert.equal(inbox[0].priority, 'urgent'); // critical result first
  assert.equal(inbox.filter((t: any) => t.normal).length, 1);
  assert.equal((await (await as('reception'))('POST', '/api/inbox/bulk-ack', {})).status, 403);
  assert.equal((await doc('POST', '/api/inbox/bulk-ack', {})).body.acknowledged, 1);
  assert.equal((await doc('GET', '/api/inbox')).body.length, 2);
  const t = inbox.find((x: any) => !x.normal && x.priority === 'routine');
  assert.equal((await doc('POST', `/api/inbox/${t.id}/done`, { note: 'seen' })).status, 200);
  assert.equal((await doc('POST', `/api/inbox/${t.id}/done`, {})).status, 404);
  void ids;
});

test('scheduling: waiting list ordering, booking, double-booking refused, backfill after cancellation', async () => {
  const { as, db } = await setup();
  const doc = await as('clinician');
  const a = (await doc('POST', '/fhir/Patient', patient('Alpha', 'A'))).body;
  const b = (await doc('POST', '/fhir/Patient', patient('Beta', 'B'))).body;
  const dr = (await doc('POST', '/fhir/Practitioner', { resourceType: 'Practitioner', name: [{ family: 'Doc' }] })).body;
  const ref = (p: any, daysAgo: number, priority: string) => doc('POST', '/fhir/ServiceRequest', {
    resourceType: 'ServiceRequest', status: 'active', intent: 'order', category: [{ text: 'referral' }], priority, code: { text: 'Continence' },
    subject: { reference: `Patient/${p.id}`, display: p.name[0].family }, authoredOn: new Date(Date.now() - daysAgo * 86400_000).toISOString() });
  const rA = (await ref(a, 30, 'routine')).body;
  await ref(b, 40, 'urgent'); // 40d on an urgent (28d) target: breached
  const wl = (await doc('GET', '/api/waiting-list')).body;
  assert.equal(wl.length, 2);
  assert.equal(wl[0].patientName, 'Beta');
  assert.equal(wl[0].breached, true);

  // a weekday session tomorrow
  const tomorrow = new Date(Date.now() + 86400_000);
  await db.query("insert into clinic_sessions(id,practitioner_id,service,weekday,start_time,end_time,slot_mins) values ('s1',$1,'Continence',$2,'09:00','10:00',20)", [dr.id, tomorrow.getDay()]);
  const free = (await doc('GET', '/api/slots?days=2&service=Continence')).body.filter((s: any) => s.free);
  assert.equal(free.length, 3);
  const slot = free[0];
  const booked = await doc('POST', '/api/appointments/book', { patientId: a.id, practitionerId: dr.id, start: slot.start, end: slot.end, service: 'Continence', referralId: rA.id });
  assert.equal(booked.status, 201);
  assert.equal((await doc('POST', '/api/appointments/book', { patientId: b.id, practitionerId: dr.id, start: slot.start, end: slot.end, service: 'Continence' })).status, 409);
  const [x, y] = await Promise.all([free[1], free[1]].map((s) => doc('POST', '/api/appointments/book', { patientId: b.id, practitionerId: dr.id, start: s.start, end: s.end, service: 'Continence' })));
  assert.deepEqual([x.status, y.status].sort(), [201, 409]);
  assert.equal((await doc('GET', '/api/waiting-list')).body.length, 1); // booked referral leaves the list
  assert.equal((await doc('GET', '/api/slots?days=2&service=Continence')).body.filter((s: any) => s.free).length, 1);

  await doc('POST', `/api/appointments/${booked.body.id}/status`, { status: 'cancelled', reason: 'patient called' });
  const tasks = (await (await as('reception'))('GET', '/api/inbox')).body;
  assert.equal(tasks.some((t: any) => t.kind === 'backfill'), true);
  const cands = (await doc('GET', '/api/backfill?service=Continence')).body;
  assert.equal(cands[0].patientName, 'Beta');
  assert.equal(await doc('POST', '/api/appointments/book', { patientId: a.id, practitionerId: dr.id, start: localIso(new Date(Date.now() - 3600_000)), end: localIso(new Date()), service: 'x' }).then((r) => r.status), 422);
});

test('dna risk rises with history; kpis computed; user admin and audit verify', async () => {
  const { as } = await setup();
  const doc = await as('clinician');
  const p = (await doc('POST', '/fhir/Patient', patient())).body;
  const base = (await doc('GET', `/api/patients/${p.id}/dna-risk?leadDays=0`)).body.risk;
  const start = new Date(Date.now() - 5 * 86400_000).toISOString();
  for (const st of ['noshow', 'noshow', 'fulfilled'])
    await doc('POST', '/fhir/Appointment', { resourceType: 'Appointment', status: st, start, end: start, participant: [{ actor: subj(p.id), status: 'accepted' }] });
  const after = (await doc('GET', `/api/patients/${p.id}/dna-risk?leadDays=0`)).body;
  assert.ok(after.risk > base);
  assert.match(after.reasons[0], /2 of 3/);
  const k = (await (await as('manager'))('GET', '/api/kpi')).body;
  assert.equal(k.appointments.dna, 2);
  assert.equal(k.appointments.dnaRatePct, 66.7);
  assert.equal((await (await as('reception'))('GET', '/api/kpi')).status, 403);
  const admin = await as('admin');
  assert.equal((await admin('POST', '/api/users', { username: 'new', name: 'N', role: 'nurse', password: 'short' })).status, 422);
  assert.equal((await admin('POST', '/api/users', { username: 'new', name: 'N', role: 'nurse', password: 'long-enough-password' })).status, 201);
  assert.equal((await admin('GET', '/api/audit/verify')).body.ok, true);
  assert.equal((await doc('GET', '/api/audit')).status, 403);
  const sum = await doc('GET', `/api/patients/${p.id}/summary`);
  assert.equal(sum.status, 200);
  assert.equal(sum.body.appts.length, 3);
});
