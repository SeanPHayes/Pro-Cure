import { addDays, daysBetween, daysSince } from './dates.js';

export type Level = 'none' | 'watch' | 'at_risk' | 'critical';
export const LEVELS: Level[] = ['none', 'watch', 'at_risk', 'critical'];
export const rank = (l: Level | null | undefined): number => LEVELS.indexOf(l ?? 'none');
export const maxLevel = (...ls: (Level | null | undefined)[]): Level =>
  ls.reduce<Level>((a, b) => (rank(b) > rank(a) ? (b as Level) : a), 'none');

/**
 * Risk levels from the AI model may use another vocabulary; normalize them onto the escalation scale.
 */
export const normalizeRiskLevel = (level: string | null | undefined): Level | null => {
  if (!level) return null;
  const l = level.toLowerCase().replace(/[\s-]/g, '_');
  if ((LEVELS as string[]).includes(l)) return l as Level;
  if (l === 'low' || l === 'ok') return 'none';
  if (l === 'medium' || l === 'moderate' || l === 'elevated') return 'watch';
  if (l === 'high' || l === 'risk') return 'at_risk';
  if (l === 'very_high' || l === 'severe') return 'critical';
  return null;
};

export interface Finding {
  level: Level;
  reason: string;
}

const SHIPPED = new Set(['shipped', 'in_transit', 'delivered']);

export interface PoFacts {
  releaseByDate: string | null;
  pendingRequirements: number;
  pendingRequirementLabels?: string[];
}

export interface ShipmentFacts {
  id?: string;
  label?: string;
  status: string;
  origin: 'domestic' | 'international' | null;
  requestedDeliveryDate: string | null;
  estimatedShipDate: string | null;
  estimatedDeliveryDate: string | null;
  transitDays: number;
  hasTracking: boolean;
  /** Times the estimated ship date moved later. */
  shipDateSlips: number;
  lastConfirmationRequestedAt: string | null;
  lastConfirmedAt: string | null;
  riskLevel?: Level | null;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** PO-level rules: the release-by (order-by) date against outstanding pre-order requirements. */
export function poFindings(po: PoFacts, today: string): Finding[] {
  if (!po.releaseByDate || po.pendingRequirements <= 0) return [];
  const what = po.pendingRequirementLabels?.length
    ? po.pendingRequirementLabels.join(', ')
    : plural(po.pendingRequirements, 'requirement');
  const left = daysBetween(today, po.releaseByDate);
  if (left < 0)
    return [
      {
        level: 'critical',
        reason: `Order-by date ${po.releaseByDate} passed ${plural(-left, 'day')} ago with pending: ${what}`,
      },
    ];
  if (left <= 7)
    return [
      {
        level: 'at_risk',
        reason: `Order-by date ${po.releaseByDate} in ${plural(left, 'day')}; pending: ${what}`,
      },
    ];
  if (left <= 21)
    return [
      {
        level: 'watch',
        reason: `Order-by date ${po.releaseByDate} in ${plural(left, 'day')}; pending: ${what}`,
      },
    ];
  return [];
}

/** Estimated delivery: carrier/vendor estimate, else estimated ship date + transit. */
export const effectiveDelivery = (s: ShipmentFacts): string | null =>
  s.estimatedDeliveryDate ?? (s.estimatedShipDate ? addDays(s.estimatedShipDate, s.transitDays) : null);

export function shipmentFindings(s: ShipmentFacts, today: string, now: Date = new Date()): Finding[] {
  if (s.status === 'delivered') return [];
  const out: Finding[] = [];
  const eta = effectiveDelivery(s);
  if (eta && s.requestedDeliveryDate && eta > s.requestedDeliveryDate)
    out.push({
      level: 'critical',
      reason: `Estimated delivery ${eta} is ${plural(daysBetween(s.requestedDeliveryDate, eta), 'day')} after the requested ${s.requestedDeliveryDate}`,
    });
  if (s.estimatedShipDate && !s.hasTracking && !SHIPPED.has(s.status)) {
    const late = daysBetween(s.estimatedShipDate, today);
    if (late > 3)
      out.push({
        level: 'critical',
        reason: `Estimated ship date ${s.estimatedShipDate} passed ${plural(late, 'day')} ago with no tracking`,
      });
  }
  if (s.shipDateSlips >= 2)
    out.push({ level: 'at_risk', reason: `Ship date pushed later ${s.shipDateSlips} times` });
  if (
    s.lastConfirmationRequestedAt &&
    (!s.lastConfirmedAt || s.lastConfirmedAt < s.lastConfirmationRequestedAt) &&
    !SHIPPED.has(s.status)
  ) {
    const waited = daysSince(s.lastConfirmationRequestedAt, now);
    if (waited >= 10)
      out.push({
        level: 'at_risk',
        reason: `No ship-date confirmation from the vendor for ${plural(waited, 'day')}`,
      });
  }
  if (s.origin === 'international' && eta && s.requestedDeliveryDate) {
    const slack = daysBetween(eta, s.requestedDeliveryDate);
    if (slack >= 0 && slack < 14)
      out.push({
        level: 'watch',
        reason: `International shipment with only ${plural(slack, 'day')} of slack`,
      });
  }
  return out;
}

export interface Evaluation {
  level: Level;
  reasons: string[];
}

/** Final level = max(rule level, AI risk level); reasons list rule findings, then the model's. */
export function combine(
  findings: Finding[],
  riskLevel?: Level | null,
  riskReasons: string[] = [],
): Evaluation {
  const level = maxLevel(...findings.map((f) => f.level), riskLevel ?? 'none');
  const reasons = [...findings].sort((a, b) => rank(b.level) - rank(a.level)).map((f) => f.reason);
  if (riskLevel && rank(riskLevel) > 0)
    reasons.push(
      ...(riskReasons.length ? riskReasons.map((r) => `Risk model: ${r}`) : [`Risk model: ${riskLevel}`]),
    );
  return { level, reasons: [...new Set(reasons)] };
}

export interface PoEvaluation extends Evaluation {
  shipments: (Evaluation & { id?: string })[];
}

/**
 * Escalation for a PO and each of its shipments. A shipment's level comes from its own rules and its risk
 * score; the PO's is the max of the release-by rules, every open shipment, and the PO's rolled-up risk.
 */
export function evaluatePo(input: {
  po: PoFacts & { riskLevel?: Level | null; riskReasons?: string[] };
  shipments: (ShipmentFacts & { riskReasons?: string[] })[];
  today: string;
  now?: Date;
}): PoEvaluation {
  const now = input.now ?? new Date();
  const multi = input.shipments.length > 1;
  const shipments = input.shipments.map((s) => {
    const own = shipmentFindings(s, input.today, now);
    return {
      id: s.id,
      ...combine(own, s.riskLevel, s.riskReasons),
      findings: own.map((f) => ({
        level: f.level,
        reason: multi && s.label ? `Shipment ${s.label}: ${f.reason}` : f.reason,
      })),
    };
  });
  const findings = [...poFindings(input.po, input.today), ...shipments.flatMap((s) => s.findings)];
  const po = combine(findings, input.po.riskLevel, input.po.riskReasons);
  return { ...po, shipments: shipments.map(({ findings: _f, ...s }) => s) };
}
