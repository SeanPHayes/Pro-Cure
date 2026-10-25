import { z } from '@procure/platform';

/** Tenant-defined approval conditions. A policy "fails" (requires approval) when its condition holds. */
export const ApprovalCondition = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('line_margin_below'),
    pct: z.number().min(-100).max(100),
    category: z.string().optional(),
  }),
  z.object({ type: z.literal('quote_margin_below'), pct: z.number().min(-100).max(100) }),
  z.object({ type: z.literal('quote_total_above'), amount: z.number().min(0) }),
  z.object({ type: z.literal('line_below_cost') }),
  z.object({ type: z.literal('cost_expired_lines') }),
  z.object({ type: z.literal('vendor_not_preferred') }),
]);
export type ApprovalCondition = z.infer<typeof ApprovalCondition>;

export interface EvalLine {
  id: string;
  code: string;
  name: string;
  category: string;
  vendorId: string | null;
  vendorName: string | null;
  isSelected: boolean;
  marginPct: number | null;
  flags: string[];
}

export interface EvalQuote {
  sellSubtotal: number;
  grandTotal: number;
  marginPct: number;
}

export interface EvalPolicy {
  id: string;
  name: string;
  condition: ApprovalCondition;
  approverRole: string;
}

export interface PolicyFailure {
  policyId: string;
  policyName: string;
  approverRole: string;
  reason: string;
  details: {
    lines?: { id: string; code: string; name: string; value?: number | string | null }[];
    value?: number;
    threshold?: number;
    warnings?: string[];
  };
}

export interface EvalResult {
  failures: PolicyFailure[];
  warnings: string[];
}

const lineRef = (l: EvalLine, value?: number | string | null) => ({
  id: l.id,
  code: l.code,
  name: l.name,
  value,
});

/**
 * Evaluate policies against a quote. `preferredVendor` returns true/false, or null when the vendor
 * profile could not be loaded (catalog unavailable) — such rules are skipped with a warning.
 */
export function evaluatePolicies(
  policies: EvalPolicy[],
  quote: EvalQuote,
  lines: EvalLine[],
  preferredVendor: (vendorId: string) => boolean | null,
): EvalResult {
  const sel = lines.filter((l) => l.isSelected);
  const failures: PolicyFailure[] = [];
  const warnings: string[] = [];
  const fail = (p: EvalPolicy, reason: string, details: PolicyFailure['details']) =>
    failures.push({ policyId: p.id, policyName: p.name, approverRole: p.approverRole, reason, details });

  for (const p of policies) {
    const c = p.condition;
    switch (c.type) {
      case 'line_margin_below': {
        const off = sel.filter(
          (l) => (!c.category || l.category === c.category) && l.marginPct !== null && l.marginPct < c.pct,
        );
        if (off.length)
          fail(p, `${off.length} line(s) below ${c.pct}% margin${c.category ? ` (${c.category})` : ''}`, {
            threshold: c.pct,
            lines: off.map((l) => lineRef(l, l.marginPct)),
          });
        break;
      }
      case 'quote_margin_below':
        if (quote.marginPct < c.pct)
          fail(p, `Quote margin ${quote.marginPct}% is below ${c.pct}%`, {
            value: quote.marginPct,
            threshold: c.pct,
          });
        break;
      case 'quote_total_above':
        if (quote.grandTotal > c.amount)
          fail(p, `Quote total ${quote.grandTotal.toFixed(2)} exceeds ${c.amount.toFixed(2)}`, {
            value: quote.grandTotal,
            threshold: c.amount,
          });
        break;
      case 'line_below_cost': {
        const off = sel.filter((l) => l.flags.includes('below_cost'));
        if (off.length)
          fail(p, `${off.length} line(s) priced below cost`, {
            lines: off.map((l) => lineRef(l, l.marginPct)),
          });
        break;
      }
      case 'cost_expired_lines': {
        const off = sel.filter((l) => l.flags.includes('cost_expired'));
        if (off.length)
          fail(p, `${off.length} line(s) have expired vendor costs`, { lines: off.map((l) => lineRef(l)) });
        break;
      }
      case 'vendor_not_preferred': {
        const off: EvalLine[] = [];
        const unknown = new Set<string>();
        for (const l of sel) {
          if (!l.vendorId) continue;
          const pref = preferredVendor(l.vendorId);
          if (pref === null) unknown.add(l.vendorName ?? l.vendorId);
          else if (!pref) off.push(l);
        }
        const w = unknown.size
          ? [
              `Vendor profile unavailable for ${[...unknown].join(', ')}; preferred-vendor check skipped for them`,
            ]
          : [];
        warnings.push(...w.map((m) => `${p.name}: ${m}`));
        if (off.length)
          fail(p, `${off.length} line(s) use non-preferred vendors`, {
            lines: off.map((l) => lineRef(l, l.vendorName)),
            ...(w.length ? { warnings: w } : {}),
          });
        break;
      }
    }
  }
  return { failures, warnings };
}
