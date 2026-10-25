import type { OpenPurchaseOrder } from '../../clients.js';
import { DATE_SRC, normalizeSpace, parseDate, parseMoney, round, tokenCoverage } from '../../text/util.js';

/**
 * Rule-based vendor email understanding: PO references, intent, tracking numbers, dates and amounts.
 */

export const INTENTS = [
  'order_acknowledgement',
  'proforma_deposit_invoice',
  'shipping_notification',
  'ship_date_change',
  'line_drawings_submittal',
  'invoice',
  'general',
] as const;
export type Intent = (typeof INTENTS)[number];

// ---------------------------------------------------------------- PO numbers
/**
 * Tenant format is PO-YY-NNNN (platform.next_number). Vendors write it loosely: "PO# 26-0042",
 * "P.O. 260042", "PO 26 0042", "Purchase Order 26-0042", "your order PO-26-0042".
 */
const PO_RES = [
  /(?<![A-Za-z0-9])PO-(\d{2})-(\d{4})(?!\d)/gi,
  /(?<![A-Za-z0-9])P\.?\s?O\.?\s*(?:#|No\.?|Num(?:ber)?\.?)?\s*[:#]?\s*-?\s*(\d{2})[-\s/]?(\d{4})(?!\d)/gi,
  /\bpurchase\s+order\s*(?:#|No\.?|number)?\s*[:#]?\s*(?:PO-?)?(\d{2})[-\s]?(\d{4})(?!\d)/gi,
];

export function findPoNumbers(...texts: (string | null | undefined)[]): string[] {
  const found = new Set<string>();
  for (const t of texts) {
    if (!t) continue;
    for (const re of PO_RES) for (const m of t.matchAll(re)) found.add(`PO-${m[1]}-${m[2]}`);
  }
  return [...found];
}

// ---------------------------------------------------------------- tracking
const LTL_CARRIERS: [RegExp, string][] = [
  [/\bestes\b/i, 'Estes'],
  [/\bxpo\b/i, 'XPO'],
  [/\br\s?\+\s?l\b|\br&l carriers\b|\brl carriers\b/i, 'R+L Carriers'],
  [/\bold dominion\b|\bodfl\b/i, 'Old Dominion'],
  [/\bsaia\b/i, 'SAIA'],
  [/\babf\b/i, 'ABF'],
  [/\byrc\b|\byellow freight\b/i, 'YRC'],
  [/\bsoutheastern freight\b|\bsefl\b/i, 'Southeastern Freight Lines'],
  [/\bcentral transport\b/i, 'Central Transport'],
  [/\bpilot freight\b/i, 'Pilot Freight'],
  [/\bwatkins\b|\bwatkins\s*&\s*shepard\b/i, 'Watkins & Shepard'],
  [/\btforce\b/i, 'TForce Freight'],
];

export interface Tracking {
  carrier: string;
  trackingNumber: string;
}

export function findTracking(text: string): Tracking | null {
  const ups = text.match(/\b1Z[0-9A-Z]{16}\b/i);
  if (ups) return { carrier: 'UPS', trackingNumber: ups[0].toUpperCase() };
  const lower = text.toLowerCase();
  const ltl = LTL_CARRIERS.find(([re]) => re.test(text));
  const pro = text.match(
    /\b(?:PRO|pro number|pro#|BOL|bill of lading)\s*(?:#|number|no\.?)?\s*[:#]?\s*([0-9]{7,11}(?:-\d)?)\b/i,
  );
  if (pro && ltl) return { carrier: ltl[1], trackingNumber: pro[1]! };
  const digits = [...text.matchAll(/\b(\d{12}|\d{15}|\d{20}|\d{22}|9[1-5]\d{18,20}|420\d{5}9\d{21})\b/g)].map(
    (m) => m[1]!,
  );
  const tracking = text.match(/\btracking\s*(?:#|number|no\.?)?\s*[:#]?\s*([0-9 ]{12,30})/i);
  const candidates = [...digits, ...(tracking ? [tracking[1]!.replace(/\s/g, '')] : [])].filter((d) =>
    /^\d{12,26}$/.test(d),
  );
  if (candidates.length) {
    const d = candidates[0]!;
    if (lower.includes('usps') || lower.includes('postal')) return { carrier: 'USPS', trackingNumber: d };
    if (lower.includes('fedex') || lower.includes('fed ex')) return { carrier: 'FedEx', trackingNumber: d };
    if (/^9[1-5]/.test(d) && d.length >= 20) return { carrier: 'USPS', trackingNumber: d };
    if ([12, 15, 20, 22].includes(d.length)) return { carrier: 'FedEx', trackingNumber: d };
  }
  if (pro) return { carrier: 'LTL', trackingNumber: pro[1]! };
  return null;
}

// ---------------------------------------------------------------- dates & amounts
const NEW_DATE_RES = [
  new RegExp(
    `\\b(?:new|revised|updated|adjusted)\\s+(?:estimated\\s+)?(?:ship(?:ping)?|delivery|completion)\\s+date\\s*(?:is|of|will be|:)?\\s*(${DATE_SRC})`,
    'i',
  ),
  new RegExp(
    `\\b(?:pushed|moved|delayed|rescheduled|slipped|changed)\\s+(?:out\\s+|back\\s+)?(?:to|until)\\s+(${DATE_SRC})`,
    'i',
  ),
  new RegExp(
    `\\b(?:now|will now)\\s+(?:be\\s+)?(?:ship(?:ping)?|ship)\\s+(?:on|by|the week of)\\s+(${DATE_SRC})`,
    'i',
  ),
];
const SHIP_DATE_RE = new RegExp(
  `\\b(?:ship(?:ped|s|ping)?\\s*(?:date|on|out on)?|date shipped|estimated ship(?:ping)? date|esd)\\s*[:-]?\\s*(${DATE_SRC})`,
  'i',
);

export function findDates(text: string, ref: Date) {
  let newShipDate: string | null = null;
  for (const re of NEW_DATE_RES) {
    const m = text.match(re);
    if (m) {
      newShipDate = parseDate(m[1]!, ref);
      if (newShipDate) break;
    }
  }
  const s = text.match(SHIP_DATE_RE);
  const shipDate = s ? parseDate(s[1]!, ref) : null;
  return {
    shipDate: shipDate && shipDate !== newShipDate ? shipDate : newShipDate ? null : shipDate,
    newShipDate,
  };
}

export function findAmount(text: string): number | null {
  const near = text.match(
    /\b(?:deposit|amount|total|balance|invoice total|amount due|payment of)\b[^$\d]{0,40}(\$\s?[\d,]+(?:\.\d{2})?)/i,
  );
  if (near) return parseMoney(near[1]);
  const all = [...text.matchAll(/\$\s?[\d,]+(?:\.\d{2})?/g)].map((m) => parseMoney(m[0]) ?? 0);
  return all.length ? Math.max(...all) : null;
}

// ---------------------------------------------------------------- intent
const INTENT_RULES: [Intent, RegExp, number][] = [
  [
    'shipping_notification',
    /\b(has shipped|have shipped|shipped (?:today|out|via)|shipment notification|ship(?:ping)? confirmation|tracking (?:number|#|info)|in transit|out for delivery|bill of lading|\bbol\b|pro\s*#|advance ship notice|\basn\b)/i,
    2,
  ],
  [
    'ship_date_change',
    /\b(new|revised|updated|adjusted) (?:estimated )?(ship(?:ping)?|delivery|completion) date|ship date (?:has )?(?:changed|moved|slipped)|(?:pushed|moved|delayed|rescheduled) (?:out |back )?(?:to|until)|production delay|been delayed|delay in production/i,
    2.2,
  ],
  [
    'order_acknowledgement',
    /\b(order acknowledg(?:e)?ment|acknowledg(?:e|ing|ement of) (?:your |the )?(?:order|po|purchase order)|order confirmation|sales order (?:confirmation|#)|confirm(?:ing)? receipt of (?:your |the )?(?:order|po)|\back\b)/i,
    2,
  ],
  [
    'proforma_deposit_invoice',
    /\b(pro[\s-]?forma|deposit (?:invoice|request|required|due)|down ?payment|prepayment|\d{2}% deposit)/i,
    2.1,
  ],
  [
    'line_drawings_submittal',
    /\b(shop drawings?|line drawings?|cad drawings?|drawings? (?:attached|for (?:your )?(?:review|approval))|submittals?|cut sheets?|strike[- ]?offs?)/i,
    2,
  ],
  ['invoice', /\b(invoice|balance due|remit|payment due|statement of account)\b/i, 1],
];

export function classifyIntent(
  text: string,
  hasTracking: boolean,
  hasNewDate: boolean,
  attachmentNames: string[],
) {
  const scores = new Map<Intent, number>();
  const reasons: string[] = [];
  const names = attachmentNames.join(' ');
  for (const [intent, re, weight] of INTENT_RULES) {
    const m = text.match(re) ?? names.match(re);
    if (m) {
      scores.set(intent, (scores.get(intent) ?? 0) + weight);
      reasons.push(`"${normalizeSpace(m[0])}" suggests ${intent.replace(/_/g, ' ')}`);
    }
  }
  if (hasTracking) scores.set('shipping_notification', (scores.get('shipping_notification') ?? 0) + 2);
  if (hasNewDate) scores.set('ship_date_change', (scores.get('ship_date_change') ?? 0) + 1.5);
  if (/\b(ack|acknowledg)/i.test(names))
    scores.set('order_acknowledgement', (scores.get('order_acknowledgement') ?? 0) + 1);
  // A proforma/deposit invoice is also an "invoice" — prefer the specific intent.
  if (scores.has('proforma_deposit_invoice')) scores.delete('invoice');
  const ranked = [...scores].sort((a, b) => b[1] - a[1]);
  const top = ranked[0];
  if (!top) return { intent: 'general' as Intent, strength: 0, reasons: ['No recognizable intent'] };
  const margin = top[1] - (ranked[1]?.[1] ?? 0);
  return { intent: top[0], strength: Math.min(1, 0.5 + margin / 4 + top[1] / 8), reasons };
}

// ---------------------------------------------------------------- candidate POs
export interface Candidate {
  po: OpenPurchaseOrder;
  score: number;
  reasons: string[];
}

export function rankCandidates(
  pos: OpenPurchaseOrder[],
  ctx: { poNumbers: string[]; vendorId: string | null; vendorName: string | null; text: string },
): Candidate[] {
  const vendorPos = ctx.vendorId ? pos.filter((p) => p.vendorId === ctx.vendorId) : [];
  const out: Candidate[] = [];
  for (const po of pos) {
    let score = 0;
    const reasons: string[] = [];
    const numberHit = ctx.poNumbers.includes(po.number.toUpperCase());
    if (numberHit) {
      score += 0.65;
      reasons.push(`Mentions ${po.number}`);
    }
    if (ctx.vendorId && po.vendorId === ctx.vendorId) {
      score += 0.2;
      reasons.push(`Sender is ${po.vendorName ?? ctx.vendorName ?? 'the PO vendor'}`);
      if (!ctx.poNumbers.length && vendorPos.length === 1) {
        score += 0.35;
        reasons.push(`Only open PO with ${po.vendorName ?? 'this vendor'}`);
      }
    } else if (ctx.vendorId && numberHit) {
      score -= 0.3;
      reasons.push(`PO vendor ${po.vendorName ?? ''} differs from the sender`.replace('  ', ' '));
    }
    if (po.projectName && po.projectName.length > 3 && tokenCoverage(po.projectName, ctx.text) >= 0.8) {
      score += 0.15;
      reasons.push(`Mentions project "${po.projectName}"`);
    }
    if (score > 0.05) out.push({ po, score: round(Math.min(0.99, score), 2), reasons });
  }
  return out.sort((a, b) => b.score - a.score);
}

export const senderDomain = (from: string) => {
  const m = from.match(/@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/);
  return m ? m[1]!.toLowerCase() : null;
};

const FREEMAIL = new Set([
  'gmail.com',
  'yahoo.com',
  'outlook.com',
  'hotmail.com',
  'aol.com',
  'icloud.com',
  'me.com',
  'live.com',
  'msn.com',
  'comcast.net',
]);
export const isFreemail = (d: string | null) => !d || FREEMAIL.has(d);
