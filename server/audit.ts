import { createHash } from 'node:crypto';
import type { Db } from './db.ts';

export type AuditEntry = {
  userId?: string | null; username?: string | null; action: string; resourceType?: string; resourceId?: string;
  patientId?: string | null; detail?: unknown; reason?: string;
};

const canon = (r: { at: string; user_id: any; username: any; action: string; resource_type: any; resource_id: any; patient_id: any; detail: any; reason: any }) =>
  JSON.stringify([r.at, r.user_id, r.username, r.action, r.resource_type, r.resource_id, r.patient_id, r.detail, r.reason]);
const digest = (prev: string, c: string) => createHash('sha256').update(prev + c).digest('hex');

/** Append-only, hash-chained audit trail: editing or deleting a row breaks every later hash. */
export async function audit(db: Db, e: AuditEntry) {
  await db.tx(async (t) => {
    await t.query('select pg_advisory_xact_lock(7001)');
    const prev = (await t.query<{ hash: string }>('select hash from audit order by seq desc limit 1')).rows[0]?.hash ?? '';
    const row = {
      at: new Date().toISOString(), user_id: e.userId ?? null, username: e.username ?? null, action: e.action,
      resource_type: e.resourceType ?? null, resource_id: e.resourceId ?? null, patient_id: e.patientId ?? null,
      detail: e.detail === undefined ? null : JSON.stringify(e.detail), reason: e.reason ?? null,
    };
    await t.query(
      `insert into audit(at,user_id,username,action,resource_type,resource_id,patient_id,detail,reason,prev_hash,hash)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [row.at, row.user_id, row.username, row.action, row.resource_type, row.resource_id, row.patient_id, row.detail, row.reason, prev, digest(prev, canon(row))],
    );
  });
}

export async function verifyChain(db: Db): Promise<{ ok: boolean; checked: number; brokenAt?: number }> {
  const rows = (await db.query('select * from audit order by seq')).rows;
  let prev = '';
  for (const r of rows) {
    const want = digest(prev, canon({ ...r, at: new Date(r.at).toISOString() }));
    if (r.prev_hash !== prev || r.hash !== want) return { ok: false, checked: rows.length, brokenAt: Number(r.seq) };
    prev = r.hash;
  }
  return { ok: true, checked: rows.length };
}
