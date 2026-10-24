import { randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import type { Db } from './db.ts';
import { audit, verifyChain } from './audit.ts';
import { can, changePassword, confirmMfa, createUser, disableMfa, login, logout, ROLES, startMfa, userForToken, type Role, type User } from './auth.ts';
import { backup } from './backup.ts';
import { applyTuning, checkMedication, ruleOf } from './cds.ts';
import { afterWrite, backfillCandidates, beforeWrite, dnaRisk, getSetting, setSetting, waitingList, DEFAULT_TARGET_DAYS } from './domain.ts';
import * as store from './fhir/store.ts';
import { SearchError } from './fhir/search.ts';
import { dismiss, duplicates, LIKELY, merge, person, score, unmerge } from './identity.ts';
import { kpis } from './kpi.ts';
import { DEFAULT_RECALLS, recalls, validRules } from './recall.ts';
import { advance, DEFAULT_REFERRAL_DAYS, outbound, send, type Stage } from './referrals.ts';
import { handleReply, NO_REMINDERS, reminderSettings, runReminders, saveReminderSettings, verifyInbound } from './reminders.ts';
import { lastIntegrity, rebuildIndex, runIntegrity } from './integrity.ts';
import { ACTIVE, assertFree, book, dnaRiskMany, slots, today } from './scheduling.ts';

declare module 'fastify' { interface FastifyRequest { user: User | null; token?: string } }

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version as string;
const COOKIE = 'arogya_session';

/** Which shared work queues each role sees, besides their own. */
const POOLS: Record<Role, string[]> = {
  admin: [], clinician: ['results', 'messages', 'triage'], nurse: ['results', 'messages', 'triage'],
  reception: ['scheduling', 'messages'], manager: ['scheduling'], biller: [],
};

/** Paths that authenticate some other way: the reply webhook carries a gateway signature, not a session. */
const SIGNED_PATHS = new Set(['/api/reminders/reply']);
const MFA_SETUP_PATHS = new Set(['/api/me', '/api/logout', '/api/account/mfa/start', '/api/account/mfa/confirm', '/api/account/password']);
const SLA_DAYS: Record<string, number> = { result: 2, message: 2, referral: 5, backfill: 1, chase: 2 };

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
    if (e.code === '23505') return reply.code(409).send(outcome('error', 'conflict', 'Someone else saved this at the same moment. Reload and try again.'));
    if (e.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send(outcome('error', 'invalid', e.message));
    console.error(e);
    return reply.code(500).send(outcome('fatal', 'exception', 'Internal error'));
  });

  app.decorateRequest('user', null);
  const mfaRoles = async () => (await getSetting(db, 'security', { mfaRoles: [] as Role[] })).mfaRoles;
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0];
    if ((!path.startsWith('/api/') && !path.startsWith('/fhir')) || SIGNED_PATHS.has(path)) return;
    const bearer = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : undefined;
    const token = bearer ?? req.cookies[COOKIE];
    req.token = token;
    req.user = await userForToken(db, token);
    const open = path === '/api/login' || path === '/fhir/metadata';
    if (!req.user && !open) return reply.code(401).send(outcome('error', 'login', 'Not signed in or session expired'));
    if (req.user && !req.user.mfa && !MFA_SETUP_PATHS.has(path) && (await mfaRoles()).includes(req.user.role))
      return reply.code(403).send(outcome('error', 'security', 'Your role must set up two-step verification first', { alerts: { mfaSetupRequired: true } }));
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
    if (opts.secureCookies) reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
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
    const b = req.body as { username?: string; password?: string; code?: string };
    if (!b?.username || !b?.password) throw new store.FhirError(400, 'username and password required');
    try {
      const { token, user } = await login(db, b.username, b.password, req.ip, b.code);
      await audit(db, { userId: user.id, username: user.username, action: 'login' });
      reply.setCookie(COOKIE, token, { httpOnly: true, sameSite: 'strict', secure: !!opts.secureCookies, path: '/', maxAge: 12 * 3600 });
      return { user, token, mfaSetupRequired: !user.mfa && (await mfaRoles()).includes(user.role) };
    } catch (e: any) {
      if (!e.alerts?.mfaRequired) await audit(db, { username: b.username, action: 'login-failed', detail: { ip: req.ip } });
      throw e;
    }
  });
  app.post('/api/logout', async (req, reply) => {
    if (req.token) await logout(db, req.token);
    await log(req, 'logout');
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });
  app.get('/api/me', async (req) => ({
    user: req.user, version: VERSION,
    mfaSetupRequired: !!req.user && !req.user.mfa && (await mfaRoles()).includes(req.user.role),
  }));

  // ---------- own account ----------
  app.post('/api/account/password', async (req) => {
    const b = req.body as { current?: string; next?: string };
    await changePassword(db, req.user!.id, String(b?.current ?? ''), String(b?.next ?? ''), req.token);
    await log(req, 'password-change');
    return { ok: true };
  });
  app.post('/api/account/mfa/start', async (req) => {
    if (req.user!.mfa) throw new store.FhirError(409, 'Two-step verification is already on');
    return startMfa(db, req.user!);
  });
  app.post('/api/account/mfa/confirm', async (req) => {
    await confirmMfa(db, req.user!.id, String((req.body as any)?.code ?? ''));
    await log(req, 'mfa-enabled');
    return { ok: true };
  });
  app.post('/api/account/mfa/disable', async (req) => {
    if ((await mfaRoles()).includes(req.user!.role)) throw new store.FhirError(403, 'Your role requires two-step verification');
    await disableMfa(db, req.user!.id, String((req.body as any)?.password ?? ''));
    await log(req, 'mfa-disabled');
    return { ok: true };
  });

  // ---------- FHIR ----------
  const typeOf = (req: FastifyRequest) => {
    const t = (req.params as any).type as string;
    if (!store.TYPES.has(t)) throw new store.FhirError(404, `Unsupported resource type ${t}`);
    return t;
  };
  const guard = (req: FastifyRequest, action: 'read' | 'write', type: string) => {
    if (!can(req.user!.role, action, type)) throw new store.FhirError(403, `Role ${req.user!.role} cannot ${action} ${type}`);
  };
  /**
   * Restricted records (meta.security R/V) need a stated reason, which is logged. A deleted patient keeps its
   * labels: deleting the record must not unprotect the data that still points at it.
   */
  const restrictedOf = async (ids: (string | null | undefined)[]) => {
    const want = [...new Set(ids.filter(Boolean))] as string[];
    if (!want.length) return new Set<string>();
    return new Set((await db.query(
      `select id from resources where type='Patient' and id = any($1::text[])
       and exists (select 1 from jsonb_array_elements(coalesce(data->'meta'->'security', '[]'::jsonb)) l where l->>'code' in ('R','V'))`, [want])).rows.map((r) => r.id as string));
  };
  const restricted = async (patientId: string | null) => (await restrictedOf([patientId])).size > 0;
  const givenReason = (req: FastifyRequest) => String(req.headers['x-break-glass-reason'] ?? '').trim();
  const BREAK_GLASS = 'Restricted record: send X-Break-Glass-Reason (at least 10 characters). The access is logged.';
  const breakGlass = async (req: FastifyRequest, patientId: string | null) => {
    if (!(await restricted(patientId))) return undefined;
    const reason = givenReason(req);
    if (reason.length < 10) throw new store.FhirError(403, BREAK_GLASS);
    return reason;
  };
  /** Drop results that belong to restricted patients unless a reason was given. Checked per result, so no query spelling gets round it. */
  const screen = async <T>(req: FastifyRequest, rows: T[], owner: (r: T) => string | null) => {
    const hidden = await restrictedOf(rows.map(owner));
    if (!hidden.size) return { rows, reason: undefined, hidden: 0 };
    const reason = givenReason(req);
    if (reason.length >= 10) return { rows, reason, hidden: 0 };
    const kept = rows.filter((r) => !hidden.has(owner(r) ?? ''));
    return { rows: kept, reason: undefined, hidden: rows.length - kept.length };
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
    const scoped = (query.patient ?? query.subject) as string | undefined;
    const { rows: out, reason, hidden } = await screen(req, resources, store.patientOf);
    // Asking for one patient's data and getting silently less would mislead: say a reason is needed.
    if (hidden && scoped) throw new store.FhirError(403, BREAK_GLASS);
    await log(req, 'search', { type, patientId: typeof scoped === 'string' ? scoped.replace(/^Patient\//, '') : null, detail: { query, returned: out.length }, reason });
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

  app.get('/fhir/:type/:id/_history/:vid', async (req) => {
    const type = typeOf(req); guard(req, 'read', type);
    const { id, vid } = req.params as any;
    const res = await store.vread(db, type, id, Number(vid));
    const pid = store.patientOf(res);
    const reason = await breakGlass(req, pid);
    await log(req, 'vread', { type, id, patientId: pid, reason, detail: { version: Number(vid) } });
    return res;
  });

  const medGate = async (req: FastifyRequest, body: any, id?: string) => {
    if (body?.resourceType !== 'MedicationRequest' || body.status !== 'active') return;
    const pid = store.patientOf(body);
    if (!pid) return;
    const alerts = await applyTuning(db, await checkMedication(db, pid, body, id));
    const high = alerts.filter((a) => a.severity === 'high');
    if (!high.length) return;
    const reason = String(req.headers['x-override-reason'] ?? '').trim();
    const overridden = reason.length >= 5;
    for (const a of high)
      await db.query('insert into alert_log(user_id,patient_id,rule,severity,overridden) values ($1,$2,$3,$4,$5)', [req.user!.id, pid, ruleOf(a), a.severity, overridden]);
    if (reason.length < 5) throw new store.FhirError(409, 'Safety alerts need a clinician decision: change the prescription or send X-Override-Reason.', alerts);
    await db.query('insert into override_log(user_id,patient_id,medication,alerts,reason) values ($1,$2,$3,$4,$5)',
      [req.user!.id, pid, body.medicationCodeableConcept?.text ?? '', JSON.stringify(alerts), reason]);
    body.note = [...(body.note ?? []), { text: `Safety override by ${req.user!.name}: ${reason}`, time: new Date().toISOString() }];
  };

  /** Appointments are checked for clashes inside the same transaction as the write. */
  const save = (type: string, body: any, write: (q: Db) => Promise<any>, id?: string) =>
    type === 'Appointment' ? db.tx(async (t) => { store.validate(body, type); await assertFree(t, body, id); return write(t); }) : write(db);
  const labels = (r: any) => (r?.meta?.security ?? []).map((l: any) => `${l.system ?? ''}|${l.code}`).sort().join(',');

  app.post('/fhir/:type', async (req, reply) => {
    const type = typeOf(req); guard(req, 'write', type);
    const body = req.body as any;
    beforeWrite(type, body);
    await medGate(req, body);
    const res = await save(type, body, (q) => store.create(q, type, body));
    await afterWrite(db, type, res, true, req.user!);
    await log(req, 'create', { type, id: res.id, patientId: store.patientOf(res) });
    return reply.code(201).header('location', `/fhir/${type}/${res.id}`).header('etag', store.etag(1)).send(res);
  });

  app.put('/fhir/:type/:id', async (req, reply) => {
    const type = typeOf(req); guard(req, 'write', type);
    const { id } = req.params as any;
    const body = req.body as any;
    beforeWrite(type, body);
    const cur = type === 'Patient' ? (await db.query(`select data from resources where type='Patient' and id=$1`, [id])).rows[0]?.data : undefined;
    let reason: string | undefined, relabelled = false;
    if (cur) {
      // Changing a restricted record needs a reason; only clinicians can change who may see it.
      reason = await breakGlass(req, id);
      if (req.user!.role !== 'clinician') body.meta = { ...body.meta, security: cur.meta?.security };
      relabelled = labels(cur) !== labels(body);
    }
    await medGate(req, body, id);
    const { res, created } = await save(type, body, (q) => store.update(q, type, id, body, store.parseEtag(req.headers['if-match'] as string)), id);
    await afterWrite(db, type, res, created, req.user!);
    await log(req, created ? 'create' : 'update', { type, id, patientId: store.patientOf(res), reason });
    if (relabelled) await log(req, 'security-label-change', { type, id, patientId: id, reason, detail: { from: labels(cur), to: labels(res) } });
    return reply.code(created ? 201 : 200).header('etag', store.etag(Number(res.meta.versionId))).send(res);
  });

  app.delete('/fhir/:type/:id', async (req, reply) => {
    const type = typeOf(req); need(req, 'admin', 'clinician'); guard(req, 'write', type);
    const { id } = req.params as any;
    const reason = await breakGlass(req, store.patientOf(await store.read(db, type, id)));
    const old = await store.remove(db, type, id);
    await log(req, 'delete', { type, id, patientId: store.patientOf(old), reason });
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
    const due = await recalls(db, id);
    await log(req, 'open-chart', { type: 'Patient', id, patientId: id, reason });
    return { patient, allergies, problems, meds, vitals, labs, appts, referrals, encounters, notes, flags, due };
  });

  /** The front-desk view of a patient: contact details, appointments and referrals being chased. No clinical content. */
  app.get('/api/patients/:id/desk', async (req) => {
    need(req, 'reception', 'clinician', 'nurse');
    const { id } = req.params as any;
    const patient = await store.read(db, 'Patient', id);
    const reason = await breakGlass(req, id);
    const appts = (await store.search(db, 'Appointment', { patient: id, _sort: '-date', _count: '20' })).resources;
    const referralsOut = await outbound(db, id);
    await log(req, 'open-desk-record', { type: 'Patient', id, patientId: id, reason });
    return { patient, appts, referralsOut, remindersOff: !!patient.extension?.some((e: any) => e.url === NO_REMINDERS && e.valueBoolean) };
  });

  app.get('/api/patients/:id/dna-risk', async (req) => {
    need(req, 'clinician', 'nurse', 'reception', 'manager');
    const { id } = req.params as any;
    await breakGlass(req, id);
    return dnaRisk(db, id, Number((req.query as any).leadDays ?? 0));
  });

  // ---------- registration ----------
  /**
   * Restricted patients in registration lists. R (restricted) shows only enough to recognise the person, so the
   * record can be found and opened with a reason; V (very restricted) does not appear at all. A stated reason shows both in full.
   */
  const deskList = (req: FastifyRequest, list: any[]) => {
    const reason = givenReason(req).length >= 10 ? givenReason(req) : undefined;
    const code = (p: any) => p.meta?.security?.find((l: any) => l.code === 'V' || l.code === 'R')?.code as string | undefined;
    if (reason) return { rows: list, reason };
    return {
      rows: list.filter((p) => code(p) !== 'V').map((p) => (code(p) === 'R'
        ? { resourceType: 'Patient', id: p.id, name: p.name, birthDate: p.birthDate, gender: p.gender, active: p.active, link: p.link, meta: { security: p.meta.security }, restricted: true }
        : p)),
      reason,
    };
  };
  app.get('/api/search/patients', async (req) => {
    guard(req, 'read', 'Patient');
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
    const rank = (p: any) => words.filter((w) => JSON.stringify([p.name, p.identifier, p.telecom, p.birthDate]).toLowerCase().includes(w)).length;
    const { rows, reason } = deskList(req, [...seen.values()]);
    await log(req, 'search-patients', { detail: { q: q.replace(/\w/g, '*') }, reason });
    // A merged record is reachable through the record that replaced it, which carries its old identifiers.
    return rows.filter((p) => !p.link?.some((l: any) => l.type === 'replaced-by'))
      .sort((a, b) => rank(b) - rank(a)).slice(0, 25);
  });

  app.post('/api/patients/check-duplicate', async (req) => {
    guard(req, 'read', 'Patient');
    const b = req.body as { family?: string; given?: string; birthDate?: string; identifier?: string; phone?: string; gender?: string };
    const found = new Map<string, any>();
    const add = async (q: Record<string, string>) => (await store.search(db, 'Patient', { ...q, _count: '50' })).resources.forEach((r) => found.set(r.id, r));
    if (b.identifier) await add({ identifier: b.identifier });
    if (b.birthDate) await add({ birthdate: b.birthDate });
    if (b.family) await add({ family: b.family });
    if (b.phone) await add({ phone: b.phone });
    const me = person({ name: [{ family: b.family, given: [b.given] }], birthDate: b.birthDate, gender: b.gender,
      identifier: b.identifier ? [{ system: 'urn:arogya:mrn', value: b.identifier }] : [], telecom: b.phone ? [{ system: 'phone', value: b.phone }] : [] });
    const { rows, reason } = deskList(req, [...found.values()]);
    await log(req, 'check-duplicate', { detail: { candidates: rows.length }, reason });
    // At the desk, warn on weaker evidence than the duplicates worklist uses: a missed duplicate costs more than a second look.
    return rows.filter((p) => p.active !== false && !p.link?.some((l: any) => l.type === 'replaced-by'))
      .map((p) => { const m = score(me, person(p)); return { ...p, score: m.score, why: m.why.join(', ') }; })
      .filter((p) => p.score >= LIKELY - 0.1)
      .sort((x, y) => y.score - x.score).slice(0, 10);
  });

  // ---------- identity: duplicates and merge ----------
  app.get('/api/duplicates', async (req) => {
    need(req, 'reception', 'clinician');
    const list = await duplicates(db);
    await log(req, 'duplicates-list', { detail: { pairs: list.length } });
    return list;
  });
  app.post('/api/duplicates/dismiss', async (req) => {
    const u = need(req, 'reception', 'clinician');
    const b = req.body as { a?: string; b?: string };
    if (!b?.a || !b?.b) throw new store.FhirError(400, 'a and b required');
    await dismiss(db, b.a, b.b, u.id);
    await log(req, 'not-duplicate', { type: 'Patient', id: b.a, patientId: b.a, detail: { other: b.b } });
    return { ok: true };
  });
  app.post('/api/patients/merge', async (req) => {
    const u = need(req, 'reception', 'clinician');
    const b = req.body as { keepId?: string; mergeId?: string; reason?: string };
    const reason = String(b?.reason ?? '').trim();
    if (!b?.keepId || !b?.mergeId) throw new store.FhirError(400, 'keepId and mergeId required');
    if (reason.length < 10) throw new store.FhirError(422, 'Say how you confirmed these are the same person (at least 10 characters)');
    const r = await merge(db, b.keepId, b.mergeId, reason, u.id);
    await log(req, 'patient-merge', { type: 'Patient', id: b.keepId, patientId: b.keepId, reason, detail: { merged: b.mergeId, moved: r.moved } });
    await log(req, 'patient-merge', { type: 'Patient', id: b.mergeId, patientId: b.mergeId, reason, detail: { into: b.keepId } });
    return r;
  });
  app.get('/api/merges', async (req) => {
    need(req, 'reception', 'clinician');
    return (await db.query(
      `select m.id, m.keep_id, m.merged_id, m.reason, m.at, m.undone_at, jsonb_array_length(m.moved) moved, u.name by_name,
       k.data->'name'->0 keep_name, g.data->'name'->0 merged_name from merge_log m left join users u on u.id=m.user_id
       left join resources k on k.type='Patient' and k.id=m.keep_id left join resources g on g.type='Patient' and g.id=m.merged_id
       order by m.at desc limit 50`)).rows;
  });
  app.post('/api/merges/:id/undo', async (req) => {
    const u = need(req, 'reception', 'clinician');
    const r = await unmerge(db, (req.params as any).id, u.id);
    await log(req, 'patient-unmerge', { type: 'Patient', id: r.keepId, patientId: r.keepId, detail: { restored: r.mergedId } });
    await log(req, 'patient-unmerge', { type: 'Patient', id: r.mergedId, patientId: r.mergedId });
    return r;
  });

  // ---------- referrals to other providers ----------
  app.get('/api/referrals-out', async (req) => {
    need(req, 'clinician', 'nurse', 'reception', 'manager');
    const list = await outbound(db);
    await log(req, 'referrals-out-list', { detail: { rows: list.length } });
    return list;
  });
  app.post('/api/referrals-out', async (req, reply) => {
    const u = need(req, 'clinician', 'nurse');
    const b = req.body as any;
    if (!b?.patientId) throw new store.FhirError(400, 'patientId required');
    await breakGlass(req, b.patientId);
    const r = await send(db, { ...b, requester: u.practitionerId ?? undefined });
    await log(req, 'create', { type: 'ServiceRequest', id: r.id, patientId: b.patientId, detail: { to: b.to } });
    return reply.code(201).send(r);
  });
  app.post('/api/referrals-out/:id/stage', async (req) => {
    const u = need(req, 'clinician', 'nurse', 'reception');
    const b = req.body as { stage?: Stage; note?: string };
    const r = await advance(db, (req.params as any).id, b?.stage as Stage, String(b?.note ?? '').trim().slice(0, 500), u.name);
    await log(req, 'update', { type: 'ServiceRequest', id: r.id, patientId: store.patientOf(r), detail: { stage: b?.stage } });
    return r;
  });
  app.get('/api/settings/referral-days', async () => getSetting(db, 'referralDays', DEFAULT_REFERRAL_DAYS));
  app.put('/api/settings/referral-days', async (req) => {
    need(req, 'admin', 'manager');
    const b = req.body as Record<string, number>;
    for (const k of Object.keys(DEFAULT_REFERRAL_DAYS)) if (!(Number.isInteger(b?.[k]) && b[k] > 0 && b[k] <= 365)) throw new store.FhirError(422, `${k} must be 1 to 365 days`);
    await setSetting(db, 'referralDays', Object.fromEntries(Object.keys(DEFAULT_REFERRAL_DAYS).map((k) => [k, b[k]])));
    await log(req, 'settings-update', { detail: { referralDays: b } });
    return { ok: true };
  });

  // ---------- appointment reminders ----------
  app.get('/api/settings/reminders', async (req) => {
    need(req, 'admin');
    const { secret, ...rest } = await reminderSettings(db);
    return { ...rest, hasSecret: !!secret };
  });
  app.put('/api/settings/reminders', async (req) => {
    need(req, 'admin');
    const r = await saveReminderSettings(db, req.body as any);
    const { secret: _s, ...saved } = await reminderSettings(db);
    await log(req, 'settings-update', { detail: { reminders: { ...saved, rotated: !!r.secret } } });
    return r;
  });
  app.post('/api/admin/reminders/run', async (req) => { need(req, 'admin'); const r = await runReminders(db); await log(req, 'reminders-run', { detail: r }); return r; });
  app.get('/api/reminders/outbox', async (req) => {
    need(req, 'admin', 'reception');
    return (await db.query(
      `select o.id, o.status, o.detail, o.attempts, o.created_at, o.sent_at, o.to_addr, a.data->>'start' as start, a.data->'participant'->0->'actor'->>'display' as patient,
         (select i.action from inbound i where i.outbox_id=o.id order by i.at desc limit 1) as reply
       from outbox o left join resources a on a.type='Appointment' and a.id=o.appointment_id order by o.created_at desc limit 100`)).rows;
  });
  /** Gateway callback with a patient's reply. Signed over the raw body, so this route keeps the body as text. */
  await app.register(async (hook) => {
    hook.removeAllContentTypeParsers();
    hook.addContentTypeParser('*', { parseAs: 'string', bodyLimit: 10_000 }, (_req, body, done) => done(null, body));
    hook.post('/api/reminders/reply', async (req) => {
      const raw = String(req.body ?? '');
      await verifyInbound(db, String(req.headers['x-arogya-timestamp'] ?? ''), raw, String(req.headers['x-arogya-signature'] ?? ''));
      let b: any;
      try { b = JSON.parse(raw); } catch { throw new store.FhirError(400, 'Body must be JSON'); }
      const r = await handleReply(db, b ?? {});
      await audit(db, { username: 'sms-gateway', action: 'reminder-reply', resourceType: r.appointmentId ? 'Appointment' : undefined, resourceId: r.appointmentId, patientId: r.patientId ?? null, detail: { action: r.action } });
      return { action: r.action };
    });
  });
  /** Whether this patient gets text reminders. The desk changes it when the patient asks. */
  app.put('/api/patients/:id/reminders', async (req) => {
    need(req, 'clinician', 'nurse', 'reception');
    const { id } = req.params as any;
    const reason = await breakGlass(req, id);
    const off = !!(req.body as any)?.off;
    const p = await store.read(db, 'Patient', id);
    const extension = [...(p.extension ?? []).filter((e: any) => e.url !== NO_REMINDERS), ...(off ? [{ url: NO_REMINDERS, valueBoolean: true }] : [])];
    await store.update(db, 'Patient', id, { ...p, extension: extension.length ? extension : undefined });
    await log(req, 'reminders-preference', { type: 'Patient', id, patientId: id, reason, detail: { off } });
    return { off };
  });

  // ---------- recalls ----------
  app.get('/api/recalls', async (req) => {
    need(req, 'clinician', 'nurse', 'reception', 'manager');
    const list = await recalls(db);
    await log(req, 'recall-list', { detail: { rows: list.length } });
    return list;
  });
  app.get('/api/settings/recalls', async (req) => { need(req, 'clinician', 'nurse', 'reception', 'manager', 'admin'); return getSetting(db, 'recalls', DEFAULT_RECALLS); });
  app.put('/api/settings/recalls', async (req) => {
    need(req, 'clinician', 'manager');
    if (!validRules(req.body)) throw new store.FhirError(422, 'Each rule needs an id, a name, condition and test terms, and a whole number of days (1 to 3650)');
    await setSetting(db, 'recalls', req.body);
    await log(req, 'settings-update', { detail: { recalls: (req.body as any[]).map((r) => `${r.id}:${r.everyDays}`) } });
    return { ok: true };
  });

  // ---------- meds ----------
  app.post('/api/meds/check', async (req) => {
    need(req, 'clinician', 'nurse');
    const b = req.body as { patientId: string; medication: any };
    await breakGlass(req, b?.patientId ?? null);
    return { alerts: await applyTuning(db, await checkMedication(db, b.patientId, b.medication)) };
  });

  // ---------- inbox ----------
  const myPools = (u: User) => [`user:${u.id}`, ...(u.practitionerId ? [`user:${u.practitionerId}`] : []), ...POOLS[u.role]];
  app.get('/api/inbox', async (req) => {
    const u = req.user!;
    // A critical result nobody has closed within an hour leaves the personal queue for the shared results pool.
    const esc = (await db.query(
      `update tasks set pool='results', escalated=true where status='open' and kind='result' and priority='urgent'
       and not escalated and pool like 'user:%' and created_at < now() - interval '1 hour' returning id, patient_id, pool`)).rows;
    for (const r of esc) await audit(db, { action: 'task-escalated', resourceType: 'Task', resourceId: r.id, patientId: r.patient_id });
    const rows = (await db.query(
      `select * from tasks where status='open' and (pool = any($1::text[]) or assignee=$2)
       order by (priority='urgent') desc, created_at asc limit 500`, [myPools(u), u.id])).rows;
    return rows.map((r) => ({ id: r.id, kind: r.kind, patientId: r.patient_id, subject: r.subject, refType: r.ref_type, refId: r.ref_id, pool: r.pool, assignee: r.assignee, priority: r.priority, normal: r.normal, escalated: r.escalated, createdAt: r.created_at, overdue: Date.now() - Date.parse(r.created_at) > (SLA_DAYS[r.kind] ?? 3) * 86400_000 }));
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
    const res = await db.tx(async (t) => {
      const cur = await store.read(t, 'Appointment', id);
      const next = { ...cur, status, cancelationReason: (req.body as any)?.reason ? { text: (req.body as any).reason } : cur.cancelationReason };
      // Bringing a cancelled or missed appointment back must not land on top of whoever took the slot since.
      if (!ACTIVE.includes(cur.status)) await assertFree(t, next, id);
      return (await store.update(t, 'Appointment', id, next)).res;
    });
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

  app.get('/api/today', async (req) => {
    need(req, 'clinician', 'nurse', 'reception', 'manager', 'admin');
    const q = req.query as any;
    const mine = q.all !== '1' && req.user!.practitionerId ? req.user!.practitionerId : undefined;
    const list = await today(db, q.date, mine);
    const risks = await dnaRiskMany(db, list.filter((a) => a.status === 'booked').map((a) => a.patientId));
    return list.map((a) => ({ ...a, dnaRisk: risks[a.patientId] ?? null }));
  });

  app.get('/api/safety/alert-rules', async (req) => {
    need(req, 'admin', 'manager', 'clinician');
    const rows = (await db.query(
      `select rule, severity, count(*)::int fired, count(*) filter (where overridden)::int overridden from alert_log
       where at > now() - interval '180 days' group by rule, severity order by fired desc limit 100`)).rows;
    const quiet = new Map((await db.query('select t.rule, t.reason, t.at, u.name from alert_tuning t left join users u on u.id=t.user_id')).rows.map((q: any) => [q.rule, q]));
    // A rule overridden almost every time is noise that trains people to ignore alerts: flag it for review.
    const out = rows.map((r) => ({ ...r, overridePct: Math.round((r.overridden / r.fired) * 1000) / 10, review: r.fired >= 10 && r.overridden / r.fired > 0.95, quiet: quiet.get(r.rule) ?? null }));
    for (const [rule, q] of quiet) if (!out.some((r) => r.rule === rule)) out.push({ rule, severity: 'high', fired: 0, overridden: 0, overridePct: 0, review: false, quiet: q });
    return out;
  });
  app.post('/api/safety/alert-rules/quiet', async (req) => {
    const u = need(req, 'clinician');
    const b = req.body as { rule?: string; reason?: string };
    const rule = String(b?.rule ?? ''), reason = String(b?.reason ?? '').trim();
    if (!/^(interaction|dose|duplicate): /.test(rule)) throw new store.FhirError(422, 'Only interaction, dose and duplicate rules can stop interrupting. Allergy alerts always interrupt.');
    if (reason.length < 10) throw new store.FhirError(422, 'Give the clinical reason (at least 10 characters)');
    await db.query('insert into alert_tuning(rule,user_id,reason) values ($1,$2,$3) on conflict (rule) do update set user_id=excluded.user_id, reason=excluded.reason, at=now()', [rule, u.id, reason]);
    await log(req, 'alert-rule-quietened', { reason, detail: { rule } });
    return { ok: true };
  });
  app.post('/api/safety/alert-rules/restore', async (req) => {
    need(req, 'clinician');
    const rule = String((req.body as any)?.rule ?? '');
    await db.query('delete from alert_tuning where rule=$1', [rule]);
    await log(req, 'alert-rule-restored', { detail: { rule } });
    return { ok: true };
  });

  app.get('/api/stuck-work', async (req) => {
    need(req, 'admin', 'manager', 'clinician', 'nurse', 'reception');
    const rows = (await db.query(`select id, kind, subject, pool, priority, patient_id, created_at from tasks where status='open' order by created_at limit 1000`)).rows;
    return rows.filter((r) => Date.now() - Date.parse(r.created_at) > (SLA_DAYS[r.kind] ?? 3) * 86400_000)
      .map((r) => ({ id: r.id, kind: r.kind, subject: r.subject, pool: r.pool, priority: r.priority, patientId: r.patient_id, ageDays: Math.floor((Date.now() - Date.parse(r.created_at)) / 86400_000), slaDays: SLA_DAYS[r.kind] ?? 3 }));
  });

  /** Data-protection report: every recorded access to one patient's record. */
  app.get('/api/patients/:id/access-log', async (req) => {
    need(req, 'admin');
    const { id } = req.params as any;
    const rows = (await db.query(
      `select a.at, a.username, u.name, u.role, a.action, a.resource_type, a.reason from audit a left join users u on u.id=a.user_id
       where a.patient_id=$1 order by a.seq desc limit 2000`, [id])).rows;
    await log(req, 'access-report', { type: 'Patient', id, patientId: id });
    return rows;
  });

  app.get('/api/settings/security', async (req) => { need(req, 'admin'); return getSetting(db, 'security', { mfaRoles: [] }); });
  app.put('/api/settings/security', async (req) => {
    const u = need(req, 'admin');
    const roles = ((req.body as any)?.mfaRoles ?? []) as Role[];
    if (!Array.isArray(roles) || roles.some((r) => !ROLES.includes(r))) throw new store.FhirError(422, 'Unknown role');
    if (roles.includes('admin') && !u.mfa) throw new store.FhirError(422, 'Turn on two-step verification for yourself before requiring it for admins');
    await setSetting(db, 'security', { mfaRoles: roles });
    await log(req, 'settings-update', { detail: { mfaRoles: roles } });
    return { ok: true };
  });

  /** Encrypted full backup. Admin with two-step verification only: the file holds every record. */
  app.post('/api/admin/backup', async (req, reply) => {
    const u = need(req, 'admin');
    if (!u.mfa) throw new store.FhirError(403, 'Turn on two-step verification before taking backups');
    const passphrase = String((req.body as any)?.passphrase ?? '');
    let file: Buffer;
    try { file = await backup(db, passphrase); } catch (e: any) { throw new store.FhirError(422, e.message); }
    await log(req, 'backup', { detail: { bytes: file.length } });
    const name = `arogya-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.arogya-backup`;
    return reply.type('application/octet-stream').header('content-disposition', `attachment; filename="${name}"`).send(file);
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
    return (await db.query('select id,username,name,role,practitioner_id,active,created_at,(totp_secret is not null) as mfa from users order by username')).rows;
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
    const b = req.body as { active?: boolean; role?: Role; resetMfa?: boolean };
    if (id === req.user!.id && b.active === false) throw new store.FhirError(422, 'You cannot deactivate yourself');
    if (b.role && !ROLES.includes(b.role)) throw new store.FhirError(422, 'Unknown role');
    await db.query('update users set active=coalesce($2,active), role=coalesce($3,role) where id=$1', [id, b.active ?? null, b.role ?? null]);
    if (b.resetMfa) await db.query('update users set totp_secret=null, totp_pending=null, totp_last_step=null where id=$1', [id]);
    if (b.active === false || b.resetMfa || b.role) await db.query('delete from sessions where user_id=$1', [id]);
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
  app.get('/api/admin/integrity', async (req) => { need(req, 'admin'); return lastIntegrity(db); });
  app.post('/api/admin/integrity', async (req) => {
    need(req, 'admin');
    const r = await runIntegrity(db);
    await log(req, 'integrity-check', { detail: { status: r.status, failed: r.checks.filter((c) => c.status !== 'ok').map((c) => c.key) } });
    return r;
  });
  app.post('/api/admin/integrity/reindex', async (req) => {
    need(req, 'admin');
    const r = await rebuildIndex(db);
    await log(req, 'search-index-rebuild', { detail: r });
    return r;
  });
  /** Bulk NDJSON export: the same read rights as the type itself, two-step verification, and restricted records only with a reason. */
  app.get('/api/export/:type', async (req, reply) => {
    const type = typeOf(req); guard(req, 'read', type);
    if (!req.user!.mfa) throw new store.FhirError(403, 'Turn on two-step verification before exporting records');
    const all = (await db.query('select data from resources where type=$1 and not deleted order by id', [type])).rows.map((r) => r.data);
    const { rows, reason, hidden } = await screen(req, all, store.patientOf);
    await log(req, 'export', { type, detail: { count: rows.length, withheld: hidden }, reason });
    return reply.type('application/fhir+ndjson').send(rows.map((r) => JSON.stringify(r)).join('\n'));
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
