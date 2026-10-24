import { openMemoryDb } from '../server/db.ts';
import { buildApp } from '../server/app.ts';
import { createUser, resetLockouts, type Role } from '../server/auth.ts';

export const PW = 'correct-horse-battery';

export async function setup() {
  resetLockouts();
  const db = await openMemoryDb();
  const app = await buildApp(db, { webDir: '/nonexistent' });
  const ids: Record<string, string> = {};
  for (const role of ['admin', 'clinician', 'nurse', 'reception', 'manager', 'biller'] as Role[])
    ids[role] = await createUser(db, { username: role, name: role, role, password: PW });
  const tokens: Record<string, string> = {};
  const as = async (role: string) => {
    if (!tokens[role]) {
      const r = await app.inject({ method: 'POST', url: '/api/login', payload: { username: role, password: PW } });
      tokens[role] = r.json().token;
    }
    const headers = { authorization: `Bearer ${tokens[role]}` };
    const call = async (method: string, url: string, payload?: unknown, extra: Record<string, string> = {}) => {
      const r = await app.inject({ method: method as any, url, payload: payload as any, headers: { ...headers, ...extra } });
      return { status: r.statusCode, body: r.body ? safe(r.body) : null, res: r };
    };
    return call;
  };
  return { db, app, ids, as };
}
const safe = (b: string) => { try { return JSON.parse(b); } catch { return b; } };

export const patient = (family = 'Test', given = 'Pat', extra: object = {}) =>
  ({ resourceType: 'Patient', name: [{ family, given: [given] }], birthDate: '1980-01-01', identifier: [{ system: 'urn:t', value: `ID-${family}` }], ...extra });
