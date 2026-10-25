import { type Principal, unprocessable, z } from '@procure/platform';
import { PDFDocument } from 'pdf-lib';
import { createDocument, listSpecs } from '../../clients.js';
import { currentLlm } from '../../llm.js';
import { loadPdf, loadPdfText, PartialApplyError } from '../common.js';
import type { FeatureRunner, JobRow } from '../types.js';
import { assignPages, groupAssignments, type PageAssignment } from './heuristic.js';
import { llmAssignPages } from './llm.js';

export const DrawingGroup = z.object({
  specId: z.string(),
  code: z.string(),
  name: z.string(),
  pages: z.array(z.number().int().min(1)),
  confidence: z.number(),
  reasons: z.array(z.string()),
});

export const DrawingSplitOutput = z.object({
  filename: z.string(),
  pageCount: z.number().int(),
  groups: z.array(DrawingGroup),
  unassignedPages: z.array(z.number().int()),
  pageAssignments: z.array(
    z.object({
      page: z.number().int(),
      specId: z.string().nullable(),
      score: z.number(),
      reasons: z.array(z.string()),
      via: z.string().nullable(),
    }),
  ),
  candidates: z.array(z.object({ id: z.string(), code: z.string(), name: z.string() })),
  warnings: z.array(z.string()),
  scannedPages: z.array(z.number().int()).default([]),
});
export type DrawingSplitOutput = z.infer<typeof DrawingSplitOutput>;

export const runDrawingSplit: FeatureRunner = async ({ tenantId, job, meter, log }) => {
  const input = job.input as { documentId: string; quoteId?: string; specIds?: string[] };
  const [specs, pdf] = await Promise.all([
    listSpecs(tenantId, { quoteId: input.quoteId, ids: input.specIds }),
    loadPdfText(tenantId, input.documentId),
  ]);
  if (!specs.length) throw unprocessable('No candidate specs found for the quote / spec ids given');
  const warnings = [...pdf.warnings];
  let assignments: PageAssignment[] = assignPages(pdf.pages, specs);
  if (currentLlm().available) {
    try {
      const ai = await llmAssignPages(pdf.pages, specs, meter);
      // Strong rule-based signals (printed code/SKU) win over the model; the model fills the rest.
      assignments = assignments.map((h, i) => {
        const a = ai[i];
        if ((h.via === 'code' || h.via === 'sku') && h.specId) {
          if (a?.specId && a.specId !== h.specId)
            warnings.push(`Page ${h.page}: AI suggested a different spec; kept printed code match.`);
          return h;
        }
        return a?.specId ? a : h;
      });
    } catch (err) {
      log.warn({ err }, 'drawing-split LLM path failed; using heuristic');
      meter.heuristic();
      warnings.push(`AI model failed (${(err as Error).message}); used rule-based assignment.`);
    }
  } else meter.heuristic();
  const { groups, unassignedPages } = groupAssignments(assignments, specs);
  if (unassignedPages.length)
    warnings.push(`${unassignedPages.length} page(s) not assigned: ${unassignedPages.join(', ')}`);
  const missing = specs.filter((s) => !groups.some((g) => g.specId === s.id));
  if (missing.length && missing.length < specs.length)
    warnings.push(`No drawing found for: ${missing.map((s) => s.code).join(', ')}`);
  return {
    output: DrawingSplitOutput.parse({
      filename: pdf.filename,
      pageCount: pdf.pageCount,
      groups,
      unassignedPages,
      pageAssignments: assignments,
      candidates: specs.map((s) => ({ id: s.id, code: s.code, name: s.name })),
      warnings,
      scannedPages: pdf.scannedPages,
    }),
    pages: pdf.pageCount,
  };
};

export const DrawingSplitApplyBody = z.object({
  groups: z
    .array(
      z.object({
        specId: z.uuid(),
        code: z.string().optional(),
        name: z.string().optional(),
        pages: z.array(z.number().int().min(1)).min(1),
      }),
    )
    .optional(),
});

const safeName = (s: string) =>
  s
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);

export async function applyDrawingSplit(
  job: JobRow,
  body: z.infer<typeof DrawingSplitApplyBody>,
  principal: Principal,
) {
  principal.require('specs:write');
  const out = DrawingSplitOutput.parse(job.output);
  const reviewed = (job.review?.groups as z.infer<typeof DrawingSplitApplyBody>['groups']) ?? undefined;
  const chosen = body.groups ?? reviewed ?? out.groups;
  if (!chosen?.length) throw unprocessable('No groups to split');
  const candidates = new Map(out.candidates.map((c) => [c.id, c]));
  for (const g of chosen) {
    if (!candidates.has(g.specId))
      throw unprocessable(`Spec ${g.specId} was not a candidate for this packet`);
    for (const p of g.pages)
      if (p > out.pageCount) throw unprocessable(`Page ${p} is beyond the packet's ${out.pageCount} pages`);
  }
  const { bytes } = await loadPdf(job.tenantId, job.input.documentId as string);
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
  // Idempotent re-apply: skip groups already created in a previous (partially failed) apply.
  const done: { specId: string; documentId: string; filename: string; pages: number[] }[] = [
    ...((job.applyResult?.documents as any[]) ?? []),
  ];
  try {
    for (const g of chosen) {
      if (done.some((d) => d.specId === g.specId)) continue;
      const c = candidates.get(g.specId)!;
      const part = await PDFDocument.create();
      const copied = await part.copyPages(
        src,
        g.pages.map((p) => p - 1),
      );
      for (const pg of copied) part.addPage(pg);
      part.setTitle(`${c.code} – ${c.name} – line drawing`);
      part.setProducer('Pro-Cure AI');
      const filename = `${safeName(c.code)} – ${safeName(g.name ?? c.name)} – line drawing.pdf`;
      const doc = await createDocument(job.tenantId, {
        filename,
        contentType: 'application/pdf',
        base64: Buffer.from(await part.save()).toString('base64'),
        entityType: 'spec',
        entityId: g.specId,
        kind: 'line_drawing',
        visibility: 'internal',
        includeInSpecBook: true,
        uploadedByName: principal.name,
      });
      done.push({ specId: g.specId, documentId: doc.id, filename, pages: g.pages });
    }
  } catch (err) {
    throw new PartialApplyError(err, { documents: done, applied: done.length });
  }
  return { documents: done, applied: done.length };
}
