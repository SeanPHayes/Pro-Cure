import { z } from '@procure/platform';
import type { CostRequest } from '../../clients.js';
import type { Meter } from '../../llm.js';
import { type PdfPage, pageBatches, pagesForPrompt } from '../../text/extract.js';
import { parseLeadTimeWeeks } from '../../text/util.js';
import type { QuoteHeader, QuoteLine } from './schema.js';

const isoOrNull = z
  .string()
  .nullable()
  .transform((s) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null));

const LlmQuote = z.object({
  header: z
    .object({
      vendorName: z.string().nullable(),
      vendorQuoteNumber: z.string().nullable(),
      quoteDate: isoOrNull,
      validUntil: isoOrNull,
      leadTime: z.string().nullable(),
      freightTerms: z.string().nullable(),
    })
    .nullable(),
  lines: z.array(
    z.object({
      vendorSku: z.string().nullable(),
      specCode: z.string().nullable(),
      description: z.string(),
      quantity: z.number().nullable(),
      unitPrice: z.number().nullable(),
      extended: z.number().nullable(),
      leadTimeWeeks: z.number().nullable(),
      expiresAt: isoOrNull,
      notes: z.string().nullable(),
      sourcePage: z.number().int().nullable(),
      costRequestLineId: z.string().nullable(),
    }),
  ),
  totals: z
    .object({ subtotal: z.number().nullable(), freight: z.number().nullable(), total: z.number().nullable() })
    .nullable(),
});

const SYSTEM = `You extract pricing from vendor quotations for a hotel FF&E procurement firm. A buyer sent the vendor a
cost request (list provided) and the vendor replied with a PDF quote. Your output updates costs after human review.

Rules:
- Extract every priced product line. Ignore subtotal/total/tax/freight rows as lines (report them in "totals").
- unitPrice is the price per single unit in USD as a number (no symbols). If only an extended amount and a quantity
  are printed, compute unitPrice = extended / quantity. Never invent a price.
- quantity is the vendor's quoted quantity. vendorSku is the vendor's model/item number. specCode is the buyer's
  spec code if the vendor echoed it (e.g. "CG-101", "LT-3").
- leadTimeWeeks: when a range is given ("10-12 weeks") use the UPPER bound; convert days to weeks (round up).
- expiresAt / validUntil: the date pricing expires, YYYY-MM-DD. quoteDate likewise.
- costRequestLineId: the id of the cost-request line this quote line prices, chosen from the provided list by
  code, SKU, description and quantity; null when no request line clearly corresponds. Each request line id should
  be used at most once.
- notes: finish/fabric selections, COM/COL yardage, exclusions or conditions printed for that line.`;

export async function llmVendorQuote(
  pages: PdfPage[],
  request: CostRequest,
  meter: Meter,
): Promise<{
  header: Partial<QuoteHeader>;
  lines: QuoteLine[];
  totals: { subtotal: number | null; freight: number | null; total: number | null };
}> {
  const requestList = request.lines
    .map((l) =>
      JSON.stringify({
        id: l.id,
        code: l.code,
        name: l.name,
        description: l.description,
        vendorSku: l.vendorSku,
        quantity: l.quantity,
      }),
    )
    .join('\n');
  let header: Partial<QuoteHeader> = {};
  const lines: QuoteLine[] = [];
  let totals = {
    subtotal: null as number | null,
    freight: null as number | null,
    total: null as number | null,
  };
  for (const batch of pageBatches(pages, 12_000)) {
    const res = await meter.json(
      {
        system: SYSTEM,
        prompt: `Cost request ${request.number} lines (one JSON object per line):
${requestList}

Vendor quote pages:
${pagesForPrompt(batch)}

Return JSON: {"header": {...}|null, "lines": [...], "totals": {...}|null}`,
        maxTokens: 8000,
      },
      LlmQuote,
    );
    if (res.header) {
      header = {
        vendorName: header.vendorName ?? res.header.vendorName,
        vendorQuoteNumber: header.vendorQuoteNumber ?? res.header.vendorQuoteNumber,
        quoteDate: header.quoteDate ?? res.header.quoteDate,
        validUntil: header.validUntil ?? res.header.validUntil,
        leadTime: header.leadTime ?? res.header.leadTime,
        leadTimeWeeks: header.leadTimeWeeks ?? parseLeadTimeWeeks(res.header.leadTime),
        freightTerms: header.freightTerms ?? res.header.freightTerms,
      };
    }
    if (res.totals)
      totals = {
        subtotal: res.totals.subtotal ?? totals.subtotal,
        freight: res.totals.freight ?? totals.freight,
        total: res.totals.total ?? totals.total,
      };
    const known = new Set(request.lines.map((l) => l.id));
    for (const l of res.lines)
      lines.push({
        vendorSku: l.vendorSku,
        specCode: l.specCode,
        description: l.description,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        extended: l.extended,
        leadTimeWeeks: l.leadTimeWeeks,
        expiresAt: l.expiresAt,
        notes: l.notes,
        sourcePage: l.sourcePage,
        suggestedLineId: l.costRequestLineId && known.has(l.costRequestLineId) ? l.costRequestLineId : null,
      });
  }
  return { header, lines, totals };
}
