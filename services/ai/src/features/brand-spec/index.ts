import { type Principal, unprocessable } from '@procure/platform';
import { getBrandStandard, importSpecs, upsertBrandStandardItems } from '../../clients.js';
import { currentLlm } from '../../llm.js';
import { loadPdfText, selectItems } from '../common.js';
import type { FeatureRunner, JobRow } from '../types.js';
import { heuristicBrandSpec } from './heuristic.js';
import { llmBrandSpec } from './llm.js';
import { type BrandSpecItem, BrandSpecOutput } from './schema.js';

export const runBrandSpec: FeatureRunner = async ({ tenantId, job, meter, log }) => {
  const input = job.input as { documentId: string; standardName?: string };
  const pdf = await loadPdfText(tenantId, input.documentId);
  let out: BrandSpecOutput;
  const heuristic = heuristicBrandSpec(pdf.pages);
  if (currentLlm().available) {
    try {
      const res = await llmBrandSpec(pdf.pages, meter);
      out = { ...res, scannedPages: [] };
      // Recall safety net: codes the heuristic found that the model skipped are added for review.
      const have = new Set(out.items.map((i) => i.code.toUpperCase()));
      const missed = heuristic.items.filter((i) => !have.has(i.code.toUpperCase()));
      if (missed.length) {
        out.items.push(...missed.map((i) => ({ ...i, confidence: Math.min(i.confidence, 0.5) })));
        out.warnings.push(
          `${missed.length} item(s) found only by the rule-based parser: ${missed.map((i) => i.code).join(', ')}`,
        );
      }
      out.standard = {
        name: out.standard.name ?? heuristic.standard.name,
        brandGuess: out.standard.brandGuess ?? heuristic.standard.brandGuess,
        version: out.standard.version ?? heuristic.standard.version,
        effectiveDate: out.standard.effectiveDate ?? heuristic.standard.effectiveDate,
      };
    } catch (err) {
      log.warn({ err }, 'brand-spec LLM path failed; using heuristic');
      meter.heuristic();
      out = {
        ...heuristic,
        warnings: [
          `AI model failed (${(err as Error).message}); used rule-based parser.`,
          ...heuristic.warnings,
        ],
      };
    }
  } else {
    meter.heuristic();
    out = heuristic;
  }
  if (input.standardName && !out.standard.name) out.standard.name = input.standardName;
  out.items.sort(
    (a, b) =>
      (a.sourcePage ?? 0) - (b.sourcePage ?? 0) || a.code.localeCompare(b.code, 'en', { numeric: true }),
  );
  out.scannedPages = pdf.scannedPages;
  out.warnings = [...pdf.warnings, ...out.warnings];
  return { output: BrandSpecOutput.parse(out), pages: pdf.pageCount };
};

export interface BrandSpecApplyBody {
  target: 'catalog' | 'specs';
  standardId?: string;
  itemIndexes?: number[];
  edits?: { index: number; set: Record<string, unknown> }[];
}

/**
 * Apply to the shared catalog (upsert items into an EXISTING brand standard — creating standards is a
 * curator action in catalog) or to the tenant's private spec library (quoting spec import).
 */
export async function applyBrandSpec(job: JobRow, body: BrandSpecApplyBody, principal: Principal) {
  const out = BrandSpecOutput.parse(job.output);
  const chosen = selectItems(
    out.items as unknown as Record<string, unknown>[],
    job.review,
    body.itemIndexes,
    body.edits,
  ).map((c) => c.item as unknown as BrandSpecItem);
  if (!chosen.length) throw unprocessable('No items selected to apply');
  if (body.target === 'catalog') {
    principal.require('catalog:contribute');
    const standardId = body.standardId ?? (job.input.standardId as string | undefined);
    if (!standardId)
      throw unprocessable(
        'standardId is required to apply to the catalog (choose an existing brand standard)',
      );
    await getBrandStandard(job.tenantId, standardId); // 404s if it does not exist
    await upsertBrandStandardItems(
      job.tenantId,
      standardId,
      chosen.map((i) => ({
        code: i.code,
        area: i.area,
        category: i.category,
        name: i.name,
        description: i.description,
        dimensions: i.dimensions,
        finish: i.finish,
        materials: i.materials,
        approvedVendors: i.approvedVendors,
        quantityBasis: i.quantityBasis,
        sourcePage: i.sourcePage,
      })),
    );
    return {
      target: 'catalog',
      standardId,
      applied: chosen.length,
      entity: { type: 'brand_standard', id: standardId },
    };
  }
  principal.require('specs:write');
  const res = await importSpecs(
    job.tenantId,
    chosen.map((i) => ({
      code: i.code,
      name: i.name,
      category: i.category,
      description:
        [
          i.description,
          i.approvedVendors.length
            ? `Approved: ${i.approvedVendors.map((v) => (v.model ? `${v.name} (${v.model})` : v.name)).join('; ')}`
            : null,
          i.quantityBasis ? `Qty: ${i.quantityBasis}` : null,
        ]
          .filter(Boolean)
          .join('\n') || null,
      dimensions: i.dimensions,
      finish: i.finish,
      materials: i.materials,
    })),
  );
  return { target: 'specs', applied: chosen.length, created: res.created, updated: res.updated };
}
