import type { SpecSummary } from '../../clients.js';
import type { PdfPage } from '../../text/extract.js';
import { codeKey, containsCode, normalizeSpace, round, tokenCoverage } from '../../text/util.js';

/**
 * Assign the pages of a vendor drawing packet to specs.
 *
 * Signals per (page, spec):
 *   strong  spec code printed on the page (title block "ITEM: CG-101", "Tag CG-101")   +0.60
 *   strong  vendor SKU / model number on the page                                      +0.50
 *   medium  spec name tokens covered by the page text (≥ 60%)                           +0.30 × coverage
 * Title-block text (the bottom/top 25% of the page, where vendors print item/tag/model) is weighted
 * ×1.15 for the code signal.
 *
 * Continuation: a page with no strong signal that follows a matched page belongs to the same spec when
 * it looks like a continuation ("Sheet 2 of 3", "Page 2/3", "(cont.)", "continued", or it shares the
 * previous page's title-block lines). Otherwise it is left unassigned for the reviewer.
 */

export interface PageAssignment {
  page: number;
  specId: string | null;
  score: number;
  reasons: string[];
  via: 'code' | 'sku' | 'name' | 'continuation' | 'llm' | null;
}

export interface DrawingGroup {
  specId: string;
  code: string;
  name: string;
  pages: number[];
  confidence: number;
  reasons: string[];
}

const SHEET_RE = /\b(?:sheet|page|pg\.?|dwg\.?)\s*(\d+)\s*(?:of|\/)\s*(\d+)\b/i;
const CONT_RE = /\b(?:cont(?:'d|\.|inued)?|continuation)\b/i;

const titleBlock = (p: PdfPage) => {
  const h = p.height || 792;
  return p.lines
    .filter((l) => l.y < h * 0.25 || l.y > h * 0.75)
    .map((l) => normalizeSpace(l.text))
    .filter(Boolean);
};

export function scorePage(
  page: PdfPage,
  spec: SpecSummary,
): { score: number; reasons: string[]; via: PageAssignment['via'] } {
  const text = page.text;
  const tb = titleBlock(page).join('\n');
  let score = 0;
  const reasons: string[] = [];
  let via: PageAssignment['via'] = null;
  if (spec.code && containsCode(text, spec.code)) {
    const inTb = containsCode(tb, spec.code);
    score += 0.6 * (inTb ? 1.15 : 1);
    reasons.push(`Spec code ${spec.code} on page${inTb ? ' title block' : ''}`);
    via = 'code';
  }
  if (spec.vendorSku && codeKey(spec.vendorSku).length >= 4 && containsCode(text, spec.vendorSku)) {
    score += 0.5;
    reasons.push(`Vendor model ${spec.vendorSku} on page`);
    via ??= 'sku';
  }
  const cov = tokenCoverage(spec.name, text);
  if (cov >= 0.6) {
    score += 0.3 * cov;
    reasons.push(`Name "${spec.name}" ${Math.round(cov * 100)}% present`);
    via ??= 'name';
  }
  return { score, reasons, via };
}

const looksLikeContinuation = (
  page: PdfPage,
  prev: PdfPage | undefined,
  prevSheet: [number, number] | null,
) => {
  const m = page.text.match(SHEET_RE);
  if (m) {
    const [n, of] = [Number(m[1]), Number(m[2])];
    if (n > 1 && n <= of) return { ok: true, reason: `Continuation sheet ${n} of ${of}` };
    if (n === 1) return { ok: false, reason: '' };
  }
  if (CONT_RE.test(page.text)) return { ok: true, reason: 'Marked as continued' };
  if (prev) {
    const a = new Set(titleBlock(prev).map((s) => s.replace(/\d+/g, '#')));
    const b = titleBlock(page).map((s) => s.replace(/\d+/g, '#'));
    const shared = b.filter((s) => a.has(s) && s.length > 6).length;
    if (shared >= 2 && !prevSheet) return { ok: true, reason: 'Same title block as previous page' };
  }
  if (page.scanned) return { ok: true, reason: 'Image-only page following a matched drawing' };
  return { ok: false, reason: '' };
};

export function assignPages(pages: PdfPage[], specs: SpecSummary[]): PageAssignment[] {
  const out: PageAssignment[] = [];
  let prevSheet: [number, number] | null = null;
  for (const [i, page] of pages.entries()) {
    const ranked = specs
      .map((s) => ({ s, ...scorePage(page, s) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score);
    const best = ranked[0];
    const strong = best && (best.via === 'code' || best.via === 'sku');
    const second = ranked[1];
    const ambiguous = best && second && best.score - second.score < 0.1 && best.via === second.via;
    const prev = out[i - 1];
    if (strong && !ambiguous) {
      out.push({
        page: page.page,
        specId: best.s.id,
        score: round(Math.min(0.99, best.score), 2),
        reasons: best.reasons,
        via: best.via,
      });
    } else if (prev?.specId) {
      const c = looksLikeContinuation(page, pages[i - 1], prevSheet);
      if (c.ok)
        out.push({
          page: page.page,
          specId: prev.specId,
          score: round(Math.min(prev.score, 0.8), 2),
          reasons: [c.reason],
          via: 'continuation',
        });
      else if (best && best.score >= 0.25 && !ambiguous)
        out.push({
          page: page.page,
          specId: best.s.id,
          score: round(best.score, 2),
          reasons: best.reasons,
          via: best.via,
        });
      else
        out.push({
          page: page.page,
          specId: null,
          score: 0,
          reasons: ambiguous ? ['Matches several specs equally'] : ['No spec signal'],
          via: null,
        });
    } else if (best && best.score >= 0.25 && !ambiguous) {
      out.push({
        page: page.page,
        specId: best.s.id,
        score: round(best.score, 2),
        reasons: best.reasons,
        via: best.via,
      });
    } else {
      out.push({
        page: page.page,
        specId: null,
        score: 0,
        reasons: ambiguous ? ['Matches several specs equally'] : ['No spec signal'],
        via: null,
      });
    }
    const m = page.text.match(SHEET_RE);
    prevSheet = m ? [Number(m[1]), Number(m[2])] : null;
  }
  return out;
}

export function groupAssignments(assignments: PageAssignment[], specs: SpecSummary[]) {
  const byId = new Map(specs.map((s) => [s.id, s]));
  const groups = new Map<string, DrawingGroup>();
  for (const a of assignments) {
    if (!a.specId) continue;
    const s = byId.get(a.specId);
    if (!s) continue;
    const g = groups.get(s.id) ?? {
      specId: s.id,
      code: s.code,
      name: s.name,
      pages: [],
      confidence: 1,
      reasons: [],
    };
    g.pages.push(a.page);
    g.confidence = Math.min(g.confidence, a.score);
    for (const r of a.reasons)
      if (!g.reasons.includes(`p${a.page}: ${r}`)) g.reasons.push(`p${a.page}: ${r}`);
    groups.set(s.id, g);
  }
  const unassignedPages = assignments.filter((a) => !a.specId).map((a) => a.page);
  return {
    groups: [...groups.values()]
      .map((g) => ({ ...g, confidence: round(g.confidence, 2) }))
      .sort((a, b) => a.pages[0]! - b.pages[0]!),
    unassignedPages,
  };
}
