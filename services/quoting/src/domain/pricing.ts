import { type LineFlag, marginPct, priceFromMarkup, round2, round4 } from '@procure/domain';

export const EXPIRING_DAYS = 14;

export interface PriceInput {
  quantity: number;
  unitCost: number | null;
  freightUnit: number | null;
  markupPct: number;
  unitPrice: number | null;
  priceOverride: boolean;
  costExpiresAt: string | null;
}

export interface PriceContext {
  /** per_line: freight_unit is part of landed cost; percent: freight is billed at quote level. */
  freightMode: 'per_line' | 'percent';
  /** Minimum acceptable margin for this line (quote or policy), or null. */
  minMarginPct: number | null;
  /** YYYY-MM-DD */
  today: string;
}

export interface PriceResult {
  unitPrice: number | null;
  extendedCost: number | null;
  extendedPrice: number | null;
  marginPct: number | null;
  flags: LineFlag[];
}

export const addDays = (isoDate: string, days: number) => {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

export const todayIso = (now = new Date()) => now.toISOString().slice(0, 10);

/** Landed unit cost: vendor cost plus per-unit freight when freight is carried per line. */
export const landedUnitCost = (
  l: Pick<PriceInput, 'unitCost' | 'freightUnit'>,
  ctx: Pick<PriceContext, 'freightMode'>,
) =>
  l.unitCost === null
    ? null
    : round4(l.unitCost + (ctx.freightMode === 'per_line' ? (l.freightUnit ?? 0) : 0));

export function priceLine(l: PriceInput, ctx: PriceContext): PriceResult {
  const landed = landedUnitCost(l, ctx);
  const unitPrice = l.priceOverride
    ? l.unitPrice
    : landed === null
      ? null
      : priceFromMarkup(landed, Number(l.markupPct) || 0);
  const extendedCost = landed === null ? null : round2(landed * l.quantity);
  const extendedPrice = unitPrice === null ? null : round2(unitPrice * l.quantity);
  const margin = landed === null || unitPrice === null ? null : marginPct(landed, unitPrice);

  const flags: LineFlag[] = [];
  if (l.unitCost === null) flags.push('missing_cost');
  if (unitPrice === null) flags.push('missing_price');
  if (landed !== null && unitPrice !== null && unitPrice < landed) flags.push('below_cost');
  if (l.costExpiresAt && l.unitCost !== null) {
    if (l.costExpiresAt < ctx.today) flags.push('cost_expired');
    else if (l.costExpiresAt <= addDays(ctx.today, EXPIRING_DAYS)) flags.push('cost_expiring');
  }
  if (margin !== null && ctx.minMarginPct !== null && margin < ctx.minMarginPct)
    flags.push('below_min_margin');
  return { unitPrice, extendedCost, extendedPrice, marginPct: margin, flags };
}
