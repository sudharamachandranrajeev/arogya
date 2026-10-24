import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Db } from './db.ts';
import { afterWrite, getSetting, setSetting } from './domain.ts';
import { FhirError, read, update } from './fhir/store.ts';
import { seal, unseal } from './secrets.ts';

/**
 * Appointment reminders, sent through an SMS or email gateway the site chooses. Arogya POSTs each message
 * as JSON to the gateway URL, signed with HMAC-SHA256 so the gateway can reject forgeries.
 * Messages carry no clinical detail: a text can be read by someone else on the patient's phone.
 * With two-way replies on, the gateway POSTs patients' answers back to /api/reminders/reply, signed the same way.
 */
export type ReminderSettings = { enabled: boolean; hoursBefore: number; webhookUrl: string; clinicName: string; clinicPhone: string; twoWay: boolean; secret?: string };
export const DEFAULT_REMINDERS: ReminderSettings = { enabled: false, hoursBefore: 48, webhookUrl: '', clinicName: '', clinicPhone: '', twoWay: false };
const MAX_ATTEMPTS = 3;
export const NO_REMINDERS = 'urn:arogya:no-reminders';
export const CONFIRMED = 'urn:arogya:patient-confirmed';
const SKEW_SECONDS = 300;

export const reminderSettings = async (db: Db) => ({ ...DEFAULT_REMINDERS, ...(await getSetting<Partial<ReminderSettings>>(db, 'reminders', DEFAULT_REMINDERS)) });

/** Save settings. A signing secret is made on first save and returned once; `rotate` makes a new one. */
export async function saveReminderSettings(db: Db, b: Partial<ReminderSettings> & { rotate?: boolean }) {
  const cur = await reminderSettings(db);
  const url = String(b.webhookUrl ?? '').trim();
  if (url) {
    let u: URL;
    try { u = new URL(url); } catch { throw new FhirError(422, 'Gateway URL is not a valid URL'); }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) throw new FhirError(422, 'Gateway URL must use https (http is allowed only for a gateway on this machine)');
  }
  const hours = Number(b.hoursBefore);
  if (!Number.isInteger(hours) || hours < 1 || hours > 168) throw new FhirError(422, 'Send reminders 1 to 168 hours before');
  if (b.enabled && !url) throw new FhirError(422, 'Set a gateway URL before turning reminders on');
  let secret: string | undefined;
  const sealed = !cur.secret || b.rotate ? seal((secret = randomBytes(32).toString('base64url'))) : cur.secret;
  await setSetting(db, 'reminders', {
    enabled: !!b.enabled, hoursBefore: hours, webhookUrl: url, clinicName: String(b.clinicName ?? '').slice(0, 60), clinicPhone: String(b.clinicPhone ?? '').slice(0, 30),
    twoWay: !!b.twoWay, secret: sealed,
  });
  return { secret };
}

const dayName = (d: Date) => d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
const hhmm = (iso: string) => iso.slice(11, 16);

export function message(start: string, s: ReminderSettings) {
  const where = s.clinicName ? ` at ${s.clinicName}` : '';
  const call = s.clinicPhone ? ` To change, call ${s.clinicPhone}.` : '';
  const reply = s.twoWay ? ' Reply C to confirm or X to cancel.' : '';
  return `Reminder: you have an appointment${where} on ${dayName(new Date(start))} at ${hhmm(start)}.${reply}${call}`;
}

/**
 * Queue a reminder for every booked appointment starting within the window. Each appointment gets at most one.
 * Patients without a phone, who opted out, or whose record is restricted get a "skipped" row instead, so staff can see why.
 */
export async function queueDue(db: Db, now = new Date()) {
  const s = await reminderSettings(db);
  if (!s.enabled) return 0;
  const until = new Date(now.getTime() + s.hoursBefore * 3600_000);
  const appts = (await db.query(
    `select a.id, a.data from resources a where a.type='Appointment' and not a.deleted and a.data->>'status'='booked'
     and (a.data->>'start')::timestamptz between $1 and $2
     and not exists (select 1 from outbox o where o.appointment_id=a.id and o.channel='sms')`, [now.toISOString(), until.toISOString()])).rows;
  let n = 0;
  for (const { id, data: a } of appts) {
    const pid = a.participant?.map((p: any) => p.actor?.reference).find((r: string) => r?.startsWith('Patient/'))?.slice(8);
    const p = pid ? (await db.query(`select data from resources where type='Patient' and id=$1 and not deleted`, [pid])).rows[0]?.data : null;
    const phone = p?.telecom?.find((t: any) => t.system === 'phone' && (t.use === 'mobile' || !t.use))?.value ?? null;
    const skip = !p ? 'no patient on the appointment'
      : p.extension?.some((e: any) => e.url === NO_REMINDERS && e.valueBoolean) ? 'patient asked not to get reminders'
      : p.meta?.security?.some((x: any) => x.code === 'R' || x.code === 'V') ? 'restricted record: no messages'
      : !phone ? 'no phone number' : null;
    const r = await db.query(
      `insert into outbox(id,appointment_id,patient_id,channel,to_addr,body,status,detail) values ($1,$2,$3,'sms',$4,$5,$6,$7) on conflict do nothing returning id`,
      [randomUUID(), id, pid ?? null, skip ? null : phone, message(a.start, s), skip ? 'skipped' : 'queued', skip]);
    n += r.rows.length;
  }
  return n;
}

export const sign = (secret: string, body: string) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

/**
 * Send queued messages. Failures are retried on later runs, up to three attempts.
 * Rows are claimed first (status 'sending'), so the background job and a manual run never send one twice.
 */
export async function deliver(db: Db, fetcher: typeof fetch = fetch) {
  const s = await reminderSettings(db);
  if (!s.enabled || !s.webhookUrl || !s.secret) return { sent: 0, failed: 0 };
  const secret = unseal(s.secret);
  // A claim older than ten minutes belongs to a run that died part-way: hand it back.
  await db.query(`update outbox set status='queued' where status='sending' and claimed_at < now() - interval '10 minutes'`);
  const rows = (await db.query(
    `update outbox set status='sending', claimed_at=now() where id in
       (select id from outbox where status='queued' order by created_at limit 100 for update skip locked) returning *`)).rows;
  let sent = 0, failed = 0;
  for (const m of rows) {
    // Cancelled since it was queued? Then say nothing.
    const a = (await db.query(`select data->>'status' as status from resources where type='Appointment' and id=$1`, [m.appointment_id])).rows[0];
    if (a?.status !== 'booked') { await db.query(`update outbox set status='skipped', detail='appointment no longer booked' where id=$1`, [m.id]); continue; }
    const body = JSON.stringify({ id: m.id, channel: m.channel, to: m.to_addr, text: m.body });
    let err: string | null = null;
    try {
      const r = await fetcher(s.webhookUrl, { method: 'POST', headers: { 'content-type': 'application/json', 'x-arogya-signature': sign(secret, body) }, body, signal: AbortSignal.timeout(10_000), redirect: 'error' });
      if (!r.ok) err = `gateway answered ${r.status}`;
    } catch (e: any) { err = String(e?.message ?? e).slice(0, 200); }
    if (!err) { sent++; await db.query(`update outbox set status='sent', sent_at=now(), attempts=attempts+1, detail=null where id=$1`, [m.id]); }
    else { failed++; await db.query(`update outbox set attempts=attempts+1, detail=$2, status=case when attempts+1 >= $3 then 'failed' else 'queued' end where id=$1`, [m.id, err, MAX_ATTEMPTS]); }
  }
  return { sent, failed };
}

/** Check a gateway callback: HMAC over "<timestamp>.<raw body>", with the timestamp within five minutes so a captured request cannot be replayed later. */
export async function verifyInbound(db: Db, timestamp: string, raw: string, signature: string, now = Date.now()) {
  const s = await reminderSettings(db);
  if (!s.enabled || !s.twoWay || !s.secret) throw new FhirError(404, 'Two-way replies are off');
  const ts = Number(timestamp);
  if (!Number.isInteger(ts) || Math.abs(now / 1000 - ts) > SKEW_SECONDS) throw new FhirError(401, 'Stale or missing X-Arogya-Timestamp');
  const want = Buffer.from(sign(unseal(s.secret), `${ts}.${raw}`));
  const got = Buffer.from(String(signature));
  if (want.length !== got.length || !timingSafeEqual(want, got)) throw new FhirError(401, 'Bad signature');
}

const WORDS: Record<string, 'confirm' | 'cancel' | 'stop'> = {
  C: 'confirm', CONFIRM: 'confirm', YES: 'confirm', Y: 'confirm', OK: 'confirm',
  X: 'cancel', CANCEL: 'cancel', NO: 'cancel', N: 'cancel',
  STOP: 'stop', UNSUBSCRIBE: 'stop', STOPALL: 'stop',
};
const digits = (s: unknown) => String(s ?? '').replace(/\D/g, '').slice(-9);

/**
 * Act on a patient's reply. C confirms, X cancels (the freed slot goes to the backfill queue), STOP opts out of
 * reminders. Anything else becomes a message for reception, so no reply is lost. Each gateway message id is acted on once.
 */
export async function handleReply(db: Db, b: { messageId?: string; inReplyTo?: string; from?: string; text?: string }) {
  const text = String(b.text ?? '').trim().slice(0, 500);
  if (!text) throw new FhirError(422, 'text required');
  const id = b.messageId ? `gw:${String(b.messageId).slice(0, 100)}` : randomUUID();
  if ((await db.query('select 1 from inbound where id=$1', [id])).rows.length) return { action: 'duplicate' as const };
  // Prefer the message the gateway says this answers; otherwise the latest reminder sent to this number for an appointment still to come.
  const m = (await db.query(
    `select o.* from outbox o join resources a on a.type='Appointment' and a.id=o.appointment_id
     where o.status='sent' and (o.id=$1 or ($1 = '' and right(regexp_replace(coalesce(o.to_addr,''), '\\D', '', 'g'), 9) = $2 and $2 <> ''))
       and (a.data->>'start')::timestamptz > now() order by o.sent_at desc limit 1`, [String(b.inReplyTo ?? ''), digits(b.from)])).rows[0];
  const word = WORDS[text.toUpperCase().replace(/[^A-Z]/g, '')];
  let action: string;
  if (!m) {
    action = 'unmatched';
    await task(db, null, null, `Text from ${maskPhone(b.from)} that matches no upcoming reminder: ${text}`);
  } else if (word === 'stop') {
    const p = await read(db, 'Patient', m.patient_id);
    await update(db, 'Patient', p.id, { ...p, extension: [...(p.extension ?? []).filter((e: any) => e.url !== NO_REMINDERS), { url: NO_REMINDERS, valueBoolean: true }] });
    action = 'stopped';
  } else {
    const a = await read(db, 'Appointment', m.appointment_id);
    if (a.status !== 'booked') action = 'too-late';
    else if (word === 'confirm') {
      await update(db, 'Appointment', a.id, { ...a, extension: [...(a.extension ?? []).filter((e: any) => e.url !== CONFIRMED), { url: CONFIRMED, valueDateTime: new Date().toISOString() }] }, Number(a.meta.versionId));
      action = 'confirmed';
    } else if (word === 'cancel') {
      const { res } = await update(db, 'Appointment', a.id, { ...a, status: 'cancelled', cancelationReason: { text: 'Patient cancelled by text reply' } }, Number(a.meta.versionId));
      await afterWrite(db, 'Appointment', res, false);
      action = 'cancelled';
    } else {
      await task(db, m.patient_id, m.appointment_id, `Reply to appointment reminder: ${text}`);
      action = 'message';
    }
  }
  await db.query('insert into inbound(id,outbox_id,from_addr,body,action) values ($1,$2,$3,$4,$5) on conflict do nothing', [id, m?.id ?? null, maskPhone(b.from), text, action]);
  return { action, patientId: m?.patient_id as string | undefined, appointmentId: m?.appointment_id as string | undefined };
}

const maskPhone = (p: unknown) => { const d = String(p ?? '').replace(/\D/g, ''); return d ? `…${d.slice(-4)}` : 'an unknown number'; };
const task = (db: Db, patientId: string | null, apptId: string | null, subject: string) =>
  db.query(`insert into tasks(id,kind,patient_id,subject,ref_type,ref_id,pool) values ($1,'message',$2,$3,$4,$5,'scheduling')`,
    [randomUUID(), patientId, subject.slice(0, 300), apptId ? 'Appointment' : null, apptId]);

export async function runReminders(db: Db, fetcher?: typeof fetch) {
  const queued = await queueDue(db);
  return { queued, ...(await deliver(db, fetcher)) };
}
