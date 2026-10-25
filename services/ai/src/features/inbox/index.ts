import { z } from '@procure/platform';
import {
  findVendorsByDomain,
  getInboundEmail,
  listOpenPurchaseOrders,
  type OpenPurchaseOrder,
  routeInboundEmail,
  type Vendor,
} from '../../clients.js';
import { currentLlm } from '../../llm.js';
import { normalizeSpace, round } from '../../text/util.js';
import type { FeatureRunner } from '../types.js';
import {
  type Candidate,
  classifyIntent,
  findAmount,
  findDates,
  findPoNumbers,
  findTracking,
  INTENTS,
  type Intent,
  isFreemail,
  rankCandidates,
  senderDomain,
} from './heuristic.js';
import { llmInbox } from './llm.js';

/** Routed automatically at or above this confidence; otherwise left for a human in the inbox. */
export const AUTO_ROUTE_THRESHOLD = 0.85;

export const Suggestion = z.object({
  type: z.enum([
    'set_tracking',
    'complete_requirement',
    'update_ship_date',
    'attach_to_requirement',
    'route_to_po',
  ]),
  label: z.string(),
  payload: z.record(z.string(), z.unknown()),
});
export type Suggestion = z.infer<typeof Suggestion>;

export const InboxOutput = z.object({
  inboundEmailId: z.string(),
  intent: z.enum(INTENTS),
  target: z
    .object({ entityType: z.literal('purchase_order'), entityId: z.string(), poNumber: z.string() })
    .nullable(),
  vendor: z.object({ id: z.string(), name: z.string(), orgId: z.string().nullable() }).nullable(),
  confidence: z.number(),
  reasons: z.array(z.string()),
  extracted: z.object({
    poNumbers: z.array(z.string()),
    trackingNumber: z.string().nullable(),
    carrier: z.string().nullable(),
    shipDate: z.string().nullable(),
    newShipDate: z.string().nullable(),
    amount: z.number().nullable(),
  }),
  candidates: z.array(
    z.object({
      poId: z.string(),
      poNumber: z.string(),
      vendorName: z.string().nullable(),
      projectName: z.string().nullable(),
      score: z.number(),
      reasons: z.array(z.string()),
    }),
  ),
  suggestions: z.array(Suggestion),
  routed: z.boolean(),
  routeStatus: z.enum(['routed', 'needs_review']),
  routeError: z.string().nullable().default(null),
});
export type InboxOutput = z.infer<typeof InboxOutput>;

const REQUIREMENT_FOR: Partial<Record<Intent, { kind: string; status: string; label: string }>> = {
  order_acknowledgement: {
    kind: 'order_acknowledgement',
    status: 'submitted',
    label: 'Mark order acknowledgement received',
  },
  proforma_deposit_invoice: {
    kind: 'deposit',
    status: 'submitted',
    label: 'Attach deposit invoice to the deposit requirement',
  },
  line_drawings_submittal: {
    kind: 'shop_drawing_approval',
    status: 'submitted',
    label: 'Attach drawings to shop-drawing approval',
  },
};

export function buildSuggestions(
  intent: Intent,
  po: { id: string; number: string } | null,
  extracted: InboxOutput['extracted'],
  attachments: { documentId: string; filename: string }[],
): Suggestion[] {
  if (!po) return [];
  const s: Suggestion[] = [];
  if (extracted.trackingNumber)
    s.push({
      type: 'set_tracking',
      label: `Add ${extracted.carrier ?? 'carrier'} tracking ${extracted.trackingNumber} to ${po.number}`,
      payload: {
        poId: po.id,
        carrier: extracted.carrier ?? 'Unknown',
        trackingNumber: extracted.trackingNumber,
        shipDate: extracted.shipDate,
      },
    });
  if (extracted.newShipDate)
    s.push({
      type: 'update_ship_date',
      label: `Update ${po.number} ship date to ${extracted.newShipDate}`,
      payload: { poId: po.id, newShipDate: extracted.newShipDate, source: 'vendor_email' },
    });
  const req = REQUIREMENT_FOR[intent];
  if (req) {
    const doc = attachments.find((a) => /\.pdf$/i.test(a.filename)) ?? attachments[0];
    if (doc)
      s.push({
        type: 'attach_to_requirement',
        label: `${req.label} (${doc.filename})`,
        payload: {
          poId: po.id,
          kind: req.kind,
          status: req.status,
          documentId: doc.documentId,
          amount: extracted.amount,
        },
      });
    if (intent === 'order_acknowledgement')
      s.push({
        type: 'complete_requirement',
        label: `Complete order acknowledgement on ${po.number}`,
        payload: { poId: po.id, kind: 'order_acknowledgement', status: 'approved' },
      });
  }
  return s;
}

export const runInboxRoute: FeatureRunner = async ({ tenantId, job, meter, log }) => {
  const emailId = job.input.inboundEmailId as string;
  const email = await getInboundEmail(tenantId, emailId);
  const now = new Date(email.receivedAt || Date.now());
  const subject = email.subject ?? '';
  const body = email.text ?? '';
  const attachmentNames = email.attachments.map((a) => a.filename);
  const allText = `${subject}\n${body}\n${attachmentNames.join('\n')}`;

  // ---- context: vendor by sender domain, open POs
  const domain = senderDomain(email.from);
  let vendor: Vendor | null = null;
  if (domain && !isFreemail(domain)) {
    try {
      const found = await findVendorsByDomain(tenantId, domain);
      vendor = found.length === 1 ? found[0]! : null;
    } catch (err) {
      log.warn({ err, domain }, 'vendor lookup failed');
    }
  }
  const poNumbers = findPoNumbers(subject, body, ...attachmentNames);
  let pos: OpenPurchaseOrder[] = [];
  if (vendor) pos = await listOpenPurchaseOrders(tenantId, vendor.id);
  if (poNumbers.length && !poNumbers.every((n) => pos.some((p) => p.number.toUpperCase() === n))) {
    // A mentioned PO may belong to another vendor (rep company, freight forwarder) — look tenant-wide.
    const all = await listOpenPurchaseOrders(tenantId);
    const seen = new Set(pos.map((p) => p.id));
    for (const p of all) if (!seen.has(p.id)) pos.push(p);
  }
  const candidates: Candidate[] = rankCandidates(pos, {
    poNumbers,
    vendorId: vendor?.id ?? null,
    vendorName: vendor?.name ?? null,
    text: allText,
  });

  // ---- heuristic understanding
  const tracking = findTracking(`${subject}\n${body}`);
  const dates = findDates(body || subject, now);
  const cls = classifyIntent(allText, !!tracking, !!dates.newShipDate, attachmentNames);
  let intent: Intent = cls.intent;
  const extracted: InboxOutput['extracted'] = {
    poNumbers,
    trackingNumber: tracking?.trackingNumber ?? null,
    carrier: tracking?.carrier ?? null,
    shipDate: dates.shipDate,
    newShipDate: intent === 'ship_date_change' || dates.newShipDate ? dates.newShipDate : null,
    amount: ['proforma_deposit_invoice', 'invoice'].includes(intent) ? findAmount(body) : null,
  };
  const top = candidates[0];
  const second = candidates[1];
  let target: Candidate | null = top && (!second || top.score - second.score >= 0.2) ? top : null;
  let confidence = target
    ? round(Math.min(0.99, target.score * 0.75 + cls.strength * 0.3), 2)
    : round(Math.min(0.5, cls.strength * 0.4), 2);
  if (target && intent === 'general') confidence = Math.min(confidence, 0.7);
  const reasons = [...(target?.reasons ?? []), ...cls.reasons];
  if (!target && candidates.length > 1)
    reasons.push(`${candidates.length} possible purchase orders — needs a human`);
  if (!candidates.length) reasons.push('No matching open purchase order');

  // ---- LLM path refines intent, target and extraction
  if (currentLlm().available) {
    try {
      const ai = await llmInbox(
        email,
        candidates.length ? candidates : pos.slice(0, 15).map((po) => ({ po, score: 0, reasons: [] })),
        meter,
      );
      intent = ai.intent;
      const aiTarget = ai.poId
        ? (candidates.find((c) => c.po.id === ai.poId) ??
          (pos.find((p) => p.id === ai.poId)
            ? { po: pos.find((p) => p.id === ai.poId)!, score: 0, reasons: [] }
            : null))
        : null;
      // A printed PO number that the model contradicts lowers confidence rather than flipping silently.
      if (aiTarget && target && aiTarget.po.id !== target.po.id) {
        confidence = Math.min(ai.confidence, 0.6);
        reasons.push(`AI suggested ${aiTarget.po.number}; rules suggested ${target.po.number}`);
      } else confidence = round(Math.max(confidence, ai.confidence), 2);
      target = aiTarget ?? target;
      for (const [k, v] of Object.entries(ai.extracted)) if (v != null) (extracted as any)[k] = v;
      reasons.unshift(...ai.reasons.map((r) => `AI: ${r}`));
    } catch (err) {
      log.warn({ err }, 'inbox LLM path failed; using heuristic');
      meter.heuristic();
      reasons.push(`AI model unavailable (${(err as Error).message.slice(0, 120)}); rule-based routing used`);
    }
  } else meter.heuristic();

  const po = target ? { id: target.po.id, number: target.po.number } : null;
  let suggestions = buildSuggestions(intent, po, extracted, email.attachments);
  const routeStatus: 'routed' | 'needs_review' =
    po && confidence >= AUTO_ROUTE_THRESHOLD ? 'routed' : 'needs_review';
  if (routeStatus === 'needs_review') {
    // Ranked candidates become one-click routing suggestions for the reviewer.
    const ranked = (
      target ? [target, ...candidates.filter((c) => c.po.id !== target!.po.id)] : candidates
    ).slice(0, 5);
    suggestions = [
      ...ranked.map((c) => ({
        type: 'route_to_po' as const,
        label: `Route to ${c.po.number}${c.po.projectName ? ` – ${c.po.projectName}` : ''}${c.po.vendorName ? ` (${c.po.vendorName})` : ''}`,
        payload: {
          entityType: 'purchase_order',
          entityId: c.po.id,
          poNumber: c.po.number,
          score: c.score,
          reasons: c.reasons,
        },
      })),
      ...suggestions,
    ];
  }

  let routeError: string | null = null;
  try {
    await routeInboundEmail(tenantId, emailId, {
      status: routeStatus,
      ...(routeStatus === 'routed' && po ? { entityType: 'purchase_order', entityId: po.id } : {}),
      ...(routeStatus === 'routed' && vendor?.orgId ? { vendorOrgId: vendor.orgId } : {}),
      confidence,
      reasons: reasons.map((r) => normalizeSpace(r)).slice(0, 12),
      suggestions,
    });
  } catch (err) {
    // The analysis is still useful; the job is kept for review and comms can be retried.
    routeError = (err as Error).message;
    log.warn({ err, emailId }, 'comms route call failed');
  }

  const output = InboxOutput.parse({
    inboundEmailId: emailId,
    intent,
    target: po ? { entityType: 'purchase_order', entityId: po.id, poNumber: po.number } : null,
    vendor: vendor ? { id: vendor.id, name: vendor.name, orgId: vendor.orgId } : null,
    confidence,
    reasons,
    extracted,
    candidates: candidates.slice(0, 10).map((c) => ({
      poId: c.po.id,
      poNumber: c.po.number,
      vendorName: c.po.vendorName,
      projectName: c.po.projectName,
      score: c.score,
      reasons: c.reasons,
    })),
    suggestions,
    routed: routeStatus === 'routed' && !routeError,
    routeStatus,
    routeError,
  });
  return {
    output,
    status: output.routed ? 'completed' : 'needs_review',
  };
};
