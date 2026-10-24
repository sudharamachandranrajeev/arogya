import type { Db } from './db.ts';
import { schemaVersion } from './db.ts';
import { verifyChain } from './audit.ts';
import { getSetting, setSetting } from './domain.ts';
import { reindex, TYPES } from './fhir/store.ts';
import { extract } from './fhir/search.ts';
import { seal, unseal } from './secrets.ts';

/**
 * System integrity check. Each check looks for one way the stored data can stop being trustworthy:
 * a tampered audit trail, a search index that hides records, history that does not match the record,
 * references to records that do not exist, work left pointing at nothing, or a double-booked clinician.
 * Results name record ids, never clinical content, so administrators can run it.
 */
export type Status = 'ok' | 'warn' | 'fail';
export type Check = { key: string; name: string; status: Status; summary: string; items?: string[] };
/** The audit head at the time of the check. Keep a copy outside the database to detect rows cut from the end. */
export type Anchor = { seq: number; hash: string };
export type Report = { at: string; ok: boolean; status: Status; ms: number; anchor: Anchor | null; checks: Check[] };

const SAMPLE = 20;
const BATCH = 500;
const BACKUP_DAYS = 7;

const check = (key: string, name: string, bad: string[], fail: boolean, okText: string, badText: (n: number) => string): Check =>
  bad.length ? { key, name, status: fail ? 'fail' : 'warn', summary: badText(bad.length), items: bad.slice(0, SAMPLE) } : { key, name, status: 'ok', summary: okText };

const rowKey = (r: { param: string; sys: string | null; val: string }) => `${r.param}\u0000${r.sys ?? ''}\u0000${r.val}`;

/** Every `reference` string inside a resource. */
function references(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) for (const n of node) references(n, out);
  else if (node && typeof node === 'object')
    for (const [k, v] of Object.entries(node)) {
      if (k === 'reference' && typeof v === 'string') out.push(v);
      else if (typeof v === 'object') references(v, out);
    }
  return out;
}

/** Walk every live resource once, in batches, checking its index and its references. */
async function scan(db: Db) {
  const state = new Map<string, { deleted: boolean; merged: boolean }>();
  for (const r of (await db.query(`select type, id, deleted, coalesce(data->'link' @> '[{"type":"replaced-by"}]', false) as merged from resources`)).rows)
    state.set(`${r.type}/${r.id}`, { deleted: r.deleted, merged: r.merged });
  const staleIndex: string[] = [], dangling: string[] = [], toDeleted: string[] = [], toMerged: string[] = [];
  let after = ['', ''], scanned = 0;
  for (;;) {
    const rows = (await db.query(
      `select type, id, data from resources where not deleted and (type, id) > ($1, $2) order by type, id limit ${BATCH}`, after)).rows;
    if (!rows.length) break;
    const idx = new Map<string, string[]>();
    for (const s of (await db.query(
      `select type, id, param, sys, val from search_idx where (type, id) in (select type, id from resources where not deleted and (type, id) > ($1, $2) order by type, id limit ${BATCH})`, after)).rows) {
      const k = `${s.type}/${s.id}`;
      idx.set(k, [...(idx.get(k) ?? []), rowKey(s)]);
    }
    for (const r of rows) {
      const me = `${r.type}/${r.id}`;
      const want = extract(r.data).map(rowKey).sort().join('\n');
      if (want !== (idx.get(me) ?? []).sort().join('\n')) staleIndex.push(me);
      for (const ref of references(r.data)) {
        const [t, id, extra] = ref.split('/');
        if (!TYPES.has(t) || !id || extra !== undefined) continue; // contained (#x), absolute URLs, urn: and versioned refs are out of scope
        const target = state.get(`${t}/${id}`);
        if (!target) dangling.push(`${me} → ${ref}`);
        else if (target.deleted) toDeleted.push(`${me} → ${ref}`);
        // A merged record keeps its own link to the survivor; anything else still pointing at it was missed by the merge.
        else if (target.merged && !(r.type === 'Patient' && r.data.link?.some((l: any) => l.other?.reference === ref))) toMerged.push(`${me} → ${ref}`);
      }
    }
    scanned += rows.length;
    after = [rows.at(-1).type, rows.at(-1).id];
  }
  const orphanIndex = (await db.query(
    `select distinct s.type, s.id from search_idx s where not exists (select 1 from resources r where r.type=s.type and r.id=s.id and not r.deleted) limit 100`)).rows.map((r) => `${r.type}/${r.id}`);
  return { scanned, staleIndex: [...staleIndex, ...orphanIndex], dangling, toDeleted, toMerged };
}

async function history(db: Db) {
  const rows = (await db.query(
    `select r.type, r.id, r.version,
       (select count(*)::int from resource_history h where h.type=r.type and h.id=r.id) as n,
       exists (select 1 from resource_history h where h.type=r.type and h.id=r.id and h.version=r.version and h.deleted=r.deleted
               and (r.deleted or h.data = r.data)) as current
     from resources r`)).rows;
  return rows.filter((r) => !r.current || r.n !== r.version).map((r) => `${r.type}/${r.id} v${r.version}${r.current ? ` (${r.n} history rows)` : ' (no matching history row)'}`);
}

async function tasks(db: Db) {
  return (await db.query(
    `select t.id, t.kind, t.ref_type, t.ref_id, t.patient_id from tasks t where t.status='open' and (
       (t.patient_id is not null and not exists (select 1 from resources p where p.type='Patient' and p.id=t.patient_id and not p.deleted))
       or (t.ref_type is not null and t.ref_type <> 'Task' and not exists (select 1 from resources x where x.type=t.ref_type and x.id=t.ref_id and not x.deleted)))
     limit 100`)).rows.map((t) => `${t.kind} task ${t.id} → ${t.ref_type}/${t.ref_id}`);
}

/** Two live appointments for one clinician that overlap, from yesterday on. */
async function doubleBookings(db: Db) {
  const rows = (await db.query(
    `select id, data->>'start' as start, data->>'end' as "end", data->'participant' as who from resources
     where type='Appointment' and not deleted and data->>'status' in ('booked','pending','arrived')
       and (data->>'start')::timestamptz > now() - interval '1 day'`)).rows;
  const by = new Map<string, typeof rows>();
  for (const a of rows)
    for (const p of a.who ?? []) {
      const ref = p.actor?.reference;
      if (typeof ref === 'string' && ref.startsWith('Practitioner/')) by.set(ref, [...(by.get(ref) ?? []), a]);
    }
  const out: string[] = [];
  for (const [ref, list] of by) {
    list.sort((x, y) => Date.parse(x.start) - Date.parse(y.start));
    for (let i = 1; i < list.length; i++)
      if (Date.parse(list[i].start) < Date.parse(list[i - 1].end)) out.push(`${ref}: Appointment/${list[i - 1].id} and Appointment/${list[i].id}`);
  }
  return out;
}

export async function runIntegrity(db: Db): Promise<Report> {
  const t0 = Date.now();
  const checks: Check[] = [];

  const chain = await verifyChain(db);
  checks.push(chain.ok ? { key: 'audit', name: 'Audit trail', status: 'ok', summary: `Hash chain intact across ${chain.checked} entries` }
    : { key: 'audit', name: 'Audit trail', status: 'fail', summary: `Hash chain broken at entry #${chain.brokenAt}: the trail was edited or rows were removed`, items: [`#${chain.brokenAt}`] });
  // A chain cannot show rows cut from its end, so compare with the head seen by the previous check.
  const prev = (await lastIntegrity(db))?.anchor;
  if (prev) {
    const row = (await db.query('select hash from audit where seq=$1', [prev.seq])).rows[0];
    checks.push(row?.hash === prev.hash ? { key: 'audit-head', name: 'Audit trail end', status: 'ok', summary: `Still contains entry #${prev.seq} from the last check` }
      : { key: 'audit-head', name: 'Audit trail end', status: 'fail', summary: `Entry #${prev.seq}, present at the last check, is ${row ? 'changed' : 'gone'}: audit rows were removed`, items: [`#${prev.seq}`] });
  }

  const v = (await db.query<{ v: number }>('select coalesce(max(v),0)::int as v from schema_version')).rows[0].v;
  checks.push(v === schemaVersion() ? { key: 'schema', name: 'Database schema', status: 'ok', summary: `Version ${v}, as this build expects` }
    : { key: 'schema', name: 'Database schema', status: 'fail', summary: `Database is at version ${v}; this build expects ${schemaVersion()}` });

  let keyOk = false;
  try { keyOk = unseal(seal('integrity')) === 'integrity'; } catch { /* reported below */ }
  const sealed = (await db.query(`select count(*)::int n from users where totp_secret is not null`)).rows[0].n;
  let unreadable = 0;
  for (const r of (await db.query('select totp_secret from users where totp_secret is not null')).rows) try { unseal(r.totp_secret); } catch { unreadable++; }
  checks.push(!keyOk ? { key: 'key', name: 'Application key', status: 'fail', summary: 'The application key cannot seal and open secrets' }
    : unreadable ? { key: 'key', name: 'Application key', status: 'fail', summary: `${unreadable} of ${sealed} two-step secrets cannot be opened with this key: was the key file replaced?` }
    : { key: 'key', name: 'Application key', status: 'ok', summary: `Opens all ${sealed} sealed two-step secrets` });

  const s = await scan(db);
  checks.push(check('index', 'Search index', s.staleIndex, true, `Matches all ${s.scanned} records`,
    (n) => `${n} records are indexed wrongly, so searches can miss them. Rebuild the index to fix.`));
  const h = await history(db);
  checks.push(check('history', 'Version history', h, true, 'Every record matches its latest history entry', (n) => `${n} records do not match their history`));
  checks.push(check('refs', 'References', s.dangling, true, 'Every reference points at a record that exists', (n) => `${n} references point at records that do not exist`));
  checks.push(check('refs-deleted', 'References to deleted records', s.toDeleted, false, 'No live record points at a deleted one', (n) => `${n} references point at deleted records`));
  checks.push(check('refs-merged', 'References to merged records', s.toMerged, false, 'Nothing still points at a merged-away patient', (n) => `${n} references still point at a merged-away patient`));
  checks.push(check('tasks', 'Open work', await tasks(db), false, 'Every open task points at a live record', (n) => `${n} open tasks point at records that are gone`));
  checks.push(check('booking', 'Double bookings', await doubleBookings(db), true, 'No clinician is booked twice at once', (n) => `${n} overlapping appointments for the same clinician`));

  const failed = (await db.query(`select count(*)::int n from outbox where status='failed' and created_at > now() - interval '7 days'`)).rows[0].n;
  checks.push(failed ? { key: 'outbox', name: 'Reminder delivery', status: 'warn', summary: `${failed} reminders failed to send in the last 7 days: check the gateway` }
    : { key: 'outbox', name: 'Reminder delivery', status: 'ok', summary: 'No failed reminders in the last 7 days' });

  const last = (await db.query(`select max(at) as at from audit where action='backup'`)).rows[0]?.at;
  const days = last ? (Date.now() - Date.parse(last)) / 86400_000 : Infinity;
  checks.push(days <= BACKUP_DAYS ? { key: 'backup', name: 'Backups', status: 'ok', summary: `Last backup ${Math.floor(days)} days ago` }
    : { key: 'backup', name: 'Backups', status: 'warn', summary: last ? `Last backup was ${Math.floor(days)} days ago` : 'No backup has been taken from the app. If you back up the database another way, check that it restores.' });

  const status: Status = checks.some((c) => c.status === 'fail') ? 'fail' : checks.some((c) => c.status === 'warn') ? 'warn' : 'ok';
  const head = (await db.query('select seq, hash from audit order by seq desc limit 1')).rows[0];
  const report = { at: new Date().toISOString(), ok: status !== 'fail', status, ms: Date.now() - t0, anchor: head ? { seq: Number(head.seq), hash: head.hash } : prev ?? null, checks };
  await setSetting(db, 'integrity:last', report);
  return report;
}

export const lastIntegrity = (db: Db) => getSetting<Report | null>(db, 'integrity:last', null);

/** Rebuild the search index from the stored records. The index is derived data, so this is always safe. */
export async function rebuildIndex(db: Db) {
  let after = ['', ''], n = 0;
  for (;;) {
    const rows = (await db.query(`select type, id, data from resources where not deleted and (type, id) > ($1, $2) order by type, id limit ${BATCH}`, after)).rows;
    if (!rows.length) break;
    await db.tx(async (t) => { for (const r of rows) await reindex(t, r.type, r.id, r.data); });
    n += rows.length;
    after = [rows.at(-1).type, rows.at(-1).id];
  }
  await db.query('delete from search_idx s where not exists (select 1 from resources r where r.type=s.type and r.id=s.id and not r.deleted)');
  return { reindexed: n };
}
