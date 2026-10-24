import { readFileSync } from 'node:fs';
import type { Db } from './db.ts';
import { search } from './fhir/store.ts';

type Drug = { aliases?: string[]; classes: string[]; maxDailyMg?: number };
type Interaction = { a: string; b: string; severity: 'high' | 'moderate'; effect: string };
const kb: { ingredients: Record<string, Drug>; interactions: Interaction[] } = JSON.parse(
  readFileSync(new URL('../data/drugs.json', import.meta.url), 'utf8'),
);

export type Alert = { kind: 'allergy' | 'interaction' | 'duplicate' | 'dose'; severity: 'high' | 'moderate'; message: string; quietened?: boolean };

/** A rule is the alert kind plus the drugs or classes involved, without patient detail. */
export const ruleOf = (a: Alert) => `${a.kind}: ${a.message.split(':')[0].replace(/\d+(\.\d+)? mg\/day exceeds.*for /, 'max dose ')}`;

/**
 * Rules a clinician has judged noisy stop interrupting: they are still shown, as moderate.
 * Allergy alerts are about this patient, not a rule, so they always interrupt.
 */
export async function applyTuning(db: Db, alerts: Alert[]): Promise<Alert[]> {
  if (!alerts.some((a) => a.severity === 'high' && a.kind !== 'allergy')) return alerts;
  const quiet = new Set((await db.query('select rule from alert_tuning')).rows.map((r: any) => r.rule));
  return alerts.map((a) => (a.severity === 'high' && a.kind !== 'allergy' && quiet.has(ruleOf(a)) ? { ...a, severity: 'moderate', quietened: true } : a));
}

const text = (cc: any) => String(cc?.text ?? cc?.coding?.[0]?.display ?? '').toLowerCase();

export function ingredientOf(name: string): string | null {
  const n = name.toLowerCase();
  for (const [k, v] of Object.entries(kb.ingredients)) if (n.includes(k) || v.aliases?.some((a) => n.includes(a))) return k;
  return null;
}

const tags = (ing: string) => [ing, ...kb.ingredients[ing].classes];

/** Daily dose in mg from the first dosage instruction, when it is stated numerically. */
export function dailyMg(req: any): number | null {
  const d = req.dosageInstruction?.[0];
  const dose = d?.doseAndRate?.[0]?.doseQuantity;
  const rep = d?.timing?.repeat;
  if (!dose || dose.unit !== 'mg' || !rep?.frequency) return null;
  const unitDays = rep.periodUnit === 'h' ? 1 / 24 : rep.periodUnit === 'wk' ? 7 : 1;
  const perDay = rep.frequency / ((rep.period || 1) * unitDays);
  return perDay ? dose.value * perDay : null;
}

export async function checkMedication(db: Db, patientId: string, req: any, ignoreId?: string): Promise<Alert[]> {
  const name = text(req.medicationCodeableConcept);
  const ing = ingredientOf(name);
  if (!ing) return [];
  const alerts: Alert[] = [];
  const mine = tags(ing);

  const allergies = (await search(db, 'AllergyIntolerance', { patient: patientId, status: 'active', _count: '100' })).resources;
  for (const a of allergies) {
    const sub = text(a.code);
    const hit = mine.find((t) => sub.includes(t));
    if (hit) alerts.push({ kind: 'allergy', severity: 'high', message: `Patient has a recorded allergy to ${a.code.text ?? sub} (matches ${hit}).` });
  }

  const active = (await search(db, 'MedicationRequest', { patient: patientId, status: 'active', _count: '200' })).resources
    .filter((m) => m.id !== ignoreId);
  for (const m of active) {
    const other = ingredientOf(text(m.medicationCodeableConcept));
    if (!other) continue;
    if (other === ing) { alerts.push({ kind: 'duplicate', severity: 'moderate', message: `Already on an active ${ing} prescription.` }); continue; }
    const theirs = tags(other);
    for (const i of kb.interactions) {
      const fwd = mine.includes(i.a) && theirs.includes(i.b);
      const rev = mine.includes(i.b) && theirs.includes(i.a);
      if (fwd || rev) alerts.push({ kind: 'interaction', severity: i.severity, message: `${ing} with ${other}: ${i.effect}` });
    }
  }

  const max = kb.ingredients[ing].maxDailyMg;
  const mg = dailyMg(req);
  if (max && mg && mg > max) alerts.push({ kind: 'dose', severity: 'high', message: `${mg} mg/day exceeds the usual maximum of ${max} mg/day for ${ing}.` });
  // One alert per message.
  return alerts.filter((a, i) => alerts.findIndex((b) => b.message === a.message) === i);
}

/** Flag a numeric Observation against its own reference range when nobody has set an interpretation. */
export function interpret(obs: any): string | null {
  const v = obs.valueQuantity?.value;
  const r = obs.referenceRange?.[0];
  if (typeof v !== 'number' || !r) return null;
  const lo = r.low?.value, hi = r.high?.value;
  const critLo = r.extension?.find((e: any) => e.url === 'urn:arogya:critical-low')?.valueDecimal;
  const critHi = r.extension?.find((e: any) => e.url === 'urn:arogya:critical-high')?.valueDecimal;
  if (critLo !== undefined && v <= critLo) return 'LL';
  if (critHi !== undefined && v >= critHi) return 'HH';
  if (lo !== undefined && v < lo) return 'L';
  if (hi !== undefined && v > hi) return 'H';
  return 'N';
}
