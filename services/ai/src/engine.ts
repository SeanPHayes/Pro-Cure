import type { AiJobKind } from '@procure/domain';
import {
  AppError,
  conflict,
  emit,
  notFound,
  type Principal,
  type Tx,
  unprocessable,
  withTenant,
} from '@procure/platform';
import { runBrandSpec } from './features/brand-spec/index.js';
import { errorMessage, PartialApplyError } from './features/common.js';
import { runDrawingSplit } from './features/drawing-split/index.js';
import { runInboxRoute } from './features/inbox/index.js';
import { runRiskScore } from './features/risk/index.js';
import type { FeatureRunner, JobRow } from './features/types.js';
import { runVendorQuote } from './features/vendor-quote/index.js';
import { Meter } from './llm.js';
import type { Logger } from './logger.js';

/**
 * AI job lifecycle.
 *
 *   queued ──run──▶ running ──▶ needs_review ──apply──▶ applied
 *                          │           └──discard──▶ completed (discarded_at set)
 *                          ├──▶ completed   (risk scoring, auto-routed inbox emails)
 *                          └──▶ failed      (error recorded; POST /jobs/:id/retry re-queues)
 *
 * Jobs run in-process right after the creating transaction commits. If the process dies, the
 * `stuck-jobs` scheduled job re-runs queued jobs older than 2 minutes and running jobs older than
 * 10 minutes, up to MAX_ATTEMPTS. Claiming is a conditional UPDATE so two replicas never run the same
 * attempt.
 */
export const MAX_ATTEMPTS = 3;
export const STUCK_RUNNING_MINUTES = 10;
export const STUCK_QUEUED_MINUTES = 2;

export const RUNNERS: Record<AiJobKind, FeatureRunner> = {
  brand_spec_extract: runBrandSpec,
  vendor_quote_extract: runVendorQuote,
  drawing_split: runDrawingSplit,
  inbox_route: runInboxRoute,
  risk_score: runRiskScore,
};

export interface NewJob {
  tenantId: string;
  kind: AiJobKind;
  title: string;
  input: Record<string, unknown>;
  entityType?: string | null;
  entityId?: string | null;
  createdBy?: string | null;
  createdByName?: string | null;
  idempotencyKey?: string | null;
}

/** Insert a queued job (or return the existing one for the same idempotency key). */
export async function insertJob(tx: Tx, j: NewJob): Promise<{ job: JobRow; created: boolean }> {
  await tx`insert into ai.tenants (tenant_id) values (${j.tenantId}) on conflict do nothing`;
  const rows = await tx<JobRow[]>`
    insert into ai.jobs (tenant_id, kind, title, input, entity_type, entity_id, created_by, created_by_name, idempotency_key)
    values (${j.tenantId}, ${j.kind}, ${j.title.slice(0, 300)}, ${tx.json(j.input as never)}, ${j.entityType ?? null},
            ${j.entityId ?? null}, ${j.createdBy ?? null}, ${j.createdByName ?? null}, ${j.idempotencyKey ?? null})
    on conflict (tenant_id, idempotency_key) where idempotency_key is not null do nothing
    returning *`;
  if (rows[0]) return { job: rows[0], created: true };
  const [existing] = await tx<JobRow[]>`
    select * from ai.jobs where tenant_id = ${j.tenantId} and idempotency_key = ${j.idempotencyKey!}`;
  if (!existing) throw conflict('Job with this idempotency key is being created');
  if (existing.kind !== j.kind) throw conflict('Idempotency key was used for a different kind of job');
  return { job: existing, created: false };
}

// ---------------------------------------------------------------- in-process execution
const inflight = new Set<Promise<unknown>>();
let defaultLog: Logger | undefined;
export const setEngineLogger = (l: Logger) => {
  defaultLog ??= l;
};

/** Tests: wait for all background job executions (including ones they start) to settle. */
export async function drainJobs() {
  while (inflight.size) await Promise.allSettled([...inflight]);
}

/** Run a job after the current transaction commits (fire-and-forget; errors are recorded on the job). */
export function scheduleJob(tenantId: string, jobId: string, log: Logger | undefined = defaultLog) {
  const p = new Promise<void>((resolve) => {
    setImmediate(() => {
      executeJob(tenantId, jobId, log)
        .catch((err) => log?.error({ err, jobId }, 'ai job execution crashed'))
        .finally(resolve);
    });
  });
  inflight.add(p);
  p.finally(() => inflight.delete(p));
  return p;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Claim a runnable job: queued, or running but stale. Retries briefly while the creator commits. */
async function claim(tenantId: string, jobId: string): Promise<JobRow | null> {
  for (let i = 0; i < 20; i++) {
    const res = await withTenant(tenantId, async (tx) => {
      const [row] = await tx<JobRow[]>`
        update ai.jobs set status = 'running', attempts = attempts + 1, started_at = now(), error = null
        where id = ${jobId} and attempts < ${MAX_ATTEMPTS}
          and (status = 'queued'
               or (status = 'running' and started_at < now() - make_interval(mins => ${STUCK_RUNNING_MINUTES})))
        returning *`;
      if (row) return { row };
      const [exists] = await tx<{ id: string }[]>`select id from ai.jobs where id = ${jobId}`;
      return { row: null, exists: !!exists };
    });
    if (res.row) return res.row;
    if (res.exists) return null;
    await sleep(50 * (i + 1));
  }
  return null;
}

export async function executeJob(tenantId: string, jobId: string, log: Logger | undefined = defaultLog) {
  const job = await claim(tenantId, jobId);
  if (!job) return null;
  const started = Date.now();
  const meter = new Meter();
  const childLog = (log?.child({ jobId, kind: job.kind }) ?? console) as Logger;
  try {
    const runner = RUNNERS[job.kind as AiJobKind];
    if (!runner) throw new Error(`Unknown job kind ${job.kind}`);
    const res = await runner({ tenantId, job, meter, log: childLog });
    const status = res.status ?? 'needs_review';
    return await withTenant(tenantId, async (tx) => {
      const [row] = await tx<JobRow[]>`
        update ai.jobs set status = ${status}, output = ${tx.json(res.output as never)}, error = null,
          provider = ${meter.provider}, model = ${meter.model}, input_tokens = ${meter.inputTokens},
          output_tokens = ${meter.outputTokens}, pages = ${res.pages ?? null}, duration_ms = ${Date.now() - started},
          completed_at = now(),
          entity_type = coalesce(${res.entity?.type ?? null}, entity_type),
          entity_id = coalesce(${res.entity?.id ?? null}::uuid, entity_id)
        where id = ${jobId} and status = 'running'
        returning *`;
      if (row)
        await emit(
          tx,
          'ai',
          'ai.job.completed',
          { jobId, kind: job.kind, status },
          { tenantId, actor: null },
        );
      return row ?? null;
    });
  } catch (err) {
    const message =
      err instanceof AppError
        ? `${err.message}${err.detail ? ` (${JSON.stringify(err.detail).slice(0, 300)})` : ''}`
        : errorMessage(err);
    if (err instanceof AppError && err.status < 500)
      childLog.info({ code: err.code, msg: err.message }, 'ai job failed');
    else childLog.warn({ err }, 'ai job failed');
    return withTenant(tenantId, async (tx) => {
      const [row] = await tx<JobRow[]>`
        update ai.jobs set status = 'failed', error = ${message}, provider = ${meter.provider}, model = ${meter.model},
          input_tokens = ${meter.inputTokens}, output_tokens = ${meter.outputTokens},
          duration_ms = ${Date.now() - started}, completed_at = now()
        where id = ${jobId} and status = 'running'
        returning *`;
      if (row)
        await emit(
          tx,
          'ai',
          'ai.job.completed',
          { jobId, kind: job.kind, status: 'failed' },
          { tenantId, actor: null },
        );
      return row ?? null;
    });
  }
}

/** Scheduled sweep: re-run jobs that never started or whose runner died; fail exhausted ones. */
export async function sweepStuckJobs(tx: Tx, log: Logger) {
  const exhausted = await tx<{ id: string; tenantId: string; kind: string }[]>`
    update ai.jobs set status = 'failed', completed_at = now(),
      error = coalesce(error, 'Job did not finish after ' || attempts || ' attempts')
    where status in ('queued', 'running') and attempts >= ${MAX_ATTEMPTS}
      and coalesce(started_at, created_at) < now() - make_interval(mins => ${STUCK_RUNNING_MINUTES})
    returning id, tenant_id, kind`;
  for (const j of exhausted)
    await emit(
      tx,
      'ai',
      'ai.job.completed',
      { jobId: j.id, kind: j.kind, status: 'failed' },
      { tenantId: j.tenantId, actor: null },
    );
  const stuck = await tx<{ id: string; tenantId: string }[]>`
    select id, tenant_id from ai.jobs
    where attempts < ${MAX_ATTEMPTS}
      and ((status = 'queued' and created_at < now() - make_interval(mins => ${STUCK_QUEUED_MINUTES}))
        or (status = 'running' and started_at < now() - make_interval(mins => ${STUCK_RUNNING_MINUTES})))
    order by created_at limit 50`;
  // Run after this transaction commits so the exhausted updates are visible and locks are released.
  for (const j of stuck) scheduleJob(j.tenantId, j.id, log);
  return { failed: exhausted.length, rescheduled: stuck.length };
}

// ---------------------------------------------------------------- apply
export const APPLY_LEASE_MINUTES = 5;

/**
 * Apply a reviewed job. The apply itself calls other services (not transactional with this DB), so
 * a short lease (apply_started_at) prevents two concurrent applies; partial results are saved so a
 * retried apply resumes instead of duplicating work.
 */
export async function applyJob(
  principal: Principal,
  jobId: string,
  apply: (job: JobRow) => Promise<Record<string, unknown> & { entity?: { type: string; id: string } }>,
): Promise<JobRow> {
  const tenantId = principal.tenantId;
  const job = await withTenant(tenantId, async (tx) => {
    const [row] = await tx<JobRow[]>`
      update ai.jobs set apply_started_at = now(), apply_error = null
      where id = ${jobId} and status = 'needs_review' and discarded_at is null
        and (apply_started_at is null or apply_started_at < now() - make_interval(mins => ${APPLY_LEASE_MINUTES}))
      returning *`;
    if (row) return row;
    const [cur] = await tx<JobRow[]>`select * from ai.jobs where id = ${jobId}`;
    if (!cur) throw notFound('AI job');
    if (cur.status === 'applied')
      throw conflict('This job has already been applied', { appliedAt: cur.appliedAt });
    if ((cur as any).discardedAt) throw conflict('This job was discarded');
    if (cur.status === 'needs_review') throw conflict('This job is being applied by someone else');
    throw unprocessable(`Only jobs awaiting review can be applied (status: ${cur.status})`);
  });
  try {
    const { entity, ...result } = await apply(job);
    return await withTenant(tenantId, async (tx) => {
      const [row] = await tx<JobRow[]>`
        update ai.jobs set status = 'applied', applied_at = now(), applied_by_name = ${principal.name},
          apply_result = ${tx.json(result as never)}, apply_started_at = null,
          entity_type = coalesce(${entity?.type ?? null}, entity_type),
          entity_id = coalesce(${entity?.id ?? null}::uuid, entity_id)
        where id = ${jobId}
        returning *`;
      await emit(
        tx,
        'ai',
        'ai.job.applied',
        {
          jobId,
          kind: row!.kind,
          entityType: row!.entityType,
          entityId: row!.entityId,
          appliedBy: principal.name,
        },
        { tenantId, actor: { userId: principal.userId, orgId: principal.orgId, name: principal.name } },
      );
      return row!;
    });
  } catch (err) {
    const partial = err instanceof PartialApplyError ? err.partial : null;
    await withTenant(
      tenantId,
      (tx) => tx`
      update ai.jobs set apply_started_at = null, apply_error = ${errorMessage(err)},
        apply_result = coalesce(${partial ? tx.json(partial as never) : null}, apply_result)
      where id = ${jobId}`,
    );
    if (err instanceof PartialApplyError && err.original instanceof Error) throw err.original;
    throw err;
  }
}
