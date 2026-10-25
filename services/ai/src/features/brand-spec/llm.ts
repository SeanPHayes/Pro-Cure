import { SpecCategory } from '@procure/domain';
import { z } from '@procure/platform';
import type { Meter } from '../../llm.js';
import { type PdfPage, pageBatches, pagesForPrompt } from '../../text/extract.js';
import { categorize } from './heuristic.js';
import type { BrandSpecItem, BrandSpecOutput, BrandSpecStandard } from './schema.js';

const LlmItem = z.object({
  code: z.string().min(1),
  area: z.string().nullable(),
  category: SpecCategory,
  name: z.string().min(1),
  description: z.string().nullable(),
  dimensions: z.string().nullable(),
  finish: z.string().nullable(),
  materials: z.string().nullable(),
  approvedVendors: z.array(z.object({ name: z.string(), model: z.string().nullable() })),
  quantityBasis: z.string().nullable(),
  sourcePage: z.number().int().nullable(),
  confidence: z.number().min(0).max(1),
});

const LlmBatch = z.object({
  standard: z
    .object({
      name: z.string().nullable(),
      brandGuess: z.string().nullable(),
      version: z.string().nullable(),
      effectiveDate: z.string().nullable(),
    })
    .nullable(),
  items: z.array(LlmItem),
  warnings: z.array(z.string()),
});

const SYSTEM = `You are an FF&E (furniture, fixtures & equipment) specification analyst at a hospitality procurement
firm. You read hotel brand-standard documents (Hilton, IHG, Marriott and their sub-brands) and turn them into a
structured list of specifiable items that designers and buyers will source.

Rules:
- An item is something that gets specified and purchased: casegoods, seating, lighting, mirrors, art, window
  treatments, carpet, flooring, wallcovering, plumbing fixtures, electronics, signage, OS&E, etc. Do NOT emit
  general guidance paragraphs, prototype room layouts, or code-compliance notes as items.
- "code" is the item code exactly as printed (e.g. "GR-01", "CG-101", "ST-12", "LT-3", "FF-04A"). If an item truly
  has no code, build one from the area and a sequence (e.g. "LOBBY-01") and say so in "warnings".
- "area" is the space heading the item sits under, in Title Case ("Guestroom", "Public Areas – Lobby", "Corridor").
- "category" must be one of: ${SpecCategory.options.join(', ')}. Use soft_seating for upholstered lounge pieces
  (sofas, lounge chairs, ottomans), seating for task/dining/desk chairs and stools, casegoods for wood or laminate
  case pieces (headboards, nightstands, dressers, desks, wardrobes), ose for operating supplies & equipment.
- Copy dimensions, finish and materials verbatim (keep units like 24"W x 18"D x 30"H). Put the brand-approved
  manufacturers in "approvedVendors" with their model/style number when given; "or approved equal" is not a vendor.
- "quantityBasis" is the quantity rule as written ("1 per king room", "2 per double/queen", "per plan").
- "sourcePage" is the page number from the <page number="…"> marker where the item starts.
- "confidence" (0–1) reflects how completely and unambiguously the item was stated.
- "standard" describes the document itself (title, brand, version, effective date YYYY-MM-DD) if visible in these
  pages, else null.
- Never invent values that are not in the text.`;

export async function llmBrandSpec(
  pages: PdfPage[],
  meter: Meter,
): Promise<Omit<BrandSpecOutput, 'scannedPages'>> {
  const batches = pageBatches(pages, 12_000);
  const items = new Map<string, BrandSpecItem>();
  const warnings: string[] = [];
  let standard: BrandSpecStandard = { name: null, brandGuess: null, version: null, effectiveDate: null };

  for (const [i, batch] of batches.entries()) {
    const res = await meter.json(
      {
        system: SYSTEM,
        prompt: `Brand-standard pages ${batch[0]!.page}–${batch.at(-1)!.page} (batch ${i + 1} of ${batches.length}).
Extract every specifiable item that STARTS on these pages. If an item continues from a previous batch, include it
only if its code appears here with new attributes.

${pagesForPrompt(batch)}

Return JSON: {"standard": {...}|null, "items": [...], "warnings": [...]}`,
        maxTokens: 8000,
      },
      LlmBatch,
    );
    if (res.standard) {
      standard = {
        name: standard.name ?? res.standard.name,
        brandGuess: standard.brandGuess ?? res.standard.brandGuess,
        version: standard.version ?? res.standard.version,
        effectiveDate: standard.effectiveDate ?? normalizeIsoDate(res.standard.effectiveDate),
      };
    }
    warnings.push(...res.warnings);
    for (const it of res.items) {
      const key = it.code.toUpperCase().trim();
      const prev = items.get(key);
      items.set(key, prev ? mergeItems(prev, it) : { ...it, code: it.code.trim() });
    }
  }
  // Guard against a model mislabeling an obviously coded category.
  for (const it of items.values()) {
    if (it.category === 'other') it.category = categorize(it.code, it.name).category;
  }
  return { standard, items: [...items.values()], warnings };
}

const normalizeIsoDate = (s: string | null) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null);

/** Merge two records for the same code: keep non-null fields, union vendors, max confidence. */
export function mergeItems(a: BrandSpecItem, b: BrandSpecItem): BrandSpecItem {
  const vendors = [...a.approvedVendors];
  for (const v of b.approvedVendors)
    if (!vendors.some((x) => x.name.toLowerCase() === v.name.toLowerCase())) vendors.push(v);
  return {
    ...a,
    area: a.area ?? b.area,
    category: a.category === 'other' ? b.category : a.category,
    description: a.description ?? b.description,
    dimensions: a.dimensions ?? b.dimensions,
    finish: a.finish ?? b.finish,
    materials: a.materials ?? b.materials,
    approvedVendors: vendors,
    quantityBasis: a.quantityBasis ?? b.quantityBasis,
    sourcePage: a.sourcePage ?? b.sourcePage,
    confidence: Math.max(a.confidence, b.confidence),
  };
}
