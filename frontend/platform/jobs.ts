// The scheduled jobs (the Worker's cron): each runs on its own, and its result
// is kept so a failure doesn't go unnoticed.
//
//  - Every run and every job's last outcome is stored (platform_settings,
//    one key per job, so jobs finishing together never overwrite each other).
//  - A failing job emails the provider notification address, at most once an
//    hour per job, through the outbox (so it retries like any notice).
//  - System health shows when the jobs last ran and which are failing.

import { outboxStmt, getNotificationSettings } from './notify';

const RUN_KEY = 'jobs:last_run';
const jobKey = (name: string) => `job:${name}`;
const HOUR = 3_600_000;
/** The cron runs every 10 minutes; three missed runs is a problem. */
export const JOBS_STALE_MS = 30 * 60_000;

export interface JobOutcome {
  ok: boolean;
  at: number;
  /** When it started failing (kept while it keeps failing). */
  failingSince?: number;
  error?: string;
}

const upsert = (db: D1Database, key: string, value: unknown) => db.prepare(
  `INSERT INTO platform_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, NULL)
   ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
).bind(key, JSON.stringify(value), Date.now());

/** The error as a short line for the control centre: no stack, no secrets from URLs. */
function shortError(e: unknown): string {
  const text = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return text.replace(/([?&](?:token|key|secret|signature)=)[^&\s]+/gi, '$1…').slice(0, 300);
}

/** Notes that the cron ran. */
export function recordRun(db: D1Database): Promise<unknown> {
  return upsert(db, RUN_KEY, { at: Date.now() }).run().catch(e => console.error('recording the scheduled run failed', e));
}

/**
 * Runs one job and records how it went. Never throws: one failing job must
 * not stop the others.
 */
export async function runJob(db: D1Database, name: string, work: () => Promise<unknown>): Promise<void> {
  let previous: JobOutcome | null = null;
  try {
    const row = await db.prepare('SELECT value FROM platform_settings WHERE key = ?').bind(jobKey(name)).first<{ value: string }>();
    previous = row ? JSON.parse(row.value) as JobOutcome : null;
  } catch { /* first run, or unreadable: start afresh */ }

  const now = Date.now();
  try {
    await work();
    await upsert(db, jobKey(name), { ok: true, at: now } satisfies JobOutcome).run();
  } catch (e) {
    const error = shortError(e);
    console.error(`scheduled job ${name} failed`, error);
    const outcome: JobOutcome = { ok: false, at: now, failingSince: previous && !previous.ok ? previous.failingSince ?? previous.at : now, error };
    const statements = [upsert(db, jobKey(name), outcome)];
    const { providerEmail } = await getNotificationSettings(db).catch(() => ({ providerEmail: null }));
    if (providerEmail) {
      statements.push(outboxStmt(db, {
        // One alert an hour per job, however often it fails.
        dedupeKey: `alert:job:${name}:${Math.floor(now / HOUR)}`,
        kind: 'system_alert', recipient: providerEmail,
        subject: `Scheduled job failing: ${name}`,
        body: `The scheduled job "${name}" failed at ${new Date(now).toISOString()}${outcome.failingSince !== now ? ` (failing since ${new Date(outcome.failingSince!).toISOString()})` : ''}: ${error}. It is tried again every 10 minutes. See System health in the control centre.`,
      }));
    }
    await db.batch(statements).catch(err => console.error('recording a failed job failed', err));
  }
}

export interface JobsHealth {
  ok: boolean;
  detail: string;
  lastRunAt: number | null;
  jobs: ({ name: string } & JobOutcome)[];
}

/** For System health: when the cron last ran, and each job's last outcome. */
export async function jobsHealth(db: D1Database, now = Date.now()): Promise<JobsHealth> {
  const { results } = await db.prepare("SELECT key, value FROM platform_settings WHERE key = ? OR key LIKE 'job:%'").bind(RUN_KEY).all<{ key: string; value: string }>();
  let lastRunAt: number | null = null;
  const jobs: JobsHealth['jobs'] = [];
  for (const r of results) {
    try {
      const value = JSON.parse(r.value);
      if (r.key === RUN_KEY) lastRunAt = value.at;
      else jobs.push({ name: r.key.slice('job:'.length), ...value as JobOutcome });
    } catch { /* skip unreadable */ }
  }
  jobs.sort((a, b) => a.name.localeCompare(b.name));
  const failing = jobs.filter(j => !j.ok);
  if (lastRunAt === null) return { ok: false, detail: 'No scheduled run recorded yet (normal on a fresh or local setup)', lastRunAt, jobs };
  if (now - lastRunAt > JOBS_STALE_MS) return { ok: false, detail: `Last ran ${Math.round((now - lastRunAt) / 60_000)} minutes ago — the cron trigger may be off`, lastRunAt, jobs };
  if (failing.length) return { ok: false, detail: `Failing: ${failing.map(j => `${j.name} (${j.error})`).join('; ')}`, lastRunAt, jobs };
  return { ok: true, detail: `Ran ${Math.max(0, Math.round((now - lastRunAt) / 60_000))} minutes ago; ${jobs.length} jobs fine`, lastRunAt, jobs };
}
