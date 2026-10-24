import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { Db } from './db.ts';
import { getSetting, setSetting } from './domain.ts';
import { FhirError } from './fhir/store.ts';
import { seal, unseal } from './secrets.ts';

/**
 * Appointment reminders, sent through an SMS or email gateway the site chooses. Arogya POSTs each message
 * as JSON to the gateway URL, signed with HMAC-SHA256 so the gateway can reject forgeries.
 * Messages carry no clinical detail: a text can be read by someone else on the patient's phone.
 */
export type ReminderSettings = { enabled: boolean; hoursBefore: number; webhookUrl: string; clinicName: string; clinicPhone: string; secret?: string };
export const DEFAULT_REMINDERS: ReminderSettings = { enabled: false, hoursBefore: 48, webhookUrl: '', clinicName: '', clinicPhone: '' };
const MAX_ATTEMPTS = 3;
export const NO_REMINDERS = 'urn:arogya:no-reminders';

export const reminderSettings = (db: Db) => getSetting<ReminderSettings>(db, 'reminders', DEFAULT_REMINDERS);

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
    enabled: !!b.enabled, hoursBefore: hours, webhookUrl: url, clinicName: String(b.clinicName ?? '').slice(0, 60), clinicPhone: String(b.clinicPhone ?? '').slice(0, 30), secret: sealed,
  });
  return { secret };
}

const dayName = (d: Date) => d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
const hhmm = (iso: string) => iso.slice(11, 16);

export function message(start: string, s: ReminderSettings) {
  const where = s.clinicName ? ` at ${s.clinicName}` : '';
  const call = s.clinicPhone ? ` To cancel or change, call ${s.clinicPhone}.` : '';
  return `Reminder: you have an appointment${where} on ${dayName(new Date(start))} at ${hhmm(start)}.${call}`;
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

/** Send queued messages. Failures are retried on later runs, up to three attempts. */
export async function deliver(db: Db, fetcher: typeof fetch = fetch) {
  const s = await reminderSettings(db);
  if (!s.enabled || !s.webhookUrl || !s.secret) return { sent: 0, failed: 0 };
  const secret = unseal(s.secret);
  const rows = (await db.query(`select * from outbox where status='queued' order by created_at limit 100`)).rows;
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

export async function runReminders(db: Db, fetcher?: typeof fetch) {
  const queued = await queueDue(db);
  return { queued, ...(await deliver(db, fetcher)) };
}
