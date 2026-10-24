import { randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import type { Db } from './db.ts';
import { audit, verifyChain } from './audit.ts';
import { can, createUser, login, logout, ROLES, userForToken, type Role, type User } from './auth.ts';
import { checkMedication } from './cds.ts';
import { afterWrite, backfillCandidates, beforeWrite, dnaRisk, getSetting, setSetting, waitingList, DEFAULT_TARGET_DAYS } from './domain.ts';
import * as store from './fhir/store.ts';
import { SearchError } from './fhir/search.ts';
import { kpis } from './kpi.ts';
import { book, slots } from './scheduling.ts';

declare module 'fastify' { interface FastifyRequest { user: User | null; token?: string } }

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version as string;
const COOKIE = 'arogya_session';

/** Which shared work queues each role sees, besides their own. */
const POOLS: Record<Role, string[]> = {
  admin: [], clinician: ['results', 'messages', 'triage'], nurse: ['results', 'messages', 'triage'],
  reception: ['scheduling', 'messages'], manager: ['scheduling'], biller: [],
};

const outcome = (severity: string, code: string, text: string, extra: object = {}) =>
  ({ resourceType: 'OperationOutcome', issue: [{ severity, code, diagnostics: text }], ...extra });

export async function buildApp(db: Db, opts: { webDir?: string; secureCookies?: boolean } = {}) {
  const app = Fastify({ logger: false, bodyLimit: 5_000_000 });
  await app.register(fastifyCookie);
  app.addContentTypeParser(/^application\/(fhir\+)?json/, { parseAs: 'string' }, (_req, body, done) => {
    try { done(null, body ? JSON.parse(body as string) : {}); } catch (e) { done(e as Error); }
  });

  app.setErrorHandler((e: any, _req, reply) => {
    if (e instanceof store.FhirError) {
      const sev = e.status >= 500 ? 'fatal' : 'error';
      return reply.code(e.status).send(outcome(sev, e.status === 404 ? 'not-found' : e.status === 409 ? 'conflict' : 'invalid', e.message, e.alerts ? { alerts: e.alerts } : {}));
    }
    if (e instanceof SearchError) return reply.code(400).send(outcome('error', 'not-supported', e.message));
    if (e.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send(outcome('error', 'invalid', e.message));
    console.error(e);
    return reply.code(500).send(outcome('fatal', 'exception', 'Internal error'));
  });

  app.decorateRequest('user', null);
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0];
    if (!path.startsWith('/api/') && !path.startsWith('/fhir')) return;
    const bearer = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : undefined;
    const token = bearer ?? req.cookies[COOKIE];
    req.token = token;
    req.user = await userForToken(db, token);
    const open = path === '/api/login' || path === '/fhir/metadata';
    if (!req.user && !open) return reply.code(401).send(outcome('error', 'login', 'Not signed in'));
    // Cookie sessions need a custom header on writes: browsers cannot add it cross-site without a CORS preflight, which we never grant.
    if (!bearer && !['GET', 'HEAD'].includes(req.method) && path !== '/api/login' && req.headers['x-requested-with'] !== 'arogya')
      return reply.code(403).send(outcome('error', 'forbidden', 'Missing X-Requested-With header'));
  });
  app.addHook('onSend', async (_req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-frame-options', 'DENY');
    reply.header('content-security-policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'");
    if (_req.url.startsWith('/api') || _req.url.startsWith('/fhir')) reply.header('cache-control', 'no-store');
  });

  const need = (req: FastifyRequest, ...roles: Role[]) => {
    if (!req.user || !roles.includes(req.user.role)) throw new store.FhirError(403, 'Your role cannot do this');
    return req.user;
  };
  const log = (req: FastifyRequest, action: string, e: Partial<{ type: string; id: string; patientId: string | null; detail: unknown; reason: string }> = {}) =>
    audit(db, { userId: req.user?.id, username: req.user?.username, action, resourceType: e.type, resourceId: e.id, patientId: e.patientId, detail: e.detail, reason: e.reason });

  // ---------- open endpoints ----------
  app.get('/health', async () => ({ status: 'ok', version: VERSION }));

  app.post('/api/login', async (req, reply) => {
    const b = req.body as { username?: string; password?: string };
    if (!b?.username || !b?.password) throw new store.FhirError(400, 'username and password required');
    try {
      const { token, user } = await login(db, b.username, b.password, req.ip);
      await audit(db, { userId: user.id, username: user.username, action: 'login' });
      reply.setCookie(COOKIE, token, { httpOnly: true, sameSite: 'strict', secure: !!opts.secureCookies, path: '/', maxAge: 12 * 3600 });
      return { user, token };
    } catch (e) {
      await audit(db, { username: b.username, action: 'login-failed', detail: { ip: req.ip } });
      throw e;
    }
  });
  app.post('/api/logout', async (req, reply) => {
    if (req.token) await logout(db, req.token);
    await log(req, 'logout');
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });
  app.get('/api/me', async (req) => ({ user: req.user, version: VERSION }));

  // ---------- FHIR ----------
  const typeOf = (req: FastifyRequest) => {
    const t = (req.params as any).type as string;
    if (!store.TYPES.has(t)) throw new store.FhirError(404, `Unsupported resource type ${t}`);
    return t;
  };
  const guard = (req: FastifyRequest, action: 'read' | 'write', type: string) => {
    if (!can(req.user!.role, action, type)) throw new store.FhirError(403, `Role ${req.user!.role} cannot ${action} ${type}`);
  };
  /** Restricted records (meta.security R/V) need a stated reason, which is logged. */
  const restricted = async (patientId: string | null) => {
    if (!patientId) return false;
    const r = (await db.query("select data from resources where type='Patient' and id=$1 and not deleted", [patientId])).rows[0];
    return !!r?.data.meta?.security?.some((s: any) => s.code === 'R' || s.code === 'V');
  };
  const breakGlass = async (req: FastifyRequest, patientId: string | null) => {
    if (!(await restricted(patientId))) return undefined;
    const reason = String(req.headers['x-break-glass-reason'] ?? '').trim();
    if (reason.length < 10) throw new store.FhirError(403, 'Restricted record: send X-Break-Glass-Reason (at least 10 characters). The access is logged.');
    return reason;
  };

  app.get('/fhir/metadata', async () => ({
    resourceType: 'CapabilityStatement', status: 'active', date: new Date().toISOString(), kind: 'instance',
    software: { name: 'Arogya', version: VERSION }, fhirVersion: '4.0.1', format: ['json'],
    rest: [{ mode: 'server', resource: [...store.TYPES].map((type) => ({ type, interaction: [{ code: 'read' }, { code: 'vread' }, { code: 'update' }, { code: 'create' }, { code: 'delete' }, { code: 'search-type' }, { code: 'history-instance' }], versioning: 'versioned', updateCreate: true })) }],
  }));

  app.get('/fhir/:type', async (req) => {
    const type = typeOf(req); guard(req, 'read', type);
    const query = req.query as Record<string, string | string[]>;
    const { total, resources } = await store.search(db, type, query);
    const ownerOf = (r: any) => store.patientOf(r);
    let reason: string | undefined;
    let out = resources;
    const scoped = (query.patient ?? query.subject) as string | undefined;
    if (scoped) reason = await breakGlass(req, scoped.replace(/^Patient\//, ''));
    else if (type !== 'Patient' || true) {
      const ids = [...new Set(resources.map(ownerOf).filter(Boolean) as string[])];
      const hidden = new Set<string>();
      for (const id of ids) if (await restricted(id)) hidden.add(id);
      if (hidden.size) {
        const r = String(req.headers['x-break-glass-reason'] ?? '').trim();
        if (r.length >= 10) reason = r; else out = resources.filter((x) => !hidden.has(ownerOf(x) ?? ''));
      }
    }
    await log(req, 'search', { type, patientId: scoped?.replace(/^Patient\//, ''), detail: { query, returned: out.length }, reason });
    return { resourceType: 'Bundle', type: 'searchset', total: out.length === resources.length ? total : out.length, entry: out.map((r) => ({ fullUrl: `${type}/${r.id}`, resource: r })) };
  });

  app.get('/fhir/:type/:id', async (req) => {
    const type = typeOf(req); guard(req, 'read', type);
    const { id } = req.params as any;
    const res = await store.read(db, type, id);
    const pid = store.patientOf(res);
    const reason = await breakGlass(req, pid);
    await log(req, 'read', { type, id, patientId: pid, reason });
    return res;
  });

  app.get('/fhir/:type/:id/_history', async (req) => {
    const type = typeOf(req); guard(req, 'read', type);
    const { id } = req.params as any;
    const rows = await store.history(db, type, id);
    const pid = store.patientOf(rows[0].data);
    const reason = await breakGlass(req, pid);
    await log(req, 'history', { type, id, patientId: pid, reason });
    return { resourceType: 'Bundle', type: 'history', total: rows.length, entry: rows.map((r: any) => ({ resource: r.data, request: { method: r.op.toUpperCase() } })) };
  });

  const medGate = async (req: FastifyRequest, body: any, id?: string) => {
    if (body?.resourceType !== 'MedicationRequest' || body.status !== 'active') return;
    const pid = store.patientOf(body);
    if (!pid) return;
    const alerts = await checkMedication(db, pid, body, id);
    const high = alerts.filter((a) => a.severity === 'high');
    if (!high.length) return;
    const reason = String(req.headers['x-override-reason'] ?? '').trim();
    if (reason.length < 5) throw new store.FhirError(409, 'Safety alerts need a clinician decision: change the prescription or send X-Override-Reason.', alerts);
    await db.query('insert into override_log(user_id,patient_id,medication,alerts,reason) values ($1,$2,$3,$4,$5)',
      [req.user!.id, pid, body.medicationCodeableConcept?.text ?? '', JSON.stringify(alerts), reason]);
    body.note = [...(body.note ?? []), { text: `Safety override by ${req.user!.name}: ${reason}`, time: new Date().toISOString() }];
  };

  app.post('/fhir/:type', async (req, reply) => {
    const type = typeOf(req); guard(req, 'write', type);
    const body = req.body as any;
    beforeWrite(type, body);
    await medGate(req, body);
    const res = await store.create(db, type, body);
    await afterWrite(db, type, res, true, req.user!);
    await log(req, 'create', { type, id: res.id, patientId: store.patientOf(res) });
    return reply.code(201).header('location', `/fhir/${type}/${res.id}`).header('etag', store.etag(1)).send(res);
  });

  app.put('/fhir/:type/:id', async (req, reply) => {
    const type = typeOf(req); guard(req, 'write', type);
    const { id } = req.params as any;
    const body = req.body as any;
    beforeWrite(type, body);
    await medGate(req, body, id);
    const { res, created } = await store.update(db, type, id, body, store.parseEtag(req.headers['if-match'] as string));
    await afterWrite(db, type, res, created, req.user!);
    await log(req, created ? 'create' : 'update', { type, id, patientId: store.patientOf(res) });
    return reply.code(created ? 201 : 200).header('etag', store.etag(Number(res.meta.versionId))).send(res);
  });

  app.delete('/fhir/:type/:id', async (req, reply) => {
    const type = typeOf(req); need(req, 'admin', 'clinician'); guard(req, 'write', type);
    const { id } = req.params as any;
    const old = await store.remove(db, type, id);
    await log(req, 'delete', { type, id, patientId: store.patientOf(old) });
    return reply.code(204).send();
  });

  // ---------- one-call chart ----------
  app.get('/api/patients/:id/summary', async (req) => {
    const { id } = req.params as any;
    if (!can(req.user!.role, 'read', 'Observation')) throw new store.FhirError(403, 'Your role cannot open the clinical chart');
    const patient = await store.read(db, 'Patient', id);
    const reason = await breakGlass(req, id);
    const s = (type: string, q: Record<string, string>) => store.search(db, type, { patient: id, _count: '50', ...q }).then((r) => r.resources);
    const [allergies, problems, meds, vitals, labs, appts, referrals, encounters, notes, flags] = await Promise.all([
      s('AllergyIntolerance', { status: 'active' }), s('Condition', { status: 'active' }), s('MedicationRequest', { status: 'active' }),
      s('Observation', { category: 'vital-signs', _sort: '-date', _count: '30' }), s('Observation', { category: 'laboratory', _sort: '-date', _count: '30' }),
      s('Appointment', { _sort: '-date', _count: '20' }), s('ServiceRequest', { status: 'active' }), s('Encounter', { _sort: '-date', _count: '10' }),
      s('Composition', { _sort: '-date', _count: '10' }), s('Flag', { status: 'active' }),
    ]);
    await log(req, 'open-chart', { type: 'Patient', id, patientId: id, reason });
    return { patient, allergies, problems, meds, vitals, labs, appts, referrals, encounters, notes, flags };
  });

  app.get('/api/patients/:id/dna-risk', async (req) => {
    const { id } = req.params as any;
    return dnaRisk(db, id, Number((req.query as any).leadDays ?? 0));
  });

  // ---------- registration ----------
  app.get('/api/search/patients', async (req) => {
    const q = String((req.query as any).q ?? '').trim();
    if (q.length < 2) return [];
    const seen = new Map<string, any>();
    const add = (rs: any[]) => rs.forEach((r) => seen.set(r.id, r));
    // Each word may be a family or given name; digits may be an identifier, phone or birth date.
    for (const w of q.split(/\s+/)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(w)) add((await store.search(db, 'Patient', { birthdate: w, _count: '20' })).resources);
      else if (/\d/.test(w)) {
        add((await store.search(db, 'Patient', { identifier: w, _count: '20' })).resources);
        add((await store.search(db, 'Patient', { phone: w, _count: '20' })).resources);
      } else add((await store.search(db, 'Patient', { name: w, _count: '30' })).resources);
    }
    const words = q.toLowerCase().split(/\s+/);
    const score = (p: any) => words.filter((w) => JSON.stringify([p.name, p.identifier, p.telecom, p.birthDate]).toLowerCase().includes(w)).length;
    await log(req, 'search-patients', { detail: { q: q.replace(/\w/g, '*') } });
    return [...seen.values()].sort((a, b) => score(b) - score(a)).slice(0, 25);
  });

  app.post('/api/patients/check-duplicate', async (req) => {
    const b = req.body as { family?: string; given?: string; birthDate?: string; identifier?: string };
    const out = new Map<string, any>();
    if (b.identifier) (await store.search(db, 'Patient', { identifier: b.identifier })).resources.forEach((r) => out.set(r.id, { ...r, why: 'same identifier' }));
    if (b.family && b.birthDate) (await store.search(db, 'Patient', { family: b.family, birthdate: b.birthDate })).resources.forEach((r) => out.set(r.id, { ...r, why: 'same surname and date of birth' }));
    return [...out.values()];
  });

  // ---------- meds ----------
  app.post('/api/meds/check', async (req) => {
    need(req, 'clinician', 'nurse');
    const b = req.body as { patientId: string; medication: any };
    return { alerts: await checkMedication(db, b.patientId, b.medication) };
  });

  // ---------- inbox ----------
  const myPools = (u: User) => [`user:${u.id}`, ...(u.practitionerId ? [`user:${u.practitionerId}`] : []), ...POOLS[u.role]];
  app.get('/api/inbox', async (req) => {
    const u = req.user!;
    const rows = (await db.query(
      `select * from tasks where status='open' and (pool = any($1::text[]) or assignee=$2)
       order by (priority='urgent') desc, created_at asc limit 500`, [myPools(u), u.id])).rows;
    return rows.map((r) => ({ id: r.id, kind: r.kind, patientId: r.patient_id, subject: r.subject, refType: r.ref_type, refId: r.ref_id, pool: r.pool, assignee: r.assignee, priority: r.priority, normal: r.normal, createdAt: r.created_at }));
  });
  const ownTask = async (req: FastifyRequest) => {
    const { id } = req.params as any;
    const t = (await db.query("select * from tasks where id=$1 and status='open'", [id])).rows[0];
    if (!t) throw new store.FhirError(404, 'Task not found or already closed');
    if (!(myPools(req.user!).includes(t.pool) || t.assignee === req.user!.id)) throw new store.FhirError(403, 'Not in your queue');
    return t;
  };
  app.post('/api/inbox/:id/claim', async (req) => {
    const t = await ownTask(req);
    await db.query('update tasks set assignee=$2 where id=$1', [t.id, req.user!.id]);
    await log(req, 'task-claim', { type: 'Task', id: t.id, patientId: t.patient_id });
    return { ok: true };
  });
  app.post('/api/inbox/:id/done', async (req) => {
    const t = await ownTask(req);
    const note = String((req.body as any)?.note ?? '').slice(0, 1000);
    await db.query("update tasks set status='done', done_at=now(), done_by=$2, note=$3 where id=$1", [t.id, req.user!.id, note]);
    await log(req, 'task-done', { type: 'Task', id: t.id, patientId: t.patient_id, detail: { kind: t.kind } });
    return { ok: true };
  });
  /** Acknowledge every normal result in one action. Abnormal results are never touched. */
  app.post('/api/inbox/bulk-ack', async (req) => {
    const u = need(req, 'clinician', 'nurse');
    const rows = (await db.query(
      `update tasks set status='done', done_at=now(), done_by=$1, note='Normal result acknowledged in bulk'
       where status='open' and kind='result' and normal and (pool = any($2::text[]) or assignee=$1) returning id, patient_id`, [u.id, myPools(u)])).rows;
    for (const r of rows) await log(req, 'task-done', { type: 'Task', id: r.id, patientId: r.patient_id, detail: { bulk: true } });
    return { acknowledged: rows.length };
  });

  // ---------- scheduling ----------
  app.get('/api/waiting-list', async (req) => {
    need(req, 'clinician', 'nurse', 'reception', 'manager', 'admin');
    return waitingList(db, (req.query as any).service);
  });
  app.get('/api/backfill', async (req) => {
    need(req, 'clinician', 'nurse', 'reception', 'manager', 'admin');
    return backfillCandidates(db, (req.query as any).service);
  });
  app.get('/api/slots', async (req) => {
    const q = req.query as any;
    const from = q.from ? new Date(q.from) : new Date();
    return slots(db, { from, days: Math.min(Number(q.days ?? 7), 31), service: q.service, practitionerId: q.practitioner });
  });
  app.post('/api/appointments/book', async (req, reply) => {
    need(req, 'clinician', 'nurse', 'reception');
    const b = req.body as any;
    for (const k of ['patientId', 'practitionerId', 'start', 'end', 'service']) if (!b?.[k]) throw new store.FhirError(400, `${k} required`);
    const a = await book(db, b);
    await afterWrite(db, 'Appointment', a, true, req.user!);
    await log(req, 'create', { type: 'Appointment', id: a.id, patientId: b.patientId });
    return reply.code(201).send(a);
  });
  app.post('/api/appointments/:id/status', async (req) => {
    need(req, 'clinician', 'nurse', 'reception');
    const { id } = req.params as any;
    const status = String((req.body as any)?.status);
    if (!['arrived', 'fulfilled', 'noshow', 'cancelled', 'booked'].includes(status)) throw new store.FhirError(422, 'Unknown status');
    const cur = await store.read(db, 'Appointment', id);
    const { res } = await store.update(db, 'Appointment', id, { ...cur, status, cancelationReason: (req.body as any)?.reason ? { text: (req.body as any).reason } : cur.cancelationReason });
    await afterWrite(db, 'Appointment', res, false, req.user!);
    await log(req, 'update', { type: 'Appointment', id, patientId: store.patientOf(res), detail: { status } });
    return res;
  });

  app.get('/api/clinic-sessions', async () => (await db.query('select * from clinic_sessions order by weekday, start_time')).rows);
  app.post('/api/clinic-sessions', async (req, reply) => {
    need(req, 'admin', 'manager');
    const b = req.body as any;
    if (!b?.practitionerId || !b?.service || !/^\d\d:\d\d$/.test(b.start) || !/^\d\d:\d\d$/.test(b.end) || !(b.weekday >= 0 && b.weekday <= 6)) throw new store.FhirError(422, 'practitionerId, service, weekday 0-6, start and end HH:MM required');
    const id = randomUUID();
    await db.query('insert into clinic_sessions(id,practitioner_id,location,service,weekday,start_time,end_time,slot_mins) values ($1,$2,$3,$4,$5,$6,$7,$8)',
      [id, b.practitionerId, b.location ?? 'Main clinic', b.service, b.weekday, b.start, b.end, Number(b.slotMins ?? 20)]);
    await log(req, 'session-create', { detail: b });
    return reply.code(201).send({ id });
  });
  app.delete('/api/clinic-sessions/:id', async (req, reply) => {
    need(req, 'admin', 'manager');
    await db.query('delete from clinic_sessions where id=$1', [(req.params as any).id]);
    await log(req, 'session-delete', { id: (req.params as any).id });
    return reply.code(204).send();
  });

  // ---------- management ----------
  app.get('/api/kpi', async (req) => { need(req, 'admin', 'manager', 'clinician'); return kpis(db, Number((req.query as any).days ?? 90)); });
  app.get('/api/settings/targets', async () => getSetting(db, 'targets', DEFAULT_TARGET_DAYS));
  app.put('/api/settings/targets', async (req) => {
    need(req, 'admin', 'manager');
    const b = req.body as Record<string, number>;
    for (const k of Object.keys(DEFAULT_TARGET_DAYS)) if (!(b?.[k] > 0)) throw new store.FhirError(422, `target for ${k} must be a positive number of days`);
    await setSetting(db, 'targets', Object.fromEntries(Object.keys(DEFAULT_TARGET_DAYS).map((k) => [k, b[k]])));
    await log(req, 'settings-update', { detail: b });
    return { ok: true };
  });

  // ---------- administration ----------
  app.get('/api/users', async (req) => {
    need(req, 'admin');
    return (await db.query('select id,username,name,role,practitioner_id,active,created_at from users order by username')).rows;
  });
  app.post('/api/users', async (req, reply) => {
    need(req, 'admin');
    const b = req.body as any;
    if (!b?.username || !b?.name || !b?.password) throw new store.FhirError(400, 'username, name, password, role required');
    const id = await createUser(db, b).catch((e) => { if (String(e.message).includes('unique')) throw new store.FhirError(409, 'Username already exists'); throw e; });
    await log(req, 'user-create', { id, detail: { username: b.username, role: b.role } });
    return reply.code(201).send({ id });
  });
  app.patch('/api/users/:id', async (req) => {
    need(req, 'admin');
    const { id } = req.params as any;
    const b = req.body as { active?: boolean; role?: Role };
    if (id === req.user!.id && b.active === false) throw new store.FhirError(422, 'You cannot deactivate yourself');
    if (b.role && !ROLES.includes(b.role)) throw new store.FhirError(422, 'Unknown role');
    await db.query('update users set active=coalesce($2,active), role=coalesce($3,role) where id=$1', [id, b.active ?? null, b.role ?? null]);
    if (b.active === false) await db.query('delete from sessions where user_id=$1', [id]);
    await log(req, 'user-update', { id, detail: b });
    return { ok: true };
  });
  app.get('/api/audit', async (req) => {
    need(req, 'admin');
    const q = req.query as any;
    const rows = (await db.query(
      `select seq,at,username,action,resource_type,resource_id,patient_id,detail,reason from audit
       where ($1::text is null or patient_id=$1) and ($2::text is null or username=$2) order by seq desc limit $3`,
      [q.patient ?? null, q.user ?? null, Math.min(Number(q.limit ?? 200), 1000)])).rows;
    return rows;
  });
  app.get('/api/audit/verify', async (req) => { need(req, 'admin'); return verifyChain(db); });
  app.get('/api/export/:type', async (req, reply) => {
    need(req, 'admin');
    const type = typeOf(req);
    const rows = (await db.query('select data from resources where type=$1 and not deleted order by id', [type])).rows;
    await log(req, 'export', { type, detail: { count: rows.length } });
    return reply.type('application/fhir+ndjson').send(rows.map((r) => JSON.stringify(r.data)).join('\n'));
  });

  // ---------- web client ----------
  const web = opts.webDir ?? new URL('../web/dist', import.meta.url).pathname;
  if (existsSync(web)) {
    await app.register(fastifyStatic, { root: web });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api') || req.url.startsWith('/fhir')) return reply.code(404).send(outcome('error', 'not-found', 'No such endpoint'));
      return reply.sendFile('index.html');
    });
  }
  void randomUUID;
  return app;
}
