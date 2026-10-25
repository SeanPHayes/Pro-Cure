import { type Principal, unprocessable } from '@procure/platform';
import { getCostRequest, postCostResponse } from '../../clients.js';
import { currentLlm } from '../../llm.js';
import { loadPdfText, selectItems } from '../common.js';
import type { FeatureRunner, JobRow } from '../types.js';
import { heuristicVendorQuote } from './heuristic.js';
import { llmVendorQuote } from './llm.js';
import { matchQuote } from './match.js';
import { type QuoteHeader, type QuoteMatch, VendorQuoteOutput } from './schema.js';

export const runVendorQuote: FeatureRunner = async ({ tenantId, job, meter, log }) => {
  const input = job.input as { documentId: string; costRequestId: string };
  const [request, pdf] = await Promise.all([
    getCostRequest(tenantId, input.costRequestId),
    loadPdfText(tenantId, input.documentId),
  ]);
  const heuristic = heuristicVendorQuote(pdf.pages);
  let { header, lines, totals } = heuristic;
  const warnings: string[] = [...pdf.warnings];
  if (currentLlm().available) {
    try {
      const res = await llmVendorQuote(pdf.pages, request, meter);
      const merged: QuoteHeader = { ...heuristic.header };
      for (const [k, v] of Object.entries(res.header)) if (v != null) (merged as any)[k] = v;
      header = merged;
      lines = res.lines.map((l) => ({
        ...l,
        expiresAt: l.expiresAt ?? header.validUntil,
        leadTimeWeeks: l.leadTimeWeeks ?? header.leadTimeWeeks,
      }));
      totals = {
        ...heuristic.totals,
        ...Object.fromEntries(Object.entries(res.totals).filter(([, v]) => v != null)),
      };
    } catch (err) {
      log.warn({ err }, 'vendor-quote LLM path failed; using heuristic');
      meter.heuristic();
      warnings.push(`AI model failed (${(err as Error).message}); used rule-based parser.`);
    }
  } else meter.heuristic();

  const { matches, unmatchedLines, unquotedRequestLines } = matchQuote(lines, request);
  if (!lines.length) warnings.push('No priced lines found in the quote.');
  if (unquotedRequestLines.length)
    warnings.push(`${unquotedRequestLines.length} requested line(s) were not priced.`);
  const flagged = matches.filter((m) => m.flags.length).length;
  if (flagged) warnings.push(`${flagged} match(es) flagged for review.`);
  if (totals.subtotal != null) {
    const sum = lines.reduce((s, l) => s + (l.extended ?? (l.unitPrice ?? 0) * (l.quantity ?? 1)), 0);
    if (Math.abs(sum - totals.subtotal) > Math.max(1, totals.subtotal * 0.01))
      warnings.push(
        `Extracted lines sum to ${sum.toFixed(2)} but the quote subtotal is ${totals.subtotal.toFixed(2)} — some lines may be missing.`,
      );
  }
  const output = VendorQuoteOutput.parse({
    costRequest: { id: request.id, number: request.number, vendorId: request.vendorId },
    header,
    lines,
    matches,
    unmatchedLines,
    unquotedRequestLines,
    totals,
    warnings,
    scannedPages: pdf.scannedPages,
  });
  return { output, pages: pdf.pageCount };
};

export interface VendorQuoteApplyBody {
  matchIndexes?: number[];
  edits?: { index: number; set: Record<string, unknown> }[];
}

export async function applyVendorQuote(job: JobRow, body: VendorQuoteApplyBody, principal: Principal) {
  principal.require('quotes:write');
  const out = VendorQuoteOutput.parse(job.output);
  const chosen = selectItems(
    out.matches as unknown as Record<string, unknown>[],
    job.review,
    body.matchIndexes,
    body.edits,
  ).map((c) => c.item as unknown as QuoteMatch);
  const lines = chosen
    .filter((m) => m.unitCost != null && Number.isFinite(m.unitCost) && m.unitCost >= 0)
    .map((m) => ({
      costRequestLineId: m.costRequestLineId,
      cost: Math.round(m.unitCost! * 10_000) / 10_000,
      expiresAt: m.expiresAt,
      leadTimeWeeks: m.leadTimeWeeks,
      notes:
        [
          out.header.vendorQuoteNumber ? `Vendor quote ${out.header.vendorQuoteNumber}` : null,
          m.extractedLine.notes,
        ]
          .filter(Boolean)
          .join(' — ') || null,
    }));
  if (!lines.length) throw unprocessable('No selected matches have a unit cost to apply');
  await postCostResponse(job.tenantId, out.costRequest.id, { source: 'ai_pdf', lines });
  return {
    applied: lines.length,
    costRequestId: out.costRequest.id,
    entity: { type: 'cost_request', id: out.costRequest.id },
  };
}
