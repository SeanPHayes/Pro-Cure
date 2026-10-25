import { z } from '@procure/platform';
import type { SpecSummary } from '../../clients.js';
import type { Meter } from '../../llm.js';
import type { PdfPage } from '../../text/extract.js';
import type { PageAssignment } from './heuristic.js';

const LlmAssign = z.object({
  pages: z.array(
    z.object({
      page: z.number().int(),
      specId: z.string().nullable(),
      confidence: z.number().min(0).max(1),
      reason: z.string(),
    }),
  ),
});

const SYSTEM = `You split a furniture manufacturer's drawing packet (shop drawings / line drawings for a hotel FF&E order)
into one drawing set per specified item. Each drawing usually has a title block with the buyer's item/tag code
(e.g. "CG-101"), the manufacturer's model number, the item name, a sheet number ("Sheet 2 of 3") and revision.

Assign every page to exactly one spec id from the provided list, or null when the page is a cover sheet, general
notes, a finish schedule shared by many items, or cannot be identified. A page with no identifiers that continues
the previous page's drawing (continuation sheet, same title block, detail views) belongs to the same spec as the
previous page. Only use spec ids from the list.`;

/** Max characters per page sent to the model; drawings are sparse, title blocks matter most. */
const PER_PAGE = 1500;

export async function llmAssignPages(
  pages: PdfPage[],
  specs: SpecSummary[],
  meter: Meter,
): Promise<PageAssignment[]> {
  const specList = specs
    .map((s) => JSON.stringify({ id: s.id, code: s.code, name: s.name, vendorSku: s.vendorSku }))
    .join('\n');
  const known = new Set(specs.map((s) => s.id));
  const result: PageAssignment[] = [];
  for (let i = 0; i < pages.length; i += 30) {
    const chunk = pages.slice(i, i + 30);
    const res = await meter.json(
      {
        system: SYSTEM,
        prompt: `Specs:
${specList}

Pages (previous page's assignment: ${result.at(-1)?.specId ?? 'none'}):
${chunk.map((p) => `<page number="${p.page}">\n${p.scanned ? '[image only — no text]' : p.text.slice(0, PER_PAGE)}\n</page>`).join('\n')}

Return JSON: {"pages": [{"page": n, "specId": "…"|null, "confidence": 0-1, "reason": "…"}]} with one entry per page.`,
        maxTokens: 4000,
      },
      LlmAssign,
    );
    const byPage = new Map(res.pages.map((p) => [p.page, p]));
    for (const p of chunk) {
      const a = byPage.get(p.page);
      const specId = a?.specId && known.has(a.specId) ? a.specId : null;
      result.push({
        page: p.page,
        specId,
        score: specId ? Math.round((a?.confidence ?? 0.5) * 100) / 100 : 0,
        reasons: [a?.reason ?? 'Not returned by model'],
        via: specId ? 'llm' : null,
      });
    }
  }
  return result;
}
