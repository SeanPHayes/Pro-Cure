import type { SpecCategory } from '@procure/domain';
import type { PdfPage } from '../../text/extract.js';
import { findDate, normalizeSpace, SPEC_CODE_RE } from '../../text/util.js';
import type { BrandSpecItem, BrandSpecOutput, BrandSpecStandard } from './schema.js';

/**
 * Deterministic brand-standard parser.
 *
 * Brand standards (Hilton, IHG, Marriott FF&E packages) list items as a row that starts with an item
 * code ("GR-01", "CG-101", "ST-12", "LT-3", "FF-04A"), followed by the item name, then labelled
 * attribute lines ("Dimensions:", "Finish:", "Material(s):", "Approved Manufacturer(s):", "Qty:").
 * Area headings are set in capitals ("GUESTROOM", "PUBLIC AREAS – LOBBY"). Running headers/footers are
 * detected as lines repeated on many pages and ignored.
 */

// ---------------------------------------------------------------- category mapping
/** Code prefix → category. Longest prefix wins. */
const PREFIX_CATEGORY: Record<string, SpecCategory> = {
  CG: 'casegoods',
  CS: 'casegoods',
  FC: 'casegoods',
  ST: 'seating',
  SE: 'seating',
  CH: 'seating',
  SS: 'soft_seating',
  UP: 'soft_seating',
  SF: 'soft_seating',
  TB: 'tables',
  TA: 'tables',
  BD: 'bedding',
  BB: 'bedding',
  LT: 'lighting',
  LF: 'lighting',
  LI: 'lighting',
  AR: 'artwork',
  AW: 'artwork',
  MR: 'mirrors',
  MI: 'mirrors',
  WC: 'window_treatments',
  WT: 'window_treatments',
  DR: 'window_treatments',
  CP: 'carpet',
  CT: 'carpet',
  RG: 'carpet',
  FL: 'flooring',
  LVT: 'flooring',
  TL: 'flooring',
  WV: 'wallcovering',
  WP: 'wallcovering',
  VW: 'wallcovering',
  MW: 'millwork',
  ML: 'millwork',
  PL: 'plumbing',
  PF: 'plumbing',
  EL: 'electronics',
  TV: 'electronics',
  AV: 'electronics',
  SG: 'signage',
  SN: 'signage',
  OD: 'outdoor',
  EX: 'outdoor',
  OS: 'ose',
  OSE: 'ose',
};

/** Keyword → category, checked against the item name (first match in order wins). */
const KEYWORD_CATEGORY: [RegExp, SpecCategory][] = [
  [/\b(sofa|sleeper|loveseat|lounge chair|settee|ottoman|banquette|sectional)\b/i, 'soft_seating'],
  [/\b(chair|stool|bench|seating)\b/i, 'seating'],
  [
    /\b(headboard|nightstand|dresser|chest|wardrobe|armoire|desk|credenza|media (?:unit|console)|luggage|casegood|vanity base|tv panel)\b/i,
    'casegoods',
  ],
  [/\b(table|cocktail|end table|side table)\b/i, 'tables'],
  [/\b(lamp|sconce|pendant|chandelier|light(?:ing)?|luminaire|fixture|downlight)\b/i, 'lighting'],
  [/\b(mirror)\b/i, 'mirrors'],
  [/\b(art(?:work)?|print|canvas|sculpture|framed)\b/i, 'artwork'],
  [/\b(drape|drapery|sheer|blackout|roller shade|shade|blind|valance|window)\b/i, 'window_treatments'],
  [/\b(carpet|broadloom|rug|area rug)\b/i, 'carpet'],
  [/\b(lvt|vinyl plank|tile|flooring|hardwood|laminate floor)\b/i, 'flooring'],
  [/\b(wallcovering|wall covering|vinyl wall|wallpaper)\b/i, 'wallcovering'],
  [/\b(millwork|built-in|casework|countertop)\b/i, 'millwork'],
  [/\b(faucet|lavatory|toilet|shower|tub|sink|plumbing)\b/i, 'plumbing'],
  [/\b(tv|television|monitor|speaker|charging|usb)\b/i, 'electronics'],
  [/\b(sign(?:age)?|wayfinding)\b/i, 'signage'],
  [/\b(outdoor|patio|pool|umbrella|chaise)\b/i, 'outdoor'],
  [/\b(mattress|box spring|foundation|bed frame|bedding|duvet|pillow|linen)\b/i, 'bedding'],
  [/\b(ice bucket|tray|hanger|wastebasket|ose|accessor)/i, 'ose'],
];

export function categorize(code: string, name: string): { category: SpecCategory; fromPrefix: boolean } {
  const parts = code.toUpperCase().split('-');
  // "PA-LB-02" → try "PA", "LB" (area prefix then type prefix); prefer a typed match.
  for (const p of [...parts.slice(0, -1)].reverse()) {
    const cat = PREFIX_CATEGORY[p];
    if (cat) return { category: cat, fromPrefix: true };
  }
  for (const [re, cat] of KEYWORD_CATEGORY) if (re.test(name)) return { category: cat, fromPrefix: false };
  return { category: 'other', fromPrefix: false };
}

// ---------------------------------------------------------------- attribute labels
type Attr =
  | 'description'
  | 'dimensions'
  | 'finish'
  | 'materials'
  | 'vendors'
  | 'quantity'
  | 'notes'
  | 'model';
const LABELS: [RegExp, Attr][] = [
  [/^(?:description|desc\.?|item description)\s*[:–-]\s*/i, 'description'],
  [/^(?:dimensions?|dims?\.?|size|overall size)\s*[:–-]\s*/i, 'dimensions'],
  [/^(?:finish(?:es)?|color|colour|finish\/color)\s*[:–-]\s*/i, 'finish'],
  [/^(?:materials?|material\(s\)|construction|fabric|content)\s*[:–-]\s*/i, 'materials'],
  [
    /^(?:approved\s+)?(?:manufacturers?|manufacturer\(s\)|mfrs?\.?|vendors?|vendor\(s\)|sources?|suppliers?)\s*[:–-]\s*/i,
    'vendors',
  ],
  [/^(?:qty|quantity|quantities|qty\.?\s*basis|allowance)\s*[:–-]\s*/i, 'quantity'],
  [/^(?:model|style|pattern|sku|catalog\s*#?)\s*[:–-]\s*/i, 'model'],
  [/^(?:notes?|remarks?|comments?)\s*[:–-]\s*/i, 'notes'],
];

const matchLabel = (line: string): { attr: Attr; value: string } | null => {
  for (const [re, attr] of LABELS) {
    const m = line.match(re);
    if (m) return { attr, value: line.slice(m[0].length).trim() };
  }
  return null;
};

// ---------------------------------------------------------------- area headings & boilerplate
const NOT_AREA =
  /\b(STANDARDS?|PAGE|CONFIDENTIAL|PROPRIETARY|REVISION|REV\.?|VERSION|EFFECTIVE|COPYRIGHT|TABLE OF CONTENTS|CONTENTS|SPECIFICATIONS?|SECTION \d+$|ITEM|CODE|DESCRIPTION|NOTES?)\b/;

export const isAreaHeading = (line: string): boolean => {
  const t = line.trim();
  if (t.length < 4 || t.length > 60) return false;
  if (SPEC_CODE_RE.test(t) || /\d{2,}/.test(t) || t.includes(':')) return false;
  const letters = t.replace(/[^A-Za-z]/g, '');
  if (letters.length < 4 || letters !== letters.toUpperCase()) return false;
  if (NOT_AREA.test(t)) return false;
  return /^[A-Z][A-Z &/,'’().–—-]+$/.test(t);
};

const cleanArea = (s: string) =>
  normalizeSpace(s.replace(/[—]/g, '–'))
    .split(' ')
    .map((w) =>
      /^[A-Z]{2,}$/.test(w) && !['F&E', 'FF&E', 'ADA'].includes(w) ? w[0] + w.slice(1).toLowerCase() : w,
    )
    .join(' ');

/** Running headers/footers: lines in the top/bottom 8% of the page that repeat on ≥ 40% of pages (min 2). */
const marginKey = (p: PdfPage, l: { y: number; text: string }) => {
  const h = p.height || 792;
  if (l.y > h * 0.08 && l.y < h * 0.92) return null;
  return normalizeSpace(l.text).replace(/\d+/g, '#');
};

export function boilerplate(pages: PdfPage[]): Set<string> {
  if (pages.length < 2) return new Set();
  const counts = new Map<string, number>();
  for (const p of pages) {
    const seen = new Set(p.lines.map((l) => marginKey(p, l)).filter((k): k is string => !!k));
    for (const s of seen) counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  const min = Math.max(2, Math.ceil(pages.length * 0.4));
  return new Set([...counts].filter(([, n]) => n >= min).map(([s]) => s));
}

// ---------------------------------------------------------------- standard header
const BRANDS: [RegExp, string][] = [
  [/\bhampton\b/i, 'Hampton by Hilton'],
  [/\bhilton garden inn\b/i, 'Hilton Garden Inn'],
  [/\bhomewood suites\b/i, 'Homewood Suites by Hilton'],
  [/\bhome2 suites\b/i, 'Home2 Suites by Hilton'],
  [/\bembassy suites\b/i, 'Embassy Suites by Hilton'],
  [/\bdoubletree\b/i, 'DoubleTree by Hilton'],
  [/\btru by hilton\b/i, 'Tru by Hilton'],
  [/\bcurio\b/i, 'Curio Collection by Hilton'],
  [/\btapestry\b/i, 'Tapestry Collection by Hilton'],
  [/\bholiday inn express\b/i, 'Holiday Inn Express'],
  [/\bholiday inn\b/i, 'Holiday Inn'],
  [/\bcrowne plaza\b/i, 'Crowne Plaza'],
  [/\bstaybridge\b/i, 'Staybridge Suites'],
  [/\bcandlewood\b/i, 'Candlewood Suites'],
  [/\bavid\b/i, 'avid hotels'],
  [/\bhotel indigo\b/i, 'Hotel Indigo'],
  [/\bkimpton\b/i, 'Kimpton'],
  [/\bvoco\b/i, 'voco'],
  [/\bcourtyard\b/i, 'Courtyard by Marriott'],
  [/\bfairfield\b/i, 'Fairfield by Marriott'],
  [/\bresidence inn\b/i, 'Residence Inn by Marriott'],
  [/\bspringhill suites\b/i, 'SpringHill Suites by Marriott'],
  [/\btowneplace\b/i, 'TownePlace Suites by Marriott'],
  [/\bfour points\b/i, 'Four Points by Sheraton'],
  [/\bsheraton\b/i, 'Sheraton'],
  [/\bwestin\b/i, 'Westin'],
  [/\baloft\b/i, 'Aloft'],
  [/\bmoxy\b/i, 'Moxy'],
  [/\belement\b/i, 'Element by Westin'],
  [/\bac hotels?\b/i, 'AC Hotels by Marriott'],
  [/\bhilton\b/i, 'Hilton'],
  [/\bihg\b/i, 'IHG'],
  [/\bmarriott\b/i, 'Marriott'],
];

export function parseStandardHeader(pages: PdfPage[]): BrandSpecStandard {
  const head = pages
    .slice(0, 2)
    .flatMap((p) => p.lines.map((l) => l.text))
    .slice(0, 40);
  const all = head.join('\n');
  const nameLine =
    head.find((l) =>
      /\b(brand|design|ff&e|furniture|interior)\b.*\b(standards?|guidelines?|specifications?|requirements)\b/i.test(
        l,
      ),
    ) ??
    head.find((l) => /\bstandards?\b/i.test(l)) ??
    null;
  const brand = BRANDS.find(([re]) => re.test(all))?.[1] ?? null;
  const version =
    all.match(/\b(?:version|ver\.?|v)\s*[:#]?\s*(\d+(?:\.\d+)*[a-z]?)\b/i)?.[1] ??
    all.match(/\b(?:revision|rev\.?)\s*[:#]?\s*([A-Z0-9][\w.]*)\b/i)?.[1] ??
    null;
  const effLine = head.find((l) => /\beffective\b|\bissue(?:d)? date\b|\bdated\b/i.test(l));
  const effectiveDate = effLine
    ? (findDate(effLine.replace(/^.*?(effective|date[d]?)\s*(date)?\s*[:–-]?\s*/i, '')) ?? findDate(effLine))
    : null;
  return {
    name: nameLine ? normalizeSpace(nameLine.replace(/\s*[|–—-]\s*(?:version|rev).*$/i, '')) : null,
    brandGuess: brand,
    version,
    effectiveDate,
  };
}

// ---------------------------------------------------------------- vendors
export function parseApprovedVendors(value: string): { name: string; model: string | null }[] {
  return value
    .split(/\s*(?:;|\||\/(?!\d)|\bor\b|\band\b(?=\s+[A-Z]))\s*/)
    .map((s) => s.trim().replace(/^[,.\s]+|[,.\s]+$/g, ''))
    .filter((s) => s.length > 1 && !/^(?:or equal|equal|approved equal|tbd|n\/a)$/i.test(s))
    .map((s) => {
      const paren = s.match(/^(.*?)\s*\((?:model|style|item|#)?\s*[:#]?\s*([^)]+)\)\s*$/i);
      if (paren) return { name: paren[1]!.trim(), model: paren[2]!.trim() };
      const dash = s.match(/^(.*?)\s*(?:[–—]|-\s|,)\s*(?:model|style|item|#)?\s*[:#]?\s*(.+)$/i);
      if (dash && /\d/.test(dash[2]!)) return { name: dash[1]!.trim(), model: dash[2]!.trim() };
      const model = s.match(/^(.*?)\s+(?:model|style|item|#)\s*[:#]?\s*(\S.*)$/i);
      if (model) return { name: model[1]!.trim(), model: model[2]!.trim() };
      return { name: s, model: null };
    })
    .filter((v) => v.name.length > 1);
}

// ---------------------------------------------------------------- items
const ITEM_START = new RegExp(`^(?:item\\s*)?${SPEC_CODE_RE.source}\\s*(?:[:–—|.-]\\s*)?(.*)$`);

interface Draft {
  code: string;
  name: string;
  area: string | null;
  page: number;
  attrs: Partial<Record<Attr, string>>;
  extra: string[];
  last: Attr | 'name' | null;
}

const finalize = (d: Draft): BrandSpecItem => {
  const { category, fromPrefix } = categorize(d.code, `${d.name} ${d.attrs.description ?? ''}`);
  const vendors = d.attrs.vendors ? parseApprovedVendors(d.attrs.vendors) : [];
  if (d.attrs.model && vendors.length && !vendors[0]!.model) vendors[0]!.model = d.attrs.model;
  const description = [d.attrs.description, ...d.extra].filter(Boolean).join(' ') || null;
  const notes = d.attrs.notes ? ` Notes: ${d.attrs.notes}` : '';
  const found = ['dimensions', 'finish', 'materials', 'vendors', 'quantity'].filter(
    (k) => d.attrs[k as Attr],
  ).length;
  let confidence =
    0.45 + found * 0.1 + (description ? 0.05 : 0) + (fromPrefix ? 0.05 : category === 'other' ? -0.1 : 0);
  if (!d.name) confidence -= 0.2;
  return {
    code: d.code,
    area: d.area,
    category,
    name: d.name || d.code,
    description: description ? normalizeSpace(description + notes) : notes ? notes.trim() : null,
    dimensions: d.attrs.dimensions ?? null,
    finish: d.attrs.finish ?? null,
    materials: d.attrs.materials ?? null,
    approvedVendors: vendors,
    quantityBasis: d.attrs.quantity ?? null,
    sourcePage: d.page,
    confidence: Math.round(Math.min(0.95, Math.max(0.1, confidence)) * 100) / 100,
  };
};

export function heuristicBrandSpec(pages: PdfPage[]): BrandSpecOutput {
  const skip = boilerplate(pages);
  const standard = parseStandardHeader(pages);
  const items: BrandSpecItem[] = [];
  const warnings: string[] = [];
  let area: string | null = null;
  let cur: Draft | null = null;
  const flush = () => {
    if (cur) items.push(finalize(cur));
    cur = null;
  };

  for (const page of pages) {
    if (page.scanned) continue;
    for (const line of page.lines) {
      const text = normalizeSpace(line.text);
      if (!text) continue;
      const mk = marginKey(page, line);
      if (mk && skip.has(mk)) continue;
      if (/^page \d+( of \d+)?$/i.test(text)) continue;

      const cont = text.match(/^(.+?)\s*\((?:cont(?:inued|'d|\.)?)\)\s*$/i);
      if (cont && isAreaHeading(cont[1]!)) {
        flush();
        area = cleanArea(cont[1]!);
        continue;
      }
      if (isAreaHeading(text)) {
        flush();
        area = cleanArea(text);
        continue;
      }

      // Table layout: cells [code, name, dimensions?, finish?, ...] — treat first cell as code.
      const startText =
        line.cells.length > 1 && SPEC_CODE_RE.test(line.cells[0]!) ? line.cells.join(' – ') : text;
      const start = startText.match(ITEM_START);
      if (start && startText.indexOf(start[1]!) <= 6) {
        flush();
        const rest = (start[2] ?? '').replace(/^[–—:|.-]+\s*/, '');
        const d: Draft = {
          code: start[1]!,
          name: '',
          area,
          page: page.page,
          attrs: {},
          extra: [],
          last: 'name',
        };
        // Inline "Name – Dimensions: …" or table cells beyond the name.
        const segments = rest.split(/\s+[–—|]\s+/);
        d.name = normalizeSpace(segments.shift() ?? '');
        for (const seg of segments) {
          const lab = matchLabel(seg);
          if (lab) d.attrs[lab.attr] = lab.value;
          else d.extra.push(seg);
        }
        cur = d;
        continue;
      }

      const c = cur as Draft | null;
      if (!c) continue;
      const lab = matchLabel(text);
      if (lab) {
        c.attrs[lab.attr] = c.attrs[lab.attr] ? `${c.attrs[lab.attr]}; ${lab.value}` : lab.value;
        c.last = lab.attr;
        continue;
      }
      // Continuation of the previous attribute (wrapped line) or free description.
      if (c.last && c.last !== 'name' && text.length < 200 && /^[a-z(,&]/.test(text)) {
        c.attrs[c.last] = `${c.attrs[c.last]} ${text}`;
      } else if (c.last === 'name' && !c.extra.length && !c.attrs.description && /^[a-z(]/.test(text)) {
        c.name = `${c.name} ${text}`;
      } else {
        c.extra.push(text);
      }
    }
  }
  flush();

  // De-duplicate by code (items repeated on summary pages): keep the richest record.
  const byCode = new Map<string, BrandSpecItem>();
  for (const it of items) {
    const prev = byCode.get(it.code);
    if (!prev || it.confidence > prev.confidence) byCode.set(it.code, it);
  }
  const deduped = [...byCode.values()];
  if (items.length !== deduped.length)
    warnings.push(`${items.length - deduped.length} duplicate item code(s) merged.`);
  if (!deduped.length)
    warnings.push('No item codes found. The document may not be a brand standard, or it is scanned.');
  const low = deduped.filter((i) => i.confidence < 0.5).length;
  if (low) warnings.push(`${low} item(s) have few attributes — review before applying.`);
  return { standard, items: deduped, warnings, scannedPages: [] };
}
