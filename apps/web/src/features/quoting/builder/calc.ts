/**
 * Client-side mirrors of services/quoting/src/domain (quantity, pricing, merchandising) used for
 * optimistic updates and previews. The server remains the source of truth: every mutation replaces
 * these estimates with the persisted line.
 */
import type { Line, LineFlag, Location, MarkupRule, QuoteDetail, RoomType } from '../types';

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const r4 = (n: number) => Math.round((n + Number.EPSILON) * 10000) / 10000;

export function computeQuantity(
  l: Pick<Line, 'qtyMode' | 'qtyFixed' | 'qtyPerRoom' | 'atticStockPct'>,
  rooms: Pick<RoomType, 'id' | 'count'>[],
) {
  let base = 0;
  if (l.qtyMode === 'per_room') {
    const counts = new Map(rooms.map((r) => [r.id, r.count]));
    for (const [rt, q] of Object.entries(l.qtyPerRoom ?? {}))
      base += (Number(q) || 0) * (counts.get(rt) ?? 0);
  } else base = Number(l.qtyFixed) || 0;
  base = r4(base);
  const pct = Number(l.atticStockPct) || 0;
  const attic = pct > 0 && base > 0 ? Math.ceil(r4((base * pct) / 100)) : 0;
  return { base, attic, quantity: r4(base + attic) };
}

const addDays = (iso: string, d: number) => {
  const x = new Date(`${iso}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + d);
  return x.toISOString().slice(0, 10);
};

export function landed(l: Pick<Line, 'unitCost' | 'freightUnit'>, freightMode: QuoteDetail['freightMode']) {
  return l.unitCost === null
    ? null
    : r4(l.unitCost + (freightMode === 'per_line' ? (l.freightUnit ?? 0) : 0));
}

/** Re-derive quantity, price, extended amounts, margin and flags for one line. */
export function repriceLine(
  l: Line,
  q: Pick<QuoteDetail, 'freightMode' | 'minMarginPct' | 'roomTypes'>,
): Line {
  const { quantity } = computeQuantity(l, q.roomTypes);
  const cost = landed(l, q.freightMode);
  const unitPrice = l.priceOverride
    ? l.unitPrice
    : cost === null
      ? null
      : r4(cost * (1 + (Number(l.markupPct) || 0) / 100));
  const extendedCost = cost === null ? null : r2(cost * quantity);
  const extendedPrice = unitPrice === null ? null : r2(unitPrice * quantity);
  const marginPct =
    cost === null || unitPrice === null
      ? null
      : unitPrice === 0
        ? 0
        : r2(((unitPrice - cost) / unitPrice) * 100);
  const today = new Date().toISOString().slice(0, 10);
  const flags: LineFlag[] = [];
  if (l.unitCost === null) flags.push('missing_cost');
  if (unitPrice === null) flags.push('missing_price');
  if (cost !== null && unitPrice !== null && unitPrice < cost) flags.push('below_cost');
  if (l.costExpiresAt && l.unitCost !== null) {
    if (l.costExpiresAt < today) flags.push('cost_expired');
    else if (l.costExpiresAt <= addDays(today, 14)) flags.push('cost_expiring');
  }
  if (marginPct !== null && q.minMarginPct !== null && marginPct < q.minMarginPct)
    flags.push('below_min_margin');
  // Keep server-only flags (policy floors) we can't evaluate client-side.
  if (l.flags.includes('below_min_margin') && !flags.includes('below_min_margin') && q.minMarginPct === null)
    flags.push('below_min_margin');
  return { ...l, quantity, unitPrice, extendedCost, extendedPrice, marginPct, flags };
}

// ---------------------------------------------------------------- locations
export const parentMap = (locs: Pick<Location, 'id' | 'parentId'>[]) =>
  new Map(locs.map((l) => [l.id, l.parentId ?? null]));

export const ancestry = (id: string | null, parents: Map<string, string | null>) => {
  const out: string[] = [];
  let cur = id;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    out.push(cur);
    seen.add(cur);
    cur = parents.get(cur) ?? null;
  }
  return out;
};

export const descendants = (id: string, locs: Pick<Location, 'id' | 'parentId'>[]) => {
  const out = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const l of locs)
      if (l.parentId && out.has(l.parentId) && !out.has(l.id)) {
        out.add(l.id);
        grew = true;
      }
  }
  return out;
};

// ---------------------------------------------------------------- merchandising
export function matchRule(
  line: Pick<Line, 'category' | 'locationId'>,
  rules: MarkupRule[],
  parents: Map<string, string | null>,
) {
  const chain = ancestry(line.locationId, parents);
  let best: { rule: MarkupRule; score: number } | undefined;
  for (const r of rules) {
    if (r.category && r.category !== line.category) continue;
    let depth = 0;
    if (r.locationId) {
      const i = chain.indexOf(r.locationId);
      if (i < 0) continue;
      depth = 1000 - i;
    }
    const score = (r.category ? 1 : 0) * 10_000 + (r.locationId ? 20_000 + depth : 0);
    if (!best || score > best.score) best = { rule: r, score };
  }
  return best?.rule;
}

export interface MerchPreview {
  changed: number;
  solvedMarkupPct: number | null;
  sell: number;
  cost: number;
  marginPct: number | null;
  lines: Line[];
}

/** Preview the effect of markup rules + optional target margin, the same way the server will. */
export function previewMerchandise(
  lines: Line[],
  q: Pick<QuoteDetail, 'freightMode' | 'minMarginPct' | 'roomTypes' | 'locations'>,
  rules: MarkupRule[],
  opts: { targetMarginPct: number | null; respectOverrides: boolean },
): MerchPreview {
  const parents = parentMap(q.locations);
  const markups = new Map<string, number>();
  const cleared = new Set<string>();
  const free: Line[] = [];
  let fixedCost = 0;
  let fixedSell = 0;
  const open = lines.filter((l) => !l.poId);
  for (const l of open) {
    const lc = landed(l, q.freightMode);
    if (l.priceOverride && opts.respectOverrides) {
      if (l.isSelected && lc !== null && l.unitPrice !== null) {
        fixedCost += lc * l.quantity;
        fixedSell += l.unitPrice * l.quantity;
      }
      continue;
    }
    if (l.priceOverride) cleared.add(l.id);
    const rule = matchRule(l, rules, parents);
    if (rule) {
      markups.set(l.id, rule.markupPct);
      if (l.isSelected && lc !== null) {
        fixedCost += lc * l.quantity;
        fixedSell += r4(lc * (1 + rule.markupPct / 100)) * l.quantity;
      }
    } else if (opts.targetMarginPct !== null) free.push(l);
  }
  let solved: number | null = null;
  if (opts.targetMarginPct !== null && free.length) {
    const t = opts.targetMarginPct / 100;
    const freeCost = free.reduce((a, l) => {
      const lc = landed(l, q.freightMode);
      return a + (l.isSelected && lc !== null ? lc * l.quantity : 0);
    }, 0);
    if (freeCost > 0) {
      const needed = (fixedCost + freeCost) / (1 - t) - fixedSell;
      solved = Math.max(0, Math.round((needed / freeCost - 1) * 100 * 1000) / 1000);
    } else solved = Math.round((opts.targetMarginPct / (100 - opts.targetMarginPct)) * 100 * 1000) / 1000;
    for (const l of free) markups.set(l.id, solved);
  }
  let changed = 0;
  const next = lines.map((l) => {
    const m = markups.get(l.id);
    if (m === undefined && !cleared.has(l.id)) return l;
    const before = l.unitPrice;
    const n = repriceLine({ ...l, markupPct: m ?? l.markupPct, priceOverride: false }, q);
    if (n.unitPrice !== before || n.markupPct !== l.markupPct) changed++;
    return n;
  });
  const sel = next.filter((l) => l.isSelected);
  const sell = r2(sel.reduce((a, l) => a + (l.extendedPrice ?? 0), 0));
  const cost = r2(sel.reduce((a, l) => a + (l.extendedCost ?? 0), 0));
  return {
    changed,
    solvedMarkupPct: solved,
    sell,
    cost,
    marginPct: sell === 0 ? null : r2(((sell - cost) / sell) * 100),
    lines: next,
  };
}
