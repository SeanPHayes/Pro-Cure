import { z } from '@procure/platform';
import type { InboundEmail } from '../../clients.js';
import type { Meter } from '../../llm.js';
import { type Candidate, INTENTS } from './heuristic.js';

const isoOrNull = z
  .string()
  .nullable()
  .transform((s) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null));

export const LlmInbox = z.object({
  intent: z.enum(INTENTS),
  poId: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  reasons: z.array(z.string()).max(6),
  extracted: z.object({
    trackingNumber: z.string().nullable(),
    carrier: z.string().nullable(),
    shipDate: isoOrNull,
    newShipDate: isoOrNull,
    amount: z.number().nullable(),
  }),
});
export type LlmInbox = z.infer<typeof LlmInbox>;

const SYSTEM = `You triage vendor emails for a hotel FF&E procurement firm's order-management team. Each email from a
manufacturer or supplier concerns one purchase order (PO numbers look like PO-26-0042; vendors also write
"PO# 26-0042" or "P.O. 260042").

Classify the intent as exactly one of:
- order_acknowledgement: vendor confirms/acknowledges receipt of a PO (often attaches a sales order acknowledgement)
- proforma_deposit_invoice: proforma or deposit invoice that must be paid before production
- shipping_notification: goods shipped; includes tracking/PRO/BOL numbers or carrier details
- ship_date_change: the estimated ship/delivery date has moved (give the NEW date in newShipDate)
- line_drawings_submittal: shop/line/CAD drawings, cut sheets or strike-offs for approval
- invoice: a regular (non-deposit) invoice or balance due
- general: anything else (questions, marketing, out-of-office)

Choose poId only from the candidate list; null if none clearly applies. Confidence reflects BOTH intent and PO
certainty (≥0.85 only when the PO is unambiguous). Dates are YYYY-MM-DD; amount is in USD. Extract the carrier
name (UPS, FedEx, USPS, Estes, XPO, R+L Carriers, Old Dominion, SAIA, …) and the tracking/PRO number exactly.`;

export async function llmInbox(
  email: InboundEmail,
  candidates: Candidate[],
  meter: Meter,
): Promise<LlmInbox> {
  const list = candidates
    .slice(0, 15)
    .map((c) =>
      JSON.stringify({
        id: c.po.id,
        number: c.po.number,
        vendor: c.po.vendorName,
        project: c.po.projectName,
        status: c.po.status,
      }),
    )
    .join('\n');
  return meter.json(
    {
      system: SYSTEM,
      prompt: `Candidate purchase orders:
${list || '(none found)'}

Email:
From: ${email.from}
Subject: ${email.subject ?? ''}
Attachments: ${email.attachments.map((a) => a.filename).join(', ') || 'none'}
Received: ${email.receivedAt}

${(email.text ?? '').slice(0, 8000)}

Return JSON: {"intent": "...", "poId": "..."|null, "confidence": 0-1, "reasons": ["..."], "extracted": {"trackingNumber", "carrier", "shipDate", "newShipDate", "amount"}}`,
      maxTokens: 1200,
    },
    LlmInbox,
  );
}
