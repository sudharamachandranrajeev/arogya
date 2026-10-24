import { randomUUID } from 'node:crypto';
import type { Db } from './db.ts';
import type { User } from './auth.ts';
import { interpret } from './cds.ts';
import { patientOf, read, search } from './fhir/store.ts';

export const DEFAULT_TARGET_DAYS: Record<string, number> = { stat: 2, asap: 14, urgent: 28, routine: 126 };

export async function getSetting<T>(db: Db, key: string, fallback: T): Promise<T> {
  const r = (await db.query('select value from settings where key=$1', [key])).rows[0];
  return r ? r.value : fallback;
}
export async function setSetting(db: Db, key: string, value: unknown) {
  await db.query('insert into settings(key,value) values ($1,$2) on conflict(key) do update set value=excluded.value', [key, JSON.stringify(value)]);
}

const ABNORMAL = new Set(['H', 'L', 'HH', 'LL', 'A', 'AA', 'POS', 'HU', 'LU', 'CRIT']);
const CRITICAL = new Set(['HH', 'LL', 'AA', 'CRIT']);
const code = (o: any) => o.interpretation?.[0]?.coding?.[0]?.code as string | undefined;

/** Normalise a resource before it is stored. */
export function beforeWrite(type: string, res: any) {
  if (type === 'Observation' && !res.interpretation && res.status === 'final') {
    const c = interpret(res);
    if (c) res.interpretation = [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation', code: c }], extension: [{ url: 'urn:arogya:auto-flagged', valueBoolean: true }] }];
  }
  if (type === 'ServiceRequest' && res.category?.some((c: any) => c.coding?.some((k: any) => k.code === 'referral') || c.text === 'referral')) {
    res.priority ??= 'routine';
  }
}

async function addTask(db: Db, t: { kind: string; patientId: string | null; subject: string; refType: string; refId: string; pool: string; priority?: string; normal?: boolean; assignee?: string | null }) {
  await db.query(
    'insert into tasks(id,kind,patient_id,subject,ref_type,ref_id,pool,assignee,priority,normal) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [randomUUID(), t.kind, t.patientId, t.subject, t.refType, t.refId, t.pool, t.assignee ?? null, t.priority ?? 'routine', t.normal ?? false],
  );
}

const label = (cc: any) => cc?.text ?? cc?.coding?.[0]?.display ?? cc?.coding?.[0]?.code ?? '';

/** Side effects of a stored resource: work lands in the right inbox without anyone forwarding it. */
export async function afterWrite(db: Db, type: string, res: any, created: boolean, _user?: User) {
  const patientId = patientOf(res);
  if (type === 'Observation' && res.status === 'final' && created) {
    const c = code(res);
    const normal = !c || c === 'N' || !ABNORMAL.has(c) ? c === 'N' : false;
    let owner: string | null = null;
    const sr = res.basedOn?.[0]?.reference;
    if (sr?.startsWith('ServiceRequest/')) {
      try { owner = (await read(db, 'ServiceRequest', sr.slice(15))).requester?.reference?.replace('Practitioner/', '') ?? null; } catch { /* order may be gone */ }
    }
    await addTask(db, {
      kind: 'result', patientId, subject: `${label(res.code)}${res.valueQuantity ? `: ${res.valueQuantity.value} ${res.valueQuantity.unit ?? ''}` : ''}`,
      refType: type, refId: res.id, pool: owner ? `user:${owner}` : 'results', priority: c && CRITICAL.has(c) ? 'urgent' : 'routine', normal,
    });
  }
  if (type === 'DiagnosticReport' && res.status === 'final' && created)
    await addTask(db, { kind: 'result', patientId, subject: `Report: ${label(res.code)}`, refType: type, refId: res.id, pool: res.performer?.[0]?.reference?.startsWith('Practitioner/') ? 'results' : 'results' });
  if (type === 'ServiceRequest' && created && res.category?.some((c: any) => c.text === 'referral' || c.coding?.some((k: any) => k.code === 'referral')))
    await addTask(db, { kind: 'referral', patientId, subject: `Referral: ${label(res.code)}`, refType: type, refId: res.id, pool: 'triage', priority: res.priority === 'stat' || res.priority === 'asap' ? 'urgent' : 'routine' });
  if (type === 'Appointment' && ['cancelled', 'noshow'].includes(res.status) && new Date(res.start).getTime() > Date.now())
    await addTask(db, { kind: 'backfill', patientId: null, subject: `Slot freed ${res.start.slice(0, 16).replace('T', ' ')}: fill from waiting list`, refType: type, refId: res.id, pool: 'scheduling', priority: 'urgent' });
  if (type === 'Communication' && created && res.recipient?.length)
    await addTask(db, { kind: 'message', patientId, subject: String(res.payload?.[0]?.contentString ?? 'Message').slice(0, 120), refType: type, refId: res.id, pool: 'messages' });
}

/** Waiting list: active referrals with no live appointment, longest-overdue first. */
export async function waitingList(db: Db, service?: string) {
  const q: Record<string, string> = { status: 'active', category: 'referral', _count: '200', _sort: '_lastUpdated' };
  const refs = (await search(db, 'ServiceRequest', q)).resources;
  const appts = (await search(db, 'Appointment', { status: 'booked,pending,arrived', _count: '200' })).resources;
  const booked = new Set(appts.flatMap((a) => (a.basedOn ?? []).map((b: any) => String(b.reference).replace('ServiceRequest/', ''))));
  const targets = await getSetting(db, 'targets', DEFAULT_TARGET_DAYS);
  const now = Date.now();
  return refs
    .filter((r) => !booked.has(r.id) && (!service || label(r.code).toLowerCase().includes(service.toLowerCase())))
    .map((r) => {
      const start = new Date(r.authoredOn ?? r.meta.lastUpdated).getTime();
      const days = Math.floor((now - start) / 86400_000);
      const target = targets[r.priority ?? 'routine'] ?? targets.routine;
      return {
        id: r.id, patientId: patientOf(r), patientName: r.subject?.display ?? '', service: label(r.code), priority: r.priority ?? 'routine',
        waitingDays: days, targetDays: target, daysToBreach: target - days, breached: days > target,
      };
    })
    .sort((a, b) => a.daysToBreach - b.daysToBreach);
}

const PRI: Record<string, number> = { stat: 0, asap: 1, urgent: 2, routine: 3 };

/** Transparent no-show risk: every term is shown to the scheduler. */
export async function dnaRisk(db: Db, patientId: string, leadDays: number) {
  const appts = (await search(db, 'Appointment', { patient: patientId, _count: '200' })).resources;
  const past = appts.filter((a) => ['fulfilled', 'noshow', 'cancelled'].includes(a.status));
  const dna = past.filter((a) => a.status === 'noshow').length;
  const reasons: string[] = [];
  let risk = 0.05;
  if (past.length) { const r = dna / past.length; risk += 0.5 * r; if (dna) reasons.push(`${dna} of ${past.length} past appointments were missed`); }
  else { risk += 0.05; reasons.push('no appointment history'); }
  if (leadDays > 14) { risk += Math.min(0.2, (leadDays - 14) * 0.004); reasons.push(`booked ${leadDays} days ahead`); }
  return { risk: Math.min(0.95, Number(risk.toFixed(2))), reasons };
}

/** Who should fill a freed slot: breached/urgent first, then those most likely to attend. */
export async function backfillCandidates(db: Db, service?: string, limit = 5) {
  const wl = (await waitingList(db, service)).sort((a, b) => PRI[a.priority] - PRI[b.priority] || a.daysToBreach - b.daysToBreach).slice(0, 25);
  const out = [];
  for (const w of wl) out.push({ ...w, dna: w.patientId ? await dnaRisk(db, w.patientId, 0) : { risk: 0.1, reasons: [] } });
  return out.sort((a, b) => Number(b.breached) - Number(a.breached) || PRI[a.priority] - PRI[b.priority] || a.dna.risk - b.dna.risk).slice(0, limit);
}
