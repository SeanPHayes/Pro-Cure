import { z } from '@procure/platform';

export const QuoteHeader = z.object({
  vendorName: z.string().nullable(),
  vendorQuoteNumber: z.string().nullable(),
  quoteDate: z.string().nullable(),
  validUntil: z.string().nullable(),
  leadTime: z.string().nullable(),
  leadTimeWeeks: z.number().nullable(),
  freightTerms: z.string().nullable(),
});
export type QuoteHeader = z.infer<typeof QuoteHeader>;

export const QuoteLine = z.object({
  vendorSku: z.string().nullable(),
  description: z.string(),
  quantity: z.number().nullable(),
  unitPrice: z.number().nullable(),
  extended: z.number().nullable(),
  leadTimeWeeks: z.number().nullable(),
  expiresAt: z.string().nullable(),
  notes: z.string().nullable(),
  sourcePage: z.number().int().nullable(),
  /** Spec code printed on the vendor's line (many vendors echo the designer's code). */
  specCode: z.string().nullable().default(null),
  /** LLM path only: the cost-request line the model believes this is. */
  suggestedLineId: z.string().nullable().default(null),
});
export type QuoteLine = z.infer<typeof QuoteLine>;

export const QuoteMatch = z.object({
  costRequestLineId: z.string(),
  code: z.string().nullable(),
  name: z.string(),
  lineIndex: z.number().int(),
  extractedLine: QuoteLine,
  unitCost: z.number().nullable(),
  currentCost: z.number().nullable(),
  requestedQuantity: z.number().nullable(),
  expiresAt: z.string().nullable(),
  leadTimeWeeks: z.number().nullable(),
  confidence: z.number(),
  reasons: z.array(z.string()),
  flags: z.array(z.string()),
});
export type QuoteMatch = z.infer<typeof QuoteMatch>;

export const VendorQuoteOutput = z.object({
  costRequest: z.object({ id: z.string(), number: z.string(), vendorId: z.string() }),
  header: QuoteHeader,
  lines: z.array(QuoteLine),
  matches: z.array(QuoteMatch),
  unmatchedLines: z.array(z.object({ lineIndex: z.number().int(), line: QuoteLine, reason: z.string() })),
  unquotedRequestLines: z.array(
    z.object({ costRequestLineId: z.string(), code: z.string().nullable(), name: z.string() }),
  ),
  totals: z.object({
    subtotal: z.number().nullable(),
    freight: z.number().nullable(),
    total: z.number().nullable(),
  }),
  warnings: z.array(z.string()),
  scannedPages: z.array(z.number().int()).default([]),
});
export type VendorQuoteOutput = z.infer<typeof VendorQuoteOutput>;
