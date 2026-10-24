import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';

export interface Db {
  query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /** Run several statements without parameters (migrations). */
  exec(sql: string): Promise<void>;
  tx<T>(fn: (q: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Postgres when DATABASE_URL is set; otherwise embedded PGlite (a real Postgres in WASM) so a clinic can start with zero setup. */
export async function openDb(url = process.env.DATABASE_URL, dataDir = process.env.AROGYA_DATA ?? '.data/pg'): Promise<Db> {
  const db = url ? pool(url) : await lite(url === undefined ? dataDir : undefined);
  await migrate(db);
  return db;
}

export async function openMemoryDb(): Promise<Db> {
  const db = await lite(undefined);
  await migrate(db);
  return db;
}

function pool(url: string): Db {
  const p = new pg.Pool({ connectionString: url, max: 10 });
  const wrap = (c: pg.Pool | pg.PoolClient): Db => ({
    query: (sql, params) => c.query(sql, params as any[]) as any,
    exec: async (sql) => { await c.query(sql); },
    tx: () => Promise.reject(new Error('nested transaction')),
    close: async () => {},
  });
  return {
    ...wrap(p),
    async tx(fn) {
      const c = await p.connect();
      try {
        await c.query('begin');
        const r = await fn(wrap(c));
        await c.query('commit');
        return r;
      } catch (e) {
        await c.query('rollback');
        throw e;
      } finally {
        c.release();
      }
    },
    close: () => p.end(),
  };
}

async function lite(dir?: string): Promise<Db> {
  const l = dir ? new PGlite(dir) : new PGlite();
  await l.waitReady;
  const wrap = (c: { query: PGlite['query']; exec: PGlite['exec'] }): Db => ({
    query: (sql, params) => c.query(sql, params as any[]) as any,
    exec: async (sql) => { await c.exec(sql); },
    tx: () => Promise.reject(new Error('nested transaction')),
    close: async () => {},
  });
  return {
    ...wrap(l),
    tx: (fn) => l.transaction((t) => fn(wrap(t as any))),
    close: () => l.close(),
  };
}

const MIGRATIONS: string[] = [
  `
create table users(
  id text primary key, username text unique not null, name text not null, role text not null,
  pwd text not null, practitioner_id text, active boolean not null default true,
  must_change boolean not null default false, created_at timestamptz not null default now());
create table sessions(
  token_hash text primary key, user_id text not null references users(id) on delete cascade,
  expires_at timestamptz not null, created_at timestamptz not null default now());
create table resources(
  type text not null, id text not null, version int not null, data jsonb not null,
  deleted boolean not null default false, last_updated timestamptz not null, primary key(type, id));
create table resource_history(
  type text not null, id text not null, version int not null, data jsonb not null,
  deleted boolean not null, last_updated timestamptz not null, op text not null, primary key(type, id, version));
create table search_idx(type text not null, id text not null, param text not null, sys text, val text not null);
create index search_idx_q on search_idx(type, param, val);
create index search_idx_id on search_idx(type, id);
create table audit(
  seq bigserial primary key, at timestamptz not null default now(), user_id text, username text,
  action text not null, resource_type text, resource_id text, patient_id text, detail text, reason text,
  prev_hash text not null, hash text not null);
create index audit_patient on audit(patient_id);
create table tasks(
  id text primary key, kind text not null, patient_id text, subject text not null, ref_type text, ref_id text,
  pool text not null, assignee text, status text not null default 'open', priority text not null default 'routine',
  normal boolean not null default false, created_at timestamptz not null default now(), done_at timestamptz,
  done_by text, note text);
create index tasks_open on tasks(status, pool);
create table clinic_sessions(
  id text primary key, practitioner_id text not null, location text not null default 'Main clinic',
  service text not null, weekday int not null, start_time text not null, end_time text not null,
  slot_mins int not null default 20, active boolean not null default true);
create table settings(key text primary key, value jsonb not null);
create table override_log(
  id bigserial primary key, at timestamptz not null default now(), user_id text, patient_id text,
  medication text, alerts jsonb not null, reason text not null);
`,
];

async function migrate(db: Db) {
  await db.query('create table if not exists schema_version(v int not null)');
  const cur = (await db.query<{ v: number }>('select coalesce(max(v), 0) as v from schema_version')).rows[0].v;
  for (let i = cur; i < MIGRATIONS.length; i++) {
    await db.tx(async (t) => {
      await t.exec(MIGRATIONS[i]);
      await t.query('insert into schema_version(v) values ($1)', [i + 1]);
    });
  }
}
