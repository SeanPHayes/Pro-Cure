import { page } from '@procure/domain';
import { ActivityEntry, type App, listActivity, notFound, type Tx, unprocessable } from '@procure/platform';
import * as clients from '../clients.js';
import { emailVendor, getPo, requestEmitter, vendorPortalLink } from '../core.js';
import { type ClaimStatus, canTransitionClaim } from '../domain/claims.js';
import { addDays } from '../domain/dates.js';
import { openClaim } from '../ops.js';
import {
  BulkApplyBody,
  CalendarQuery,
  CalendarResult,
  Claim,
  ClaimCreateBody,
  ClaimPatchBody,
  ClaimsQuery,
  DocumentResult,
  IdParams,
  ProjectParams,
  Recipient,
  RecipientInput,
  RecipientParams,
  RecipientPatch,
  RecipientsQuery,
  StorageItem,
  StorageItemPatch,
  StorageItemsQuery,
  StorageLocation,
  StorageLocationBody,
  StorageLocationsQuery,
  z,
} from './_shared.js';
import { tenantInfo } from './purchase-orders.js';

// ---------------------------------------------------------------------------------------------
// Shared loaders (also used by the portals)
// ---------------------------------------------------------------------------------------------
export async function loadClaim(tx: Tx, id: string) {
  const [c] = await tx<any[]>`
    select c.*, p.number as po_number, coalesce(p.vendor_name, null) as vendor_name
    from orders.claims c left join orders.purchase_orders p on p.id = c.po_id where c.id = ${id}`;
  if (!c) throw notFound('Claim');
  c.items = await tx`
    select ci.id, ci.po_line_id, l.code, l.name, ci.quantity, ci.note
    from orders.claim_items ci left join orders.po_lines l on l.id = ci.po_line_id
    where ci.claim_id = ${id} order by l.sort, l.code`;
  return c;
}

/** Split `quantity` units off a storage item (returns the id of the row to change). */
export async function splitStorageItem(tx: Tx, item: any, quantity: number | undefined): Promise<string> {
  if (!quantity || quantity >= item.quantity) {
    if (quantity && quantity > item.quantity)
      throw unprocessable(`Only ${item.quantity} units in this storage entry`);
    return item.id;
  }
  await tx`update orders.storage_items set quantity = quantity - ${quantity} where id = ${item.id}`;
  const [n] = await tx<{ id: string }[]>`
    insert into orders.storage_items (tenant_id, project_id, client_org_id, po_id, po_line_id, storage_location_id,
      quantity, status, area_note, updated_by_name)
    values (${item.tenantId}, ${item.projectId}, ${item.clientOrgId}, ${item.poId}, ${item.poLineId},
      ${item.storageLocationId}, ${quantity}, ${item.status}, ${item.areaNote}, ${item.updatedByName})
    returning id`;
  return n!.id;
}

export const storageItemsSelect = (tx: Tx) => tx`
  select si.*, p.number as po_number, p.vendor_name, l.code, l.name, loc.name as location_name, loc.kind as location_kind
  from orders.storage_items si
  join orders.purchase_orders p on p.id = si.po_id
  join orders.po_lines l on l.id = si.po_line_id
  left join orders.storage_locations loc on loc.id = si.storage_location_id`;

export async function logisticsRoutes(app: App) {
  // ------------------------------------------------------------------ delivery recipients
  app.get(
    '/projects/:projectId/delivery-recipients',
    {
      schema: {
        tags: ['delivery-recipients'],
        summary: 'People notified when tracking is added (project-wide, or for one PO)',
        params: ProjectParams,
        querystring: RecipientsQuery,
        response: { 200: z.array(Recipient) },
      },
    },
    async (req) => {
      req.principal.require('orders:read');
      return req.tx(
        (tx) =>
          tx`
          select * from orders.delivery_recipients where project_id = ${req.params.projectId}
          ${req.query.poId ? tx`and (po_id is null or po_id = ${req.query.poId})` : tx``}
          order by po_id nulls first, name` as never,
      );
    },
  );

  app.post(
    '/projects/:projectId/delivery-recipients',
    {
      schema: {
        tags: ['delivery-recipients'],
        summary: 'Add a delivery recipient (poId omitted = every PO on the project)',
        params: ProjectParams,
        body: RecipientInput,
        response: { 201: Recipient },
      },
    },
    async (req, reply) => {
      const p = req.principal;
      p.require('logistics:write');
      const r = await req.tx(async (tx) => {
        if (req.body.poId) {
          const po = await getPo(tx, req.body.poId);
          if (po.projectId !== req.params.projectId) throw unprocessable('PO belongs to another project');
        }
        const [row] =
          await tx`insert into orders.delivery_recipients (tenant_id, project_id, po_id, name, email, phone)
          values (${p.tenantId}, ${req.params.projectId}, ${req.body.poId ?? null}, ${req.body.name},
                  ${req.body.email ?? null}, ${req.body.phone ?? null}) returning *`;
        return row;
      });
      return reply.status(201).send(r as never);
    },
  );

  app.patch(
    '/projects/:projectId/delivery-recipients/:id',
    {
      schema: {
        tags: ['delivery-recipients'],
        summary: 'Edit a delivery recipient',
        params: RecipientParams,
        body: RecipientPatch,
        response: { 200: Recipient },
      },
    },
    async (req) => {
      req.principal.require('logistics:write');
      return req.tx(async (tx) => {
        const sets = Object.fromEntries(Object.entries(req.body).filter(([, v]) => v !== undefined));
        const [row] = Object.keys(sets).length
          ? await tx`update orders.delivery_recipients set ${tx(sets as never)}
                     where id = ${req.params.id} and project_id = ${req.params.projectId} returning *`
          : await tx`select * from orders.delivery_recipients where id = ${req.params.id} and project_id = ${req.params.projectId}`;
        if (!row) throw notFound('Delivery recipient');
        return row as never;
      });
    },
  );

  app.delete(
    '/projects/:projectId/delivery-recipients/:id',
    {
      schema: {
        tags: ['delivery-recipients'],
        summary: 'Remove a delivery recipient',
        params: RecipientParams,
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      req.principal.require('logistics:write');
      await req.tx(async (tx) => {
        const r = await tx`delete from orders.delivery_recipients
                           where id = ${req.params.id} and project_id = ${req.params.projectId} returning id`;
        if (!r.length) throw notFound('Delivery recipient');
      });
      return reply.status(204).send(null);
    },
  );

  app.post(
    '/projects/:projectId/delivery-recipients/bulk-apply',
    {
      schema: {
        tags: ['delivery-recipients'],
        summary: 'Apply a recipient list to every PO on the project (optionally replacing PO-specific lists)',
        params: ProjectParams,
        body: BulkApplyBody,
        response: { 200: z.object({ items: z.array(Recipient), purchaseOrders: z.number() }) },
      },
    },
    async (req) => {
      const p = req.principal;
      p.require('logistics:write');
      return req.tx(async (tx) => {
        const pid = req.params.projectId;
        if (req.body.replaceExisting)
          await tx`delete from orders.delivery_recipients where project_id = ${pid}`;
        const existing = await tx<{ email: string | null; name: string }[]>`
          select name, email from orders.delivery_recipients where project_id = ${pid} and po_id is null`;
        for (const r of req.body.recipients) {
          const dup = existing.some(
            (e) =>
              (r.email && e.email?.toLowerCase() === r.email.toLowerCase()) ||
              (!r.email && e.name === r.name),
          );
          if (!dup)
            await tx`insert into orders.delivery_recipients (tenant_id, project_id, name, email, phone)
                     values (${p.tenantId}, ${pid}, ${r.name}, ${r.email ?? null}, ${r.phone ?? null})`;
        }
        // Project-wide entries now cover every PO; drop PO-specific duplicates.
        await tx`delete from orders.delivery_recipients d where d.project_id = ${pid} and d.po_id is not null
                 and exists (select 1 from orders.delivery_recipients x where x.project_id = ${pid} and x.po_id is null
                             and lower(coalesce(x.email, x.name)) = lower(coalesce(d.email, d.name)))`;
        const [{ n }] = (await tx`select count(*)::int as n from orders.purchase_orders
                                  where project_id = ${pid} and status <> 'cancelled'`) as unknown as [
          { n: number },
        ];
        const items =
          await tx`select * from orders.delivery_recipients where project_id = ${pid} order by po_id nulls first, name`;
        return { items: items as never, purchaseOrders: n };
      });
    },
  );

  // ------------------------------------------------------------------ storage locations
  app.get(
    '/storage-locations',
    {
      schema: {
        tags: ['storage'],
        summary: 'Warehouses, on-site rooms and staging areas (project-specific and tenant-wide)',
        querystring: StorageLocationsQuery,
        response: { 200: z.array(StorageLocation) },
      },
    },
    async (req) => {
      req.principal.require('orders:read');
      const q = req.query;
      return req.tx(
        (tx) =>
          tx`
          select l.*, (select coalesce(sum(quantity), 0)::numeric from orders.storage_items i
                       where i.storage_location_id = l.id and i.status in ('stored', 'staged')) as item_count
          from orders.storage_locations l
          where true
          ${q.projectId ? tx`and (l.project_id = ${q.projectId} or l.project_id is null)` : tx``}
          ${q.includeInactive ? tx`` : tx`and l.active`}
          order by l.project_id nulls last, l.kind, l.name` as never,
      );
    },
  );

  app.post(
    '/storage-locations',
    {
      schema: {
        tags: ['storage'],
        summary: 'Create a storage location',
        body: StorageLocationBody,
        response: { 201: StorageLocation },
      },
    },
    async (req, reply) => {
      const p = req.principal;
      p.require('logistics:write');
      const b = req.body;
      // Owners see on-site locations of their project: copy the project's client org.
      const clientOrgId = b.projectId
        ? (await clients.getProject(p.tenantId, b.projectId)).clientOrgId
        : null;
      const row = await req.tx(async (tx) => {
        const [r] = await tx`
          insert into orders.storage_locations (tenant_id, project_id, client_org_id, name, kind, address, notes, active)
          values (${p.tenantId}, ${b.projectId ?? null}, ${clientOrgId}, ${b.name}, ${b.kind},
                  ${tx.json((b.address ?? {}) as never)}, ${b.notes ?? null}, ${b.active ?? true})
          returning *`;
        return r;
      });
      return reply.status(201).send(row as never);
    },
  );

  app.patch(
    '/storage-locations/:id',
    {
      schema: {
        tags: ['storage'],
        summary: 'Edit or deactivate a storage location',
        params: IdParams,
        body: StorageLocationBody.partial().omit({ projectId: true }),
        response: { 200: StorageLocation },
      },
    },
    async (req) => {
      req.principal.require('logistics:write');
      return req.tx(async (tx) => {
        const b = req.body;
        const sets = Object.fromEntries(
          Object.entries({ ...b, address: b.address ? tx.json(b.address as never) : undefined }).filter(
            ([, v]) => v !== undefined,
          ),
        );
        const [row] = Object.keys(sets).length
          ? await tx`update orders.storage_locations set ${tx(sets as never)} where id = ${req.params.id} returning *`
          : await tx`select * from orders.storage_locations where id = ${req.params.id}`;
        if (!row) throw notFound('Storage location');
        return row as never;
      });
    },
  );

  app.delete(
    '/storage-locations/:id',
    {
      schema: {
        tags: ['storage'],
        summary: 'Delete an empty storage location (deactivate it otherwise)',
        params: IdParams,
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      req.principal.require('logistics:write');
      await req.tx(async (tx) => {
        const [{ n }] = (await tx`select count(*)::int as n from orders.storage_items
                                  where storage_location_id = ${req.params.id} and status in ('stored', 'staged')`) as unknown as [
          { n: number },
        ];
        if (n) throw unprocessable('Location still holds items; move them or deactivate the location');
        const r = await tx`delete from orders.storage_locations where id = ${req.params.id} returning id`;
        if (!r.length) throw notFound('Storage location');
      });
      return reply.status(204).send(null);
    },
  );

  // ------------------------------------------------------------------ storage items
  app.get(
    '/storage-items',
    {
      schema: {
        tags: ['storage'],
        summary: 'Received goods by location and status (stored → staged → installed)',
        querystring: StorageItemsQuery,
        response: { 200: page(StorageItem) },
      },
    },
    async (req) => {
      req.principal.require('orders:read');
      const q = req.query;
      return req.tx(async (tx) => {
        const conds = [tx`true`];
        if (q.projectId) conds.push(tx`si.project_id = ${q.projectId}`);
        if (q.locationId) conds.push(tx`si.storage_location_id = ${q.locationId}`);
        if (q.poId) conds.push(tx`si.po_id = ${q.poId}`);
        if (q.status?.length) conds.push(tx`si.status in ${tx(q.status)}`);
        if (q.q) {
          const like = `%${q.q}%`;
          conds.push(
            tx`(l.code ilike ${like} or l.name ilike ${like} or p.number ilike ${like} or si.area_note ilike ${like})`,
          );
        }
        const where = conds.reduce((a, c) => tx`${a} and ${c}`);
        const rows = await tx<any[]>`
          select x.*, count(*) over ()::int as total_count from (${storageItemsSelect(tx)} where ${where}) x
          order by x.location_name nulls last, x.code limit ${q.limit} offset ${q.offset}`;
        return { items: rows, total: rows[0]?.totalCount ?? 0, limit: q.limit, offset: q.offset };
      });
    },
  );

  app.patch(
    '/storage-items/:id',
    {
      schema: {
        tags: ['storage'],
        summary: 'Stage, install, mark damaged or move stored goods (optionally only some units)',
        params: IdParams,
        body: StorageItemPatch,
        response: { 200: StorageItem },
      },
    },
    async (req) => {
      const p = req.principal;
      p.require('logistics:write');
      return req.tx(async (tx) => {
        const [item] = await tx<
          any[]
        >`select * from orders.storage_items where id = ${req.params.id} for update`;
        if (!item) throw notFound('Storage item');
        const b = req.body;
        if (b.storageLocationId) {
          const [loc] = await tx`select id from orders.storage_locations where id = ${b.storageLocationId}`;
          if (!loc) throw notFound('Storage location');
        }
        const target = await splitStorageItem(tx, item, b.quantity);
        const sets = Object.fromEntries(
          Object.entries({
            status: b.status,
            storageLocationId: b.storageLocationId,
            areaNote: b.areaNote,
            updatedByName: p.name,
          }).filter(([, v]) => v !== undefined),
        );
        await tx`update orders.storage_items set ${tx(sets as never)} where id = ${target}`;
        const [row] = await tx`select * from (${storageItemsSelect(tx)}) x where x.id = ${target}`;
        return row as never;
      });
    },
  );

  // ------------------------------------------------------------------ claims
  app.get(
    '/claims',
    {
      schema: {
        tags: ['claims'],
        summary: 'Damage, shortage and defect claims across projects',
        querystring: ClaimsQuery,
        response: { 200: page(Claim) },
      },
    },
    async (req) => {
      req.principal.require('orders:read');
      const q = req.query;
      return req.tx(async (tx) => {
        const conds = [tx`true`];
        if (q.status?.length) conds.push(tx`c.status in ${tx(q.status)}`);
        if (q.projectId) conds.push(tx`c.project_id = ${q.projectId}`);
        if (q.vendorId) conds.push(tx`c.vendor_id = ${q.vendorId}`);
        if (q.poId) conds.push(tx`c.po_id = ${q.poId}`);
        if (q.q) {
          const like = `%${q.q}%`;
          conds.push(tx`(c.number ilike ${like} or c.description ilike ${like} or p.number ilike ${like})`);
        }
        const where = conds.reduce((a, c) => tx`${a} and ${c}`);
        const rows = await tx<any[]>`
          select c.*, p.number as po_number, p.vendor_name, count(*) over ()::int as total_count
          from orders.claims c left join orders.purchase_orders p on p.id = c.po_id
          where ${where} order by c.reported_at desc limit ${q.limit} offset ${q.offset}`;
        return { items: rows, total: rows[0]?.totalCount ?? 0, limit: q.limit, offset: q.offset };
      });
    },
  );

  app.post(
    '/claims',
    {
      schema: {
        tags: ['claims'],
        summary: 'Open a claim against a PO (or a project, when the PO is not known yet)',
        body: ClaimCreateBody,
        response: { 201: Claim },
      },
    },
    async (req, reply) => {
      const p = req.principal;
      p.require('claims:write');
      const em = requestEmitter(req);
      const b = req.body;
      const claim = await req.tx(async (tx) => {
        const po = b.poId ? await getPo(tx, b.poId) : null;
        const projectId = po?.projectId ?? b.projectId;
        if (!projectId) throw unprocessable('projectId or poId is required');
        if (po && b.projectId && po.projectId !== b.projectId)
          throw unprocessable('PO belongs to another project');
        await assertClaimItems(tx, po?.id ?? null, b.items);
        const clientOrgId = po?.clientOrgId ?? (await clients.getProject(p.tenantId, projectId)).clientOrgId;
        const c = await openClaim(tx, em, {
          tenantId: p.tenantId,
          projectId,
          poId: po?.id ?? null,
          shipmentId: b.shipmentId ?? null,
          vendorId: po?.vendorId ?? null,
          vendorOrgId: po?.vendorOrgId ?? null,
          clientOrgId,
          type: b.type,
          description: b.description,
          reportedByName: p.name,
          reportedByActor: 'internal',
          photoDocumentIds: b.photoDocumentIds,
          creditAmount: b.creditAmount ?? null,
          items: b.items,
        });
        return loadClaim(tx, c.id);
      });
      return reply.status(201).send(claim);
    },
  );

  app.get(
    '/claims/:id',
    { schema: { tags: ['claims'], summary: 'Claim with items', params: IdParams, response: { 200: Claim } } },
    async (req) => {
      req.principal.require('orders:read');
      return req.tx((tx) => loadClaim(tx, req.params.id));
    },
  );

  app.patch(
    '/claims/:id',
    {
      schema: {
        tags: ['claims'],
        summary: 'Move a claim through its workflow; submitting to the vendor emails them',
        params: IdParams,
        body: ClaimPatchBody,
        response: { 200: Claim },
      },
    },
    async (req) => {
      const p = req.principal;
      p.require('claims:write');
      const em = requestEmitter(req);
      return req.tx(async (tx) => {
        const cur = await loadClaim(tx, req.params.id);
        const b = req.body;
        if (b.status && !canTransitionClaim(cur.status as ClaimStatus, b.status))
          throw unprocessable(`A claim cannot move from ${cur.status} to ${b.status}`);
        const closing = b.status && ['resolved', 'rejected', 'credited'].includes(b.status);
        await tx`update orders.claims set
                   status = coalesce(${b.status ?? null}, status),
                   resolution = case when ${b.resolution !== undefined} then ${b.resolution ?? null} else resolution end,
                   credit_amount = case when ${b.creditAmount !== undefined} then ${b.creditAmount ?? null}::numeric
                                        else credit_amount end,
                   description = coalesce(${b.description ?? null}, description),
                   resolved_at = case when ${!!closing} then now() when ${b.status === 'open'} then null else resolved_at end
                 where id = ${cur.id}`;
        if (b.status === 'submitted_to_vendor' && cur.poId) {
          const po = await getPo(tx, cur.poId);
          await emailVendor(tx, em, po, {
            subject: `Claim ${cur.number} on ${po.number}`,
            text: [
              `A ${String(cur.type).replace('_', ' ')} claim has been filed on purchase order ${po.number}.`,
              '',
              cur.description,
              '',
              ...cur.items.map(
                (i: any) =>
                  `  • ${i.code ?? ''} ${i.name ?? ''} — qty ${i.quantity}${i.note ? ` (${i.note})` : ''}`,
              ),
              '',
              `Please acknowledge and tell us how it will be resolved: ${vendorPortalLink(po.id)}`,
            ].join('\n'),
          });
        }
        return loadClaim(tx, cur.id);
      });
    },
  );

  app.get(
    '/claims/:id/activity',
    {
      schema: {
        tags: ['claims'],
        summary: 'Field-level activity for a claim',
        params: IdParams,
        response: { 200: z.array(ActivityEntry) },
      },
    },
    async (req) => {
      req.principal.require('orders:read');
      return req.tx(async (tx) => {
        await loadClaim(tx, req.params.id);
        return listActivity(tx, 'claim', req.params.id, { limit: 200 });
      });
    },
  );

  app.post(
    '/claims/:id/report',
    {
      schema: {
        tags: ['claims'],
        summary: 'Render the claim as a PDF',
        params: IdParams,
        response: { 200: DocumentResult },
      },
    },
    async (req) => {
      const p = req.principal;
      p.require('orders:read');
      const tenant = await tenantInfo(p);
      return req.tx(async (tx) => {
        const c = await loadClaim(tx, req.params.id);
        const [proj] = await tx<{ projectNumber: string | null; projectName: string | null }[]>`
          select project_number, project_name from orders.purchase_orders where project_id = ${c.projectId} limit 1`;
        return clients.renderReport({
          tenantId: p.tenantId,
          template: 'claim',
          data: {
            tenant,
            project: { number: proj?.projectNumber ?? null, name: proj?.projectName ?? null },
            claim: {
              number: c.number,
              type: c.type,
              status: c.status,
              description: c.description,
              reportedBy: c.reportedByName,
              reportedAt: c.reportedAt,
              poNumber: c.poNumber,
              vendor: c.vendorName,
            },
            items: c.items.map((i: any) => ({ code: i.code, name: i.name, qty: i.quantity, note: i.note })),
          },
          filename: `${c.number}.pdf`,
          entityType: 'claim',
          entityId: c.id,
          visibility: 'internal',
        });
      });
    },
  );

  // ------------------------------------------------------------------ calendar
  app.get(
    '/calendar',
    {
      schema: {
        tags: ['calendar'],
        summary: 'Logistics calendar: deliveries, ship dates and release-by dates across projects',
        querystring: CalendarQuery,
        response: { 200: CalendarResult },
      },
    },
    async (req) => {
      req.principal.require('orders:read');
      const { from, to, projectId, vendorId } = req.query;
      if (to < from) throw unprocessable('`to` must not be before `from`');
      return req.tx(async (tx) => {
        const scope = tx`p.status not in ('cancelled', 'closed')
          ${projectId ? tx`and p.project_id = ${projectId}` : tx``}
          ${vendorId ? tx`and p.vendor_id = ${vendorId}` : tx``}`;
        const ships = await tx<any[]>`
          select s.*, p.number as po_number, p.project_name, p.vendor_name, p.transit_days
          from orders.shipments s join orders.purchase_orders p on p.id = s.po_id
          where ${scope} and p.status <> 'draft'`;
        const pos = await tx<any[]>`
          select p.*, exists (select 1 from orders.pre_order_requirements r where r.po_id = p.id
                              and r.status in ('pending', 'submitted', 'rejected')) as has_pending
          from orders.purchase_orders p where ${scope} and p.release_by_date between ${from} and ${to}`;
        const events = [];
        const inRange = (d: string | null) => !!d && d >= from && d <= to;
        for (const s of ships) {
          const base = {
            poId: s.poId,
            poNumber: s.poNumber,
            shipmentId: s.id,
            shipmentLabel: s.label,
            projectId: s.projectId,
            projectName: s.projectName,
            vendorName: s.vendorName,
            escalation: s.escalation,
            status: s.status,
          };
          const delivered = s.deliveredAt ? String(s.deliveredAt).slice(0, 10) : null;
          if (delivered && inRange(delivered))
            events.push({
              ...base,
              date: delivered,
              kind: 'delivered' as const,
              title: `Delivered ${s.poNumber}-${s.label}`,
            });
          const eta =
            s.estimatedDeliveryDate ??
            (s.estimatedShipDate
              ? addDays(s.estimatedShipDate, s.transitDays ?? 5)
              : s.requestedDeliveryDate);
          if (!delivered && inRange(eta))
            events.push({
              ...base,
              date: eta!,
              kind: 'delivery' as const,
              title: `Delivery ${s.poNumber}-${s.label} · ${s.vendorName}`,
            });
          const ship = s.actualShipDate ?? s.estimatedShipDate;
          if (inRange(ship))
            events.push({
              ...base,
              date: ship!,
              kind: 'ship' as const,
              title: `Ships ${s.poNumber}-${s.label} · ${s.vendorName}`,
            });
        }
        for (const p of pos)
          events.push({
            date: p.releaseByDate,
            kind: 'release_by' as const,
            title: `Order-by ${p.number}${p.hasPending ? ' (requirements pending)' : ''}`,
            poId: p.id,
            poNumber: p.number,
            shipmentId: null,
            shipmentLabel: null,
            projectId: p.projectId,
            projectName: p.projectName,
            vendorName: p.vendorName,
            escalation: p.escalation,
            status: p.status,
          });
        events.sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind));
        return { from, to, events };
      });
    },
  );
}

export async function assertClaimItems(
  tx: Tx,
  poId: string | null,
  items: { poLineId: string; quantity: number }[],
) {
  if (!items.length) return;
  if (!poId) throw unprocessable('Claim items need a purchase order');
  const lines = await tx<{ id: string; quantity: number }[]>`
    select id, quantity from orders.po_lines where po_id = ${poId} and id in ${tx(items.map((i) => i.poLineId))}`;
  const bad = items.filter((i) => {
    const l = lines.find((x) => x.id === i.poLineId);
    return !l || i.quantity > l.quantity;
  });
  if (bad.length)
    throw unprocessable('Claim items must be lines on the PO and within the ordered quantity', {
      poLineIds: bad.map((b) => b.poLineId),
    });
}
