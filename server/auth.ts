import { randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import type { Db } from './db.ts';
import { FhirError } from './fhir/store.ts';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export type Role = 'admin' | 'clinician' | 'nurse' | 'reception' | 'manager' | 'biller';
export const ROLES: Role[] = ['admin', 'clinician', 'nurse', 'reception', 'manager', 'biller'];
export type User = { id: string; username: string; name: string; role: Role; practitionerId: string | null };

export const MIN_PASSWORD = 12;
const SESSION_HOURS = 12;

export async function hashPassword(pw: string) {
  const salt = randomBytes(16);
  const key = await scrypt(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

async function verifyPassword(pw: string, stored: string) {
  const [, salt, key] = stored.split('$');
  const got = await scrypt(pw, Buffer.from(salt, 'hex'), 64);
  return timingSafeEqual(got, Buffer.from(key, 'hex'));
}

export async function createUser(db: Db, u: { username: string; name: string; role: Role; password: string; practitionerId?: string }) {
  if (u.password.length < MIN_PASSWORD) throw new FhirError(422, `Password must be at least ${MIN_PASSWORD} characters`);
  if (!ROLES.includes(u.role)) throw new FhirError(422, 'Unknown role');
  const id = randomUUID();
  await db.query('insert into users(id,username,name,role,pwd,practitioner_id) values ($1,$2,$3,$4,$5,$6)', [id, u.username.toLowerCase(), u.name, u.role, await hashPassword(u.password), u.practitionerId ?? null]);
  return id;
}

const fails = new Map<string, { n: number; until: number }>();
/** Test hook. */
export const resetLockouts = () => fails.clear();
const dummy = hashPassword('not-a-real-password');

export async function login(db: Db, username: string, password: string, ip: string) {
  const key = `${username.toLowerCase()}|${ip}`;
  const f = fails.get(key);
  if (f && f.n >= 5 && f.until > Date.now()) throw new FhirError(429, 'Too many failed attempts. Try again in 15 minutes.');
  const row = (await db.query('select * from users where username=$1 and active', [username.toLowerCase()])).rows[0];
  const ok = await verifyPassword(password, row ? row.pwd : await dummy);
  if (!row || !ok) {
    fails.set(key, { n: (f && f.until > Date.now() ? f.n : 0) + 1, until: Date.now() + 15 * 60_000 });
    throw new FhirError(401, 'Wrong username or password');
  }
  fails.delete(key);
  const token = randomBytes(32).toString('base64url');
  await db.query('insert into sessions(token_hash,user_id,expires_at) values ($1,$2,$3)', [hashToken(token), row.id, new Date(Date.now() + SESSION_HOURS * 3600_000)]);
  return { token, user: toUser(row) };
}

const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');
const toUser = (r: any): User => ({ id: r.id, username: r.username, name: r.name, role: r.role, practitionerId: r.practitioner_id });

export async function userForToken(db: Db, token: string | undefined): Promise<User | null> {
  if (!token) return null;
  const r = (await db.query(
    'select u.* from sessions s join users u on u.id=s.user_id where s.token_hash=$1 and s.expires_at > now() and u.active', [hashToken(token)])).rows[0];
  return r ? toUser(r) : null;
}

export const logout = (db: Db, token: string) => db.query('delete from sessions where token_hash=$1', [hashToken(token)]);

/** Role-based access to FHIR resource types. Anything not listed is denied. */
const CLINICAL = ['Observation', 'Condition', 'AllergyIntolerance', 'MedicationRequest', 'MedicationStatement', 'Immunization', 'Procedure', 'DiagnosticReport', 'Composition', 'DocumentReference', 'CarePlan', 'QuestionnaireResponse', 'FamilyMemberHistory', 'Encounter', 'Consent'];
const ADMIN_T = ['Patient', 'Practitioner', 'Organization', 'Location', 'ServiceRequest', 'Appointment', 'Communication', 'Task', 'Coverage', 'Flag', 'ChargeItem'];
const ACCESS: Record<Role, { read: string[]; write: string[] }> = {
  admin: { read: ['*'], write: ['Practitioner', 'Organization', 'Location'] },
  clinician: { read: ['*'], write: [...CLINICAL, ...ADMIN_T] },
  nurse: { read: ['*'], write: CLINICAL.filter((t) => t !== 'MedicationRequest').concat(ADMIN_T) },
  reception: { read: ['Patient', 'Practitioner', 'Organization', 'Location', 'Appointment', 'ServiceRequest', 'Coverage', 'Flag', 'Communication', 'Task'], write: ['Patient', 'Appointment', 'ServiceRequest', 'Coverage', 'Communication', 'Task'] },
  manager: { read: ['Practitioner', 'Organization', 'Location', 'Appointment', 'ServiceRequest'], write: [] },
  biller: { read: ['Patient', 'Encounter', 'Coverage', 'ChargeItem', 'Procedure', 'Practitioner', 'Organization', 'Location'], write: ['ChargeItem', 'Coverage'] },
};

export function can(role: Role, action: 'read' | 'write', type: string) {
  const a = ACCESS[role][action];
  return a.includes('*') || a.includes(type);
}
