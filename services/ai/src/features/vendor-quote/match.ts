import type { CostRequest, CostRequestLine } from '../../clients.js';
import { codeKey, containsCode, round, tokenSetSimilarity } from '../../text/util.js';
import type { QuoteLine, QuoteMatch } from './schema.js';

/**
 * Match extracted vendor quote lines to cost-request lines.
 *
 * Score per (quote line, request line) pair:
 *   exact vendor SKU match               +0.60
 *   spec code match (printed or in text) +0.55
 *   LLM-suggested line id                +0.35
 *   token-set similarity of descriptions +0.45 × similarity
 *   quantity agrees                      +0.10 (disagrees: −0.05 and a flag)
 * Pairs are assigned greedily by score (one-to-one); pairs scoring < 0.30 are left unmatched.
 * Confidence = min(0.99, score).
 */
export const SUSPICIOUS_PRICE_DELTA = 0.4;
const MIN_SCORE = 0.3;

interface Scored {
  qi: number;
  ri: number;
  score: number;
  reasons: string[];
}

const describe = (r: CostRequestLine) => [r.name, r.description].filter(Boolean).join(' ');

export function scorePair(q: QuoteLine, r: CostRequestLine): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  const qText = `${q.vendorSku ?? ''} ${q.specCode ?? ''} ${q.description} ${q.notes ?? ''}`;
  if (r.vendorSku && q.vendorSku && codeKey(r.vendorSku) === codeKey(q.vendorSku)) {
    score += 0.6;
    reasons.push(`Vendor SKU ${q.vendorSku} matches`);
  } else if (r.vendorSku && codeKey(r.vendorSku).length >= 4 && containsCode(qText, r.vendorSku)) {
    score += 0.5;
    reasons.push(`Vendor SKU ${r.vendorSku} appears on the line`);
  }
  if (r.code && ((q.specCode && codeKey(q.specCode) === codeKey(r.code)) || containsCode(qText, r.code))) {
    score += 0.55;
    reasons.push(`Spec code ${r.code} matches`);
  }
  if (q.suggestedLineId && q.suggestedLineId === r.id) {
    score += 0.35;
    reasons.push('AI model matched this line');
  }
  const sim = tokenSetSimilarity(qText, describe(r));
  if (sim > 0.15) {
    score += 0.45 * sim;
    reasons.push(`Description ${Math.round(sim * 100)}% similar`);
  }
  if (q.quantity != null && r.quantity != null) {
    if (q.quantity === r.quantity) {
      score += 0.1;
      reasons.push(`Quantity ${q.quantity} agrees`);
    } else score -= 0.05;
  }
  return { score, reasons };
}

export function matchQuote(
  lines: QuoteLine[],
  request: CostRequest,
): {
  matches: QuoteMatch[];
  unmatchedLines: { lineIndex: number; line: QuoteLine; reason: string }[];
  unquotedRequestLines: { costRequestLineId: string; code: string | null; name: string }[];
} {
  const pairs: Scored[] = [];
  for (const [qi, q] of lines.entries()) {
    for (const [ri, r] of request.lines.entries()) {
      const { score, reasons } = scorePair(q, r);
      if (score >= MIN_SCORE) pairs.push({ qi, ri, score, reasons });
    }
  }
  pairs.sort((a, b) => b.score - a.score);
  const usedQ = new Set<number>();
  const usedR = new Set<number>();
  const matches: QuoteMatch[] = [];
  for (const p of pairs) {
    if (usedQ.has(p.qi) || usedR.has(p.ri)) continue;
    usedQ.add(p.qi);
    usedR.add(p.ri);
    const q = lines[p.qi]!;
    const r = request.lines[p.ri]!;
    const unitCost =
      q.unitPrice ?? (q.extended != null && q.quantity ? round(q.extended / q.quantity, 4) : null);
    const flags: string[] = [];
    if (unitCost == null) flags.push('No unit price found on the line');
    if (unitCost != null && r.currentCost) {
      const delta = (unitCost - r.currentCost) / r.currentCost;
      if (Math.abs(delta) > SUSPICIOUS_PRICE_DELTA)
        flags.push(
          `Price ${unitCost.toFixed(2)} is ${Math.round(Math.abs(delta) * 100)}% ${delta > 0 ? 'above' : 'below'} the current cost ${r.currentCost.toFixed(2)}`,
        );
    }
    if (q.quantity != null && r.quantity != null && q.quantity !== r.quantity)
      flags.push(`Quoted quantity ${q.quantity} differs from requested ${r.quantity}`);
    if (
      unitCost != null &&
      q.quantity &&
      q.extended != null &&
      Math.abs(unitCost * q.quantity - q.extended) > 0.02 * q.extended + 1
    )
      flags.push(`Extended ${q.extended.toFixed(2)} ≠ qty × unit (${(unitCost * q.quantity).toFixed(2)})`);
    if (q.expiresAt && q.expiresAt < new Date().toISOString().slice(0, 10))
      flags.push(`Pricing expired ${q.expiresAt}`);
    const confidence = round(Math.min(0.99, p.score) * (flags.length ? 0.9 : 1), 2);
    matches.push({
      costRequestLineId: r.id,
      code: r.code,
      name: r.name,
      lineIndex: p.qi,
      extractedLine: q,
      unitCost: unitCost == null ? null : round(unitCost, 4),
      currentCost: r.currentCost,
      requestedQuantity: r.quantity,
      expiresAt: q.expiresAt,
      leadTimeWeeks: q.leadTimeWeeks,
      confidence,
      reasons: p.reasons,
      flags,
    });
  }
  matches.sort((a, b) => a.lineIndex - b.lineIndex);
  const unmatchedLines = lines
    .map((line, lineIndex) => ({ lineIndex, line }))
    .filter((x) => !usedQ.has(x.lineIndex))
    .map((x) => ({ ...x, reason: 'No cost-request line matched by SKU, code or description' }));
  const unquotedRequestLines = request.lines
    .filter((_, i) => !usedR.has(i))
    .map((r) => ({ costRequestLineId: r.id, code: r.code, name: r.name }));
  return { matches, unmatchedLines, unquotedRequestLines };
}
