import { page } from '@procure/domain';
import { type App, notFound, orderBy, type Tx, unprocessable } from '@procure/platform';
import {
  emailVendor,
  getPo,
  loadLines,
  loadShipments,
  notifyOrderManagers,
  recomputeEscalation,
  refreshPoStatus,
  requestEmitter,
  vendorPortalLink,
} from '../core.js';
import { allocationErrors, nextLabel } from '../domain/allocation.js';
import { applyTracking, changeShipDate, deliverShipment, openClaim } from '../ops.js';
import {
  Confirmation,
  DeliverBody,
  IdParams,
  ReceiveBody,
  ReceiveResult,
  RequestConfirmationBody,
  Shipment,
  ShipmentCreateBody,
  ShipmentPatchBody,
  ShipmentRow,
  ShipmentsQuery,
  SplitBody,
  SplitResult,
  z,
} from './_shared.js';

const TAGS = ['shipments'];
const SHIPPED = ['shipped', 'in_transit', 'delivered'];

export async function getShipment(tx: Tx, id: string) {
  const [s] = await tx<any[]>`select * from orders.shipments where id = ${id}`;
  if (!s) throw notFound('Shipment');
  const [withLines] = await loadShipments(tx, [s.poId]).then((xs) => xs.filter((x) => x.id === id));
  return withLines ?? { ...s, lines: [] };
}

/** Validate and write the full allocation set for a PO, replacing the given shipments' lines. */
async function writeAllocations(
  tx: Tx,
  poId: string,
  changes: Map<string, { poLineId: string; quantity: number }[]>,
) {
  const lines = await loadLines(tx, poId);
  const existing = await tx<{ shipmentId: string; poLineId: string; quantity: number }[]>`
    select sl.shipment_id, sl.po_line_id, sl.quantity from orders.shipment_lines sl
    join orders.shipments s on s.id = sl.shipment_id where s.po_id = ${poId}`;
  const all = [
    ...existing.filter((e) => !changes.has(e.shipmentId)),
    ...[...changes].flatMap(([shipmentId, xs]) => xs.map((x) => ({ ...x, shipmentId }))),
  ];
  const errors = allocationErrors(
    lines.map((l) => ({ id: l.id, code: l.code, quantity: l.quantity })),
    all,
  );
  if (errors.length) throw unprocessable('Shipment allocations exceed ordered quantities', { errors });
  for (const [shipmentId, xs] of changes) {
    await tx`delete from orders.shipment_lines where shipment_id = ${shipmentId}`;
    const merged = new Map<string, number>();
    for (const x of xs) merged.set(x.poLineId, (merged.get(x.poLineId) ?? 0) + x.quantity);
    for (const [poLineId, quantity] of merged)
      await tx`insert into orders.shipment_lines (tenant_id, shipment_id, po_line_id, quantity)
               select tenant_id, ${shipmentId}, ${poLineId}, ${quantity} from orders.shipments where id = ${shipmentId}`;
  }
}

export async function shipmentRoutes(app: App) {
  app.get(
    '/shipments',
    {
      schema: {
        tags: TAGS,
        summary:
          'Cross-portfolio shipments: what ships or delivers soon, what is missing tracking, what is at risk',
        querystring: ShipmentsQuery,
        response: { 200: page(ShipmentRow) },
      },
    },
    async (req) => {
      req.principal.require('orders:read');
      const q = req.query;
      return req.tx(async (tx) => {
        const eff = tx`coalesce(s.estimated_delivery_date, s.estimated_ship_date + coalesce(p.transit_days, 5), s.requested_delivery_date)`;
        const conds = [tx`p.status not in ('cancelled', 'draft')`];
        if (q.status?.length) conds.push(tx`s.status in ${tx(q.status)}`);
        else if (!q.includeDelivered) conds.push(tx`s.status <> 'delivered'`);
        if (q.shipsWithinDays !== undefined)
          conds.push(
            tx`s.status not in ${tx(SHIPPED)} and s.estimated_ship_date <= current_date + ${q.shipsWithinDays}::int`,
          );
        if (q.deliversWithinDays !== undefined)
          conds.push(tx`s.status <> 'delivered' and ${eff} <= current_date + ${q.deliversWithinDays}::int`);
        if (q.trackingMissing !== undefined)
          conds.push(
            q.trackingMissing
              ? tx`s.tracking_number is null and s.status <> 'delivered' and s.estimated_ship_date <= current_date`
              : tx`s.tracking_number is not null`,
          );
        if (q.escalation?.length) conds.push(tx`s.escalation in ${tx(q.escalation)}`);
        if (q.projectId) conds.push(tx`s.project_id = ${q.projectId}`);
        if (q.vendorId) conds.push(tx`p.vendor_id = ${q.vendorId}`);
        if (q.poId) conds.push(tx`s.po_id = ${q.poId}`);
        if (q.q) {
          const like = `%${q.q}%`;
          conds.push(tx`(p.number ilike ${like} or p.vendor_name ilike ${like} or p.project_name ilike ${like}
                         or s.tracking_number ilike ${like} or s.note ilike ${like})`);
        }
        const where = conds.reduce((a, c) => tx`${a} and ${c}`);
        const order = orderBy(
          tx,
          q.sort,
          {
            estimatedShipDate: 's.estimated_ship_date',
            effectiveDeliveryDate: 'effective_delivery_date',
            escalation: `array_position(array['none','watch','at_risk','critical']::text[], s.escalation)`,
            poNumber: 'p.number',
          },
          'estimatedShipDate',
        );
        const rows = await tx<any[]>`
          select s.*, p.number as po_number, p.status as po_status, p.project_name, p.project_number, p.vendor_id,
                 p.vendor_name, p.release_by_date, ${eff} as effective_delivery_date,
                 (s.tracking_number is null and s.status <> 'delivered' and s.estimated_ship_date <= current_date)
                   as tracking_missing,
                 count(*) over ()::int as total_count
          from orders.shipments s join orders.purchase_orders p on p.id = s.po_id
          where ${where}
          order by ${order}, p.number, s.label
          limit ${q.limit} offset ${q.offset}`;
        const withLines = rows.length ? await loadShipments(tx, [...new Set(rows.map((r) => r.poId))]) : [];
        return {
          items: rows.map((r) => ({ ...r, lines: withLines.find((w) => w.id === r.id)?.lines ?? [] })),
          total: rows[0]?.totalCount ?? 0,
          limit: q.limit,
          offset: q.offset,
        };
      });
    },
  );

  app.get(
    '/shipments/:id',
    {
      schema: {
        tags: TAGS,
        summary: 'Shipment with allocated lines',
        params: IdParams,
        response: { 200: Shipment },
      },
    },
    async (req) => {
      req.principal.require('orders:read');
      return req.tx((tx) => getShipment(tx, req.params.id));
    },
  );

  app.get(
    '/shipments/:id/confirmations',
    {
      schema: {
        tags: TAGS,
        summary: 'Ship-date confirmation requests and vendor responses',
        params: IdParams,
        response: { 200: z.array(Confirmation) },
      },
    },
    async (req) => {
      req.principal.require('orders:read');
      return req.tx(
        (tx) =>
          tx`select * from orders.ship_date_confirmations where shipment_id = ${req.params.id}
             order by requested_at desc` as never,
      );
    },
  );

  app.post(
    '/purchase-orders/:id/shipments',
    {
      schema: {
        tags: TAGS,
        summary: 'Add a shipment with line allocations (Σ allocated per line ≤ ordered, else 422)',
        params: IdParams,
        body: ShipmentCreateBody,
        response: { 201: Shipment },
      },
    },
    async (req, reply) => {
      req.principal.require('logistics:write');
      const em = requestEmitter(req);
      const sh = await req.tx(async (tx) => {
        const po = await getPo(tx, req.params.id, true);
        if (po.status === 'cancelled') throw unprocessable('PO is cancelled');
        const b = req.body;
        const labels = (
          await tx<{ label: string }[]>`select label from orders.shipments where po_id = ${po.id}`
        ).map((r) => r.label);
        const label = b.label ?? nextLabel(labels);
        const [s] = await tx<{ id: string }[]>`
          insert into orders.shipments (tenant_id, po_id, project_id, label, note, requested_delivery_date,
            estimated_ship_date, original_ship_date, origin, ship_method, destination, storage_location_id)
          values (${po.tenantId}, ${po.id}, ${po.projectId}, ${label}, ${b.note ?? null},
            ${b.requestedDeliveryDate ?? po.requestedDeliveryDate}, ${b.estimatedShipDate ?? null},
            ${b.estimatedShipDate ?? null}, ${po.origin}, ${po.shipMethod}, ${b.destination ?? 'site'},
            ${b.storageLocationId ?? null})
          returning id`;
        await writeAllocations(tx, po.id, new Map([[s!.id, b.allocations]]));
        await refreshPoStatus(tx, po.id);
        await recomputeEscalation(tx, po.id, em);
        return getShipment(tx, s!.id);
      });
      return reply.status(201).send(sh);
    },
  );

  app.patch(
    '/shipments/:id',
    {
      schema: {
        tags: TAGS,
        summary:
          'Update dates, status, destination, allocations or tracking (tracking notifies delivery recipients)',
        params: IdParams,
        body: ShipmentPatchBody,
        response: { 200: Shipment },
      },
    },
    async (req) => {
      req.principal.require('logistics:write');
      const em = requestEmitter(req);
      return req.tx(async (tx) => {
        const [cur] = await tx<any[]>`select * from orders.shipments where id = ${req.params.id} for update`;
        if (!cur) throw notFound('Shipment');
        const b = req.body;
        if (
          (b.carrier && !b.trackingNumber && !cur.trackingNumber) ||
          (b.trackingNumber && !b.carrier && !cur.carrier)
        )
          throw unprocessable('Carrier and tracking number go together');
        if (b.estimatedShipDate !== undefined)
          await changeShipDate(tx, em, cur, b.estimatedShipDate, 'internal');
        const plain = Object.fromEntries(
          Object.entries({
            note: b.note,
            requestedDeliveryDate: b.requestedDeliveryDate,
            estimatedDeliveryDate: b.estimatedDeliveryDate,
            destination: b.destination,
            storageLocationId: b.storageLocationId,
            originLocation: b.originLocation,
            shipMethod: b.shipMethod,
            actualShipDate: b.actualShipDate,
          }).filter(([, v]) => v !== undefined),
        );
        if (Object.keys(plain).length)
          await tx`update orders.shipments set ${tx(plain as never)} where id = ${cur.id}`;
        if (b.allocations) {
          if (SHIPPED.includes(cur.status)) throw unprocessable('Shipped shipments cannot be re-allocated');
          await writeAllocations(tx, cur.poId, new Map([[cur.id, b.allocations]]));
        }
        if (b.carrier || b.trackingNumber)
          await applyTracking(tx, em, cur.id, {
            carrier: b.carrier ?? cur.carrier,
            trackingNumber: b.trackingNumber ?? cur.trackingNumber,
            shipDate: b.actualShipDate,
            trackingUrl: b.trackingUrl,
          });
        if (b.status && b.status !== cur.status) {
          if (b.status === 'delivered') await deliverShipment(tx, em, cur.id);
          else await tx`update orders.shipments set status = ${b.status} where id = ${cur.id}`;
        }
        await refreshPoStatus(tx, cur.poId);
        await recomputeEscalation(tx, cur.poId, em);
        return getShipment(tx, cur.id);
      });
    },
  );

  app.delete(
    '/shipments/:id',
    {
      schema: {
        tags: TAGS,
        summary: 'Remove a planned shipment (its quantities become unallocated)',
        params: IdParams,
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      req.principal.require('logistics:write');
      const em = requestEmitter(req);
      await req.tx(async (tx) => {
        const [cur] = await tx<any[]>`select * from orders.shipments where id = ${req.params.id}`;
        if (!cur) throw notFound('Shipment');
        if (SHIPPED.includes(cur.status) || cur.trackingNumber)
          throw unprocessable('Shipped shipments cannot be removed');
        const [{ n }] =
          (await tx`select count(*)::int as n from orders.shipments where po_id = ${cur.poId}`) as unknown as [
            { n: number },
          ];
        if (n <= 1) throw unprocessable('A purchase order keeps at least one shipment');
        await tx`delete from orders.shipments where id = ${cur.id}`;
        await refreshPoStatus(tx, cur.poId);
        await recomputeEscalation(tx, cur.poId, em);
      });
      return reply.status(204).send(null);
    },
  );

  app.post(
    '/shipments/:id/split',
    {
      schema: {
        tags: TAGS,
        summary: 'Split quantities off into a new shipment (B, C …) — e.g. phased floor-by-floor renovations',
        params: IdParams,
        body: SplitBody,
        response: { 201: SplitResult },
      },
    },
    async (req, reply) => {
      req.principal.require('logistics:write');
      const em = requestEmitter(req);
      const result = await req.tx(async (tx) => {
        const src = await getShipment(tx, req.params.id);
        if (SHIPPED.includes(src.status)) throw unprocessable('A shipped shipment cannot be split');
        const po = await getPo(tx, src.poId, true);
        const b = req.body;
        const remaining = new Map<string, number>(src.lines.map((l: any) => [l.poLineId, l.quantity]));
        const errors = [];
        for (const l of b.lines) {
          const have = remaining.get(l.poLineId) ?? 0;
          if (l.quantity > have)
            errors.push({
              poLineId: l.poLineId,
              message: `Only ${have} of this line is on shipment ${src.label}`,
              available: have,
              requested: l.quantity,
            });
          else remaining.set(l.poLineId, have - l.quantity);
        }
        if (errors.length) throw unprocessable('Cannot split more than the shipment holds', { errors });
        const labels = (
          await tx<{ label: string }[]>`select label from orders.shipments where po_id = ${po.id}`
        ).map((r) => r.label);
        const label = b.label ?? nextLabel(labels);
        const [n] = await tx<{ id: string }[]>`
          insert into orders.shipments (tenant_id, po_id, project_id, label, note, requested_delivery_date,
            estimated_ship_date, original_ship_date, origin, origin_location, ship_method, destination, storage_location_id)
          values (${po.tenantId}, ${po.id}, ${po.projectId}, ${label}, ${b.note ?? null},
            ${b.requestedDeliveryDate === undefined ? src.requestedDeliveryDate : b.requestedDeliveryDate},
            ${b.estimatedShipDate === undefined ? src.estimatedShipDate : b.estimatedShipDate},
            ${b.estimatedShipDate === undefined ? src.estimatedShipDate : b.estimatedShipDate},
            ${src.origin}, ${src.originLocation}, ${src.shipMethod}, ${b.destination ?? src.destination},
            ${src.storageLocationId})
          returning id`;
        await writeAllocations(
          tx,
          po.id,
          new Map([
            [
              src.id,
              [...remaining].filter(([, q]) => q > 0).map(([poLineId, quantity]) => ({ poLineId, quantity })),
            ],
            [n!.id, b.lines],
          ]),
        );
        await recomputeEscalation(tx, po.id, em);
        return { source: await getShipment(tx, src.id), created: await getShipment(tx, n!.id) };
      });
      return reply.status(201).send(result);
    },
  );

  app.post(
    '/shipments/:id/request-confirmation',
    {
      schema: {
        tags: TAGS,
        summary: 'Ask the vendor to confirm the ship date (email with portal link)',
        params: IdParams,
        body: RequestConfirmationBody,
        response: { 201: Confirmation },
      },
    },
    async (req, reply) => {
      req.principal.require('logistics:write');
      const em = requestEmitter(req);
      const c = await req.tx(async (tx) => {
        const sh = await getShipment(tx, req.params.id);
        if (sh.status === 'delivered') throw unprocessable('Shipment already delivered');
        const po = await getPo(tx, sh.poId);
        const row = await requestConfirmation(tx, em, po, sh, 'internal', req.body?.message);
        return row;
      });
      return reply.status(201).send(c);
    },
  );

  app.post(
    '/shipments/:id/deliver',
    {
      schema: {
        tags: TAGS,
        summary: 'Mark a shipment delivered (PO becomes delivered when all shipments are)',
        params: IdParams,
        body: DeliverBody,
        response: { 200: Shipment },
      },
    },
    async (req) => {
      req.principal.require('logistics:write');
      const em = requestEmitter(req);
      return req.tx(async (tx) => {
        await getShipment(tx, req.params.id);
        await deliverShipment(tx, em, req.params.id, req.body?.deliveredAt);
        return getShipment(tx, req.params.id);
      });
    },
  );

  app.post(
    '/shipments/:id/receive',
    {
      schema: {
        tags: TAGS,
        summary: 'Receive a shipment into storage; damaged quantities open a damage claim automatically',
        params: IdParams,
        body: ReceiveBody,
        response: { 201: ReceiveResult },
      },
    },
    async (req, reply) => {
      const p = req.principal;
      p.require('logistics:write');
      const em = requestEmitter(req);
      const result = await req.tx(async (tx) => {
        const sh = await getShipment(tx, req.params.id);
        const po = await getPo(tx, sh.poId, true);
        if (po.status === 'cancelled' || po.status === 'draft') throw unprocessable(`PO is ${po.status}`);
        const b = req.body;
        const lines = await loadLines(tx, po.id);
        const prior = await tx<{ poLineId: string; q: number }[]>`
          select rl.po_line_id, sum(rl.quantity_received)::numeric as q from orders.receipt_lines rl
          join orders.receipts r on r.id = rl.receipt_id where r.shipment_id = ${sh.id} group by rl.po_line_id`;
        const errors = [];
        for (const l of b.lines) {
          const line = lines.find((x) => x.id === l.poLineId);
          const onShipment = sh.lines.find((x: any) => x.poLineId === l.poLineId)?.quantity ?? 0;
          const already = prior.find((x) => x.poLineId === l.poLineId)?.q ?? 0;
          if (!line) errors.push({ poLineId: l.poLineId, message: 'Line is not on this purchase order' });
          else if (l.qtyDamaged > l.qtyReceived)
            errors.push({ poLineId: l.poLineId, message: `${line.code}: damaged exceeds received` });
          else if (already + l.qtyReceived > onShipment)
            errors.push({
              poLineId: l.poLineId,
              message: `${line.code}: receiving ${already + l.qtyReceived} but shipment ${sh.label} carries ${onShipment}`,
            });
        }
        if (errors.length) throw unprocessable('Receipt does not match the shipment', { errors });
        if (b.storageLocationId) {
          const [loc] = await tx`select id from orders.storage_locations where id = ${b.storageLocationId}`;
          if (!loc) throw notFound('Storage location');
        }
        const damaged = b.lines.filter((l) => l.qtyDamaged > 0);
        const short = b.lines.some(
          (l) => l.qtyReceived < (sh.lines.find((x: any) => x.poLineId === l.poLineId)?.quantity ?? 0),
        );
        const condition = b.condition ?? (damaged.length ? 'damaged' : short ? 'partial' : 'good');
        const storageLocationId = b.storageLocationId ?? sh.storageLocationId ?? null;
        const [receipt] = await tx<any[]>`
          insert into orders.receipts (tenant_id, shipment_id, po_id, received_at, received_by_name, storage_location_id,
            condition, notes, photo_document_ids)
          values (${po.tenantId}, ${sh.id}, ${po.id}, ${b.receivedAt ?? new Date().toISOString()}, ${p.name},
            ${storageLocationId}, ${condition}, ${b.notes ?? null}, ${b.photoDocumentIds}::uuid[])
          returning *`;
        for (const l of b.lines) {
          await tx`insert into orders.receipt_lines (tenant_id, receipt_id, po_line_id, quantity_received, quantity_damaged)
                   values (${po.tenantId}, ${receipt.id}, ${l.poLineId}, ${l.qtyReceived}, ${l.qtyDamaged})`;
          if (l.qtyReceived > 0)
            await tx`update orders.po_lines set received_qty = received_qty + ${l.qtyReceived} where id = ${l.poLineId}`;
          const good = l.qtyReceived - l.qtyDamaged;
          if (good > 0)
            await tx`insert into orders.storage_items (tenant_id, project_id, client_org_id, po_id, po_line_id,
                       storage_location_id, quantity, status, updated_by_name)
                     values (${po.tenantId}, ${po.projectId}, ${po.clientOrgId}, ${po.id}, ${l.poLineId},
                       ${storageLocationId}, ${good}, 'stored', ${p.name})`;
          if (l.qtyDamaged > 0)
            await tx`insert into orders.storage_items (tenant_id, project_id, client_org_id, po_id, po_line_id,
                       storage_location_id, quantity, status, updated_by_name)
                     values (${po.tenantId}, ${po.projectId}, ${po.clientOrgId}, ${po.id}, ${l.poLineId},
                       ${storageLocationId}, ${l.qtyDamaged}, 'damaged', ${p.name})`;
        }
        let claimId: string | null = null;
        if (damaged.length) {
          const codes = damaged.map((d) => {
            const line = lines.find((x) => x.id === d.poLineId)!;
            return `${line.code} ×${d.qtyDamaged}`;
          });
          const claim = await openClaim(tx, em, {
            tenantId: po.tenantId,
            projectId: po.projectId,
            poId: po.id,
            shipmentId: sh.id,
            receiptId: receipt.id,
            vendorId: po.vendorId,
            vendorOrgId: po.vendorOrgId,
            clientOrgId: po.clientOrgId,
            type: 'damage',
            description: `Damaged on receipt of ${po.number} shipment ${sh.label}: ${codes.join(', ')}${
              b.notes ? `. ${b.notes}` : ''
            }`,
            reportedByName: p.name,
            reportedByActor: 'internal',
            photoDocumentIds: b.photoDocumentIds,
            items: damaged.map((d) => ({
              poLineId: d.poLineId,
              quantity: d.qtyDamaged,
              note: 'Damaged on receipt',
            })),
          });
          claimId = claim.id;
          await notifyOrderManagers(tx, em, po, {
            title: `Damage claim ${claim.number} opened for ${po.number}`,
            body: `${codes.join(', ')} damaged on receipt (shipment ${sh.label})`,
            severity: 'warning',
            link: `/app/claims/${claim.id}`,
          });
        }
        if (sh.status !== 'delivered') await deliverShipment(tx, em, sh.id, receipt.receivedAt);
        const poStatus = await refreshPoStatus(tx, po.id);
        const rlines = await tx<any[]>`
          select rl.po_line_id, l.code, l.name, rl.quantity_received, rl.quantity_damaged
          from orders.receipt_lines rl join orders.po_lines l on l.id = rl.po_line_id where rl.receipt_id = ${receipt.id}`;
        return {
          receipt: { ...receipt, lines: rlines },
          claimId,
          shipment: await getShipment(tx, sh.id),
          poStatus,
        };
      });
      return reply.status(201).send(result);
    },
  );
}

/** Create a confirmation request and email the vendor a link to confirm or update the ship date. */
export async function requestConfirmation(
  tx: Tx,
  em: ReturnType<typeof requestEmitter>,
  po: Awaited<ReturnType<typeof getPo>>,
  sh: { id: string; label: string; estimatedShipDate: string | null; note?: string | null },
  channel: 'internal' | 'email' | 'portal',
  message?: string,
) {
  const [row] = await tx<any[]>`
    insert into orders.ship_date_confirmations (tenant_id, shipment_id, previous_date, channel)
    values (${po.tenantId}, ${sh.id}, ${sh.estimatedShipDate}, ${channel === 'internal' ? 'email' : channel})
    returning *`;
  await tx`update orders.shipments set last_confirmation_requested_at = now() where id = ${sh.id}`;
  await emailVendor(tx, em, po, {
    subject: `Please confirm ship date: ${po.number}${sh.label !== 'A' ? ` shipment ${sh.label}` : ''}`,
    text: [
      `Please confirm the ship date for purchase order ${po.number} (${po.projectName ?? ''})${
        sh.label !== 'A' || sh.note ? `, shipment ${sh.label}${sh.note ? ` — ${sh.note}` : ''}` : ''
      }.`,
      '',
      `Current estimated ship date: ${sh.estimatedShipDate ?? 'not yet provided'}`,
      message ? `\n${message}\n` : '',
      `Confirm it is on track, or give us the new date, here: ${vendorPortalLink(po.id)}`,
    ].join('\n'),
  });
  return row;
}
