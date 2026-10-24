import { randomUUID } from 'node:crypto';
import type { Db } from './db.ts';
import { FhirError, create, patientOf, search } from './fhir/store.ts';
import { dnaRisk } from './domain.ts';
import { CONFIRMED } from './reminders.ts';

export type Slot = { start: string; end: string; practitionerId: string; service: string; location: string; free: boolean };

const pad = (n: number) => String(n).padStart(2, '0');
/** Local-time ISO string with offset: clinics run on wall-clock time, so the server TZ is the clinic TZ. */
export function localIso(d: Date) {
  const off = -d.getTimezoneOffset();
  const s = off >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00${s}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}

export async function slots(db: Db, o: { from: Date; days: number; service?: string; practitionerId?: string }): Promise<Slot[]> {
  const sessions = (await db.query('select * from clinic_sessions where active')).rows
    .filter((s) => (!o.service || s.service.toLowerCase().includes(o.service.toLowerCase())) && (!o.practitionerId || s.practitioner_id === o.practitionerId));
  const out: Slot[] = [];
  const day0 = new Date(o.from.getFullYear(), o.from.getMonth(), o.from.getDate());
  const taken = new Map<string, Array<[number, number]>>();
  for (let i = 0; i < o.days; i++) {
    const day = new Date(day0.getFullYear(), day0.getMonth(), day0.getDate() + i);
    for (const s of sessions.filter((x) => x.weekday === day.getDay())) {
      const [sh, sm] = s.start_time.split(':').map(Number);
      const [eh, em] = s.end_time.split(':').map(Number);
      for (let m = sh * 60 + sm; m + s.slot_mins <= eh * 60 + em; m += s.slot_mins) {
        const a = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, m);
        const b = new Date(a.getTime() + s.slot_mins * 60_000);
        if (b.getTime() <= Date.now()) continue;
        const key = `${s.practitioner_id}|${day.toDateString()}`;
        if (!taken.has(key)) {
          const date = localIso(day).slice(0, 10);
          const appts = (await search(db, 'Appointment', { practitioner: s.practitioner_id, date, status: 'booked,pending,arrived,fulfilled', _count: '200' })).resources;
          taken.set(key, appts.map((x) => [Date.parse(x.start), Date.parse(x.end)]));
        }
        const free = !taken.get(key)!.some(([x, y]) => x < b.getTime() && y > a.getTime());
        out.push({ start: localIso(a), end: localIso(b), practitionerId: s.practitioner_id, service: s.service, location: s.location, free });
      }
    }
  }
  return out.sort((x, y) => x.start.localeCompare(y.start));
}

/** Book inside a lock per practitioner so two receptionists can never take the same slot. */
export async function book(db: Db, b: { patientId: string; practitionerId: string; start: string; end: string; service: string; referralId?: string; reason?: string; patientName?: string }) {
  const s = Date.parse(b.start), e = Date.parse(b.end);
  if (!(e > s)) throw new FhirError(422, 'end must be after start');
  if (s < Date.now()) throw new FhirError(422, 'cannot book in the past');
  const appt = {
    resourceType: 'Appointment', status: 'booked', start: b.start, end: b.end, serviceType: [{ text: b.service }],
    reasonCode: b.reason ? [{ text: b.reason }] : undefined,
    basedOn: b.referralId ? [{ reference: `ServiceRequest/${b.referralId}` }] : undefined,
    participant: [
      { actor: { reference: `Patient/${b.patientId}`, display: b.patientName }, status: 'accepted' },
      { actor: { reference: `Practitioner/${b.practitionerId}` }, status: 'accepted' },
    ],
  };
  return db.tx(async (t) => {
    await assertFree(t, appt);
    return create(t, 'Appointment', appt, randomUUID());
  });
}

export const ACTIVE = ['booked', 'pending', 'arrived'];

/**
 * Refuse an active appointment that overlaps another for the same clinician. Every path that makes or moves an
 * appointment calls this inside its write transaction; the advisory lock per clinician serialises those paths.
 * Times are compared as timestamps, so offsets and midnight do not matter.
 */
export async function assertFree(t: Db, a: any, exceptId = '') {
  if (!ACTIVE.includes(a.status)) return;
  const refs = [...new Set<string>((a.participant ?? []).map((p: any) => p.actor?.reference).filter((r: unknown) => typeof r === 'string' && r.startsWith('Practitioner/')))].sort();
  for (const ref of refs) {
    await t.query('select pg_advisory_xact_lock(hashtext($1))', [`appt:${ref.slice(13)}`]);
    const clash = (await t.query(
      `select id from resources where type='Appointment' and not deleted and id <> $1 and data->>'status' = any($2::text[])
       and data->'participant' @> $3::jsonb and (data->>'start')::timestamptz < $5::timestamptz and (data->>'end')::timestamptz > $4::timestamptz limit 1`,
      [exceptId, [...ACTIVE, 'fulfilled'], JSON.stringify([{ actor: { reference: ref } }]), a.start, a.end])).rows[0];
    if (clash) throw new FhirError(409, 'That slot has just been taken');
  }
}
export { patientOf };

/** One clinic day, in time order, with what the receptionist and clinician need at a glance. */
export async function today(db: Db, date?: string, practitionerId?: string) {
  const d = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : localIso(new Date()).slice(0, 10);
  const q: Record<string, string> = { date: d, _count: '200', _sort: 'date' };
  if (practitionerId) q.practitioner = practitionerId;
  const appts = (await search(db, 'Appointment', q)).resources.filter((a) => a.status !== 'cancelled');
  const out = [];
  for (const a of appts) {
    const pRef = a.participant?.find((p: any) => String(p.actor?.reference).startsWith('Patient/'))?.actor;
    const patientId = String(pRef?.reference ?? '').slice(8);
    const allergies = patientId ? (await search(db, 'AllergyIntolerance', { patient: patientId, status: 'active', _count: '0' })).total : 0;
    out.push({
      id: a.id, start: a.start, end: a.end, status: a.status, service: a.serviceType?.[0]?.text ?? '',
      patientId, patientName: pRef?.display ?? '', allergies, confirmed: a.extension?.find((e: any) => e.url === CONFIRMED)?.valueDateTime ?? null,
      practitionerId: String(a.participant?.find((p: any) => String(p.actor?.reference).startsWith('Practitioner/'))?.actor?.reference ?? '').slice(13),
    });
  }
  return out.sort((x, y) => x.start.localeCompare(y.start));
}

export async function dnaRiskMany(db: Db, patientIds: string[]) {
  const out: Record<string, Awaited<ReturnType<typeof dnaRisk>>> = {};
  for (const id of new Set(patientIds)) if (id) out[id] = await dnaRisk(db, id, 0);
  return out;
}
