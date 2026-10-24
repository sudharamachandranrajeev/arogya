import { randomUUID } from 'node:crypto';
import type { Db } from '../db.ts';
import { buildWhere, extract, number } from './search.ts';

export const TYPES = new Set([
  'Patient', 'Practitioner', 'Organization', 'Location', 'Encounter', 'Observation', 'Condition',
  'AllergyIntolerance', 'MedicationRequest', 'MedicationStatement', 'Immunization', 'Procedure',
  'DiagnosticReport', 'ServiceRequest', 'Appointment', 'Composition', 'DocumentReference', 'CarePlan',
  'ChargeItem', 'Communication', 'Task', 'Coverage', 'Consent', 'Flag', 'QuestionnaireResponse', 'FamilyMemberHistory',
]);

export class FhirError extends Error {
  status: number;
  alerts?: unknown;
  constructor(status: number, message: string, alerts?: unknown) {
    super(message);
    this.status = status;
    this.alerts = alerts;
  }
}

/** Minimal structural validation: enough to refuse data that downstream rules rely on. */
const REQUIRED: Record<string, (r: any) => string | null> = {
  Patient: (r) => (r.name?.length || r.identifier?.length ? null : 'Patient needs a name or identifier'),
  Observation: (r) => (!r.status ? 'Observation.status required' : !r.code ? 'Observation.code required' : !r.subject ? 'Observation.subject required' : null),
  Condition: (r) => (!r.code ? 'Condition.code required' : !r.subject ? 'Condition.subject required' : null),
  AllergyIntolerance: (r) => (!r.code ? 'AllergyIntolerance.code required' : !r.patient ? 'AllergyIntolerance.patient required' : null),
  MedicationRequest: (r) => (!r.status || !r.intent ? 'MedicationRequest.status and intent required' : !(r.medicationCodeableConcept) ? 'MedicationRequest.medicationCodeableConcept required' : !r.subject ? 'MedicationRequest.subject required' : null),
  Appointment: (r) => (!r.status ? 'Appointment.status required' : !r.start || !r.end ? 'Appointment start and end required' : null),
  ServiceRequest: (r) => (!r.status || !r.intent ? 'ServiceRequest.status and intent required' : !r.subject ? 'ServiceRequest.subject required' : null),
  Encounter: (r) => (!r.status ? 'Encounter.status required' : !r.subject ? 'Encounter.subject required' : null),
  Composition: (r) => (!r.status || !r.title ? 'Composition.status and title required' : !r.subject ? 'Composition.subject required' : null),
};

export function validate(res: any, type: string) {
  if (!res || typeof res !== 'object' || res.resourceType !== type) throw new FhirError(400, `resourceType must be ${type}`);
  const msg = REQUIRED[type]?.(res);
  if (msg) throw new FhirError(422, msg);
}

/** The Patient a resource belongs to, for audit and break-glass. */
export function patientOf(res: any): string | null {
  if (res.resourceType === 'Patient') return res.id ?? null;
  const ref = res.subject?.reference ?? res.patient?.reference ?? res.beneficiary?.reference;
  return typeof ref === 'string' && ref.startsWith('Patient/') ? ref.slice(8) : null;
}

const etag = (v: number) => `W/"${v}"`;
export const parseEtag = (h?: string) => (h ? parseInt(h.replace(/\D/g, '')) : undefined);

export async function reindex(q: Db, type: string, id: string, res: any) {
  await q.query('delete from search_idx where type=$1 and id=$2', [type, id]);
  const rows = extract(res);
  if (rows.length) {
    const vals: unknown[] = [type, id];
    const tuples = rows.map((r, i) => {
      vals.push(r.param, r.sys, r.val);
      return `($1,$2,$${i * 3 + 3},$${i * 3 + 4},$${i * 3 + 5})`;
    });
    await q.query(`insert into search_idx(type,id,param,sys,val) values ${tuples.join(',')}`, vals);
  }
}

function stamp(res: any, id: string, version: number, at: string) {
  res.id = id;
  res.meta = { ...res.meta, versionId: String(version), lastUpdated: at };
  return res;
}

export async function create(q: Db, type: string, body: any, id: string = randomUUID()) {
  validate(body, type);
  const at = new Date().toISOString();
  const res = stamp({ ...body }, id, 1, at);
  await q.query('insert into resources(type,id,version,data,last_updated) values ($1,$2,1,$3,$4)', [type, id, res, at]);
  await q.query("insert into resource_history(type,id,version,data,deleted,last_updated,op) values ($1,$2,1,$3,false,$4,'create')", [type, id, res, at]);
  await reindex(q, type, id, res);
  return res;
}

export async function read(q: Db, type: string, id: string) {
  const r = (await q.query('select data, deleted from resources where type=$1 and id=$2', [type, id])).rows[0];
  if (!r) throw new FhirError(404, `${type}/${id} not found`);
  if (r.deleted) throw new FhirError(410, `${type}/${id} was deleted`);
  return r.data;
}

export async function update(q: Db, type: string, id: string, body: any, ifMatch?: number) {
  validate(body, type);
  if (body.id && body.id !== id) throw new FhirError(400, 'id in body does not match URL');
  const cur = (await q.query('select version, deleted from resources where type=$1 and id=$2 for update', [type, id])).rows[0];
  if (!cur) return { res: await create(q, type, body, id), created: true };
  if (ifMatch !== undefined && ifMatch !== cur.version) throw new FhirError(412, `Version conflict: current is ${cur.version}`);
  const v = cur.version + 1;
  const at = new Date().toISOString();
  const res = stamp({ ...body }, id, v, at);
  await q.query('update resources set version=$3, data=$4, deleted=false, last_updated=$5 where type=$1 and id=$2', [type, id, v, res, at]);
  await q.query("insert into resource_history(type,id,version,data,deleted,last_updated,op) values ($1,$2,$3,$4,false,$5,'update')", [type, id, v, res, at]);
  await reindex(q, type, id, res);
  return { res, created: false };
}

export async function remove(q: Db, type: string, id: string) {
  const cur = (await q.query('select version, data from resources where type=$1 and id=$2 for update', [type, id])).rows[0];
  if (!cur) throw new FhirError(404, `${type}/${id} not found`);
  const v = cur.version + 1;
  const at = new Date().toISOString();
  await q.query('update resources set version=$3, deleted=true, last_updated=$4 where type=$1 and id=$2', [type, id, v, at]);
  await q.query("insert into resource_history(type,id,version,data,deleted,last_updated,op) values ($1,$2,$3,$4,true,$5,'delete')", [type, id, v, cur.data, at]);
  await q.query('delete from search_idx where type=$1 and id=$2', [type, id]);
  return cur.data;
}

export async function history(q: Db, type: string, id: string) {
  const rows = (await q.query('select data, deleted, version, op from resource_history where type=$1 and id=$2 order by version desc', [type, id])).rows;
  if (!rows.length) throw new FhirError(404, `${type}/${id} not found`);
  return rows;
}

export async function vread(q: Db, type: string, id: string, version: number) {
  const r = (await q.query('select data, deleted from resource_history where type=$1 and id=$2 and version=$3', [type, id, version])).rows[0];
  if (!r) throw new FhirError(404, 'version not found');
  return r.data;
}

export async function search(q: Db, type: string, query: Record<string, string | string[]>) {
  const { clauses, count, offset, sort } = buildWhere(type, query);
  const params: unknown[] = [type];
  let where = 'r.type = $1 and not r.deleted';
  for (const c of clauses) {
    where += ' and ' + number(c.sql, params.length + 1);
    params.push(...c.params);
  }
  let order = 'r.last_updated desc, r.id';
  if (sort) {
    const desc = sort.startsWith('-');
    const key = sort.replace(/^-/, '');
    if (key === '_lastUpdated') order = `r.last_updated ${desc ? 'desc' : 'asc'}, r.id`;
    else if (key === 'date' || key === 'birthdate')
      order = `(select min(s.val) from search_idx s where s.type=r.type and s.id=r.id and s.param='${key}') ${desc ? 'desc' : 'asc'} nulls last, r.id`;
  }
  const total = Number((await q.query(`select count(*) as n from resources r where ${where}`, params)).rows[0].n);
  const rows = count
    ? (await q.query(`select data from resources r where ${where} order by ${order} limit ${count} offset ${offset}`, params)).rows
    : [];
  return { total, resources: rows.map((r: any) => r.data) as any[] };
}

export { etag };
