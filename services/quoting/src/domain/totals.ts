import { LineFlag, marginPct, round2, sum } from '@procure/domain';

export interface TotalsLine {
  id: string;
  isSelected: boolean;
  locationId: string | null;
  category: string;
  vendorId: string | null;
  vendorName: string | null;
  quantity: number;
  freightUnit: number | null;
  extendedCost: number | null;
  extendedPrice: number | null;
  flags: string[];
}

export interface TotalsQuote {
  freightMode: 'per_line' | 'percent';
  freightPct: number;
  taxRate: number;
}

export interface Bucket {
  key: string | null;
  label: string;
  lineCount: number;
  cost: number;
  sell: number;
  marginPct: number;
}

export interface QuoteTotals {
  lineCount: number;
  selectedLineCount: number;
  costSubtotal: number;
  sellSubtotal: number;
  marginPct: number;
  /** Freight embedded in per-line landed cost (per_line mode). Informational. */
  freightIncluded: number;
  /** Freight billed at quote level (percent mode). */
  freight: number;
  tax: number;
  grandTotal: number;
  /** Total cost including quote-level freight. */
  costTotal: number;
  flagCounts: Record<LineFlag, number>;
}

export const emptyFlagCounts = (): Record<LineFlag, number> =>
  Object.fromEntries(LineFlag.options.map((f) => [f, 0])) as Record<LineFlag, number>;

/** Quote totals over SELECTED lines (losing alternates in a price matrix are excluded). */
export function quoteTotals(q: TotalsQuote, lines: TotalsLine[]): QuoteTotals {
  const sel = lines.filter((l) => l.isSelected);
  const costSubtotal = sum(sel.map((l) => l.extendedCost ?? 0));
  const sellSubtotal = sum(sel.map((l) => l.extendedPrice ?? 0));
  const freightIncluded =
    q.freightMode === 'per_line' ? sum(sel.map((l) => round2((l.freightUnit ?? 0) * l.quantity))) : 0;
  const freight =
    q.freightMode === 'percent' ? round2((sellSubtotal * (Number(q.freightPct) || 0)) / 100) : 0;
  const tax = round2(((sellSubtotal + freight) * (Number(q.taxRate) || 0)) / 100);
  const flagCounts = emptyFlagCounts();
  for (const l of sel) for (const f of l.flags) if (f in flagCounts) flagCounts[f as LineFlag]++;
  return {
    lineCount: lines.length,
    selectedLineCount: sel.length,
    costSubtotal,
    sellSubtotal,
    marginPct: marginPct(costSubtotal, sellSubtotal),
    freightIncluded,
    freight,
    tax,
    grandTotal: sum([sellSubtotal, freight, tax]),
    costTotal: sum([costSubtotal, freight]),
    flagCounts,
  };
}

export function groupTotals(
  lines: TotalsLine[],
  keyOf: (l: TotalsLine) => string | null,
  labelOf: (key: string | null, l: TotalsLine) => string,
): Bucket[] {
  const map = new Map<string, { key: string | null; label: string; lines: TotalsLine[] }>();
  for (const l of lines) {
    if (!l.isSelected) continue;
    const k = keyOf(l);
    const mk = k ?? '__none__';
    let b = map.get(mk);
    if (!b) {
      b = { key: k, label: labelOf(k, l), lines: [] };
      map.set(mk, b);
    }
    b.lines.push(l);
  }
  return [...map.values()].map((b) => {
    const cost = sum(b.lines.map((l) => l.extendedCost ?? 0));
    const sell = sum(b.lines.map((l) => l.extendedPrice ?? 0));
    return {
      key: b.key,
      label: b.label,
      lineCount: b.lines.length,
      cost,
      sell,
      marginPct: marginPct(cost, sell),
    };
  });
}
