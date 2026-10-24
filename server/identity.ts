import { randomUUID } from 'node:crypto';
import type { Db } from './db.ts';
import { FhirError, read, update } from './fhir/store.ts';

/** Fold case and accents so "Nair", "NAIR" and "Naír" compare equal. */
export const fold = (s: unknown) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');
const digits = (s: unknown) => String(s ?? '').replace(/\D/g, '');

function distance(a: string, b: string) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

type Person = { family: string; given: string; birthDate: string; gender: string; phones: string[]; ids: string[] };
export function person(p: any): Person {
  const n = p.name?.find((x: any) => x.use === 'official') ?? p.name?.[0] ?? {};
  return {
    family: fold(n.family ?? String(n.text ?? '').split(' ').at(-1)), given: fold(n.given?.[0] ?? String(n.text ?? '').split(' ')[0]),
    birthDate: p.birthDate ?? '', gender: p.gender ?? '',
    phones: (p.telecom ?? []).filter((t: any) => t.system === 'phone').map((t: any) => digits(t.value).slice(-9)).filter((d: string) => d.length >= 6),
    ids: (p.identifier ?? []).map((i: any) => `${i.system ?? ''}|${i.value}`),
  };
}

/** Transparent match score: every term that contributed is returned as a reason. */
export function score(a: Person, b: Person) {
  let s = 0;
  const why: string[] = [];
  if (a.ids.some((i) => b.ids.includes(i))) { s += 0.6; why.push('same identifier'); }
  if (a.birthDate && a.birthDate === b.birthDate) { s += 0.35; why.push('same date of birth'); }
  else if (a.birthDate && b.birthDate && a.birthDate.slice(0, 4) === b.birthDate.slice(0, 4)
    && (a.birthDate.slice(5) === `${b.birthDate.slice(8)}-${b.birthDate.slice(5, 7)}` || distance(a.birthDate, b.birthDate) === 1)) { s += 0.15; why.push('date of birth nearly matches'); }
  if (a.family && a.family === b.family) { s += 0.25; why.push('same surname'); }
  else if (a.family && b.family && distance(a.family, b.family) <= 2) { s += 0.15; why.push('similar surname'); }
  if (a.given && a.given === b.given) { s += 0.2; why.push('same first name'); }
  else if (a.given && b.given && (a.given.startsWith(b.given) || b.given.startsWith(a.given) || distance(a.given, b.given) <= 2)) { s += 0.1; why.push('similar first name'); }
  if (a.phones.some((p) => b.phones.includes(p))) { s += 0.25; why.push('same phone'); }
  if (a.gender && b.gender && a.gender !== b.gender && ![a.gender, b.gender].includes('unknown')) { s -= 0.3; why.push('different recorded sex'); }
  return { score: Math.max(0, Math.min(1, Math.round(s * 100) / 100)), why };
}

export const LIKELY = 0.6;
const merged = (p: any) => p.link?.some((l: any) => l.type === 'replaced-by');
const restricted = (p: any) => !!p.meta?.security?.some((s: any) => s.code === 'R' || s.code === 'V');

/** Pairs of live records that probably belong to one person. Compared only within blocks, never all pairs. */
export async function duplicates(db: Db, limit = 100) {
  const rows = (await db.query(`select id, data from resources where type='Patient' and not deleted`)).rows
    .filter((r: any) => r.data.active !== false && !merged(r.data) && !restricted(r.data));
  const people = new Map(rows.map((r: any) => [r.id, person(r.data)]));
  const blocks = new Map<string, string[]>();
  const put = (k: string, id: string) => { if (!blocks.has(k)) blocks.set(k, []); blocks.get(k)!.push(id); };
  for (const [id, p] of people) {
    if (p.birthDate) put(`b:${p.birthDate}`, id);
    if (p.family) put(`f:${p.family.slice(0, 3)}:${p.birthDate.slice(0, 4)}`, id);
    p.phones.forEach((x) => put(`t:${x}`, id));
    p.ids.forEach((x) => put(`i:${x}`, id));
  }
  const dismissed = new Set((await db.query('select a, b from not_duplicate')).rows.map((r: any) => `${r.a}|${r.b}`));
  const seen = new Set<string>();
  const out: Array<{ a: string; b: string; score: number; why: string[] }> = [];
  for (const ids of blocks.values()) {
    if (ids.length > 200) continue; // a block this large is a common value, not evidence
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const [a, b] = [ids[i], ids[j]].sort();
      const key = `${a}|${b}`;
      if (seen.has(key) || dismissed.has(key)) continue;
      seen.add(key);
      const m = score(people.get(a)!, people.get(b)!);
      if (m.score >= LIKELY) out.push({ a, b, ...m });
    }
  }
  out.sort((x, y) => y.score - x.score);
  const shown = out.slice(0, limit);
  const ids = [...new Set(shown.flatMap((d) => [d.a, d.b]))];
  const counts = new Map((await db.query(
    `select val, count(*)::int n from search_idx where param='patient' and val = any($1::text[]) group by val`, [ids.map((i) => `Patient/${i}`)],
  )).rows.map((r: any) => [r.val.slice(8), r.n]));
  const data = new Map(rows.map((r: any) => [r.id, r.data]));
  const card = (id: string) => ({ ...data.get(id), records: counts.get(id) ?? 0 });
  return shown.map((d) => ({ ...d, a: card(d.a), b: card(d.b) }));
}

export async function dismiss(db: Db, x: string, y: string, userId: string) {
  const [a, b] = [x, y].sort();
  await db.query('insert into not_duplicate(a,b,user_id) values ($1,$2,$3) on conflict do nothing', [a, b, userId]);
}

const orNone = <T>(a: T[]) => (a.length ? a : undefined);
const swap = (data: any, from: string, to: string) => JSON.parse(JSON.stringify(data).split(`"Patient/${from}"`).join(`"Patient/${to}"`));

/**
 * Merge `mergeId` into `keepId`. Every resource that points at the merged record is re-pointed (a new
 * version, so history keeps the original), the merged record is retired with a `replaced-by` link,
 * and everything moved is logged so the merge can be undone.
 */
export async function merge(db: Db, keepId: string, mergeId: string, reason: string, userId: string) {
  if (keepId === mergeId) throw new FhirError(422, 'Choose two different records');
  return db.tx(async (t) => {
    await t.query('select pg_advisory_xact_lock(7002)');
    const keep = await read(t, 'Patient', keepId);
    const gone = await read(t, 'Patient', mergeId);
    if (merged(keep) || merged(gone)) throw new FhirError(409, 'One of these records has already been merged');
    if (restricted(keep) || restricted(gone)) throw new FhirError(409, 'Restricted records cannot be merged here. Ask your records governance lead.');
    const refs = (await t.query(
      `select type, id, data from resources where not deleted and type <> 'Patient' and data::text like $1`, [`%"Patient/${mergeId}"%`])).rows;
    for (const r of refs) await update(t, r.type, r.id, swap(r.data, mergeId, keepId));
    const tasks = (await t.query('update tasks set patient_id=$1 where patient_id=$2 returning id', [keepId, mergeId])).rows.map((r: any) => r.id);
    const have = new Set((keep.identifier ?? []).map((i: any) => `${i.system}|${i.value}`));
    const added = (gone.identifier ?? []).filter((i: any) => !have.has(`${i.system}|${i.value}`)).map((i: any) => ({ ...i, use: 'old' }));
    await update(t, 'Patient', keepId, { ...keep, identifier: [...(keep.identifier ?? []), ...added], link: [...(keep.link ?? []), { other: { reference: `Patient/${mergeId}` }, type: 'replaces' }] });
    await update(t, 'Patient', mergeId, { ...gone, active: false, link: [...(gone.link ?? []), { other: { reference: `Patient/${keepId}` }, type: 'replaced-by' }] });
    const id = randomUUID();
    await t.query('insert into merge_log(id,keep_id,merged_id,moved,tasks,added_ids,reason,user_id) values ($1,$2,$3,$4,$5,$6,$7,$8)',
      [id, keepId, mergeId, JSON.stringify(refs.map((r: any) => `${r.type}/${r.id}`)), JSON.stringify(tasks), JSON.stringify(added), reason, userId]);
    return { id, moved: refs.length, tasks: tasks.length };
  });
}

/** Put every moved resource back. Records added to the kept patient since the merge stay where they are. */
export async function unmerge(db: Db, logId: string, userId: string) {
  return db.tx(async (t) => {
    await t.query('select pg_advisory_xact_lock(7002)');
    const m = (await t.query('select * from merge_log where id=$1 for update', [logId])).rows[0];
    if (!m) throw new FhirError(404, 'Merge not found');
    if (m.undone_at) throw new FhirError(409, 'This merge was already undone');
    for (const ref of m.moved as string[]) {
      const [type, id] = ref.split('/');
      const cur = (await t.query('select data from resources where type=$1 and id=$2 and not deleted', [type, id])).rows[0];
      if (cur) await update(t, type, id, swap(cur.data, m.keep_id, m.merged_id));
    }
    await t.query('update tasks set patient_id=$1 where id = any($2::text[])', [m.merged_id, m.tasks]);
    const keep = await read(t, 'Patient', m.keep_id);
    const added = new Set((m.added_ids as any[]).map((i) => `${i.system}|${i.value}`));
    await update(t, 'Patient', m.keep_id, {
      ...keep, identifier: orNone((keep.identifier ?? []).filter((i: any) => !(i.use === 'old' && added.has(`${i.system}|${i.value}`)))),
      link: orNone((keep.link ?? []).filter((l: any) => l.other?.reference !== `Patient/${m.merged_id}`)),
    });
    const gone = await read(t, 'Patient', m.merged_id);
    await update(t, 'Patient', m.merged_id, { ...gone, active: true, link: orNone((gone.link ?? []).filter((l: any) => l.other?.reference !== `Patient/${m.keep_id}`)) });
    await t.query('update merge_log set undone_at=now(), undone_by=$2 where id=$1', [logId, userId]);
    return { keepId: m.keep_id, mergedId: m.merged_id };
  });
}
