import { page } from '@procure/domain';
import { type App, forbidden, notFound, type Principal, type Tx, unprocessable } from '@procure/platform';
import {
  asService,
  getPo,
  loadLines,
  loadShipments,
  notifyOrderManagers,
  recomputeEscalation,
  refreshPoStatus,
  requestEmitter,
} from '../core.js';
import { type ClaimStatus, canTransitionClaim } from '../domain/claims.js';
import { applyTracking, changeShipDate, setRequirementStatus } from '../ops.js';
import {
  AcknowledgeBody,
  ConfirmBody,
  IdParams,
  PoReqParams,
  SubmitBody,
  TrackingBody,
  VendorClaim,
  VendorClaimPatch,
  VendorPo,
  VendorPoQuery,
  VendorPoSummary,
  VendorRequirement,
  VendorShipment,
  z,
} from './_shared.js';

/**
 * Vendor portal. Every query runs under the vendor's RLS (their org's non-draft POs and children only). Responses
 * use vendor schemas: no sell price, no internal notes, no risk scoring, no client details beyond ship-to.
 * Writes are validated under the vendor's RLS; derived bookkeeping (PO status, escalation) runs as service.
 */
const TAGS = ['vendor-portal'];

const guard = (p: Principal) => {
  if (!p.isVendor) throw forbidden('Vendor portal only');
  p.require('vendor:respond');
};

async function vendorPo(tx: Tx, id: string) {
  const [po] = await tx<any[]>`select * from orders.purchase_orders where id = ${id}`;
  if (!po) throw notFound('Purchase order');
  return po;
}

async function vendorShipment(tx: Tx, id: string) {
  const [sh] = await tx<any[]>`select * from orders.shipments where id = ${id}`;
  if (!sh) throw notFound('Shipment');
  const po = await vendorPo(tx, sh.poId);
  return { sh, po };
}

const pendingConfirmation = (s: any) =>
  !!s.lastConfirmationRequestedAt &&
  (!s.lastConfirmedAt || s.lastConfirmedAt < s.lastConfirmationRequestedAt) &&
  !['shipped', 'in_transit', 'delivered'].includes(s.status);

async function vendorPoDetail(tx: Tx, id: string) {
  const po = await vendorPo(tx, id);
  const [lines, shipments, requirements, revisions] = await Promise.all([
    loadLines(tx, id),
    loadShipments(tx, [id]),
    tx<any[]>`select * from orders.pre_order_requirements where po_id = ${id}
        and (party = 'vendor' or (party = 'client' and kind in ('shop_drawing_approval', 'finish_sample_approval', 'cfa', 'other')))
        order by sort`,
    tx<any[]>`select revision, changes, document_id, issued_at from orders.po_revisions where po_id = ${id}
              order by revision desc`,
  ]);
  return {
    ...po,
    shipTo: po.shipTo,
    lines,
    shipments: shipments.map((s: any) => ({ ...s, confirmationPending: pendingConfirmation(s) })),
    requirements,
    revisions,
  };
}

export async function vendorPortalRoutes(app: App) {
  app.get(
    '/vendor/purchase-orders',
    {
      schema: {
        tags: TAGS,
        summary: "Your organization's purchase orders from this procurement firm",
        querystring: VendorPoQuery,
        response: { 200: page(VendorPoSummary) },
      },
    },
    async (req) => {
      guard(req.principal);
      const q = req.query;
      return req.tx(async (tx) => {
        const conds = [tx`true`];
        if (q.status?.length) conds.push(tx`p.status in ${tx(q.status)}`);
        if (q.q) conds.push(tx`(p.number ilike ${`%${q.q}%`} or p.project_name ilike ${`%${q.q}%`})`);
        const where = conds.reduce((a, c) => tx`${a} and ${c}`);
        const rows = await tx<any[]>`
          select p.*,
            (select min(estimated_ship_date) from orders.shipments s where s.po_id = p.id
               and s.status not in ('shipped', 'in_transit', 'delivered')) as next_ship_date,
            ((case when p.acknowledged_at is null and p.status = 'issued' then 1 else 0 end)
             + (select count(*) from orders.pre_order_requirements r where r.po_id = p.id and r.party = 'vendor'
                  and r.status in ('pending', 'rejected') and r.kind <> 'order_acknowledgement')
             + (select count(*) from orders.shipments s where s.po_id = p.id
                  and s.status not in ('shipped', 'in_transit', 'delivered')
                  and s.last_confirmation_requested_at is not null
                  and (s.last_confirmed_at is null or s.last_confirmed_at < s.last_confirmation_requested_at)))::int as open_actions,
            (p.acknowledged_at is null and p.status = 'issued') as needs_ack,
            exists (select 1 from orders.shipments s where s.po_id = p.id
                    and s.status not in ('shipped', 'in_transit', 'delivered')
                    and s.last_confirmation_requested_at is not null
                    and (s.last_confirmed_at is null or s.last_confirmed_at < s.last_confirmation_requested_at)) as needs_confirm,
            exists (select 1 from orders.shipments s where s.po_id = p.id and s.tracking_number is null
                    and s.status not in ('shipped', 'in_transit', 'delivered')
                    and s.estimated_ship_date <= current_date) as needs_tracking,
            exists (select 1 from orders.pre_order_requirements r where r.po_id = p.id and r.party <> 'internal'
                    and r.kind not in ('order_acknowledgement', 'deposit')
                    and r.status in ('pending', 'rejected') and r.document_id is null) as needs_docs,
            count(*) over ()::int as total_count
          from orders.purchase_orders p where ${where}
          order by open_actions desc, p.issued_at desc nulls last limit ${q.limit} offset ${q.offset}`;
        return {
          items: rows.map((r) => ({
            ...r,
            shipToCity: [r.shipTo?.city, r.shipTo?.region].filter(Boolean).join(', ') || null,
            actions: [
              r.needsAck && 'acknowledge',
              r.needsConfirm && 'confirm_ship_date',
              r.needsTracking && 'add_tracking',
              r.needsDocs && 'submit_documents',
            ].filter(Boolean),
          })),
          total: rows[0]?.totalCount ?? 0,
          limit: q.limit,
          offset: q.offset,
        };
      });
    },
  );

  app.get(
    '/vendor/purchase-orders/:id',
    {
      schema: {
        tags: TAGS,
        summary: 'Purchase order as agreed: lines and costs, shipments, and what we need from you',
        params: IdParams,
        response: { 200: VendorPo },
      },
    },
    async (req) => {
      guard(req.principal);
      return req.tx((tx) => vendorPoDetail(tx, req.params.id));
    },
  );

  app.post(
    '/vendor/purchase-orders/:id/acknowledge',
    {
      schema: {
        tags: TAGS,
        summary: 'Acknowledge the order and give your estimated ship date',
        params: IdParams,
        body: AcknowledgeBody,
        response: { 200: VendorPo },
      },
    },
    async (req) => {
      const p = req.principal;
      guard(p);
      const em = requestEmitter(req);
      const b = req.body;
      return req.tx(async (tx) => {
        const po = await vendorPo(tx, req.params.id);
        if (['cancelled', 'closed'].includes(po.status)) throw unprocessable(`This order is ${po.status}`);
        const ships = await tx<any[]>`select * from orders.shipments where po_id = ${po.id} order by label`;
        const perShip = new Map((b.shipments ?? []).map((s) => [s.shipmentId, s.estimatedShipDate]));
        for (const id of perShip.keys())
          if (!ships.some((s) => s.id === id))
            throw unprocessable('Shipment is not on this order', { shipmentId: id });
        for (const s of ships) {
          const date = perShip.get(s.id) ?? b.estimatedShipDate;
          if (date && !['shipped', 'in_transit', 'delivered'].includes(s.status)) {
            await changeShipDate(tx, em, s, date, 'vendor');
            await tx`update orders.shipments set last_confirmed_at = now(),
                       status = case when status = 'planned' then 'confirmed' else status end
                     where id = ${s.id}`;
          }
        }
        const [ack] = await tx<any[]>`select id from orders.pre_order_requirements
                                      where po_id = ${po.id} and kind = 'order_acknowledgement' order by sort limit 1`;
        if (ack)
          await setRequirementStatus(tx, em, ack.id, 'approved', {
            actorName: p.name,
            documentId: b.documentId ?? null,
            note: b.note ?? null,
          });
        await asService(tx, p, async () => {
          await tx`update orders.purchase_orders set acknowledged_at = coalesce(acknowledged_at, now()),
                     status = case when status = 'issued' then 'acknowledged' else status end
                   where id = ${po.id}`;
          await refreshPoStatus(tx, po.id);
          await recomputeEscalation(tx, po.id, em);
          await em(tx, 'orders.po.acknowledged', {
            poId: po.id,
            projectId: po.projectId,
            vendorId: po.vendorId,
            number: po.number,
            estimatedShipDate: b.estimatedShipDate ?? [...perShip.values()].sort()[0] ?? null,
          });
          await notifyOrderManagers(tx, em, po, {
            title: `${po.vendorName} acknowledged ${po.number}`,
            body:
              [b.estimatedShipDate ? `Estimated ship date ${b.estimatedShipDate}` : null, b.note ?? null]
                .filter(Boolean)
                .join(' · ') || 'Order acknowledged',
            severity: 'success',
          });
        });
        return vendorPoDetail(tx, po.id);
      });
    },
  );

  app.post(
    '/vendor/shipments/:id/confirm',
    {
      schema: {
        tags: TAGS,
        summary: 'Confirm the ship date is on track, or give the new date',
        params: IdParams,
        body: ConfirmBody,
        response: { 200: VendorShipment },
      },
    },
    async (req) => {
      const p = req.principal;
      guard(p);
      const em = requestEmitter(req);
      const b = req.body;
      if (!b.onTrack && !b.newShipDate) throw unprocessable('Give the new ship date when it is not on track');
      return req.tx(async (tx) => {
        const { sh, po } = await vendorShipment(tx, req.params.id);
        if (['shipped', 'in_transit', 'delivered'].includes(sh.status))
          throw unprocessable('This shipment has already shipped');
        const changed = !b.onTrack && b.newShipDate !== sh.estimatedShipDate;
        // Answer the open request if there is one, else record an unsolicited confirmation.
        const [open] = await tx<{ id: string }[]>`
          select id from orders.ship_date_confirmations where shipment_id = ${sh.id} and responded_at is null
          order by requested_at desc limit 1`;
        const vals = {
          respondedAt: new Date().toISOString(),
          response: changed ? 'changed' : 'on_track',
          previousDate: sh.estimatedShipDate,
          newDate: changed ? b.newShipDate! : sh.estimatedShipDate,
          note: b.note ?? null,
          channel: 'portal',
          respondedByName: p.name,
        };
        if (open)
          await tx`update orders.ship_date_confirmations set ${tx(vals as never)} where id = ${open.id}`;
        else
          await tx`insert into orders.ship_date_confirmations ${tx({
            tenantId: sh.tenantId,
            shipmentId: sh.id,
            requestedAt: vals.respondedAt,
            ...vals,
          } as never)}`;
        if (changed) await changeShipDate(tx, em, sh, b.newShipDate!, 'vendor');
        await tx`update orders.shipments set last_confirmed_at = now(),
                   status = case when status = 'planned' then 'confirmed' else status end
                 where id = ${sh.id}`;
        await asService(tx, p, async () => {
          await recomputeEscalation(tx, po.id, em);
          await notifyOrderManagers(tx, em, po, {
            title: changed
              ? `${po.vendorName} moved ${po.number}-${sh.label} to ${b.newShipDate}`
              : `${po.vendorName} confirmed ${po.number}-${sh.label} on track`,
            body: changed
              ? `Ship date ${sh.estimatedShipDate ?? 'TBD'} → ${b.newShipDate}${b.note ? ` · ${b.note}` : ''}`
              : `Ship date ${sh.estimatedShipDate ?? 'TBD'}${b.note ? ` · ${b.note}` : ''}`,
            severity: changed ? 'warning' : 'info',
          });
        });
        const [s] = (await loadShipments(tx, [po.id])).filter((x: any) => x.id === sh.id);
        return { ...s, confirmationPending: false };
      });
    },
  );

  app.post(
    '/vendor/shipments/:id/tracking',
    {
      schema: {
        tags: TAGS,
        summary: 'Add carrier and tracking number (the site team is notified)',
        params: IdParams,
        body: TrackingBody,
        response: { 200: VendorShipment },
      },
    },
    async (req) => {
      const p = req.principal;
      guard(p);
      const em = requestEmitter(req);
      return req.tx(async (tx) => {
        const { sh, po } = await vendorShipment(tx, req.params.id);
        if (sh.status === 'delivered') throw unprocessable('This shipment was already delivered');
        await applyTrackingAsVendor(tx, p, em, sh.id, req.body);
        await asService(tx, p, () =>
          notifyOrderManagers(tx, em, po, {
            title: `${po.vendorName} shipped ${po.number}-${sh.label}`,
            body: `${req.body.carrier} ${req.body.trackingNumber}${req.body.shipDate ? ` · shipped ${req.body.shipDate}` : ''}`,
            severity: 'info',
          }),
        );
        const [s] = (await loadShipments(tx, [po.id])).filter((x: any) => x.id === sh.id);
        return { ...s, confirmationPending: false };
      });
    },
  );

  app.post(
    '/vendor/purchase-orders/:id/requirements/:reqId/submit',
    {
      schema: {
        tags: TAGS,
        summary: 'Submit a document for a requirement (e.g. shop drawings uploaded to documents)',
        params: PoReqParams,
        body: SubmitBody,
        response: { 200: VendorRequirement },
      },
    },
    async (req) => {
      const p = req.principal;
      guard(p);
      const em = requestEmitter(req);
      return req.tx(async (tx) => {
        const po = await vendorPo(tx, req.params.id);
        // Vendors submit their own requirements and, for client approvals, the drawings/samples to be approved.
        const [r] = await asService(
          tx,
          p,
          () =>
            tx<
              any[]
            >`select * from orders.pre_order_requirements where id = ${req.params.reqId} and po_id = ${po.id}`,
        );
        if (!r || r.party === 'internal' || r.kind === 'deposit') throw notFound('Requirement');
        if (r.status === 'approved' || r.status === 'waived')
          throw unprocessable(`Requirement is already ${r.status}`);
        const row = await asService(tx, p, async () => {
          const u = await setRequirementStatus(tx, em, r.id, 'submitted', {
            documentId: req.body.documentId,
            note: req.body.note ?? null,
          });
          await recomputeEscalation(tx, po.id, em);
          await notifyOrderManagers(tx, em, po, {
            title: `${po.vendorName} submitted ${r.label} for ${po.number}`,
            body: req.body.note ?? 'Ready for review',
            severity: 'info',
          });
          return u;
        });
        return row;
      });
    },
  );

  app.get(
    '/vendor/claims',
    {
      schema: {
        tags: TAGS,
        summary: 'Claims filed against your orders',
        querystring: z.object({ status: z.string().optional() }),
        response: { 200: z.array(VendorClaim) },
      },
    },
    async (req) => {
      guard(req.principal);
      return req.tx(async (tx) => {
        const rows = await tx<any[]>`
          select c.*, p.number as po_number from orders.claims c left join orders.purchase_orders p on p.id = c.po_id
          where true ${req.query.status ? tx`and c.status = ${req.query.status}` : tx``}
          order by c.reported_at desc limit 500`;
        return withVendorClaimItems(tx, rows);
      });
    },
  );

  app.patch(
    '/vendor/claims/:id',
    {
      schema: {
        tags: TAGS,
        summary: 'Acknowledge a claim or confirm a replacement is ordered',
        params: IdParams,
        body: VendorClaimPatch,
        response: { 200: VendorClaim },
      },
    },
    async (req) => {
      const p = req.principal;
      guard(p);
      const em = requestEmitter(req);
      return req.tx(async (tx) => {
        const [c] = await tx<any[]>`select * from orders.claims where id = ${req.params.id}`;
        if (!c) throw notFound('Claim');
        const b = req.body;
        if (b.status && !canTransitionClaim(c.status as ClaimStatus, b.status, 'vendor'))
          throw unprocessable(`Cannot move this claim from ${c.status} to ${b.status}`);
        await tx`update orders.claims set status = coalesce(${b.status ?? null}, status),
                   resolution = coalesce(${b.resolution ?? null}, resolution)
                 where id = ${c.id}`;
        if (c.poId)
          await asService(tx, p, async () => {
            const po = await getPo(tx, c.poId);
            await notifyOrderManagers(tx, em, po, {
              title: `${po.vendorName} updated claim ${c.number}`,
              body: [b.status?.replace('_', ' '), b.resolution].filter(Boolean).join(' · '),
              severity: 'info',
              link: `/app/claims/${c.id}`,
            });
          });
        const rows = await tx<any[]>`
          select c.*, p.number as po_number from orders.claims c left join orders.purchase_orders p on p.id = c.po_id
          where c.id = ${c.id}`;
        return (await withVendorClaimItems(tx, rows))[0];
      });
    },
  );
}

async function withVendorClaimItems(tx: Tx, rows: any[]) {
  if (!rows.length) return rows;
  const items = await tx<any[]>`
    select ci.claim_id, l.code, l.name, ci.quantity, ci.note from orders.claim_items ci
    left join orders.po_lines l on l.id = ci.po_line_id where ci.claim_id in ${tx(rows.map((r) => r.id))}`;
  return rows.map((r) => ({ ...r, items: items.filter((i) => i.claimId === r.id) }));
}

/** Tracking from the vendor: the shipment row is vendor-updatable; follow-on effects run as service. */
async function applyTrackingAsVendor(
  tx: Tx,
  p: Principal,
  em: ReturnType<typeof requestEmitter>,
  shipmentId: string,
  b: { carrier: string; trackingNumber: string; shipDate?: string | null; trackingUrl?: string },
) {
  await asService(tx, p, () =>
    applyTracking(tx, em, shipmentId, {
      carrier: b.carrier,
      trackingNumber: b.trackingNumber,
      shipDate: b.shipDate ?? null,
      trackingUrl: b.trackingUrl ?? null,
    }),
  );
}
