import { randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import type { Db } from './db.ts';
import { FhirError } from './fhir/store.ts';
import { newTotpSecret, seal, unseal, verifyTotp } from './secrets.ts';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export type Role = 'admin' | 'clinician' | 'nurse' | 'reception' | 'manager' | 'biller';
export const ROLES: Role[] = ['admin', 'clinician', 'nurse', 'reception', 'manager', 'biller'];
export type User = { id: string; username: string; name: string; role: Role; practitionerId: string | null; mfa: boolean };

export const MIN_PASSWORD = 12;
const SESSION_HOURS = 12;
/** Sessions end after this long without a request, so an unattended workstation does not stay signed in. */
export const IDLE_MINUTES = 30;

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

export async function login(db: Db, username: string, password: string, ip: string, code?: string) {
  const key = `${username.toLowerCase()}|${ip}`;
  const f = fails.get(key);
  if (f && f.n >= 5 && f.until > Date.now()) throw new FhirError(429, 'Too many failed attempts. Try again in 15 minutes.');
  const row = (await db.query('select * from users where username=$1 and active', [username.toLowerCase()])).rows[0];
  const ok = await verifyPassword(password, row ? row.pwd : await dummy);
  const fail = (msg: string) => {
    fails.set(key, { n: (f && f.until > Date.now() ? f.n : 0) + 1, until: Date.now() + 15 * 60_000 });
    return new FhirError(401, msg);
  };
  if (!row || !ok) throw fail('Wrong username or password');
  if (row.totp_secret) {
    if (!code) throw new FhirError(401, 'Enter the 6-digit code from your authenticator app', { mfaRequired: true });
    let secret: string;
    try { secret = unseal(row.totp_secret); } catch {
      throw new FhirError(503, 'Two-step verification cannot be checked: this server has a different application key than the one your code was set up with. An administrator can run "node server/main.ts reset-mfa <username>".');
    }
    const step = verifyTotp(secret, code);
    // A code is single-use: replaying an observed code inside its 30 s window is refused.
    if (step === null || (row.totp_last_step !== null && step <= Number(row.totp_last_step))) throw fail('Wrong or reused code');
    await db.query('update users set totp_last_step=$2 where id=$1', [row.id, step]);
  }
  fails.delete(key);
  const token = randomBytes(32).toString('base64url');
  await db.query('insert into sessions(token_hash,user_id,expires_at) values ($1,$2,$3)', [hashToken(token), row.id, new Date(Date.now() + SESSION_HOURS * 3600_000)]);
  return { token, user: toUser(row) };
}

const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');
const toUser = (r: any): User => ({ id: r.id, username: r.username, name: r.name, role: r.role, practitionerId: r.practitioner_id, mfa: !!r.totp_secret });

export async function userForToken(db: Db, token: string | undefined): Promise<User | null> {
  if (!token) return null;
  const r = (await db.query(
    `update sessions s set last_seen=now() from users u
     where u.id=s.user_id and s.token_hash=$1 and s.expires_at > now() and s.last_seen > now() - interval '${IDLE_MINUTES} minutes' and u.active
     returning u.*`, [hashToken(token)])).rows[0];
  return r ? toUser(r) : null;
}

export const logout = (db: Db, token: string) => db.query('delete from sessions where token_hash=$1', [hashToken(token)]);

/** Role-based access to FHIR resource types. Anything not listed is denied. */
const CLINICAL = ['Observation', 'Condition', 'AllergyIntolerance', 'MedicationRequest', 'MedicationStatement', 'Immunization', 'Procedure', 'DiagnosticReport', 'Composition', 'DocumentReference', 'CarePlan', 'QuestionnaireResponse', 'FamilyMemberHistory', 'Encounter', 'Consent'];
const ADMIN_T = ['Patient', 'Practitioner', 'Organization', 'Location', 'ServiceRequest', 'Appointment', 'Communication', 'Task', 'Coverage', 'Flag', 'ChargeItem'];
const ACCESS: Record<Role, { read: string[]; write: string[] }> = {
  // Administrators run the system, not care: no clinical content (data minimisation). They see access reports instead.
  admin: { read: ['Patient', 'Practitioner', 'Organization', 'Location', 'Appointment', 'ServiceRequest', 'Flag', 'Coverage'], write: ['Practitioner', 'Organization', 'Location'] },
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

export async function changePassword(db: Db, userId: string, current: string, next: string, keepToken?: string) {
  const row = (await db.query('select pwd from users where id=$1', [userId])).rows[0];
  if (!row || !(await verifyPassword(current, row.pwd))) throw new FhirError(401, 'Current password is wrong');
  if (next.length < MIN_PASSWORD) throw new FhirError(422, `Password must be at least ${MIN_PASSWORD} characters`);
  if (next === current) throw new FhirError(422, 'Choose a different password');
  await db.query('update users set pwd=$2 where id=$1', [userId, await hashPassword(next)]);
  // Every other session ends: a password change is often a response to suspected compromise.
  await db.query('delete from sessions where user_id=$1 and token_hash <> $2', [userId, keepToken ? hashToken(keepToken) : '']);
}

export async function startMfa(db: Db, user: User) {
  const secret = newTotpSecret();
  await db.query('update users set totp_pending=$2 where id=$1', [user.id, seal(secret)]);
  const uri = `otpauth://totp/Arogya:${encodeURIComponent(user.username)}?secret=${secret}&issuer=Arogya&algorithm=SHA1&digits=6&period=30`;
  return { secret, uri };
}

export async function confirmMfa(db: Db, userId: string, code: string) {
  const row = (await db.query('select totp_pending from users where id=$1', [userId])).rows[0];
  if (!row?.totp_pending) throw new FhirError(409, 'Start two-step setup first');
  const step = verifyTotp(unseal(row.totp_pending), code);
  if (step === null) throw new FhirError(422, 'That code does not match. Check the time on your phone and try again.');
  await db.query('update users set totp_secret=totp_pending, totp_pending=null, totp_last_step=$2 where id=$1', [userId, step]);
}

export async function disableMfa(db: Db, userId: string, password: string) {
  const row = (await db.query('select pwd from users where id=$1', [userId])).rows[0];
  if (!row || !(await verifyPassword(password, row.pwd))) throw new FhirError(401, 'Password is wrong');
  await db.query('update users set totp_secret=null, totp_pending=null, totp_last_step=null where id=$1', [userId]);
}
