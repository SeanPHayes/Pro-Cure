import { type Tx, withTenant } from '@procure/platform';
import { listOpenShipments, listShipmentHistory, type OpenShipment, postRiskScores } from '../../clients.js';
import { currentLlm, type Meter } from '../../llm.js';
import { today } from '../../text/util.js';
import type { FeatureRunner } from '../types.js';
import { heuristicNarrative, llmNarrative, type PortfolioSummary } from './llm.js';
import { COEFFICIENTS, features, type RiskScore, scoreFeatures } from './model.js';
import {
  PRIOR_STRENGTH,
  type Prior,
  priorProfile,
  type VendorProfile,
  vendorProfiles,
} from './performance.js';

export interface RiskRunOutput {
  runId: string;
  runAt: string;
  shipmentsScored: number;
  vendorsProfiled: number;
  counts: Record<'none' | 'watch' | 'at_risk' | 'critical', number>;
  prior: Record<string, number>;
  scores: (Omit<RiskScore, 'features' | 'terms'> & {
    poId: string | null;
    poNumber: string | null;
    projectName: string | null;
    vendorId: string;
    vendorName: string | null;
    label: string;
    terms: RiskScore['terms'];
    features: RiskScore['features'];
  })[];
  narrative: string;
  postedToOrders: boolean;
  postError: string | null;
}

const shipmentId = (s: OpenShipment) => (s.shipmentId ?? s.id)!;

/** Pure scoring step (exported for tests). */
export function scoreShipments(
  open: OpenShipment[],
  profiles: Map<string, VendorProfile>,
  prior: Prior,
  now = new Date(),
) {
  const t = today(now);
  return open
    .filter((s) => shipmentId(s))
    .map((s) => {
      const v = profiles.get(s.vendorId) ?? priorProfile(prior, s.vendorId);
      const r = scoreFeatures(shipmentId(s), features(s, v, t));
      return {
        ...r,
        poId: s.poId ?? null,
        poNumber: s.poNumber ?? null,
        projectName: s.projectName ?? null,
        vendorId: s.vendorId,
        vendorName: s.vendorName ?? null,
        label: [s.poNumber, s.label, s.vendorName].filter(Boolean).join(' · ') || shipmentId(s),
      };
    })
    .sort((a, b) => b.score - a.score);
}

async function saveProfiles(tx: Tx, tenantId: string, profiles: Map<string, VendorProfile>) {
  for (const p of profiles.values()) {
    await tx`
      insert into ai.vendor_performance (tenant_id, vendor_id, sample_size, on_time_rate, mean_slip_days, p90_slip_days,
        std_slip_days, mean_lead_time_weeks, ship_date_change_rate, raw, updated_at)
      values (${tenantId}, ${p.vendorId}, ${p.sampleSize}, ${p.onTimeRate}, ${p.meanSlipDays}, ${p.p90SlipDays},
        ${p.stdSlipDays}, ${p.meanLeadTimeWeeks}, ${p.shipDateChangeRate}, ${tx.json(p.raw as never)}, now())
      on conflict (tenant_id, vendor_id) do update set
        sample_size = excluded.sample_size, on_time_rate = excluded.on_time_rate, mean_slip_days = excluded.mean_slip_days,
        p90_slip_days = excluded.p90_slip_days, std_slip_days = excluded.std_slip_days,
        mean_lead_time_weeks = excluded.mean_lead_time_weeks, ship_date_change_rate = excluded.ship_date_change_rate,
        raw = excluded.raw, updated_at = now()`;
  }
}

export async function runRiskModel(
  tenantId: string,
  meter: Meter,
  log: { warn: (o: unknown, m?: string) => void },
  jobId: string | null,
  now = new Date(),
): Promise<RiskRunOutput> {
  const [history, open] = await Promise.all([listShipmentHistory(tenantId), listOpenShipments(tenantId)]);
  const { prior, profiles } = vendorProfiles(history);
  const scored = scoreShipments(open, profiles, prior, now);
  const counts = { none: 0, watch: 0, at_risk: 0, critical: 0 };
  for (const s of scored) counts[s.level]++;

  let postedToOrders = false;
  let postError: string | null = null;
  if (scored.length) {
    try {
      await postRiskScores(
        tenantId,
        scored.map((s) => ({ shipmentId: s.shipmentId, score: s.score, level: s.level, reasons: s.reasons })),
      );
      postedToOrders = true;
    } catch (err) {
      postError = (err as Error).message;
      log.warn({ err }, 'posting risk scores to orders failed');
    }
  }

  const vendorNames = new Map(open.map((s) => [s.vendorId, s.vendorName ?? null]));
  const summary: PortfolioSummary = {
    scored: scored.length,
    counts,
    top: scored
      .slice(0, 5)
      .map((s) => ({ label: s.label, score: s.score, level: s.level, reasons: s.reasons })),
    worstVendors: [...profiles.values()]
      .sort((a, b) => a.onTimeRate - b.onTimeRate)
      .slice(0, 3)
      .map((p) => ({
        name: vendorNames.get(p.vendorId) ?? p.vendorId,
        onTimeRate: p.onTimeRate,
        meanSlipDays: p.meanSlipDays,
        sampleSize: p.sampleSize,
      })),
  };
  let narrative = heuristicNarrative(summary);
  if (currentLlm().available && scored.length) {
    try {
      narrative = await llmNarrative(summary, meter);
    } catch (err) {
      log.warn({ err }, 'risk narrative LLM failed');
    }
  } else meter.heuristic();

  const params = {
    coefficients: COEFFICIENTS,
    priorStrength: PRIOR_STRENGTH,
    prior,
    historyCount: history.length,
  };
  const output = {
    shipmentsScored: scored.length,
    vendorsProfiled: profiles.size,
    counts,
    prior,
    scores: scored,
    narrative,
    postedToOrders,
    postError,
  };
  const run = await withTenant(tenantId, async (tx) => {
    await saveProfiles(tx, tenantId, profiles);
    const [r] = await tx<{ id: string; runAt: string }[]>`
      insert into ai.risk_model_runs (tenant_id, job_id, shipments_scored, vendors_profiled, params, output)
      values (${tenantId}, ${jobId}, ${scored.length}, ${profiles.size}, ${tx.json(params as never)},
              ${tx.json({ counts, narrative, top: scored.slice(0, 25) } as never)})
      returning id, run_at`;
    return r!;
  });
  return { runId: run.id, runAt: run.runAt, ...output } as RiskRunOutput;
}

export const runRiskScore: FeatureRunner = async ({ tenantId, job, meter, log }) => {
  const output = await runRiskModel(tenantId, meter, log, job.id);
  return { output: output as unknown as Record<string, unknown>, status: 'completed' };
};
