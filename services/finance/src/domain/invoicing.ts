import { round2, round4, sum } from '@procure/domain';

/** Pure AR/AP arithmetic and state rules. No I/O — unit tested in test/domain.test.ts. */

export type InvoiceStatus = 'draft' | 'sent' | 'partially_paid' | 'paid' | 'overdue' | 'void';
export type BillStatus = 'open' | 'scheduled' | 'partially_paid' | 'paid' | 'void';

export interface LineInput {
  description: string;
  quantity: number;
  unitPrice: number;
  quoteLineId?: string | null;
}

export interface PricedLine extends LineInput {
  amount: number;
  sort: number;
}

export const priceLines = (lines: LineInput[]): PricedLine[] =>
  lines.map((l, i) => ({
    description: l.description,
    quantity: round4(l.quantity),
    unitPrice: round4(l.unitPrice),
    quoteLineId: l.quoteLineId ?? null,
    amount: round2(l.quantity * l.unitPrice),
    sort: i,
  }));

export const invoiceTotals = (lines: { amount: number }[], taxRatePct: number) => {
  const subtotal = sum(lines.map((l) => l.amount));
  const tax = round2((subtotal * taxRatePct) / 100);
  return { subtotal, tax, total: round2(subtotal + tax) };
};

/** Status after a payment change. Void and draft are never changed by payments. */
export function invoiceStatusAfterPayment(
  current: InvoiceStatus,
  total: number,
  amountPaid: number,
  dueDate: string,
  today: string,
): InvoiceStatus {
  if (current === 'void' || current === 'draft') return current;
  const balance = round2(total - amountPaid);
  if (balance <= 0) return 'paid';
  if (dueDate < today) return 'overdue';
  return amountPaid > 0 ? 'partially_paid' : 'sent';
}

export function billStatusAfterPayment(current: BillStatus, amount: number, amountPaid: number): BillStatus {
  if (current === 'void') return current;
  const balance = round2(amount - amountPaid);
  if (balance <= 0) return 'paid';
  if (amountPaid > 0) return 'partially_paid';
  return current === 'scheduled' ? 'scheduled' : 'open';
}

// ---------------------------------------------------------------------------------------------
// Invoices from a quote
// ---------------------------------------------------------------------------------------------
export interface QuoteRef {
  id: string;
  number: string;
  name: string;
  status: string;
  sellTotal: number;
}

export type FromQuoteKind = 'deposit' | 'progress' | 'final';

export interface FromQuoteInput {
  kind: FromQuoteKind;
  percent?: number | undefined;
  amount?: number | undefined;
}

export class InvoicingRuleError extends Error {}

const pctLabel = (p: number) => `${Number.isInteger(p) ? p : round2(p)}%`;

/**
 * The single invoice line for a deposit / progress / final invoice against a quote.
 * `previouslyInvoiced` is Σ total of the quote's earlier non-void invoices.
 */
export function quoteInvoiceLine(
  quote: QuoteRef,
  input: FromQuoteInput,
  previouslyInvoiced: number,
): { description: string; quantity: number; unitPrice: number } {
  const sell = round2(quote.sellTotal);
  const remaining = round2(sell - previouslyInvoiced);
  const ref = `Quote ${quote.number} '${quote.name}'`;
  let amount: number;
  let description: string;
  switch (input.kind) {
    case 'deposit': {
      if (quote.status !== 'client_approved' && quote.status !== 'ordered')
        throw new InvoicingRuleError(
          `Quote ${quote.number} must be client approved before a deposit invoice`,
        );
      const pct = input.percent ?? 50;
      amount = input.amount !== undefined ? round2(input.amount) : round2((sell * pct) / 100);
      description = input.amount !== undefined ? `Deposit — ${ref}` : `Deposit — ${pctLabel(pct)} of ${ref}`;
      break;
    }
    case 'progress': {
      if (input.amount === undefined && input.percent === undefined)
        throw new InvoicingRuleError('A progress invoice needs a percent or an amount');
      if (input.amount !== undefined) {
        amount = round2(input.amount);
        description = `Progress billing — ${ref}`;
      } else {
        amount = round2((sell * input.percent!) / 100);
        description = `Progress billing — ${pctLabel(input.percent!)} of ${ref}`;
      }
      break;
    }
    case 'final': {
      amount = remaining;
      description = `Final invoice — balance of ${ref}`;
      break;
    }
  }
  if (amount <= 0) throw new InvoicingRuleError(`Nothing left to invoice on quote ${quote.number}`);
  if (amount > remaining + 0.005)
    throw new InvoicingRuleError(
      `Invoice amount ${amount.toFixed(2)} exceeds the uninvoiced balance ${remaining.toFixed(2)} of quote ${quote.number}`,
    );
  return { description, quantity: 1, unitPrice: amount };
}

// ---------------------------------------------------------------------------------------------
// Dates & aging
// ---------------------------------------------------------------------------------------------
export const isoDate = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDate(d);
};
export const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

export const termsForDays = (days: number) => (days <= 0 ? 'Due on receipt' : `Net ${days}`);

/** "Net 45" → 45; "Due on receipt" → 0; unknown → null. */
export const daysForTerms = (terms: string | null | undefined): number | null => {
  if (!terms) return null;
  if (/due on receipt/i.test(terms)) return 0;
  const m = /net\s*(\d+)/i.exec(terms);
  return m ? Number(m[1]) : null;
};

export const AGING_BUCKETS = ['current', '1-30', '31-60', '61-90', '90+'] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

export const agingBucket = (dueDate: string, today: string): AgingBucket => {
  const late = daysBetween(dueDate, today);
  if (late <= 0) return 'current';
  if (late <= 30) return '1-30';
  if (late <= 60) return '31-60';
  if (late <= 90) return '61-90';
  return '90+';
};

export const emptyAging = (): Record<AgingBucket, number> => ({
  current: 0,
  '1-30': 0,
  '31-60': 0,
  '61-90': 0,
  '90+': 0,
});

/** Last `n` calendar months ending with the month of `today`, as 'YYYY-MM'. */
export const lastMonths = (today: string, n = 12): string[] => {
  const [y, m] = today.split('-').map(Number) as [number, number];
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    out.push(d.toISOString().slice(0, 7));
  }
  return out;
};
