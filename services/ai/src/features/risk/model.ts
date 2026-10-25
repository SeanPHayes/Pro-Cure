import type { OpenShipment } from '../../clients.js';
import { addDays, clamp, daysBetween, round } from '../../text/util.js';
import type { VendorProfile } from './performance.js';

/**
 * Late-delivery risk model — a transparent, hand-set logistic regression.
 *
 *   z = INTERCEPT + Σ termᵢ          P(late) = 1 / (1 + e^−z)          score = round(100·P)
 *
 * Terms (each is computed and reported, so every score can be explained line by line):
 *
 * | term              | definition                                                        | coefficient          |
 * |-------------------|-------------------------------------------------------------------|----------------------|
 * | buffer            | margin = slack_days − vendor p90 slip days, clamped to ±45        | −0.07 per day        |
 * |                   | slack_days = requested delivery − estimated delivery              |                      |
 * |                   | (estimated delivery = est. delivery, else est. ship + transit)    |                      |
 * | vendor_reliability| vendor late rate (1 − shrunk on-time rate) − 0.25                 | +3.0                 |
 * | ship_date_changes | number of times the ship date moved (cap 5)                       | +0.35 each           |
 * | requirements      | pending pre-order requirements (cap 4)                            | +0.25 each           |
 * | release_by        | requirements pending and release-by date passed / within 7 days   | +0.9 / +0.45         |
 * | international     | origin is international (customs, ocean freight variance)         | +0.5                 |
 * | stale_confirmation| days since the vendor last confirmed the ship date beyond 21       | +0.025/day (cap 0.8) |
 * | lead_time         | (lead time − vendor mean lead time) / vendor mean, clamped −0.5..1| +0.6                 |
 * | unknown_dates     | no requested or estimated date (can't compute slack)              | +0.4                 |
 *
 * INTERCEPT = −1.4 puts a typical domestic order from an average vendor with two weeks of buffer
 * beyond the vendor's p90 slip at ≈ 8% (none). Levels: none < 25 ≤ watch < 50 ≤ at_risk < 75 ≤ critical.
 *
 * Monotonicity (tested): more slack → lower score; a worse vendor (higher late rate or p90 slip) → higher.
 */
export const COEFFICIENTS = {
  intercept: -1.4,
  bufferPerDay: -0.07,
  bufferClampDays: 45,
  vendorLateRate: 3.0,
  vendorLateRateCenter: 0.25,
  shipDateChange: 0.35,
  shipDateChangeCap: 5,
  pendingRequirement: 0.25,
  pendingRequirementCap: 4,
  releaseByPassed: 0.9,
  releaseBySoon: 0.45,
  international: 0.5,
  staleConfirmationPerDay: 0.025,
  staleConfirmationAfterDays: 21,
  staleConfirmationCap: 0.8,
  leadTime: 0.6,
  unknownDates: 0.4,
} as const;

export const DEFAULT_TRANSIT_DAYS = { domestic: 7, international: 42 } as const;

export type RiskLevel = 'none' | 'watch' | 'at_risk' | 'critical';
export const levelFor = (score: number): RiskLevel =>
  score >= 75 ? 'critical' : score >= 50 ? 'at_risk' : score >= 25 ? 'watch' : 'none';

export interface RiskFeatures {
  slackDays: number | null;
  estimatedDelivery: string | null;
  daysToReleaseBy: number | null;
  pendingRequirements: number;
  international: boolean;
  shipDateChanges: number;
  daysSinceConfirmation: number | null;
  vendorOnTimeRate: number;
  vendorP90SlipDays: number;
  vendorMeanSlipDays: number;
  vendorSampleSize: number;
  leadTimeWeeks: number | null;
  vendorMeanLeadTimeWeeks: number;
}

export interface RiskTerm {
  term: string;
  contribution: number;
  reason: string;
}

export interface RiskScore {
  shipmentId: string;
  score: number;
  probability: number;
  level: RiskLevel;
  reasons: string[];
  terms: RiskTerm[];
  features: RiskFeatures;
}

const plural = (n: number, w: string) => `${n} ${w}${Math.abs(n) === 1 ? '' : 's'}`;

export function features(s: OpenShipment, v: VendorProfile, today: string): RiskFeatures {
  const international = (s.origin ?? '').toLowerCase() === 'international';
  const transit =
    s.transitDays ?? (international ? DEFAULT_TRANSIT_DAYS.international : DEFAULT_TRANSIT_DAYS.domestic);
  const estimatedDelivery =
    s.estimatedDeliveryDate ?? (s.estimatedShipDate ? addDays(s.estimatedShipDate, transit) : null);
  const slackDays =
    s.requestedDeliveryDate && estimatedDelivery
      ? daysBetween(estimatedDelivery, s.requestedDeliveryDate)
      : null;
  const confirmed = s.lastConfirmedAt ?? s.confirmedAt ?? null;
  return {
    slackDays,
    estimatedDelivery,
    daysToReleaseBy: s.releaseByDate ? daysBetween(today, s.releaseByDate) : null,
    pendingRequirements: Math.max(0, s.pendingRequirements ?? 0),
    international,
    shipDateChanges: Math.max(0, s.shipDateChanges ?? 0),
    daysSinceConfirmation: confirmed ? Math.max(0, daysBetween(confirmed.slice(0, 10), today)) : null,
    vendorOnTimeRate: v.onTimeRate,
    vendorP90SlipDays: v.p90SlipDays,
    vendorMeanSlipDays: v.meanSlipDays,
    vendorSampleSize: v.sampleSize,
    leadTimeWeeks: s.leadTimeWeeks ?? null,
    vendorMeanLeadTimeWeeks: v.meanLeadTimeWeeks,
  };
}

export function scoreFeatures(shipmentId: string, f: RiskFeatures): RiskScore {
  const C = COEFFICIENTS;
  const terms: RiskTerm[] = [];
  const add = (term: string, contribution: number, reason: string) => {
    if (contribution !== 0) terms.push({ term, contribution: round(contribution, 3), reason });
  };

  if (f.slackDays === null) {
    add(
      'unknown_dates',
      C.unknownDates,
      'No requested delivery or estimated ship date to measure slack against',
    );
  } else {
    const margin = clamp(f.slackDays - f.vendorP90SlipDays, -C.bufferClampDays, C.bufferClampDays);
    const reason =
      f.slackDays < 0
        ? `Estimated delivery is ${plural(-f.slackDays, 'day')} after the requested delivery date`
        : `Only ${plural(f.slackDays, 'day')} of slack before the requested delivery date` +
          (f.vendorP90SlipDays >= 1
            ? ` (vendor's late shipments slip up to ${Math.round(f.vendorP90SlipDays)})`
            : '');
    add(
      'buffer',
      C.bufferPerDay * margin,
      margin < 0 ? reason : `${plural(f.slackDays, 'day')} of slack before the requested delivery date`,
    );
  }

  const lateRate = 1 - f.vendorOnTimeRate;
  add(
    'vendor_reliability',
    C.vendorLateRate * (lateRate - C.vendorLateRateCenter),
    f.vendorSampleSize
      ? `Vendor ships late ${Math.round(lateRate * 100)}% of the time (avg ${Math.round(f.vendorMeanSlipDays)} days, ${plural(f.vendorSampleSize, 'shipment')})`
      : `No delivery history for this vendor; assuming the portfolio average (${Math.round(lateRate * 100)}% late)`,
  );

  const changes = Math.min(f.shipDateChanges, C.shipDateChangeCap);
  if (changes)
    add(
      'ship_date_changes',
      C.shipDateChange * changes,
      `Ship date has moved ${changes === 1 ? 'once' : `${f.shipDateChanges} times`}`,
    );

  const pending = Math.min(f.pendingRequirements, C.pendingRequirementCap);
  if (pending)
    add(
      'requirements',
      C.pendingRequirement * pending,
      `${plural(f.pendingRequirements, 'pre-order requirement')} still pending`,
    );
  if (f.pendingRequirements > 0 && f.daysToReleaseBy !== null) {
    if (f.daysToReleaseBy < 0)
      add(
        'release_by',
        C.releaseByPassed,
        `Release-by date passed ${plural(-f.daysToReleaseBy, 'day')} ago with requirements open`,
      );
    else if (f.daysToReleaseBy <= 7)
      add(
        'release_by',
        C.releaseBySoon,
        `Release-by date is in ${plural(f.daysToReleaseBy, 'day')} with requirements open`,
      );
  }

  if (f.international)
    add('international', C.international, 'International origin (ocean freight and customs variability)');

  if (f.daysSinceConfirmation !== null && f.daysSinceConfirmation > C.staleConfirmationAfterDays)
    add(
      'stale_confirmation',
      Math.min(
        C.staleConfirmationCap,
        C.staleConfirmationPerDay * (f.daysSinceConfirmation - C.staleConfirmationAfterDays),
      ),
      `Ship date not reconfirmed in ${f.daysSinceConfirmation} days`,
    );

  if (f.leadTimeWeeks != null && f.vendorMeanLeadTimeWeeks > 0) {
    const rel = clamp((f.leadTimeWeeks - f.vendorMeanLeadTimeWeeks) / f.vendorMeanLeadTimeWeeks, -0.5, 1);
    if (Math.abs(rel) >= 0.1)
      add(
        'lead_time',
        C.leadTime * rel,
        `Lead time ${f.leadTimeWeeks} weeks vs vendor's usual ${Math.round(f.vendorMeanLeadTimeWeeks)}`,
      );
  }

  const z = C.intercept + terms.reduce((s, t) => s + t.contribution, 0);
  const probability = 1 / (1 + Math.exp(-z));
  const score = Math.round(probability * 100);
  const reasons = terms
    .filter((t) => t.contribution > 0.05)
    .sort((a, b) => b.contribution - a.contribution)
    .slice(0, 3)
    .map((t) => t.reason);
  return {
    shipmentId,
    score,
    probability: round(probability, 4),
    level: levelFor(score),
    reasons: reasons.length ? reasons : ['On track: adequate slack and a reliable vendor'],
    terms: terms.sort((a, b) => b.contribution - a.contribution),
    features: f,
  };
}
