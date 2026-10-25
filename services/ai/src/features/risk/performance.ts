import type { ShipmentHistory } from '../../clients.js';
import { daysBetween, round } from '../../text/util.js';

/**
 * Vendor delivery performance with empirical-Bayes shrinkage.
 *
 * For each delivered shipment we observe
 *   late      = delivered after the requested delivery date (fallback: shipped > 3 days after plan)
 *   slipDays  = actual ship − planned ship (fallback: delivered − requested), floored at 0 for "late days"
 * A vendor's raw on-time rate with n observations is shrunk toward the tenant-wide prior p0 with a
 * Beta(k·p0, k·(1−p0)) prior:   onTime = (onTimeCount + k·p0) / (n + k)
 * Slip statistics are shrunk the same way: stat = (n·vendorStat + k·priorStat) / (n + k).
 * With k = PRIOR_STRENGTH = 8, a vendor with 2 perfect shipments scores ≈ prior + 20% of the way to
 * perfect, not 100%. When the tenant has no history the industry defaults below are the prior.
 */
export const PRIOR_STRENGTH = 8;
export const DEFAULT_PRIOR = {
  onTimeRate: 0.72,
  meanSlipDays: 6,
  p90SlipDays: 21,
  stdSlipDays: 9,
  meanLeadTimeWeeks: 14,
  shipDateChangeRate: 0.6,
};
export type Prior = typeof DEFAULT_PRIOR;

export interface Observation {
  vendorId: string;
  late: boolean;
  slipDays: number;
  changes: number;
  leadTimeWeeks: number | null;
}

export function observe(h: ShipmentHistory): Observation | null {
  let slip: number | null = null;
  if (h.plannedShipDate && h.actualShipDate) slip = daysBetween(h.plannedShipDate, h.actualShipDate);
  let late: boolean | null = null;
  if (h.requestedDeliveryDate && h.deliveredAt) {
    const d = daysBetween(h.requestedDeliveryDate, h.deliveredAt.slice(0, 10));
    late = d > 0;
    slip ??= d;
  }
  if (slip === null && late === null) return null;
  late ??= (slip ?? 0) > 3;
  let lead = h.leadTimeWeeks ?? null;
  if (lead == null && h.orderedAt && h.actualShipDate)
    lead = round(daysBetween(h.orderedAt, h.actualShipDate) / 7, 1);
  return {
    vendorId: h.vendorId,
    late,
    slipDays: Math.max(0, slip ?? 0),
    changes: Math.max(0, h.shipDateChanges ?? 0),
    leadTimeWeeks: lead,
  };
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const std = (xs: number[]) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
};
export const quantile = (xs: number[], q: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
};

interface RawStats {
  n: number;
  onTimeRate: number;
  meanSlipDays: number;
  p90SlipDays: number;
  stdSlipDays: number;
  meanLeadTimeWeeks: number | null;
  shipDateChangeRate: number;
}

const rawStats = (obs: Observation[]): RawStats => {
  const slips = obs.map((o) => o.slipDays);
  const leads = obs.map((o) => o.leadTimeWeeks).filter((x): x is number => x != null);
  return {
    n: obs.length,
    onTimeRate: obs.length ? obs.filter((o) => !o.late).length / obs.length : 0,
    meanSlipDays: mean(slips),
    p90SlipDays: quantile(slips, 0.9),
    stdSlipDays: std(slips),
    meanLeadTimeWeeks: leads.length ? mean(leads) : null,
    shipDateChangeRate: mean(obs.map((o) => o.changes)),
  };
};

/** Tenant-wide prior: pooled stats shrunk toward industry defaults when the tenant is small. */
export function tenantPrior(obs: Observation[]): Prior {
  if (!obs.length) return { ...DEFAULT_PRIOR };
  const r = rawStats(obs);
  const k = 20; // pooled data dominates once a tenant has more than ~20 deliveries
  const s = (x: number, d: number) => (r.n * x + k * d) / (r.n + k);
  return {
    onTimeRate: s(r.onTimeRate, DEFAULT_PRIOR.onTimeRate),
    meanSlipDays: s(r.meanSlipDays, DEFAULT_PRIOR.meanSlipDays),
    p90SlipDays: s(r.p90SlipDays, DEFAULT_PRIOR.p90SlipDays),
    stdSlipDays: s(r.stdSlipDays, DEFAULT_PRIOR.stdSlipDays),
    meanLeadTimeWeeks:
      r.meanLeadTimeWeeks == null
        ? DEFAULT_PRIOR.meanLeadTimeWeeks
        : s(r.meanLeadTimeWeeks, DEFAULT_PRIOR.meanLeadTimeWeeks),
    shipDateChangeRate: s(r.shipDateChangeRate, DEFAULT_PRIOR.shipDateChangeRate),
  };
}

export interface VendorProfile {
  vendorId: string;
  sampleSize: number;
  onTimeRate: number;
  meanSlipDays: number;
  p90SlipDays: number;
  stdSlipDays: number;
  meanLeadTimeWeeks: number;
  shipDateChangeRate: number;
  raw: RawStats;
}

export function shrink(raw: RawStats, prior: Prior, vendorId: string, k = PRIOR_STRENGTH): VendorProfile {
  const n = raw.n;
  const s = (x: number, p: number) => (n * x + k * p) / (n + k);
  return {
    vendorId,
    sampleSize: n,
    onTimeRate: round((raw.onTimeRate * n + k * prior.onTimeRate) / (n + k), 3),
    meanSlipDays: round(s(raw.meanSlipDays, prior.meanSlipDays), 2),
    p90SlipDays: round(s(raw.p90SlipDays, prior.p90SlipDays), 2),
    stdSlipDays: round(s(raw.stdSlipDays, prior.stdSlipDays), 2),
    meanLeadTimeWeeks: round(
      raw.meanLeadTimeWeeks == null
        ? prior.meanLeadTimeWeeks
        : s(raw.meanLeadTimeWeeks, prior.meanLeadTimeWeeks),
      2,
    ),
    shipDateChangeRate: round(s(raw.shipDateChangeRate, prior.shipDateChangeRate), 3),
    raw,
  };
}

export function vendorProfiles(history: ShipmentHistory[]) {
  const obs = history.map(observe).filter((o): o is Observation => !!o);
  const prior = tenantPrior(obs);
  const byVendor = new Map<string, Observation[]>();
  for (const o of obs) byVendor.set(o.vendorId, [...(byVendor.get(o.vendorId) ?? []), o]);
  const profiles = new Map<string, VendorProfile>();
  for (const [v, list] of byVendor) profiles.set(v, shrink(rawStats(list), prior, v));
  return { prior, profiles, observations: obs.length };
}

/** Profile for a vendor with no history: the prior itself (n = 0). */
export const priorProfile = (prior: Prior, vendorId: string): VendorProfile =>
  shrink(
    {
      n: 0,
      onTimeRate: 0,
      meanSlipDays: 0,
      p90SlipDays: 0,
      stdSlipDays: 0,
      meanLeadTimeWeeks: null,
      shipDateChangeRate: 0,
    },
    prior,
    vendorId,
  );
