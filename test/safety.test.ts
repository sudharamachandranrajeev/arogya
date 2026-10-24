import { test } from 'node:test';
import assert from 'node:assert/strict';
import { patient, setup } from './helpers.ts';
import { localIso } from '../server/scheduling.ts';

test('unacknowledged critical result escalates to the shared pool after an hour', async () => {
  const { as, db } = await setup();
  const doc = await as('clinician');
  const p = (await doc('POST', '/fhir/Patient', patient())).body;
  const dr = (await doc('POST', '/fhir/Practitioner', { resourceType: 'Practitioner', name: [{ family: 'Away' }] })).body;
  const sr = (await doc('POST', '/fhir/ServiceRequest', { resourceType: 'ServiceRequest', status: 'active', intent: 'order', subject: { reference: `Patient/${p.id}` }, requester: { reference: `Practitioner/${dr.id}` } })).body;
  await doc('POST', '/fhir/Observation', { resourceType: 'Observation', status: 'final', code: { text: 'Potassium' }, subject: { reference: `Patient/${p.id}` }, basedOn: [{ reference: `ServiceRequest/${sr.id}` }], valueQuantity: { value: 7.1, unit: 'mmol/L' }, referenceRange: [{ low: { value: 3.5 }, high: { value: 5.3 }, extension: [{ url: 'urn:arogya:critical-high', valueDecimal: 6.5 }] }] });
  const t = (await db.query("select * from tasks where kind='result'")).rows[0];
  assert.equal(t.pool, `user:${dr.id}`);
  assert.equal((await doc('GET', '/api/inbox')).body.length, 0); // not ours yet
  await db.query("update tasks set created_at = now() - interval '61 minutes'");
  const inbox = (await doc('GET', '/api/inbox')).body;
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].escalated, true);
  assert.equal(inbox[0].pool, 'results');
});

test('alert analytics count fired and overridden per rule; stuck work beyond SLA is listed', async () => {
  const { as, db } = await setup();
  const doc = await as('clinician');
  const p = (await doc('POST', '/fhir/Patient', patient())).body;
  const rx = (text: string) => ({ resourceType: 'MedicationRequest', status: 'active', intent: 'order', medicationCodeableConcept: { text }, subject: { reference: `Patient/${p.id}` } });
  await doc('POST', '/fhir/MedicationRequest', rx('Warfarin 3 mg'));
  await doc('POST', '/fhir/MedicationRequest', rx('Ibuprofen 400 mg'));
  await doc('POST', '/fhir/MedicationRequest', rx('Ibuprofen 400 mg'), { 'x-override-reason': 'Short course, PPI cover, INR checked' });
  const rules = (await doc('GET', '/api/safety/alert-rules')).body;
  const r = rules.find((x: any) => x.rule.startsWith('interaction'));
  assert.equal(r.fired, 2);
  assert.equal(r.overridden, 1);
  assert.equal(r.overridePct, 50);
  assert.ok(!JSON.stringify(rules).includes(p.id));

  await doc('POST', '/fhir/Observation', { resourceType: 'Observation', status: 'final', code: { text: 'Na' }, subject: { reference: `Patient/${p.id}` }, valueQuantity: { value: 140 } });
  assert.equal((await doc('GET', '/api/stuck-work')).body.length, 0);
  await db.query("update tasks set created_at = now() - interval '3 days'");
  const stuck = (await doc('GET', '/api/stuck-work')).body;
  assert.equal(stuck.length, 1);
  assert.equal(stuck[0].slaDays, 2);
  assert.equal((await doc('GET', '/api/inbox')).body[0].overdue, true);
  assert.equal((await doc('GET', '/api/kpi')).body.inbox.overdue, 1);
});

test('today list shows the clinic day in order with allergy counts and no-show risk', async () => {
  const { as, db } = await setup();
  const doc = await as('clinician');
  const p = (await doc('POST', '/fhir/Patient', patient('Today', 'Tia'))).body;
  await doc('POST', '/fhir/AllergyIntolerance', { resourceType: 'AllergyIntolerance', clinicalStatus: { coding: [{ code: 'active' }] }, code: { text: 'Latex' }, patient: { reference: `Patient/${p.id}` } });
  const at = (h: number) => { const d = new Date(); d.setHours(h, 0, 0, 0); return localIso(d); };
  for (const [h, st] of [[16, 'booked'], [9, 'fulfilled'], [11, 'cancelled']] as const)
    await doc('POST', '/fhir/Appointment', { resourceType: 'Appointment', status: st, start: at(h), end: at(h), participant: [{ actor: { reference: `Patient/${p.id}`, display: 'Tia Today' }, status: 'accepted' }] });
  const list = (await doc('GET', '/api/today?all=1')).body;
  assert.equal(list.length, 2); // cancelled hidden
  assert.equal(list[0].status, 'fulfilled');
  assert.equal(list[1].allergies, 1);
  assert.equal(typeof list[1].dnaRisk.risk, 'number');
  void db;
});
