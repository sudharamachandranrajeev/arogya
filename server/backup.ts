import { gunzipSync, gzipSync } from 'node:zlib';
import type { Db } from './db.ts';
import { reindex } from './fhir/store.ts';
import { decryptWithPassphrase, encryptWithPassphrase } from './secrets.ts';

/** Tables in restore order. search_idx is rebuilt; sessions are never backed up. */
const TABLES = ['users', 'settings', 'clinic_sessions', 'resources', 'resource_history', 'tasks', 'audit', 'override_log', 'alert_log', 'alert_tuning', 'merge_log', 'not_duplicate', 'outbox'];
const SERIALS: Record<string, string> = { audit: 'seq', override_log: 'id', alert_log: 'id' };
export const MIN_PASSPHRASE = 12;

export async function backup(db: Db, passphrase: string) {
  if (passphrase.length < MIN_PASSPHRASE) throw new Error(`Backup passphrase must be at least ${MIN_PASSPHRASE} characters`);
  const tables: Record<string, unknown[]> = {};
  for (const t of TABLES) tables[t] = (await db.query(`select * from ${t}`)).rows;
  const body = gzipSync(JSON.stringify({ format: 'arogya-backup', version: 1, at: new Date().toISOString(), tables }));
  return encryptWithPassphrase(body, passphrase);
}

/** Restore into an empty database only, so a backup can never silently overwrite live records. */
export async function restore(db: Db, file: Buffer, passphrase: string) {
  const data = JSON.parse(gunzipSync(decryptWithPassphrase(file, passphrase)).toString('utf8'));
  if (data.format !== 'arogya-backup') throw new Error('Not an Arogya backup');
  if ((await db.query('select 1 from users limit 1')).rows.length) throw new Error('Restore needs an empty database');
  await db.tx(async (t) => {
    for (const name of TABLES) {
      for (const row of data.tables[name] ?? []) {
        const cols = Object.keys(row);
        const vals = cols.map((c) => (row[c] !== null && typeof row[c] === 'object' && !(row[c] instanceof Date) ? JSON.stringify(row[c]) : row[c]));
        await t.query(`insert into ${name}(${cols.join(',')}) values (${cols.map((_, i) => `$${i + 1}`).join(',')})`, vals);
      }
      if (SERIALS[name]) await t.query(`select setval(pg_get_serial_sequence('${name}', '${SERIALS[name]}'), coalesce((select max(${SERIALS[name]}) from ${name}), 0) + 1, false)`);
    }
    for (const r of (await t.query('select type, id, data from resources where not deleted')).rows) await reindex(t, r.type, r.id, r.data);
  });
  return Object.fromEntries(TABLES.map((n) => [n, (data.tables[n] ?? []).length]));
}
