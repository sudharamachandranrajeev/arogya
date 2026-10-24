/** Search index: values are extracted at write time so queries stay simple, portable SQL. */

type Kind = 'string' | 'token' | 'reference' | 'date';
type Param = { kind: Kind; paths: string[] };

const CLIN_DATES = ['effectiveDateTime', 'effectivePeriod.start', 'period.start', 'start', 'authoredOn', 'occurrenceDateTime', 'recordedDate', 'onsetDateTime', 'issued', 'created', 'date', 'sent'];

export const PARAMS: Record<string, Param> = {
  name: { kind: 'string', paths: ['name.family', 'name.given', 'name.text'] },
  family: { kind: 'string', paths: ['name.family'] },
  given: { kind: 'string', paths: ['name.given'] },
  address: { kind: 'string', paths: ['address.line', 'address.city', 'address.postalCode'] },
  identifier: { kind: 'token', paths: ['identifier'] },
  gender: { kind: 'token', paths: ['gender'] },
  phone: { kind: 'token', paths: ['telecom'] },
  email: { kind: 'token', paths: ['telecom'] },
  birthdate: { kind: 'date', paths: ['birthDate'] },
  patient: { kind: 'reference', paths: ['subject', 'patient', 'beneficiary', 'participant.actor'] },
  subject: { kind: 'reference', paths: ['subject'] },
  encounter: { kind: 'reference', paths: ['encounter'] },
  practitioner: { kind: 'reference', paths: ['participant.actor', 'performer', 'requester', 'recorder', 'author'] },
  'based-on': { kind: 'reference', paths: ['basedOn'] },
  status: { kind: 'token', paths: ['status', 'clinicalStatus', 'verificationStatus'] },
  code: { kind: 'token', paths: ['code', 'vaccineCode', 'medicationCodeableConcept'] },
  category: { kind: 'token', paths: ['category'] },
  priority: { kind: 'token', paths: ['priority'] },
  'service-type': { kind: 'token', paths: ['serviceType', 'specialty'] },
  date: { kind: 'date', paths: CLIN_DATES },
};

export const COMMON = new Set(['_id', '_lastUpdated', '_count', '_offset', '_sort', '_summary', '_total']);

/** Flatten a dotted path through arrays and objects. */
function walk(o: any, path: string[]): any[] {
  let cur = [o];
  for (const p of path) {
    const next: any[] = [];
    for (const c of cur) {
      const v = c?.[p];
      if (Array.isArray(v)) next.push(...v);
      else if (v !== undefined && v !== null) next.push(v);
    }
    cur = next;
  }
  return cur;
}

export type Row = { param: string; sys: string | null; val: string };

function tokens(v: any): Array<[string | null, string]> {
  if (v === null || v === undefined) return [];
  if (typeof v === 'string' || typeof v === 'boolean' || typeof v === 'number') return [[null, String(v)]];
  if (Array.isArray(v)) return v.flatMap(tokens);
  if (v.coding) return tokens(v.coding);
  if (v.text && v.code === undefined && v.value === undefined) return [[null, String(v.text)]];
  if (v.code !== undefined) return [[v.system ?? null, String(v.code)]];
  if (v.value !== undefined) return [[v.system ?? null, String(v.value)]];
  return [];
}

function strings(v: any): string[] {
  if (v === null || v === undefined) return [];
  if (typeof v === 'string') return [v];
  if (Array.isArray(v)) return v.flatMap(strings);
  return [];
}

export function extract(res: any): Row[] {
  const out: Row[] = [];
  for (const [param, spec] of Object.entries(PARAMS)) {
    if (param === 'phone' || param === 'email') {
      const sys = param;
      for (const t of walk(res, ['telecom'])) if (t.system === sys && t.value) out.push({ param, sys: null, val: String(t.value) });
      continue;
    }
    for (const p of spec.paths) {
      for (const v of walk(res, p.split('.'))) {
        if (spec.kind === 'string') for (const s of strings(v)) out.push({ param, sys: null, val: s.toLowerCase() });
        else if (spec.kind === 'token') for (const [sys, c] of tokens(v)) out.push({ param, sys, val: c });
        else if (spec.kind === 'reference') {
          const r = typeof v === 'string' ? v : v.reference;
          if (typeof r === 'string') out.push({ param, sys: null, val: r.replace(/^.*\/(\w+\/[^/]+)$/, '$1') });
        } else if (spec.kind === 'date') {
          const d = typeof v === 'string' ? v : v.start;
          if (typeof d === 'string') out.push({ param, sys: null, val: d });
        }
      }
    }
  }
  return out;
}

export type Where = { sql: string; params: unknown[] };

export class SearchError extends Error {}

const PREFIX: Record<string, string> = { eq: '=', ne: '<>', gt: '>', lt: '<', ge: '>=', le: '<=', sa: '>', eb: '<' };

/** Build `id in (...)` clauses for one request. Throws SearchError on unknown parameters. */
export function buildWhere(type: string, query: Record<string, string | string[]>): { clauses: Where[]; count: number; offset: number; sort: string } {
  const clauses: Where[] = [];
  let count = 50, offset = 0, sort = '';
  for (const [rawKey, rawVal] of Object.entries(query)) {
    const vals = Array.isArray(rawVal) ? rawVal : [rawVal];
    const [key, modifier] = rawKey.split(':');
    if (key === '_count') { count = Math.min(Math.max(parseInt(vals[0]) || 50, 0), 200); continue; }
    if (key === '_offset') { offset = Math.max(parseInt(vals[0]) || 0, 0); continue; }
    if (key === '_sort') { sort = vals[0]; continue; }
    if (key === '_summary' || key === '_total') continue;
    if (key === '_id') { clauses.push({ sql: 'r.id = any($#::text[])', params: [vals.flatMap((v) => v.split(','))] }); continue; }
    if (key === '_lastUpdated') {
      for (const v of vals) {
        const m = /^(eq|ne|gt|lt|ge|le)?(.+)$/.exec(v)!;
        clauses.push({ sql: `r.last_updated ${PREFIX[m[1] ?? 'eq']} $#::timestamptz`, params: [m[2]] });
      }
      continue;
    }
    const spec = PARAMS[key];
    if (!spec) throw new SearchError(`Unknown search parameter "${key}"`);
    for (const joined of vals) {
      const ors: string[] = [];
      const params: unknown[] = [];
      for (const v of joined.split(',')) {
        const base = `s.type = r.type and s.id = r.id and s.param = $#`;
        if (spec.kind === 'string') {
          const t = v.toLowerCase();
          ors.push(`(${base} and s.val ${modifier === 'exact' ? '=' : modifier === 'contains' ? 'like' : 'like'} $#)`);
          params.push(key, modifier === 'exact' ? t : modifier === 'contains' ? `%${esc(t)}%` : `${esc(t)}%`);
        } else if (spec.kind === 'token') {
          const bar = v.indexOf('|');
          if (bar >= 0) {
            const sys = v.slice(0, bar), code = v.slice(bar + 1);
            ors.push(`(${base} and s.sys ${sys ? '= $#' : 'is null'}${code ? ' and s.val = $#' : ''})`);
            params.push(key); if (sys) params.push(sys); if (code) params.push(code);
          } else { ors.push(`(${base} and s.val = $#)`); params.push(key, v); }
        } else if (spec.kind === 'reference') {
          const typed = key === 'patient' ? 'Patient' : key === 'practitioner' ? 'Practitioner' : null;
          if (typed) { ors.push(`(${base} and s.val = $#)`); params.push(key, `${typed}/${v.replace(/^\w+\//, '')}`); }
          else { ors.push(`(${base} and (s.val = $# or s.val like $#))`); params.push(key, v, `%/${esc(v)}`); }
        } else {
          const m = /^(eq|ne|gt|lt|ge|le|sa|eb)?(.+)$/.exec(v)!;
          const op = PREFIX[m[1] ?? 'eq'];
          // Day-granularity equality: '2026-10-24' matches any time on that day.
          if (!m[1] || m[1] === 'eq') { ors.push(`(${base} and s.val like $#)`); params.push(key, `${esc(m[2])}%`); }
          else { ors.push(`(${base} and s.val ${op} $#)`); params.push(key, m[2]); }
        }
      }
      clauses.push({ sql: `exists (select 1 from search_idx s where ${ors.join(' or ')})`, params });
    }
  }
  void type;
  return { clauses, count, offset, sort };
}

function esc(s: string) { return s.replace(/[\\%_]/g, '\\$&'); }

/** Replace each `$#` with the next positional parameter. */
export function number(sql: string, start: number): string {
  let n = start;
  return sql.replace(/\$#/g, () => `$${n++}`);
}
export { strings as _strings };
