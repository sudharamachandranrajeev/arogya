import type { Db } from './db.ts';
import { getSetting } from './domain.ts';

/** A monitoring rule: people with a matching active condition need a matching result every `everyDays`. */
export type RecallRule = { id: string; name: string; condition: string[]; test: string[]; everyDays: number; service: string };

// Terms match a code exactly or appear in the text. The intervals are common defaults, not guidance: set your own.
export const DEFAULT_RECALLS: RecallRule[] = [
  { id: 'dm-hba1c', name: 'Diabetes: HbA1c', condition: ['diabetes', '44054006', '73211009'], test: ['hba1c', '4548-4'], everyDays: 182, service: 'Diabetes review' },
  { id: 'htn-bp', name: 'Hypertension: blood pressure', condition: ['hypertension', '38341003'], test: ['systolic', '8480-6'], everyDays: 365, service: '' },
  { id: 'ckd-egfr', name: 'Chronic kidney disease: eGFR', condition: ['chronic kidney', 'ckd', '709044004'], test: ['egfr', '62238-1', '33914-3'], everyDays: 182, service: '' },
];

const DUE_SOON_DAYS = 30;
const DAY = 86400_000;

export function validRules(v: unknown): v is RecallRule[] {
  return Array.isArray(v) && v.every((r) => r && typeof r.id === 'string' && r.id && typeof r.name === 'string' && r.name
    && Array.isArray(r.condition) && r.condition.length && r.condition.every((t: unknown) => typeof t === 'string' && t.trim())
    && Array.isArray(r.test) && r.test.length && r.test.every((t: unknown) => typeof t === 'string' && t.trim())
    && Number.isInteger(r.everyDays) && r.everyDays > 0 && r.everyDays <= 3650 && typeof r.service === 'string');
}

const matches = (cc: any, terms: string[]) => {
  const text = [cc?.text, ...(cc?.coding ?? []).map((c: any) => c.display)].filter(Boolean).join(' ').toLowerCase();
  const codes = new Set((cc?.coding ?? []).map((c: any) => String(c.code)));
  return terms.some((t) => codes.has(t) || text.includes(t.toLowerCase()));
};
const isRestricted = (p: any) => !!p.meta?.security?.some((s: any) => s.code === 'R' || s.code === 'V');
const isLive = (p: any) => p.active !== false && !p.deceasedBoolean && !p.deceasedDateTime;

export type Recall = {
  ruleId: string; rule: string; service: string; patientId: string; patientName: string; birthDate?: string;
  lastDone: string | null; dueDate: string; overdueDays: number; status: 'never' | 'overdue' | 'due'; booked: string | null;
};

/**
 * Who is due monitoring now or within a month. Restricted records are left out of the shared list
 * (they would reveal a diagnosis); pass `patientId` from an opened chart to include them.
 */
export async function recalls(db: Db, patientId?: string): Promise<Recall[]> {
  const rules = await getSetting(db, 'recalls', DEFAULT_RECALLS);
  const one = patientId ? `Patient/${patientId}` : null;
  const conds = (await db.query(
    `select data->'subject'->>'reference' as ref, data->'code' as code from resources r
     where type='Condition' and not deleted and ($1::text is null or data->'subject'->>'reference' = $1)
     and exists (select 1 from search_idx s where s.type='Condition' and s.id=r.id and s.param='status' and s.val='active')`, [one])).rows;
  const wanted = new Map<string, RecallRule[]>();
  for (const c of conds) for (const rule of rules) {
    if (!c.ref?.startsWith('Patient/') || !matches(c.code, rule.condition)) continue;
    const list = wanted.get(c.ref) ?? [];
    if (!list.includes(rule)) list.push(rule);
    wanted.set(c.ref, list);
  }
  if (!wanted.size) return [];
  const refs = [...wanted.keys()];
  const [obs, pats, appts] = await Promise.all([
    db.query(
      `select data->'subject'->>'reference' as ref, data->'code' as code,
       coalesce(data->>'effectiveDateTime', data->'effectivePeriod'->>'start', data->>'issued') as at
       from resources where type='Observation' and not deleted and data->>'status' in ('final','amended','corrected')
       and data->'subject'->>'reference' = any($1::text[])`, [refs]),
    db.query(`select id, data from resources where type='Patient' and not deleted and id = any($1::text[])`, [refs.map((r) => r.slice(8))]),
    db.query(
      `select r.data from resources r join search_idx s on s.type=r.type and s.id=r.id and s.param='patient'
       where r.type='Appointment' and not r.deleted and r.data->>'status' in ('booked','pending','arrived')
       and (r.data->>'start')::timestamptz > now() and s.val = any($1::text[])`, [refs]),
  ]);
  const patient = new Map(pats.rows.map((p: any) => [`Patient/${p.id}`, p.data]));
  const nextAppt = new Map<string, string>();
  for (const { data: a } of appts.rows)
    for (const p of a.participant ?? []) {
      const ref = p.actor?.reference;
      if (ref && (!nextAppt.has(ref) || a.start < nextAppt.get(ref)!)) nextAppt.set(ref, a.start);
    }

  const now = Date.now();
  const out: Recall[] = [];
  for (const [ref, ruleList] of wanted) {
    const p = patient.get(ref);
    if (!p || !isLive(p) || (!one && isRestricted(p))) continue;
    for (const rule of ruleList) {
      const last = obs.rows.filter((o: any) => o.ref === ref && o.at && matches(o.code, rule.test)).map((o: any) => o.at as string).sort().at(-1) ?? null;
      const due = last ? Date.parse(last) + rule.everyDays * DAY : now;
      if (due - now > DUE_SOON_DAYS * DAY) continue;
      out.push({
        ruleId: rule.id, rule: rule.name, service: rule.service, patientId: ref.slice(8),
        patientName: p.name?.[0]?.text ?? [p.name?.[0]?.given?.join(' '), p.name?.[0]?.family].filter(Boolean).join(' '),
        birthDate: p.birthDate, lastDone: last, dueDate: new Date(due).toISOString().slice(0, 10),
        overdueDays: Math.max(0, Math.floor((now - due) / DAY)), status: !last ? 'never' : due <= now ? 'overdue' : 'due',
        booked: nextAppt.get(ref) ?? null,
      });
    }
  }
  const rank = { never: 0, overdue: 1, due: 2 };
  return out.sort((a, b) => rank[a.status] - rank[b.status] || b.overdueDays - a.overdueDays || a.dueDate.localeCompare(b.dueDate));
}
