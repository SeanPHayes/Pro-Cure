import type { Logger } from 'pino';
import { config } from './config.js';
import { sql, type Tx, withSystem } from './db.js';

/**
 * Recurring background jobs (ship-date confirmations, cost expiry sweeps, risk scoring...). Every
 * replica schedules them, but each run takes a transaction-scoped advisory lock so only one replica
 * executes a given job at a time. In AWS this is equivalent to an EventBridge Scheduler target but
 * keeps job code next to the service that owns the data.
 */
export interface Job {
  name: string;
  everyMs: number;
  /** Delay before first run; defaults to a small jitter. */
  initialDelayMs?: number;
  run: (ctx: { tx: Tx; log: Logger; now: Date }) => Promise<Record<string, unknown> | undefined | void>;
}

export const minutes = (n: number) => n * 60_000;
export const hours = (n: number) => n * 3_600_000;

export async function runJobOnce(service: string, job: Job, log: Logger) {
  const key = `${service}:${job.name}`;
  return withSystem(async (tx) => {
    const [lock] = await tx<{ ok: boolean }[]>`select pg_try_advisory_xact_lock(hashtext(${key})) as ok`;
    if (!lock?.ok) return { skipped: true };
    const [run] = await sql()<{ id: number }[]>`
      insert into platform.job_runs (service, job) values (${service}, ${job.name}) returning id`;
    try {
      const detail = (await job.run({ tx, log: log.child({ job: job.name }), now: new Date() })) ?? {};
      await sql()`update platform.job_runs set status = 'succeeded', finished_at = now(), detail = ${sql().json(
        detail as never,
      )} where id = ${run!.id}`;
      return detail;
    } catch (err) {
      await sql()`update platform.job_runs set status = 'failed', finished_at = now(), error = ${(err as Error).message}
                  where id = ${run!.id}`;
      throw err;
    }
  });
}

export function startJobs(service: string, jobs: Job[], log: Logger) {
  if (!config().JOBS_ENABLED || config().APP_ENV === 'test' || !jobs.length) return () => {};
  const timers: NodeJS.Timeout[] = [];
  for (const job of jobs) {
    const fire = () =>
      runJobOnce(service, job, log).catch((err) => log.error({ err, job: job.name }, 'scheduled job failed'));
    const first = setTimeout(
      () => {
        fire();
        timers.push(setInterval(fire, job.everyMs));
      },
      job.initialDelayMs ?? 5_000 + Math.floor(Math.random() * 5_000),
    );
    timers.push(first);
  }
  return () => timers.forEach(clearTimeout);
}
