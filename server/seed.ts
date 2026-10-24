import type { Db } from './db.ts';
import { createUser } from './auth.ts';
import { afterWrite, beforeWrite } from './domain.ts';
import { create } from './fhir/store.ts';
import { localIso } from './scheduling.ts';
import { advance, send as sendReferral } from './referrals.ts';

export const DEMO_PASSWORD = 'arogya-demo-2026';

/** Deterministic synthetic data only: no real person is represented. */
function rng(seed: number) { return () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296; }

const FAMILY = ['Nair', 'Menon', 'Okafor', 'Silva', 'Haddad', 'Kowalski', 'Tanaka', 'Murphy', 'Singh', 'Garcia', 'Lindqvist', 'Mwangi', 'Rahman', 'Dubois', 'Costa'];
const GIVEN = ['Asha', 'Ravi', 'Chidi', 'Maria', 'Omar', 'Anna', 'Kenji', 'Aoife', 'Priya', 'Luis', 'Elsa', 'Wanjiru', 'Imran', 'Claire', 'Tiago'];
const SERVICES = ['Continence', 'Diabetes review', 'Physiotherapy', 'Respiratory'];

const LAB = { loinc: 'http://loinc.org' };

export async function seed(db: Db) {
  const u: Record<string, string> = {};
  for (const [username, role, name] of [['admin', 'admin', 'Alex Admin'], ['mehta', 'clinician', 'Dr Sunita Mehta'], ['osei', 'clinician', 'Dr Kwame Osei'], ['nurse', 'nurse', 'Nia Nurse'], ['reception', 'reception', 'Rory Reception'], ['manager', 'manager', 'Mina Manager'], ['biller', 'biller', 'Bo Biller']] as const) {
    let pid: string | undefined;
    if (username === 'mehta' || username === 'osei') {
      pid = (await create(db, "Practitioner", { resourceType: "Practitioner", name: [{ text: name, family: name.split(" ").pop() }], active: true })).id as string;
      u[username] = pid;
    }
    await createUser(db, { username, role, name, password: DEMO_PASSWORD, practitionerId: pid });
  }
  const R = rng(42);
  const pick = <T,>(a: T[]) => a[Math.floor(R() * a.length)];
  const now = Date.now();
  const system = { reception: { id: 'seed', role: 'admin' } } as any;
  const ref = (t: string, id: string) => ({ reference: `${t}/${id}` });

  const patients: Array<{ id: string; name: string }> = [];
  for (let i = 0; i < 40; i++) {
    const family = pick(FAMILY), given = pick(GIVEN);
    const born = new Date(now - (20 + Math.floor(R() * 65)) * 365 * 86400_000);
    const p = await create(db, 'Patient', {
      resourceType: 'Patient', active: true, name: [{ family, given: [given], text: `${given} ${family}` }],
      gender: pick(['male', 'female']), birthDate: born.toISOString().slice(0, 10),
      identifier: [{ system: 'urn:arogya:mrn', value: `A${String(100000 + i)}` }],
      telecom: [{ system: 'phone', value: `07${String(Math.floor(R() * 1e9)).padStart(9, '0')}` }],
      ...(i === 0 ? { meta: { security: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-Confidentiality', code: 'R' }] } } : {}),
    });
    patients.push({ id: p.id, name: `${given} ${family}` });
  }
  // One person registered twice, so the duplicates worklist has something to resolve.
  const twin = (await db.query(`select data from resources where type='Patient' and id=$1`, [patients[4].id])).rows[0].data;
  await create(db, 'Patient', { resourceType: 'Patient', active: true, name: [{ family: twin.name[0].family, given: twin.name[0].given, text: twin.name[0].text }],
    gender: twin.gender, birthDate: twin.birthDate, identifier: [{ system: 'urn:arogya:mrn', value: 'A900004' }] });

  for (let i = 0; i < 40; i++) {
    const p = patients[i];
    const subject = { reference: `Patient/${p.id}`, display: p.name };
    if (i % 5 === 0) await create(db, 'AllergyIntolerance', { resourceType: 'AllergyIntolerance', clinicalStatus: { coding: [{code: 'active'}] }, code: { text: 'Penicillin' }, patient: subject, criticality: 'high' });
    if (i % 3 === 0) await create(db, 'Condition', { resourceType: 'Condition', clinicalStatus: { coding: [{ code: 'active' }] }, code: { text: pick(['Type 2 diabetes', 'Hypertension', 'Asthma', 'Urinary incontinence']) }, subject });
    if (i % 4 === 0) await create(db, 'MedicationRequest', { resourceType: 'MedicationRequest', status: 'active', intent: 'order', medicationCodeableConcept: { text: pick(['Ramipril 5 mg', 'Metformin 500 mg', 'Warfarin 3 mg', 'Atorvastatin 20 mg']) }, subject });
    if (i % 2) continue; // half the list has recent results; the rest feed the recall list below
    const hba1c = 38 + Math.floor(R() * 40);
    const obs = {
      resourceType: 'Observation', status: 'final', category: [{ coding: [{ code: 'laboratory' }] }], code: { coding: [{ system: LAB.loinc, code: '4548-4', display: 'HbA1c' }], text: 'HbA1c' },
      subject, effectiveDateTime: new Date(now - R() * 20 * 86400_000).toISOString(), valueQuantity: { value: hba1c, unit: 'mmol/mol' },
      referenceRange: [{ low: { value: 20 }, high: { value: 48 }, extension: [{ url: 'urn:arogya:critical-high', valueDecimal: 75 }] }],
      basedOn: undefined as any,
    };
    delete obs.basedOn;
    beforeWrite('Observation', obs);
    const o = await create(db, 'Observation', obs);
    await afterWrite(db, 'Observation', o, true, system);
    await create(db, 'Observation', { resourceType: 'Observation', status: 'final', category: [{ coding: [{ code: 'vital-signs' }] }], code: { coding: [{ system: LAB.loinc, code: '8480-6', display: 'Systolic BP' }], text: 'Systolic BP' }, subject, effectiveDateTime: new Date(now - R() * 30 * 86400_000).toISOString(), valueQuantity: { value: 105 + Math.floor(R() * 60), unit: 'mmHg' } });
  }

  // Long-term conditions whose monitoring has lapsed or is coming due.
  const lapsed: Array<[number, string, string | null, number]> = [[7, 'Type 2 diabetes', 'HbA1c', 260], [11, 'Type 2 diabetes', null, 0], [13, 'Hypertension', 'Systolic BP', 400], [17, 'Chronic kidney disease stage 3', null, 0], [19, 'Type 2 diabetes', 'HbA1c', 170]];
  for (const [i, condition, test, daysAgo] of lapsed) {
    const subject = { reference: `Patient/${patients[i].id}`, display: patients[i].name };
    await create(db, 'Condition', { resourceType: 'Condition', clinicalStatus: { coding: [{ code: 'active' }] }, code: { text: condition }, subject });
    if (test) await create(db, 'Observation', { resourceType: 'Observation', status: 'final', category: [{ coding: [{ code: test === 'HbA1c' ? 'laboratory' : 'vital-signs' }] }], code: { text: test }, subject, effectiveDateTime: new Date(now - daysAgo * 86400_000).toISOString(), valueQuantity: test === 'HbA1c' ? { value: 52, unit: 'mmol/mol' } : { value: 148, unit: 'mmHg' } });
  }

  // Alert history: one rule clinicians override every time, for the alert review.
  for (let i = 0; i < 12; i++)
    await db.query('insert into alert_log(at,user_id,patient_id,rule,severity,overridden) values ($1,$2,$3,$4,$5,$6)', [new Date(now - i * 6 * 86400_000).toISOString(), null, patients[i].id, 'interaction: spironolactone with ramipril', 'high', true]);
  for (let i = 0; i < 12; i++)
    await db.query('insert into override_log(at,user_id,patient_id,medication,alerts,reason) values ($1,$2,$3,$4,$5,$6)', [new Date(now - i * 6 * 86400_000).toISOString(), null, patients[i].id, 'Spironolactone 25 mg', JSON.stringify([{ kind: 'interaction', severity: 'high', message: 'spironolactone with ramipril: Risk of high potassium.' }]), 'Heart failure: potassium monitored']);

  // Referrals of varied age, some already booked.
  const sessions = [['mehta', 'Continence', 1], ['mehta', 'Diabetes review', 3], ['osei', 'Respiratory', 2], ['osei', 'Physiotherapy', 4]] as const;
  for (const [who, service, weekday] of sessions)
    await db.query('insert into clinic_sessions(id,practitioner_id,service,weekday,start_time,end_time,slot_mins) values ($1,$2,$3,$4,$5,$6,$7)', [crypto.randomUUID(), u[who], service, weekday, '09:00', '13:00', 20]);

  for (let i = 0; i < 25; i++) {
    const p = patients[i + 5];
    const ageDays = Math.floor(R() * 150);
    const sr = {
      resourceType: 'ServiceRequest', status: 'active', intent: 'order', category: [{ text: 'referral' }],
      priority: pick(['routine', 'routine', 'routine', 'urgent']), code: { text: pick(SERVICES) },
      subject: { reference: `Patient/${p.id}`, display: p.name }, authoredOn: new Date(now - ageDays * 86400_000).toISOString(),
      requester: ref('Practitioner', u.mehta),
    };
    beforeWrite('ServiceRequest', sr);
    const r = await create(db, 'ServiceRequest', sr);
    await afterWrite(db, 'ServiceRequest', r, true, system);
  }

  // Referrals to other providers at different stages; the cardiology one has gone quiet past its deadline.
  const away: Array<[number, string, string, number, Array<[string, string]>]> = [
    [21, 'City Hospital Cardiology', 'Echocardiogram', 12, []],
    [22, 'Community Podiatry', 'Diabetic foot review', 3, []],
    [23, 'Regional Eye Unit', 'Retinal screening', 40, [['acknowledged', 'On their list']]],
    [24, 'Memory Clinic', 'Cognitive assessment', 20, [['acknowledged', 'Letter received'], ['booked', 'Seen 2 Dec']]],
  ];
  for (const [i, to, service, daysAgo, steps] of away) {
    const r = await sendReferral(db, { patientId: patients[i].id, patientName: patients[i].name, to, service, requester: u.mehta });
    await db.query(`update resources set data = jsonb_set(data, '{authoredOn}', to_jsonb($2::text)) where type='ServiceRequest' and id=$1`, [r.id, new Date(now - daysAgo * 86400_000).toISOString()]);
    for (const [stage, note] of steps) await advance(db, r.id, stage as any, note, 'Rory Reception');
  }

  // Past appointment history so DNA risk has something to learn from.
  for (let i = 0; i < 30; i++) {
    const p = patients[i];
    const start = new Date(now - (10 + R() * 200) * 86400_000);
    start.setHours(9 + Math.floor(R() * 4), 0, 0, 0);
    await create(db, 'Appointment', {
      resourceType: 'Appointment', status: R() < 0.15 ? 'noshow' : R() < 0.1 ? 'cancelled' : 'fulfilled',
      start: localIso(start), end: localIso(new Date(start.getTime() + 20 * 60_000)),
      participant: [{ actor: { reference: `Patient/${p.id}`, display: p.name }, status: 'accepted' }, { actor: ref('Practitioner', u.mehta), status: 'accepted' }],
    });
  }

  // Today's clinic so the day view has something to show.
  for (let i = 0; i < 8; i++) {
    const p = patients[i + 1];
    const start = new Date(); start.setHours(9, i * 50, 0, 0);
    const past = start.getTime() < now;
    await create(db, 'Appointment', {
      resourceType: 'Appointment', status: past ? (i % 4 === 3 ? 'noshow' : 'fulfilled') : i % 3 === 0 ? 'arrived' : 'booked',
      start: localIso(start), end: localIso(new Date(start.getTime() + 20 * 60_000)), serviceType: [{ text: SERVICES[i % 4] }],
      participant: [{ actor: { reference: `Patient/${p.id}`, display: p.name }, status: 'accepted' }, { actor: ref('Practitioner', u.mehta), status: 'accepted' }],
    });
  }
}
