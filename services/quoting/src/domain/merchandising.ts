import { markupForMargin, round, round4 } from '@procure/domain';

export interface MarkupRule {
  category?: string | null;
  locationId?: string | null;
  markupPct: number;
}

export interface MerchLine {
  id: string;
  category: string;
  locationId: string | null;
  isSelected: boolean;
  quantity: number;
  /** Landed unit cost (cost + per-line freight), null when missing. */
  landedCost: number | null;
  priceOverride: boolean;
  unitPrice: number | null;
}

export interface MerchResult {
  /** New markup per line id; lines absent are unchanged. */
  markups: Map<string, number>;
  /** Lines whose price override was cleared. */
  clearedOverrides: string[];
  /** Markup solved for unmatched lines when a target margin was requested. */
  solvedMarkupPct: number | null;
}

/** Ancestor chain of a location (self first), from a parent map. */
export const ancestry = (locationId: string | null, parentOf: Map<string, string | null>): string[] => {
  const out: string[] = [];
  const seen = new Set<string>();
  let cur = locationId;
  while (cur && !seen.has(cur)) {
    out.push(cur);
    seen.add(cur);
    cur = parentOf.get(cur) ?? null;
  }
  return out;
};

/**
 * Most specific matching rule for a line. Location rules match the line's location or any ancestor
 * (a rule on "Guestrooms" covers "Guestrooms > King"); nearer ancestors win. Specificity order:
 * category+location > location > category. Returns undefined when nothing matches.
 */
export function matchRule(
  line: Pick<MerchLine, 'category' | 'locationId'>,
  rules: MarkupRule[],
  parentOf: Map<string, string | null>,
): MarkupRule | undefined {
  const chain = ancestry(line.locationId, parentOf);
  let best: { rule: MarkupRule; score: number } | undefined;
  for (const r of rules) {
    if (r.category && r.category !== line.category) continue;
    let depthScore = 0;
    if (r.locationId) {
      const idx = chain.indexOf(r.locationId);
      if (idx < 0) continue;
      depthScore = 1000 - idx; // closer ancestor = higher
    }
    const score = (r.category ? 1 : 0) * 10_000 + (r.locationId ? 20_000 + depthScore : 0);
    if (!best || score > best.score) best = { rule: r, score };
  }
  return best?.rule;
}

/**
 * Apply markup rules, and optionally solve a uniform markup for lines no rule covers so the whole
 * quote (selected lines) hits `targetMarginPct`. Overridden prices are kept when `respectOverrides`,
 * and count as fixed sell in the solve.
 */
export function merchandise(
  lines: MerchLine[],
  rules: MarkupRule[],
  parentOf: Map<string, string | null>,
  opts: { targetMarginPct?: number | null; respectOverrides: boolean },
): MerchResult {
  const markups = new Map<string, number>();
  const clearedOverrides: string[] = [];
  const free: MerchLine[] = [];
  let fixedCost = 0;
  let fixedSell = 0;

  for (const l of lines) {
    if (l.priceOverride && opts.respectOverrides) {
      if (l.isSelected && l.landedCost !== null && l.unitPrice !== null) {
        fixedCost += l.landedCost * l.quantity;
        fixedSell += l.unitPrice * l.quantity;
      }
      continue;
    }
    if (l.priceOverride) clearedOverrides.push(l.id);
    const rule = matchRule(l, rules, parentOf);
    if (rule) {
      markups.set(l.id, rule.markupPct);
      if (l.isSelected && l.landedCost !== null) {
        fixedCost += l.landedCost * l.quantity;
        fixedSell += round4(l.landedCost * (1 + rule.markupPct / 100)) * l.quantity;
      }
    } else if (opts.targetMarginPct !== undefined && opts.targetMarginPct !== null) {
      free.push(l);
    }
  }

  let solvedMarkupPct: number | null = null;
  if (opts.targetMarginPct !== undefined && opts.targetMarginPct !== null && free.length) {
    const t = opts.targetMarginPct / 100;
    const freeCost = free.reduce(
      (a, l) => a + (l.isSelected && l.landedCost !== null ? l.landedCost * l.quantity : 0),
      0,
    );
    if (freeCost > 0) {
      // (fixedSell + freeSell - totalCost) / (fixedSell + freeSell) = t  →  freeSell = totalCost/(1-t) - fixedSell
      const totalCost = fixedCost + freeCost;
      const neededSell = totalCost / (1 - t) - fixedSell;
      solvedMarkupPct = Math.max(0, round((neededSell / freeCost - 1) * 100, 3));
    } else {
      solvedMarkupPct = round(markupForMargin(opts.targetMarginPct), 3);
    }
    for (const l of free) markups.set(l.id, solvedMarkupPct);
  }
  return { markups, clearedOverrides, solvedMarkupPct };
}
