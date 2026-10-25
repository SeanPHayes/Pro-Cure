import type { EventData, EventType } from '@procure/domain';
import { round2 } from '@procure/domain';
import { applyContext, config, emit, must, type Principal, type Tx } from '@procure/platform';
import { addDays, today as todayIso } from './domain/dates.js';
import { evaluatePo, type Level, normalizeRiskLevel, rank } from './domain/escalation.js';
import { isPending } from './domain/requirements.js';
import type { PoSnapshot, SnapshotLine } from './domain/revision.js';
import { derivePoStatus, type PoStatus } from './domain/status.js';
import { poTotals } from './domain/totals.js';

// ---------------------------------------------------------------------------------------------
// Event emission that works the same for requests, jobs, subscriptions and internal endpoints.
// ---------------------------------------------------------------------------------------------
export type Emit = <T extends EventType>(tx: Tx, type: T, data: EventData<T>) => Promise<string>;

export const requestEmitter = (req: { emit: Emit }): Emit =>
  ((tx: Tx, type: EventType, data: never) => req.emit(tx, type, data)) as Emit;

export const systemEmitter = (tenantId: string): Emit =>
  ((tx: Tx, type: EventType, data: never) =>
    emit(tx, 'orders', type, data, {
      tenantId,
      actor: { userId: null, orgId: null, name: 'Pro-Cure' },
    })) as Emit;

export const webUrl = (path: string) => `${config().PUBLIC_WEB_URL.replace(/\/$/, '')}${path}`;

/**
 * Portal writes run under the caller's RLS for the primary change (so the audit log attributes the vendor or
 * owner). Derived bookkeeping — PO status, escalation, received counts — is not something an external actor may
 * write directly, so it runs with a service context inside the same transaction, then the caller's context is
 * restored.
 */
export async function asService<T>(tx: Tx, p: Principal, fn: () => Promise<T>): Promise<T> {
  await applyContext(tx, {
    tenantId: p.tenantId,
    userId: p.userId,
    orgId: p.orgId,
    actor: 'service',
    userName: p.name,
  });
  try {
    return await fn();
  } finally {
    await applyContext(tx, {
      tenantId: p.tenantId,
      userId: p.userId,
      orgId: p.orgId,
      actor: p.actor,
      userName: p.name,
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------------------------
export type PoRow = Record<string, any> & {
  id: string;
  tenantId: string;
  projectId: string;
  vendorId: string;
  vendorName: string;
  vendorOrgId: string | null;
  clientOrgId: string | null;
  number: string;
  status: PoStatus;
  revision: number;
  version: number;
  vendorContact: { name?: string | null; email?: string | null; phone?: string | null } | null;
  orderManagerIds: string[];
  escalation: Level;
};

export async function getPo(tx: Tx, id: string, forUpdate = false): Promise<PoRow> {
  const [po] = forUpdate
    ? await tx<PoRow[]>`select * from orders.purchase_orders where id = ${id} for update`
    : await tx<PoRow[]>`select * from orders.purchase_orders where id = ${id}`;
  return must(po, 'Purchase order');
}

export async function loadLines(tx: Tx, poId: string) {
  return tx<any[]>`
    select l.*, coalesce((select sum(sl.quantity) from orders.shipment_lines sl where sl.po_line_id = l.id), 0)::numeric as allocated_qty
    from orders.po_lines l where l.po_id = ${poId} order by l.sort, l.code, l.id`;
}

export async function loadShipments(tx: Tx, poIds: string[]) {
  if (!poIds.length) return [];
  const ships = await tx<any[]>`
    select * from orders.shipments where po_id in ${tx(poIds)} order by po_id, length(label), label`;
  if (!ships.length) return ships;
  const lines = await tx<any[]>`
    select sl.id, sl.shipment_id, sl.po_line_id, sl.quantity, l.code, l.name
    from orders.shipment_lines sl join orders.po_lines l on l.id = sl.po_line_id
    where sl.shipment_id in ${tx(ships.map((s) => s.id))} order by l.sort, l.code`;
  for (const s of ships) s.lines = lines.filter((l) => l.shipmentId === s.id);
  return ships;
}

// biome-ignore lint/suspicious/noExplicitAny: rows are shaped by response schemas
export async function loadPoDetail(tx: Tx, id: string): Promise<any> {
  const po = await getPo(tx, id);
  const [lines, shipments, requirements, revisions, recipients] = await Promise.all([
    loadLines(tx, id),
    loadShipments(tx, [id]),
    tx<any[]>`select r.*, coalesce(r.status in ('pending','submitted','rejected')
                       and coalesce(r.due_date, p.release_by_date) < current_date, false) as overdue
              from orders.pre_order_requirements r join orders.purchase_orders p on p.id = r.po_id
              where r.po_id = ${id} order by r.sort, r.created_at`,
    tx<any[]>`select * from orders.po_revisions where po_id = ${id} order by revision desc`,
    tx<any[]>`select * from orders.delivery_recipients
              where project_id = ${po.projectId} and (po_id is null or po_id = ${id}) order by name`,
  ]);
  return { ...po, lines, shipments, requirements, revisions, recipients };
}

// ---------------------------------------------------------------------------------------------
// Derived state
// ---------------------------------------------------------------------------------------------
export async function recalcTotals(tx: Tx, poId: string) {
  const lines = await tx<{ extended: number }[]>`select extended from orders.po_lines where po_id = ${poId}`;
  const [po] = await tx<
    { freight: number; tax: number }[]
  >`select freight, tax from orders.purchase_orders where id = ${poId}`;
  const t = poTotals(lines, po?.freight ?? 0, po?.tax ?? 0);
  await tx`update orders.purchase_orders set subtotal = ${t.subtotal}, total = ${t.total}
           where id = ${poId} and (subtotal <> ${t.subtotal} or total <> ${t.total})`;
  return t;
}

/** Editing an issued PO keeps its status but flags it for a revision. */
export async function markChanged(tx: Tx, po: Pick<PoRow, 'id' | 'status'>) {
  if (po.status === 'draft' || po.status === 'cancelled' || po.status === 'closed') return;
  await tx`update orders.purchase_orders set has_unissued_changes = true where id = ${po.id} and not has_unissued_changes`;
}

export async function bumpVersion(tx: Tx, poId: string) {
  await tx`update orders.purchase_orders set version = version + 1 where id = ${poId}`;
}

export async function refreshPoStatus(tx: Tx, poId: string): Promise<PoStatus> {
  const po = await getPo(tx, poId);
  const ships = await tx<{ status: string }[]>`select status from orders.shipments where po_id = ${poId}`;
  const reqs = await tx<
    { status: string }[]
  >`select status from orders.pre_order_requirements where po_id = ${poId}`;
  const next = derivePoStatus({
    current: po.status,
    shipmentStatuses: ships.map((s) => s.status),
    requirementsComplete: reqs.every((r) => !isPending(r.status)),
  });
  if (next !== po.status) await tx`update orders.purchase_orders set status = ${next} where id = ${poId}`;
  return next;
}

/**
 * Recompute rule-based escalation for a PO and its shipments, fold in the AI risk levels, persist, and — when the
 * PO's level rises to at_risk or critical — emit orders.risk.escalated and notify the order managers.
 */
export async function recomputeEscalation(
  tx: Tx,
  poId: string,
  em: Emit,
  now: Date = new Date(),
): Promise<{ before: Level; after: Level; reasons: string[] }> {
  const po = await getPo(tx, poId);
  if (['draft', 'cancelled', 'closed', 'delivered'].includes(po.status)) {
    if (po.escalation !== 'none' || po.escalationReasons?.length)
      await tx`update orders.purchase_orders set escalation = 'none', escalation_reasons = '{}' where id = ${poId}`;
    await tx`update orders.shipments set escalation = 'none', escalation_reasons = '{}'
             where po_id = ${poId} and escalation <> 'none'`;
    return { before: po.escalation, after: 'none', reasons: [] };
  }
  const reqs = await tx<{ label: string; status: string }[]>`
    select label, status from orders.pre_order_requirements where po_id = ${poId} order by sort`;
  const pending = reqs.filter((r) => isPending(r.status));
  const ships = await tx<
    any[]
  >`select * from orders.shipments where po_id = ${poId} order by length(label), label`;
  const transit = po.transitDays ?? (po.origin === 'international' ? 35 : 5);
  const result = evaluatePo({
    po: {
      releaseByDate: po.releaseByDate,
      pendingRequirements: pending.length,
      pendingRequirementLabels: pending.map((r) => r.label),
      riskLevel: normalizeRiskLevel(po.riskLevel),
      riskReasons: po.riskReasons ?? [],
    },
    shipments: ships.map((s) => ({
      id: s.id,
      label: s.label,
      status: s.status,
      origin: s.origin ?? po.origin,
      requestedDeliveryDate: s.requestedDeliveryDate ?? po.requestedDeliveryDate,
      estimatedShipDate: s.estimatedShipDate,
      estimatedDeliveryDate: s.estimatedDeliveryDate,
      transitDays: transit,
      hasTracking: !!s.trackingNumber,
      shipDateSlips: s.shipDateSlips,
      lastConfirmationRequestedAt: s.lastConfirmationRequestedAt,
      lastConfirmedAt: s.lastConfirmedAt,
      riskLevel: normalizeRiskLevel(s.riskLevel),
      riskReasons: s.riskReasons ?? [],
    })),
    today: todayIso(now),
    now,
  });
  for (const se of result.shipments) {
    const cur = ships.find((s) => s.id === se.id);
    if (
      cur &&
      (cur.escalation !== se.level || JSON.stringify(cur.escalationReasons) !== JSON.stringify(se.reasons))
    )
      await tx`update orders.shipments set escalation = ${se.level}, escalation_reasons = ${se.reasons}::text[]
               where id = ${se.id}`;
  }
  if (
    po.escalation !== result.level ||
    JSON.stringify(po.escalationReasons) !== JSON.stringify(result.reasons)
  )
    await tx`update orders.purchase_orders set escalation = ${result.level}, escalation_reasons = ${result.reasons}::text[]
             where id = ${poId}`;
  if (rank(result.level) > rank(po.escalation) && rank(result.level) >= rank('at_risk')) {
    await em(tx, 'orders.risk.escalated', {
      poId,
      projectId: po.projectId,
      escalation: result.level,
      reasons: result.reasons,
    });
    await notifyOrderManagers(tx, em, po, {
      title: `${po.number} is ${result.level === 'critical' ? 'critical' : 'at risk'}`,
      body: `${po.vendorName} · ${po.projectName ?? ''}\n${result.reasons.slice(0, 4).join('\n')}`,
      severity: result.level === 'critical' ? 'critical' : 'warning',
    });
  }
  return { before: po.escalation, after: result.level, reasons: result.reasons };
}

/** Release-by date and (if not yet set by the user) shipment ship dates follow the PO's dates. */
export async function refreshReleaseBy(tx: Tx, poId: string) {
  await tx`
    update orders.purchase_orders set release_by_date =
      case when requested_delivery_date is null or lead_time_weeks is null then null
           else requested_delivery_date - (lead_time_weeks * 7)
                - coalesce(transit_days, case when origin = 'international' then 35 else 5 end) end
    where id = ${poId}`;
}

// ---------------------------------------------------------------------------------------------
// Snapshots for revisions
// ---------------------------------------------------------------------------------------------
export async function snapshotOf(tx: Tx, poId: string): Promise<PoSnapshot> {
  const po = await getPo(tx, poId);
  const lines = await tx<SnapshotLine[]>`
    select id, code, name, description, finish, quantity, unit_cost, extended
    from orders.po_lines where po_id = ${poId} order by sort, code, id`;
  return {
    header: {
      requestedDeliveryDate: po.requestedDeliveryDate,
      releaseByDate: po.releaseByDate,
      shipTo: po.shipTo,
      billTo: po.billTo,
      contact24h: po.contact24h,
      paymentTerms: po.paymentTerms,
      freightTerms: po.freightTerms,
      shipMethod: po.shipMethod,
      depositPct: po.depositPct,
      vendorNotes: po.vendorNotes,
      freight: po.freight,
      tax: po.tax,
      total: po.total,
    },
    lines: lines.map((l) => ({
      id: l.id,
      code: l.code,
      name: l.name,
      description: l.description,
      finish: l.finish,
      quantity: l.quantity,
      unitCost: l.unitCost,
      extended: l.extended,
    })),
  };
}

// ---------------------------------------------------------------------------------------------
// Notifications & email (cmd.notify / cmd.email.send are carried out by comms)
// ---------------------------------------------------------------------------------------------
export async function notifyOrderManagers(
  tx: Tx,
  em: Emit,
  po: Pick<PoRow, 'id' | 'orderManagerIds'>,
  n: { title: string; body: string; severity?: 'info' | 'success' | 'warning' | 'critical'; link?: string },
) {
  await em(tx, 'cmd.notify', {
    userIds: po.orderManagerIds ?? [],
    roles: ['order_manager'],
    title: n.title,
    body: n.body,
    link: n.link ?? webUrl(`/app/orders/${po.id}`),
    severity: n.severity ?? 'info',
  });
}

export async function emailVendor(
  tx: Tx,
  em: Emit,
  po: Pick<PoRow, 'id' | 'vendorContact'>,
  m: {
    subject: string;
    text: string;
    attachments?: { documentId: string; filename: string }[];
    threadId?: string | null;
  },
): Promise<boolean> {
  const to = po.vendorContact?.email;
  if (!to) return false;
  await em(tx, 'cmd.email.send', {
    to: [to],
    cc: [],
    subject: m.subject,
    text: m.text,
    html: null,
    replyTo: null,
    attachments: m.attachments ?? [],
    threadId: m.threadId ?? null,
  });
  return true;
}

export const vendorPortalLink = (poId: string) => webUrl(`/vendor/orders/${poId}`);

const fmtAddr = (a: Record<string, any> | null | undefined) =>
  a
    ? [a.name, a.line1, a.line2, [a.city, a.region, a.postalCode].filter(Boolean).join(', ')]
        .filter((x) => x && String(x).trim())
        .join(', ')
    : '';

/** Tell delivery recipients what is coming, how to track it, and who to call. */
export async function emailDeliveryRecipients(tx: Tx, em: Emit, shipmentId: string): Promise<number> {
  const [sh] = await tx<any[]>`select * from orders.shipments where id = ${shipmentId}`;
  if (!sh) return 0;
  const po = await getPo(tx, sh.poId);
  const recipients = await tx<{ email: string | null; name: string }[]>`
    select name, email from orders.delivery_recipients
    where project_id = ${po.projectId} and (po_id is null or po_id = ${po.id}) and email is not null`;
  const to = [...new Set(recipients.map((r) => r.email!).filter(Boolean))];
  if (!to.length) return 0;
  const lines = await tx<{ code: string; name: string; quantity: number }[]>`
    select l.code, l.name, sl.quantity from orders.shipment_lines sl join orders.po_lines l on l.id = sl.po_line_id
    where sl.shipment_id = ${shipmentId} order by l.sort, l.code`;
  const contact = po.contact24h ?? po.vendorContact;
  const eta =
    sh.estimatedDeliveryDate ?? (sh.actualShipDate ? addDays(sh.actualShipDate, po.transitDays ?? 5) : null);
  const text = [
    `A shipment for ${po.projectName ?? 'your project'} is on its way.`,
    '',
    `Purchase order: ${po.number} (${po.vendorName}) — shipment ${sh.label}${sh.note ? ` · ${sh.note}` : ''}`,
    `Carrier: ${sh.carrier}   Tracking: ${sh.trackingNumber}`,
    sh.trackingUrl ? `Track it: ${sh.trackingUrl}` : null,
    sh.actualShipDate ? `Shipped: ${sh.actualShipDate}` : null,
    eta ? `Estimated delivery: ${eta}` : null,
    `Deliver to: ${fmtAddr(po.shipTo) || 'project site'}`,
    '',
    'Contents:',
    ...lines.map((l) => `  • ${l.code} ${l.name} — qty ${l.quantity}`),
    '',
    contact?.name || contact?.phone
      ? `Questions about this delivery? Call ${[contact?.name, contact?.phone, contact?.email].filter(Boolean).join(' · ')}.`
      : null,
  ]
    .filter((x) => x !== null)
    .join('\n');
  await em(tx, 'cmd.email.send', {
    to,
    cc: [],
    subject: `Shipment on the way: ${po.number}-${sh.label} for ${po.projectName ?? po.projectNumber ?? 'your project'}`,
    text,
    html: null,
    replyTo: null,
    attachments: [],
    threadId: null,
  });
  return to.length;
}

// ---------------------------------------------------------------------------------------------
// Render data for PO / revision PDFs (documents' purchase_order / po_revision templates)
// ---------------------------------------------------------------------------------------------
export async function poRenderData(
  tx: Tx,
  poId: string,
  tenant: Record<string, unknown>,
  changes?: unknown[],
) {
  const d = await loadPoDetail(tx, poId);
  return {
    tenant,
    vendor: { name: d.vendorName, address: {}, contact: d.vendorContact ?? {} },
    po: {
      number: d.number,
      revision: d.revision,
      date: d.orderDate,
      paymentTerms: d.paymentTerms,
      freightTerms: d.freightTerms,
      requestedDelivery: d.requestedDeliveryDate,
      releaseBy: d.releaseByDate,
      notes: d.vendorNotes,
      shipTo: d.shipTo,
      billTo: d.billTo,
      contact24h: d.contact24h,
    },
    project: { number: d.projectNumber, name: d.projectName },
    lines: d.lines.map((l: any) => ({
      code: l.code,
      name: l.name,
      description: l.description,
      finish: l.finish,
      qty: l.quantity,
      unitCost: l.unitCost,
      extended: l.extended,
    })),
    totals: { subtotal: d.subtotal, freight: d.freight, tax: d.tax, total: round2(d.total) },
    shipments: d.shipments.map((s: any) => ({
      label: s.label,
      note: s.note,
      requestedDelivery: s.requestedDeliveryDate,
      lines: s.lines.map((l: any) => ({ code: l.code, qty: l.quantity })),
    })),
    ...(changes ? { changes } : {}),
  };
}
