import { hours, type Job, minutes, withSystem } from '@procure/platform';
import { sweepStuckJobs } from './engine.js';
import { errorMessage } from './features/common.js';
import { runRiskModel } from './features/risk/index.js';
import { Meter } from './llm.js';

/**
 * Scheduled jobs.
 *  - risk-model (6h): for every registered tenant, profile vendors from delivery history and score open
 *    shipments; recorded as a risk_score AI job (status completed) per tenant so it shows in job history.
 *  - stuck-jobs (2 min): re-run AI jobs that were queued/running too long (max 3 attempts).
 */
export const jobs: Job[] = [
  {
    name: 'risk-model',
    everyMs: hours(6),
    initialDelayMs: minutes(1),
    run: async ({ tx, log }) => {
      const tenants = await tx<
        { tenantId: string }[]
      >`select tenant_id from ai.tenants where risk_enabled order by tenant_id`;
      const results: Record<string, unknown> = {};
      for (const { tenantId } of tenants) {
        const started = Date.now();
        const meter = new Meter();
        const [job] = await withSystem(
          (t) => t<{ id: string }[]>`
            insert into ai.jobs (tenant_id, kind, status, title, input, created_by_name, started_at, attempts)
            values (${tenantId}, 'risk_score', 'running', 'Shipment risk scoring (scheduled)', '{}', 'Pro-Cure scheduler', now(), 1)
            returning id`,
          tenantId,
        );
        try {
          const out = await runRiskModel(tenantId, meter, log, job!.id);
          await withSystem(
            (t) => t`
              update ai.jobs set status = 'completed', output = ${t.json(out as never)}, provider = ${meter.provider},
                model = ${meter.model}, input_tokens = ${meter.inputTokens}, output_tokens = ${meter.outputTokens},
                duration_ms = ${Date.now() - started}, completed_at = now()
              where id = ${job!.id}`,
            tenantId,
          );
          results[tenantId] = { scored: out.shipmentsScored, vendors: out.vendorsProfiled };
        } catch (err) {
          log.warn({ err, tenantId }, 'risk model failed for tenant');
          await withSystem(
            (t) => t`update ai.jobs set status = 'failed', error = ${errorMessage(err)}, completed_at = now(),
                     duration_ms = ${Date.now() - started} where id = ${job!.id}`,
            tenantId,
          );
          results[tenantId] = { error: errorMessage(err) };
        }
      }
      return { tenants: tenants.length, results };
    },
  },
  {
    name: 'stuck-jobs',
    everyMs: minutes(2),
    run: async ({ tx, log }) => sweepStuckJobs(tx, log),
  },
];
