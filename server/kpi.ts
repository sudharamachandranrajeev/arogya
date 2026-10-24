import type { Db } from './db.ts';
import { search } from './fhir/store.ts';
import { getSetting, waitingList, DEFAULT_TARGET_DAYS } from './domain.ts';

const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);

export async function kpis(db: Db, sinceDays = 90) {
  const since = new Date(Date.now() - sinceDays * 86400_000).toISOString().slice(0, 10);
  const wl = await waitingList(db);
  const appts = (await search(db, 'Appointment', { date: `ge${since}`, _count: '200' })).resources;
  const count = (s: string) => appts.filter((a) => a.status === s).length;
  const attended = count('fulfilled'), dna = count('noshow'), cancelled = count('cancelled');
  const booked = appts.filter((a) => ['fulfilled', 'noshow', 'booked', 'arrived'].includes(a.status)).length;
  const targets = await getSetting(db, 'targets', DEFAULT_TARGET_DAYS);
  const tasks = (await db.query(
    `select kind, count(*)::int n, coalesce(avg(extract(epoch from (now()-created_at))/86400),0) age,
            count(*) filter (where normal)::int normal
     from tasks where status='open' group by kind`)).rows;
  const turnaround = (await db.query(
    `select coalesce(avg(extract(epoch from (done_at-created_at))/3600),0) h, count(*)::int n from tasks
     where kind='result' and status='done' and done_at > now() - ($1 || ' days')::interval`, [String(sinceDays)])).rows[0];
  const overrides = Number((await db.query(`select count(*) n from override_log where at > now() - ($1 || ' days')::interval`, [String(sinceDays)])).rows[0].n);
  const rx = (await search(db, 'MedicationRequest', { _count: '0' })).total;
  return {
    sinceDays,
    waitingList: {
      size: wl.length,
      averageWaitDays: wl.length ? Math.round(wl.reduce((s, w) => s + w.waitingDays, 0) / wl.length) : 0,
      longestWaitDays: wl.reduce((m, w) => Math.max(m, w.waitingDays), 0),
      breached: wl.filter((w) => w.breached).length,
      withinTargetPct: pct(wl.filter((w) => !w.breached).length, wl.length),
      breachingSoon: wl.filter((w) => !w.breached && w.daysToBreach <= 14).length,
      targets,
    },
    appointments: {
      booked, attended, dna, cancelled,
      dnaRatePct: pct(dna, attended + dna), cancellationRatePct: pct(cancelled, booked + cancelled),
      lostSlots: dna + cancelled,
    },
    inbox: {
      open: tasks.reduce((s, t) => s + t.n, 0),
      byKind: Object.fromEntries(tasks.map((t) => [t.kind, { open: t.n, avgAgeDays: Math.round(t.age * 10) / 10, normalResults: t.normal }])),
      resultTurnaroundHours: Math.round(Number(turnaround.h) * 10) / 10,
      resultsClosed: turnaround.n,
    },
    safety: {
      prescriptions: rx, alertOverrides: overrides,
      interruptiveAlertRatePct: pct(overrides, rx),
    },
  };
}
