import { type Tx, unprocessable } from '@procure/platform';
import { openThread } from './clients.js';
import {
  type Emit,
  emailDeliveryRecipients,
  getPo,
  notifyOrderManagers,
  recomputeEscalation,
  refreshPoStatus,
} from './core.js';
import { today as todayIso } from './domain/dates.js';
import { isShipped } from './domain/status.js';
import { carrierTrackingUrl, type TrackingResult } from './tracking/index.js';

/**
 * State transitions shared by internal routes, portal routes, jobs, subscriptions and /internal endpoints.
 * Every function takes the transaction and an emitter so the same code runs under a user, a vendor/owner
 * (after API validation, with derived writes under a service context) or a background job.
 */

// ---------------------------------------------------------------- requirements
export type RequirementStatus = 'pending' | 'submitted' | 'approved' | 'rejected' | 'waived';

export async function setRequirementStatus(
  tx: Tx,
  em: Emit,
  reqId: string,
  status: RequirementStatus,
  opts: { actorName?: string | null; documentId?: string | null; note?: string | null } = {},
) {
  const decided = status === 'approved' || status === 'rejected' || status === 'waived';
  const [r] = await tx<any[]>`
    update orders.pre_order_requirements set
      status = ${status},
      submitted_at = case when ${status} = 'submitted' then now() else submitted_at end,
      decided_at = case when ${decided} then now() when ${status} = 'pending' then null else decided_at end,
      decided_by_name = case when ${decided} then ${opts.actorName ?? null} when ${status} = 'pending' then null
                             else decided_by_name end,
      document_id = case when ${opts.documentId !== undefined} then ${opts.documentId ?? null}::uuid else document_id end,
      note = case when ${opts.note !== undefined} then ${opts.note ?? null} else note end
    where id = ${reqId}
    returning *`;
  if (!r) return null;
  await em(tx, 'orders.requirement.updated', {
    requirementId: r.id,
    poId: r.poId,
    kind: r.kind,
    status: r.status,
  });
  return r;
}

/** After requirements change: PO status (acknowledged → in production) and escalation. */
export async function afterRequirementsChanged(tx: Tx, em: Emit, poId: string) {
  await refreshPoStatus(tx, poId);
  await recomputeEscalation(tx, poId, em);
}

// ---------------------------------------------------------------- ship dates
export async function changeShipDate(
  tx: Tx,
  em: Emit,
  shipment: { id: string; poId: string; projectId: string; estimatedShipDate: string | null },
  next: string | null,
  source: 'internal' | 'vendor' | 'tracking' | 'system',
) {
  const prev = shipment.estimatedShipDate;
  if (prev === next) return false;
  const later = !!prev && !!next && next > prev;
  await tx`
    update orders.shipments set
      estimated_ship_date = ${next},
      original_ship_date = coalesce(original_ship_date, ${prev ?? next}),
      ship_date_changes = ship_date_changes + ${prev ? 1 : 0},
      ship_date_slips = ship_date_slips + ${later ? 1 : 0}
    where id = ${shipment.id}`;
  await em(tx, 'orders.shipment.ship_date_changed', {
    shipmentId: shipment.id,
    poId: shipment.poId,
    projectId: shipment.projectId,
    previous: prev,
    current: next,
    source,
  });
  return true;
}

// ---------------------------------------------------------------- tracking
export async function applyTracking(
  tx: Tx,
  em: Emit,
  shipmentId: string,
  t: { carrier: string; trackingNumber: string; shipDate?: string | null; trackingUrl?: string | null },
) {
  const [s] = await tx<any[]>`select * from orders.shipments where id = ${shipmentId} for update`;
  if (!s) return null;
  if (s.status === 'delivered') throw unprocessable('Shipment is already delivered');
  const same = s.carrier === t.carrier && s.trackingNumber === t.trackingNumber;
  const [u] = await tx<any[]>`
    update orders.shipments set
      carrier = ${t.carrier},
      tracking_number = ${t.trackingNumber},
      tracking_url = ${t.trackingUrl ?? carrierTrackingUrl(t.carrier, t.trackingNumber)},
      tracking_status = case when ${same} then tracking_status else 'label_created' end,
      tracking_events = case when ${same} then tracking_events else '[]'::jsonb end,
      actual_ship_date = coalesce(${t.shipDate ?? null}::date, actual_ship_date, current_date),
      status = case when status in ('shipped', 'in_transit', 'delivered') then status else 'shipped' end
    where id = ${shipmentId}
    returning *`;
  if (!same) {
    await em(tx, 'orders.shipment.tracking_added', {
      shipmentId,
      poId: s.poId,
      projectId: s.projectId,
      carrier: t.carrier,
      trackingNumber: t.trackingNumber,
    });
    await emailDeliveryRecipients(tx, em, shipmentId);
  }
  await refreshPoStatus(tx, s.poId);
  await recomputeEscalation(tx, s.poId, em);
  return u;
}

/** Apply a carrier status poll; delivered → delivery flow. */
export async function applyTrackingResult(tx: Tx, em: Emit, shipmentId: string, r: TrackingResult) {
  const [s] = await tx<any[]>`select * from orders.shipments where id = ${shipmentId} for update`;
  if (!s || s.status === 'delivered') return 'skipped';
  const status =
    r.status === 'exception'
      ? 'exception'
      : r.status === 'in_transit' || r.status === 'out_for_delivery'
        ? 'in_transit'
        : s.status;
  await tx`
    update orders.shipments set
      tracking_status = ${r.status},
      tracking_events = ${tx.json(r.events as never)},
      tracking_url = coalesce(tracking_url, ${r.trackingUrl}),
      tracking_checked_at = now(),
      estimated_delivery_date = coalesce(${r.estimatedDeliveryDate}::date, estimated_delivery_date),
      status = ${status}
    where id = ${shipmentId}`;
  if (r.status === 'delivered') {
    await deliverShipment(tx, em, shipmentId, r.deliveredAt ?? new Date().toISOString());
    return 'delivered';
  }
  if (status !== s.status) await refreshPoStatus(tx, s.poId);
  await recomputeEscalation(tx, s.poId, em);
  return status === 'exception' ? 'exception' : 'updated';
}

// ---------------------------------------------------------------- delivery
export async function deliverShipment(tx: Tx, em: Emit, shipmentId: string, at?: string) {
  const [s] = await tx<any[]>`select * from orders.shipments where id = ${shipmentId}`;
  if (!s) return null;
  if (s.status === 'delivered') return s;
  const [u] = await tx<any[]>`
    update orders.shipments set status = 'delivered', delivered_at = ${at ?? new Date().toISOString()},
      actual_ship_date = coalesce(actual_ship_date, estimated_ship_date, current_date),
      tracking_status = case when tracking_number is not null then 'delivered' else tracking_status end
    where id = ${shipmentId} returning *`;
  await em(tx, 'orders.shipment.delivered', { shipmentId, poId: s.poId, projectId: s.projectId });
  const status = await refreshPoStatus(tx, s.poId);
  await recomputeEscalation(tx, s.poId, em);
  if (status === 'delivered') {
    const po = await getPo(tx, s.poId);
    await notifyOrderManagers(tx, em, po, {
      title: `${po.number} fully delivered`,
      body: `${po.vendorName} · ${po.projectName ?? ''}`,
      severity: 'success',
    });
  }
  return u;
}

// ---------------------------------------------------------------- claims
export async function openClaim(
  tx: Tx,
  em: Emit,
  c: {
    tenantId: string;
    projectId: string;
    poId: string | null;
    shipmentId?: string | null;
    receiptId?: string | null;
    vendorId: string | null;
    vendorOrgId: string | null;
    clientOrgId: string | null;
    type: string;
    description: string;
    reportedByName: string | null;
    reportedByActor: 'internal' | 'client' | 'vendor';
    photoDocumentIds: string[];
    creditAmount?: number | null;
    items: { poLineId: string | null; quantity: number; note?: string | null }[];
  },
) {
  const [claim] = await tx<any[]>`
    insert into orders.claims (tenant_id, project_id, po_id, shipment_id, receipt_id, vendor_id, vendor_org_id,
      client_org_id, number, type, description, reported_by_name, reported_by_actor, photo_document_ids, credit_amount)
    values (${c.tenantId}, ${c.projectId}, ${c.poId}, ${c.shipmentId ?? null}, ${c.receiptId ?? null}, ${c.vendorId},
      ${c.vendorOrgId}, ${c.clientOrgId}, platform.next_number(${c.tenantId}, 'CL'), ${c.type}, ${c.description},
      ${c.reportedByName}, ${c.reportedByActor}, ${c.photoDocumentIds}::uuid[], ${c.creditAmount ?? null})
    returning *`;
  for (const it of c.items)
    await tx`insert into orders.claim_items (tenant_id, claim_id, po_line_id, quantity, note)
             values (${c.tenantId}, ${claim.id}, ${it.poLineId}, ${it.quantity}, ${it.note ?? null})`;
  // Portal users can only open threads that already exist: create the claim's conversations up front so the
  // owner who reported it (and the vendor, once it is submitted to them) can message about it.
  const subject = `Claim ${claim.number}`;
  await Promise.all([
    openThread({
      tenantId: c.tenantId,
      entityType: 'claim',
      entityId: claim.id,
      subject,
      visibility: 'internal',
    }),
    c.clientOrgId
      ? openThread({
          tenantId: c.tenantId,
          entityType: 'claim',
          entityId: claim.id,
          subject,
          visibility: 'client',
          clientOrgId: c.clientOrgId,
        })
      : null,
    c.vendorOrgId
      ? openThread({
          tenantId: c.tenantId,
          entityType: 'claim',
          entityId: claim.id,
          subject,
          visibility: 'vendor',
          vendorOrgId: c.vendorOrgId,
        })
      : null,
  ]);
  await em(tx, 'orders.claim.opened', {
    claimId: claim.id,
    projectId: c.projectId,
    poId: c.poId,
    number: claim.number,
    type: c.type,
  });
  return claim;
}

export const shipmentIsOpen = (s: { status: string }) => !isShipped(s.status) && s.status !== 'exception';
export const todayStr = () => todayIso();
