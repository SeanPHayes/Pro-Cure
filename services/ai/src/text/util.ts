/**
 * Deterministic text helpers shared by the heuristic extractors: tokenization and similarity, money,
 * quantity, date and lead-time parsing, and spec-code normalization.
 */

const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'the',
  'of',
  'for',
  'with',
  'w',
  'to',
  'in',
  'on',
  'by',
  'at',
  'or',
  'per',
  'x',
  'ea',
  'each',
  'qty',
  'item',
  'no',
]);

export const normalizeSpace = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Lowercase alphanumeric tokens without stopwords or bare 1-char tokens. */
export const tokens = (s: string | null | undefined): string[] =>
  (s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));

/** Dice coefficient over token sets (0..1). Robust to word order and extra words. */
export const tokenSetSimilarity = (a: string | null | undefined, b: string | null | undefined): number => {
  const A = new Set(tokens(a));
  const B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return (2 * inter) / (A.size + B.size);
};

/** Share of `needle` tokens present in `haystack` (0..1); good for "is this name mentioned here". */
export const tokenCoverage = (needle: string | null | undefined, haystack: string | null | undefined) => {
  const N = new Set(tokens(needle));
  const H = new Set(tokens(haystack));
  if (!N.size) return 0;
  let hit = 0;
  for (const t of N) if (H.has(t)) hit++;
  return hit / N.size;
};

/** Spec / SKU code comparison key: uppercase, no separators ("cg-101" → "CG101"). */
export const codeKey = (s: string | null | undefined) => (s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * Brand-standard style item codes: GR-01, CG-101, ST-12, LT-3, FF-04A, PA-LB-02, and brand prefixes that
 * contain a digit such as Home2's H2-CG-01. The first segment must start with a letter.
 */
export const SPEC_CODE_RE = /\b([A-Z][A-Z0-9]{0,3}(?:-[A-Z]{1,3})?-\d{1,4}[A-Z]?)\b/;
export const SPEC_CODE_RE_G = new RegExp(SPEC_CODE_RE.source, 'g');

/** True when `text` contains `code` as a standalone token (tolerant of a missing hyphen). */
export const containsCode = (text: string, code: string): boolean => {
  const k = codeKey(code);
  if (k.length < 3) return false;
  // Split off the trailing number: "H2-CG-01" → "H2-CG" + "01", "FF-04A" → "FF" + "04A".
  const m = code.toUpperCase().match(/^([A-Z0-9-]*?[A-Z])-?(\d[\dA-Z]*)$/);
  const pattern = m
    ? `(?<![A-Z0-9])${m[1]!.replace(/-/g, '[-\\s]?')}[-\\s]?${m[2]!.replace(/[^A-Z0-9]/g, '')}(?![A-Z0-9])`
    : `(?<![A-Z0-9])${k}(?![A-Z0-9])`;
  return new RegExp(pattern, 'i').test(text);
};

// ---------------------------------------------------------------- money & numbers
export const MONEY_RE =
  /\$\s?\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\$\s?\d+(?:\.\d{1,2})?|\b\d{1,3}(?:,\d{3})+\.\d{2}\b|\b\d+\.\d{2}\b/g;

export const parseMoney = (s: string | null | undefined): number | null => {
  if (!s) return null;
  const m = s.replace(/USD/i, '').match(/-?\$?\s?([\d,]+(?:\.\d+)?)/);
  if (!m) return null;
  const n = Number.parseFloat(m[1]!.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};

/** A token that is purely a money amount ("$1,234.50", "1234.50"). */
export const isMoneyToken = (t: string) =>
  /^\(?-?\$?\s?\d{1,3}(?:,\d{3})*(?:\.\d{2,4})?\)?$|^\(?-?\$?\s?\d+\.\d{2,4}\)?$/.test(t.trim()) &&
  (t.includes('$') || t.includes('.') || t.includes(','));

// ---------------------------------------------------------------- dates
const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  sept: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

const pad = (n: number) => String(n).padStart(2, '0');
const iso = (y: number, m: number, d: number): string | null => {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
};
const fullYear = (y: number) => (y < 100 ? 2000 + y : y);

/** Regex source matching the date formats `parseDate` understands (for embedding in patterns). */
export const DATE_SRC =
  '(?:\\d{4}-\\d{1,2}-\\d{1,2}|\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{2,4}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?|\\d{1,2}(?:st|nd|rd|th)?[\\s-](?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?(?:[\\s-,]+\\d{2,4})?)';

/**
 * Parse common US business date formats into YYYY-MM-DD. Year-less dates ("Nov 15") resolve to the
 * next occurrence on/after `ref` minus 60 days (so a recently-past date stays in the current year).
 */
export const parseDate = (s: string | null | undefined, ref: Date = new Date()): string | null => {
  if (!s) return null;
  const t = s.trim().toLowerCase();
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return iso(+m[1]!, +m[2]!, +m[3]!);
  m = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/);
  if (m) return iso(fullYear(+m[3]!), +m[1]!, +m[2]!);
  const withYear = (mon: number, day: number, y?: string) => {
    if (y) return iso(fullYear(+y), mon, day);
    let year = ref.getUTCFullYear();
    const candidate = Date.UTC(year, mon - 1, day);
    if (candidate < ref.getTime() - 60 * 86_400_000) year++;
    return iso(year, mon, day);
  };
  m = t.match(/^([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?/);
  if (m && MONTHS[m[1]!.slice(0, m[1]!.startsWith('sept') ? 4 : 3)])
    return withYear(MONTHS[m[1]!.slice(0, m[1]!.startsWith('sept') ? 4 : 3)]!, +m[2]!, m[3]);
  m = t.match(/^(\d{1,2})(?:st|nd|rd|th)?[\s-]([a-z]{3,9})\.?(?:[\s,-]+(\d{2,4}))?/);
  if (m && MONTHS[m[2]!.slice(0, 3)]) return withYear(MONTHS[m[2]!.slice(0, 3)]!, +m[1]!, m[3]);
  return null;
};

/** Find the first date in free text. */
export const findDate = (s: string, ref?: Date): string | null => {
  const m = s.match(new RegExp(DATE_SRC, 'i'));
  return m ? parseDate(m[0], ref) : null;
};

export const addDays = (isoDate: string, days: number) => {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

export const daysBetween = (from: string, to: string) =>
  Math.round(
    (Date.parse(`${to.slice(0, 10)}T00:00:00Z`) - Date.parse(`${from.slice(0, 10)}T00:00:00Z`)) / 86_400_000,
  );

export const today = (now = new Date()) => now.toISOString().slice(0, 10);

// ---------------------------------------------------------------- lead times
/** "lead time: 10-12 weeks" → 12; "6 to 8 wks" → 8; "45 days" → 7 (weeks, rounded up). Upper bound wins. */
export const parseLeadTimeWeeks = (s: string | null | undefined): number | null => {
  if (!s) return null;
  const m = s.match(
    /(\d+(?:\.\d+)?)\s*(?:(?:-|–|—|to)\s*(\d+(?:\.\d+)?))?\s*(weeks?|wks?|w\b|days?|business days|months?|mos?)/i,
  );
  if (!m) return null;
  const hi = Number.parseFloat(m[2] ?? m[1]!);
  const unit = m[3]!.toLowerCase();
  if (unit.startsWith('d') || unit.startsWith('business'))
    return Math.ceil(hi / (unit.startsWith('business') ? 5 : 7));
  if (unit.startsWith('mo')) return Math.round(hi * 4.33);
  return hi;
};

export const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
export const round = (x: number, dp = 2) => Math.round(x * 10 ** dp) / 10 ** dp;
