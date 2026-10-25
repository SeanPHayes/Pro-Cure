import type { PdfLine, PdfPage } from '../../text/extract.js';
import {
  codeKey,
  DATE_SRC,
  isMoneyToken,
  normalizeSpace,
  parseDate,
  parseLeadTimeWeeks,
  parseMoney,
  SPEC_CODE_RE,
} from '../../text/util.js';
import type { QuoteHeader, QuoteLine } from './schema.js';

/**
 * Rule-based vendor quotation parser. Vendor quotes (Word/Excel exports, ERP printouts) almost always
 * have a header block (quote #, date, valid-until, terms) and a table whose rows end in money columns
 * ("unit price", "extended"). Rows are recognized by trailing money tokens; the quantity is the integer
 * just before the money (or a "Qty"/"EA" token) and the SKU is the first alphanumeric code-like token.
 */

const dateAfter = (label: string) => new RegExp(`${label}\\s*(?:date)?\\s*[:#-]?\\s*(${DATE_SRC})`, 'i');

const HEADER_PATTERNS = {
  quoteNumber:
    /\b(?:quot(?:e|ation)|proposal|estimate)\s*(?:number|no\.?|#|num)\s*[:#]?\s*([A-Z0-9][A-Z0-9\-/.]{2,})/i,
  quoteDate: dateAfter('(?:quot(?:e|ation)\\s*date|date\\s*(?:issued|of quote)|^date|\\bdate)'),
  validUntil: dateAfter(
    '(?:valid\\s*(?:until|thru|through|to)|quote\\s*expires?(?:\\s*on)?|expir(?:es|ation)(?:\\s*date)?|good\\s*(?:until|thru|through)|pricing\\s*valid\\s*(?:until|through))',
  ),
  validDays: /\b(?:valid|good)\s*(?:for)?\s*(\d{2,3})\s*days\b/i,
  leadTime:
    /\b(?:lead\s*time|production\s*time|ship(?:s)?\s*in|delivery)\s*[:-]?\s*((?:approx\.?\s*)?\d+\s*(?:(?:-|–|to)\s*\d+\s*)?(?:weeks?|wks?|days?|business days))/i,
  freight: /\b(?:freight|shipping)\s*(?:terms)?\s*[:-]\s*([^\n]{2,60})/i,
  fob: /\bF\.?O\.?B\.?\s*[:-]?\s*([A-Za-z ,.]{2,40})/i,
};

const SKIP_ROW =
  /\b(sub-?total|grand total|total|freight|shipping|tax|deposit|balance|discount|crating|handling|terms|payment|page \d)\b/i;
const HEADER_ROW = /\b(qty|quantity)\b.*\b(price|unit|amount|ext)/i;

export function parseQuoteHeader(pages: PdfPage[], ref = new Date()): QuoteHeader {
  const lines = pages.flatMap((p) => p.lines.map((l) => normalizeSpace(l.text)));
  const text = lines.join('\n');
  const first = (re: RegExp) => {
    for (const l of lines) {
      const m = l.match(re);
      if (m) return m[1]!.trim();
    }
    return null;
  };
  const quoteDate = parseDate(first(HEADER_PATTERNS.quoteDate), ref);
  let validUntil = parseDate(first(HEADER_PATTERNS.validUntil), ref);
  const days = first(HEADER_PATTERNS.validDays);
  if (!validUntil && days && quoteDate) {
    const d = new Date(`${quoteDate}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + Number(days));
    validUntil = d.toISOString().slice(0, 10);
  }
  const leadTime = first(HEADER_PATTERNS.leadTime);
  const vendorName =
    lines
      .slice(0, 6)
      .find(
        (l) =>
          /\b(inc|llc|ltd|co\.|company|furniture|manufacturing|group|industries|lighting|designs?)\b/i.test(
            l,
          ) && !/\b(quote|bill|ship) to\b/i.test(l),
      ) ?? null;
  return {
    vendorName: vendorName ? vendorName.replace(/\s{2,}.*$/, '') : null,
    vendorQuoteNumber: first(HEADER_PATTERNS.quoteNumber),
    quoteDate,
    validUntil,
    leadTime,
    leadTimeWeeks: parseLeadTimeWeeks(leadTime),
    freightTerms:
      first(HEADER_PATTERNS.freight) ??
      (text.match(HEADER_PATTERNS.fob) ? `FOB ${text.match(HEADER_PATTERNS.fob)![1]!.trim()}` : null),
  };
}

const SKU_RE = /^(?=[A-Z0-9\-./]*\d)(?=[A-Z0-9\-./]*[A-Z])[A-Z0-9][A-Z0-9\-./]{2,24}$/i;
const QTY_RE = /^(\d{1,5})(?:\s*(?:ea|each|pcs?|units?|sets?|pr|pairs?|yds?|sy|sf|lf))?$/i;

/** Split a row into tokens, preferring layout cells when present. */
const rowTokens = (line: PdfLine): string[] => {
  const base = line.cells.length > 2 ? line.cells : line.text.split(/\s{2,}/);
  return base.flatMap((c) => {
    const t = c.trim();
    if (!t) return [];
    // Split "120 $425.00" or "$425.00 $51,000.00" when packed in one cell.
    return t.split(/\s+(?=\$)|(?<=\d)\s+(?=\$)/).map((x) => x.trim());
  });
};

interface Pending {
  line: QuoteLine;
}

export function parseQuoteLines(
  pages: PdfPage[],
  header: QuoteHeader,
): { lines: QuoteLine[]; totals: { subtotal: number | null; freight: number | null; total: number | null } } {
  const out: QuoteLine[] = [];
  const totals = {
    subtotal: null as number | null,
    freight: null as number | null,
    total: null as number | null,
  };
  let cur: Pending | null = null;
  let inTable = false;

  for (const page of pages) {
    if (page.scanned) continue;
    for (const line of page.lines) {
      const text = normalizeSpace(line.text);
      if (!text) continue;
      if (HEADER_ROW.test(text)) {
        inTable = true;
        cur = null;
        continue;
      }
      const toks = rowTokens(line);
      const moneyIdx = toks.map((t, i) => (isMoneyToken(t) ? i : -1)).filter((i) => i >= 0);

      if (SKIP_ROW.test(text) && moneyIdx.length) {
        const amt = parseMoney(toks[moneyIdx.at(-1)!]!);
        if (/sub-?total/i.test(text)) totals.subtotal = amt;
        else if (/freight|shipping/i.test(text)) totals.freight = amt;
        else if (/\btotal\b/i.test(text)) totals.total = amt;
        cur = null;
        continue;
      }

      if (moneyIdx.length && moneyIdx[0]! > 0) {
        const firstMoney = moneyIdx[0]!;
        const lead = toks.slice(0, firstMoney);
        const moneys = moneyIdx.map((i) => parseMoney(toks[i]!)!);
        const trailing = toks.slice(moneyIdx.at(-1)! + 1).join(' ');
        // quantity: last QTY-looking token before the money; also handle "Qty: 12"
        let quantity: number | null = null;
        let qtyAt = -1;
        for (let i = lead.length - 1; i >= 0; i--) {
          const m = lead[i]!.match(QTY_RE);
          if (m && i > 0) {
            quantity = Number(m[1]);
            qtyAt = i;
            break;
          }
        }
        const descTokens = lead.filter((_, i) => i !== qtyAt);
        // a leading row number ("1", "2.") is not part of the description
        if (descTokens.length > 1 && /^\d{1,3}\.?$/.test(descTokens[0]!)) descTokens.shift();
        let vendorSku: string | null = null;
        let specCode: string | null = null;
        const descParts: string[] = [];
        for (const t of descTokens) {
          // The first standalone code-like cell is the vendor's model/SKU column.
          if (!vendorSku && !t.includes(' ') && SKU_RE.test(t) && !/^\d+$/.test(t)) {
            vendorSku = t;
            continue;
          }
          descParts.push(t);
        }
        const description = normalizeSpace(descParts.join(' '));
        if (!description && !vendorSku) continue;
        // A buyer spec code echoed in the description ("King Headboard CG-101").
        specCode = description.match(SPEC_CODE_RE)?.[1] ?? null;
        if (specCode && vendorSku && codeKey(specCode) === codeKey(vendorSku)) specCode = null;
        let unitPrice: number | null = moneys.length >= 2 ? moneys.at(-2)! : moneys[0]!;
        let extended: number | null = moneys.length >= 2 ? moneys.at(-1)! : null;
        if (moneys.length === 1 && quantity && quantity > 1) {
          // Single money column: decide whether it's unit or extended.
          extended = null;
        }
        if (quantity === null && unitPrice && extended) {
          const q = extended / unitPrice;
          if (Math.abs(q - Math.round(q)) < 0.01 && q >= 1) quantity = Math.round(q);
        }
        if (moneys.length === 1 && quantity === 1) extended = unitPrice;
        if (unitPrice === 0 && extended) unitPrice = null;
        const lt = parseLeadTimeWeeks(trailing) ?? parseLeadTimeWeeks(text.replace(description, ''));
        cur = {
          line: {
            vendorSku,
            description: description || vendorSku || specCode || '',
            quantity,
            unitPrice,
            extended,
            leadTimeWeeks: lt,
            expiresAt: header.validUntil,
            notes: null,
            sourcePage: page.page,
            specCode,
            suggestedLineId: null,
          },
        };
        out.push(cur.line);
        inTable = true;
        continue;
      }

      // Non-money line inside the table: continuation of the previous row (finish, notes, lead time).
      if (cur && inTable && text.length < 160 && !/^(bill|ship|sold) to\b/i.test(text)) {
        const lt = parseLeadTimeWeeks(text);
        if (lt && /lead|ship|weeks?|wks?/i.test(text)) cur.line.leadTimeWeeks = lt;
        const exp = text.match(
          new RegExp(`(?:valid|expires?|good)\\s*(?:until|thru|through|on)?\\s*[:-]?\\s*(${DATE_SRC})`, 'i'),
        );
        if (exp) cur.line.expiresAt = parseDate(exp[1]!) ?? cur.line.expiresAt;
        if (!cur.line.specCode)
          cur.line.specCode =
            text.match(new RegExp(`(?:spec|item|ref|tag)\\s*[:#]?\\s*${SPEC_CODE_RE.source}`, 'i'))?.[1] ??
            null;
        if (
          /^(finish|fabric|color|notes?|comments?|com|col)\b/i.test(text) ||
          cur.line.notes ||
          /lead|valid|ship/i.test(text)
        )
          cur.line.notes = cur.line.notes ? `${cur.line.notes}; ${text}` : text;
        else cur.line.description = `${cur.line.description} ${text}`;
        continue;
      }
      if (!moneyIdx.length) cur = null;
    }
  }
  for (const l of out) if (l.leadTimeWeeks === null) l.leadTimeWeeks = header.leadTimeWeeks;
  return { lines: out, totals };
}

export function heuristicVendorQuote(pages: PdfPage[], ref = new Date()) {
  const header = parseQuoteHeader(pages, ref);
  const { lines, totals } = parseQuoteLines(pages, header);
  return { header, lines, totals };
}
