import { test } from 'node:test';
import assert from 'node:assert/strict';
import { patient, setup } from './helpers.ts';
import { localIso } from '../server/scheduling.ts';

const DAY = 86400_000;
const ago = (d: number) => new Date(Date.now() - d * DAY).toISOString();

test('recalls list people whose monitoring is due, hide restricted records, and show in the chart', async () => {
  const { as } = await setup();
  const doc = await as('clinician');
  const mk = async (family: string, extra: object = {}) => (await doc('POST', '/fhir/Patient', patient(family, 'Pat', extra))).body;
  const cond = (p: any, text: string) => doc('POST', '/fhir/Condition', { resourceType: 'Condition', clinicalStatus: { coding: [{ code: 'active' }] }, code: { text }, subject: { reference: `Patient/${p.id}` } });
  const a1c = (p: any, at: string) => doc('POST', '/fhir/Observation', { resourceType: 'Observation', status: 'final', code: { coding: [{ system: 'http://loinc.org', code: '4548-4' }] }, subject: { reference: `Patient/${p.id}` }, effectiveDateTime: at, valueQuantity: { value: 50, unit: 'mmol/mol' } });

  const late = await mk('Late'); await cond(late, 'Type 2 diabetes mellitus'); await a1c(late, ago(250));
  const never = await mk('Never'); await cond(never, 'Type 1 diabetes');
  const fine = await mk('Fine'); await cond(fine, 'Type 2 diabetes'); await a1c(fine, ago(20));
  const soon = await mk('Soon'); await cond(soon, 'Type 2 diabetes'); await a1c(soon, ago(170));
  const secret = await mk('Secret', { meta: { security: [{ code: 'R' }] } }); await cond(secret, 'Type 2 diabetes');
  const resolved = await mk('Resolved');
  await doc('POST', '/fhir/Condition', { resourceType: 'Condition', clinicalStatus: { coding: [{ code: 'resolved' }] }, code: { text: 'Gestational diabetes' }, subject: { reference: `Patient/${resolved.id}` } });

  const start = new Date(Date.now() + 3 * DAY);
  await doc('POST', '/fhir/Appointment', { resourceType: 'Appointment', status: 'booked', start: localIso(start), end: localIso(new Date(start.getTime() + 20 * 60_000)), participant: [{ actor: { reference: `Patient/${late.id}` } }] });

  const list = (await (await as('reception'))('GET', '/api/recalls')).body;
  const by = (p: any) => list.find((r: any) => r.patientId === p.id);
  assert.deepEqual(list.map((r: any) => r.patientId), [never.id, late.id, soon.id]); // never done, then most overdue, then due soon
  assert.equal(by(never).status, 'never');
  assert.equal(by(late).status, 'overdue');
  assert.ok(by(late).overdueDays >= 67);
  assert.ok(by(late).booked);
  assert.equal(by(soon).status, 'due');
  assert.equal(by(fine), undefined);
  assert.equal(by(secret), undefined, 'a restricted record must not appear in a shared list');
  assert.equal(by(resolved), undefined);

  const chart = (await doc('GET', `/api/patients/${secret.id}/summary`, undefined, { 'x-break-glass-reason': 'Seen in clinic today, consented' })).body;
  assert.equal(chart.due[0].ruleId, 'dm-hba1c');
  assert.equal((await (await as('biller'))('GET', '/api/recalls')).status, 403);

  assert.equal((await doc('PUT', '/api/settings/recalls', [{ id: 'x', name: 'X', condition: [], test: ['a'], everyDays: 30, service: '' }])).status, 422);
  assert.equal((await (await as('reception'))('PUT', '/api/settings/recalls', [])).status, 403);
  assert.equal((await doc('PUT', '/api/settings/recalls', [{ id: 'dm', name: 'Diabetes: HbA1c', condition: ['diabetes'], test: ['4548-4'], everyDays: 210, service: '' }])).status, 200);
  assert.equal((await doc('GET', '/api/recalls')).body.some((r: any) => r.patientId === soon.id), false); // 170 + 210 days is not due within a month
});

test('likely duplicates are found with reasons, merged reversibly, and the old ID still finds the person', async () => {
  const { as, db } = await setup();
  const desk = await as('reception');
  const doc = await as('clinician');
  const keep = (await desk('POST', '/fhir/Patient', { resourceType: 'Patient', name: [{ family: 'Okafor', given: ['Grace'] }], gender: 'female', birthDate: '1971-04-02', identifier: [{ system: 'urn:arogya:mrn', value: 'M1' }], telecom: [{ system: 'phone', value: '07700 900123' }] })).body;
  const dupe = (await desk('POST', '/fhir/Patient', { resourceType: 'Patient', name: [{ family: 'Okafur', given: ['Grace'] }], gender: 'female', birthDate: '1971-04-02', identifier: [{ system: 'urn:arogya:mrn', value: 'M2' }], telecom: [{ system: 'phone', value: '+44 7700 900123' }] })).body;
  await desk('POST', '/fhir/Patient', { resourceType: 'Patient', name: [{ family: 'Okafor', given: ['Grace'] }], gender: 'male', birthDate: '1990-01-01', identifier: [{ system: 'urn:arogya:mrn', value: 'M3' }] });

  // The registration desk is warned before creating a third copy.
  const warn = (await desk('POST', '/api/patients/check-duplicate', { family: 'Okafor', given: 'Grace', birthDate: '1971-04-02' })).body;
  assert.ok(warn.length >= 2 && warn[0].why.includes('same date of birth'));

  const pairs = (await desk('GET', '/api/duplicates')).body;
  assert.equal(pairs.length, 1);
  assert.deepEqual(new Set([pairs[0].a.id, pairs[0].b.id]), new Set([keep.id, dupe.id]));
  assert.ok(pairs[0].why.includes('similar surname') && pairs[0].why.includes('same phone'));

  const allergy = (await doc('POST', '/fhir/AllergyIntolerance', { resourceType: 'AllergyIntolerance', clinicalStatus: { coding: [{ code: 'active' }] }, code: { text: 'Penicillin' }, patient: { reference: `Patient/${dupe.id}` } })).body;
  await doc('POST', '/fhir/Observation', { resourceType: 'Observation', status: 'final', code: { text: 'Na' }, subject: { reference: `Patient/${dupe.id}` }, valueQuantity: { value: 140 } });

  assert.equal((await (await as('nurse'))('POST', '/api/patients/merge', { keepId: keep.id, mergeId: dupe.id, reason: 'Checked photo ID at desk' })).status, 403);
  assert.equal((await desk('POST', '/api/patients/merge', { keepId: keep.id, mergeId: dupe.id, reason: 'same' })).status, 422);
  const m = await desk('POST', '/api/patients/merge', { keepId: keep.id, mergeId: dupe.id, reason: 'Checked photo ID and address at the desk' });
  assert.equal(m.status, 200);
  assert.equal(m.body.moved, 2);

  // The allergy now protects the kept record; history still shows where it came from.
  const allergies = (await doc('GET', `/fhir/AllergyIntolerance?patient=${keep.id}`)).body;
  assert.equal(allergies.total, 1);
  assert.equal((await doc('GET', `/fhir/AllergyIntolerance/${allergy.id}/_history/1`)).body.patient.reference, `Patient/${dupe.id}`);
  assert.equal((await db.query("select count(*)::int n from tasks where patient_id=$1", [keep.id])).rows[0].n, 1);
  const retired = (await doc('GET', `/fhir/Patient/${dupe.id}`)).body;
  assert.equal(retired.active, false);
  assert.equal(retired.link[0].type, 'replaced-by');
  const found = (await desk('GET', '/api/search/patients?q=M2')).body;
  assert.deepEqual(found.map((p: any) => p.id), [keep.id]);
  assert.equal((await desk('GET', '/api/duplicates')).body.length, 0);
  assert.equal((await desk('POST', '/api/patients/merge', { keepId: keep.id, mergeId: dupe.id, reason: 'Checked photo ID and address again' })).status, 409);

  // Undo puts everything back.
  assert.equal((await desk('POST', `/api/merges/${m.body.id}/undo`)).status, 200);
  assert.equal((await doc('GET', `/fhir/AllergyIntolerance?patient=${dupe.id}`)).body.total, 1);
  assert.equal((await doc('GET', `/fhir/Patient/${dupe.id}`)).body.active, true);
  const k = (await doc('GET', `/fhir/Patient/${keep.id}`)).body;
  assert.equal(k.link, undefined);
  assert.deepEqual(k.identifier.map((i: any) => i.value), ['M1']);
  assert.equal((await desk('POST', `/api/merges/${m.body.id}/undo`)).status, 409);

  // "Not the same person" takes the pair off the worklist.
  assert.equal((await desk('POST', '/api/duplicates/dismiss', { a: dupe.id, b: keep.id })).status, 200);
  assert.equal((await desk('GET', '/api/duplicates')).body.length, 0);

  const secret = (await doc('POST', '/fhir/Patient', patient('Hidden', 'Pat', { meta: { security: [{ code: 'R' }] } }))).body;
  assert.equal((await desk('POST', '/api/patients/merge', { keepId: keep.id, mergeId: secret.id, reason: 'Checked photo ID and address' })).status, 409);
});

test('a clinician can stop a noisy rule interrupting; allergies always interrupt', async () => {
  const { as } = await setup();
  const doc = await as('clinician');
  const p = (await doc('POST', '/fhir/Patient', patient())).body;
  const rx = (text: string) => ({ resourceType: 'MedicationRequest', status: 'active', intent: 'order', medicationCodeableConcept: { text }, subject: { reference: `Patient/${p.id}` } });
  await doc('POST', '/fhir/MedicationRequest', rx('Ramipril 5 mg'));
  assert.equal((await doc('POST', '/fhir/MedicationRequest', rx('Spironolactone 25 mg'))).status, 409);
  const rule = (await doc('GET', '/api/safety/alert-rules')).body[0].rule;
  assert.equal(rule, 'interaction: spironolactone with ramipril');

  assert.equal((await (await as('admin'))('POST', '/api/safety/alert-rules/quiet', { rule, reason: 'Heart failure clinic co-prescribes routinely' })).status, 403);
  assert.equal((await doc('POST', '/api/safety/alert-rules/quiet', { rule, reason: 'no' })).status, 422);
  assert.equal((await doc('POST', '/api/safety/alert-rules/quiet', { rule: 'allergy: penicillin', reason: 'Patients often mislabelled' })).status, 422);
  assert.equal((await doc('POST', '/api/safety/alert-rules/quiet', { rule, reason: 'Heart failure clinic co-prescribes routinely with potassium monitoring' })).status, 200);

  const check = (await doc('POST', '/api/meds/check', { patientId: p.id, medication: rx('Spironolactone 25 mg') })).body.alerts;
  assert.equal(check[0].severity, 'moderate');
  assert.equal(check[0].quietened, true);
  assert.equal((await doc('POST', '/fhir/MedicationRequest', rx('Spironolactone 25 mg'))).status, 201);
  assert.ok((await doc('GET', '/api/safety/alert-rules')).body.find((r: any) => r.rule === rule).quiet.reason.includes('Heart failure'));

  assert.equal((await doc('POST', '/api/safety/alert-rules/restore', { rule })).status, 200);
  assert.equal((await doc('POST', '/fhir/MedicationRequest', rx('Ramipril 10 mg'))).status, 409, 'interrupts again after restore');
});
