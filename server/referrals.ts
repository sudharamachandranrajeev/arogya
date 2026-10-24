import { randomUUID } from 'node:crypto';
import type { Db } from './db.ts';
import { getSetting } from './domain.ts';
import { FhirError, create, read, search, update } from './fhir/store.ts';

/**
 * Referrals sent to other providers. Each one is tracked until the report comes back, so nothing
 * disappears into "the unknown queue": silence past a deadline becomes a chase task.
 */
export const OUTBOUND = { system: 'urn:arogya:category', code: 'referral-out', display: 'Referral to another provider' };
const TRACK = 'urn:arogya:referral-stage';
const CHASED = 'urn:arogya:chased-at-stage';
export const STAGES = ['sent', 'acknowledged', 'booked', 'report', 'rejected'] as const;
export type Stage = (typeof STAGES)[number];
export const DEFAULT_REFERRAL_DAYS = { acknowledge: 7, book: 28, report: 90 };
const DAY = 86400_000;

const ext = (r: any, url: string) => r.extension?.find((e: any) => e.url === url)?.valueCode as string | undefined;
const withExt = (r: any, url: string, valueCode: string) => [...(r.extension ?? []).filter((e: any) => e.url !== url), { url, valueCode }];
export const stageOf = (r: any) => (ext(r, TRACK) ?? 'sent') as Stage;

export async function send(db: Db, b: { patientId: string; patientName?: string; to: string; service: string; reason?: string; priority?: string; requester?: string }) {
  if (!b.to?.trim() || !b.service?.trim()) throw new FhirError(422, 'Say who the referral is to and for what');
  return create(db, 'ServiceRequest', {
    resourceType: 'ServiceRequest', status: 'active', intent: 'order', category: [{ coding: [OUTBOUND], text: OUTBOUND.display }],
    priority: b.priority ?? 'routine', code: { text: b.service.trim() }, reasonCode: b.reason ? [{ text: b.reason }] : undefined,
    subject: { reference: `Patient/${b.patientId}`, display: b.patientName }, performer: [{ display: b.to.trim() }],
    requester: b.requester ? { reference: `Practitioner/${b.requester}` } : undefined,
    authoredOn: new Date().toISOString(), extension: [{ url: TRACK, valueCode: 'sent' }],
  });
}

/** Record what the other provider did. A report closes the loop; a rejection goes back to the referrer. */
export async function advance(db: Db, id: string, stage: Stage, note: string, by: string) {
  if (!STAGES.includes(stage) || stage === 'sent') throw new FhirError(422, `stage must be one of ${STAGES.slice(1).join(', ')}`);
  const cur = await read(db, 'ServiceRequest', id);
  if (!cur.category?.some((c: any) => c.coding?.some((k: any) => k.code === OUTBOUND.code))) throw new FhirError(404, 'Not a referral to another provider');
  if (cur.status !== 'active') throw new FhirError(409, 'This referral is already closed');
  const text = `${stage === 'report' ? 'Report received' : stage === 'rejected' ? 'Rejected' : stage[0].toUpperCase() + stage.slice(1)}${note ? `: ${note}` : ''}`;
  const { res } = await update(db, 'ServiceRequest', id, {
    ...cur, status: stage === 'report' ? 'completed' : stage === 'rejected' ? 'revoked' : 'active',
    extension: withExt(cur, TRACK, stage), note: [...(cur.note ?? []), { text, time: new Date().toISOString(), authorString: by }],
  });
  // Any chase for this referral is answered by the update.
  await db.query(`update tasks set status='done', done_at=now(), note='Answered by referral update' where ref_type='ServiceRequest' and ref_id=$1 and kind='chase' and status='open'`, [id]);
  if (stage === 'rejected')
    await db.query(`insert into tasks(id,kind,patient_id,subject,ref_type,ref_id,pool,priority) values ($1,'referral',$2,$3,'ServiceRequest',$4,$5,'urgent')`,
      [randomUUID(), cur.subject?.reference?.slice(8) ?? null, `Referral rejected by ${cur.performer?.[0]?.display}: ${note || 'no reason given'}`, id, cur.requester?.reference ? `user:${cur.requester.reference.slice(13)}` : 'triage']);
  return res;
}

function deadline(r: any, days: typeof DEFAULT_REFERRAL_DAYS) {
  const stage = stageOf(r);
  const sent = Date.parse(r.authoredOn ?? r.meta.lastUpdated);
  const since = Date.parse(r.note?.at(-1)?.time ?? r.authoredOn ?? r.meta.lastUpdated); // when the current stage was recorded
  if (stage === 'sent') return { waitingFor: 'acknowledgement', due: sent + days.acknowledge * DAY };
  if (stage === 'acknowledged') return { waitingFor: 'an appointment', due: since + days.book * DAY };
  return { waitingFor: 'the report', due: sent + days.report * DAY };
}

/** Open referrals to other providers, most overdue first. Overdue ones get one chase task per stage. */
export async function outbound(db: Db, patientId?: string) {
  const days = await getSetting(db, 'referralDays', DEFAULT_REFERRAL_DAYS);
  const q: Record<string, string> = { category: OUTBOUND.code, status: 'active', _count: '200' };
  if (patientId) q.patient = patientId;
  const now = Date.now();
  const out = [];
  for (const r of (await search(db, 'ServiceRequest', q)).resources) {
    const stage = stageOf(r);
    const d = deadline(r, days);
    const overdue = now > d.due;
    if (overdue && ext(r, CHASED) !== stage) {
      await db.query(`insert into tasks(id,kind,patient_id,subject,ref_type,ref_id,pool,priority) values ($1,'chase',$2,$3,'ServiceRequest',$4,'scheduling','routine')`,
        [randomUUID(), r.subject?.reference?.slice(8) ?? null, `Chase ${r.performer?.[0]?.display}: no ${d.waitingFor.replace(/^an? |^the /, '')} for ${r.code?.text}`, r.id]);
      await update(db, 'ServiceRequest', r.id, { ...r, extension: withExt(r, CHASED, stage) });
    }
    out.push({
      id: r.id, patientId: r.subject?.reference?.slice(8), patientName: r.subject?.display ?? '', to: r.performer?.[0]?.display ?? '',
      service: r.code?.text ?? '', priority: r.priority ?? 'routine', stage, sent: r.authoredOn, waitingFor: d.waitingFor,
      dueDate: new Date(d.due).toISOString().slice(0, 10), overdueDays: overdue ? Math.floor((now - d.due) / DAY) : 0, notes: r.note ?? [],
    });
  }
  return out.sort((a, b) => b.overdueDays - a.overdueDays || a.dueDate.localeCompare(b.dueDate));
}
