import { type App, forbidden, notFound, type Principal, type Tx, unprocessable } from '@procure/platform';
import { asService, getPo, notifyOrderManagers, requestEmitter } from '../core.js';
import { afterRequirementsChanged, openClaim, setRequirementStatus } from '../ops.js';
import {
  ClientClaim,
  ClientClaimBody,
  ClientClaimsQuery,
  ClientOrders,
  ClientRequirement,
  ClientRequirementsQuery,
  ClientStorage,
  ClientStorageItem,
  ClientStoragePatch,
  DecisionBody,
  IdParams,
  ProjectParams,
  z,
} from './_shared.js';
import { splitStorageItem, storageItemsSelect } from './logistics.js';

/**
 * Owner (client) portal. Queries run under the client's RLS (POs and claims where client_org_id = their org).
 * Responses use client schemas: no cost, unit cost, totals, vendor terms, internal notes or risk scoring.
 */
const TAGS = ['client-portal'];

const guard = (
  p: Principal,
  perm: 'client:view' | 'client:approve' | 'client:manage_storage' | 'client:report_claims',
) => {
  if (!p.isClient) throw forbidden('Owner portal only');
  p.require(perm);
};

async function clientClaim(tx: Tx, id: string) {
  const [c] = await tx<any[]>`
    select c.*, p.number as po_number, p.vendor_name from orders.claims c
    left join orders.purchase_orders p on p.id = c.po_id where c.id = ${id}`;
  if (!c) throw notFound('Claim');
  c.items = await tx`
    select l.code, l.name, ci.quantity, ci.note from orders.claim_items ci
    left join orders.po_lines l on l.id = ci.po_line_id where ci.claim_id = ${id}`;
  return c;
}

export async function clientPortalRoutes(app: App) {
  app.get(
    '/client/projects/:projectId/orders',
    {
      schema: {
        tags: TAGS,
        summary:
          'Orders on your project: items, shipments with ETA and tracking, delivered and received counts',
        params: ProjectParams,
        response: { 200: ClientOrders },
      },
    },
    async (req) => {
      guard(req.principal, 'client:view');
      return req.tx(async (tx) => {
        const pos = await tx<any[]>`
          select p.*,
            (select count(*)::int from orders.pre_order_requirements r where r.po_id = p.id and r.party = 'client'
               and r.status in ('pending', 'submitted')) as pending_approvals
          from orders.purchase_orders p
          where p.project_id = ${req.params.projectId} and p.status <> 'cancelled'
          order by p.number`;
        if (!pos.length) return { projectId: req.params.projectId, items: [] };
        const ids = pos.map((p) => p.id);
        const lines = await tx<
          any[]
        >`select * from orders.po_lines where po_id in ${tx(ids)} order by sort, code`;
        const ships = await tx<
          any[]
        >`select * from orders.shipments where po_id in ${tx(ids)} order by label`;
        const sl = ships.length
          ? await tx<any[]>`
              select sl.shipment_id, l.code, l.name, sl.quantity from orders.shipment_lines sl
              join orders.po_lines l on l.id = sl.po_line_id where sl.shipment_id in ${tx(ships.map((s) => s.id))}`
          : [];
        return {
          projectId: req.params.projectId,
          items: pos.map((p) => {
            const items = lines.filter((l) => l.poId === p.id);
            const shipments = ships
              .filter((s) => s.poId === p.id)
              .map((s) => ({
                ...s,
                estimatedDeliveryDate: s.estimatedDeliveryDate ?? s.requestedDeliveryDate,
                items: sl.filter((x) => x.shipmentId === s.id),
              }));
            const orderedCount = items.reduce((a, l) => a + l.quantity, 0);
            const deliveredCount = shipments
              .filter((s) => s.status === 'delivered')
              .reduce((a, s) => a + s.items.reduce((b: number, i: any) => b + i.quantity, 0), 0);
            return {
              ...p,
              items,
              shipments,
              orderedCount,
              deliveredCount,
              receivedCount: items.reduce((a, l) => a + l.receivedQty, 0),
              pendingApprovals: p.pendingApprovals,
            };
          }),
        };
      });
    },
  );

  app.get(
    '/client/requirements',
    {
      schema: {
        tags: TAGS,
        summary: 'Submittals waiting for your approval (shop drawings, finish samples)',
        querystring: ClientRequirementsQuery,
        response: { 200: z.array(ClientRequirement) },
      },
    },
    async (req) => {
      guard(req.principal, 'client:view');
      const q = req.query;
      return req.tx(async (tx) => {
        const rows = await tx<any[]>`
          select r.*, p.number as po_number, p.project_id, p.project_name, p.vendor_name
          from orders.pre_order_requirements r join orders.purchase_orders p on p.id = r.po_id
          where r.party = 'client' and p.status <> 'cancelled'
            ${q.projectId ? tx`and p.project_id = ${q.projectId}` : tx``}
            ${q.status?.length ? tx`and r.status in ${tx(q.status)}` : tx`and r.status in ('pending', 'submitted')`}
          order by (r.status = 'submitted') desc, coalesce(r.due_date, p.release_by_date) nulls last, p.number`;
        if (!rows.length) return [];
        const lines = await tx<any[]>`
          select po_id, code, name, quantity, category from orders.po_lines
          where po_id in ${tx([...new Set(rows.map((r) => r.poId))])} order by sort, code`;
        return rows.map((r) => ({ ...r, items: lines.filter((l) => l.poId === r.poId) }));
      });
    },
  );

  app.post(
    '/client/requirements/:id/decision',
    {
      schema: {
        tags: TAGS,
        summary: 'Approve or reject a submittal',
        params: IdParams,
        body: DecisionBody,
        response: { 200: ClientRequirement },
      },
    },
    async (req) => {
      const p = req.principal;
      guard(p, 'client:approve');
      const em = requestEmitter(req);
      return req.tx(async (tx) => {
        const [r] = await tx<any[]>`
          select r.*, p.number as po_number, p.project_id, p.project_name, p.vendor_name
          from orders.pre_order_requirements r join orders.purchase_orders p on p.id = r.po_id
          where r.id = ${req.params.id} and r.party = 'client'`;
        if (!r) throw notFound('Approval');
        if (r.status === 'approved' || r.status === 'waived') throw unprocessable(`Already ${r.status}`);
        // client_update policy: only client-party requirements on the owner's POs.
        await setRequirementStatus(tx, em, r.id, req.body.decision, {
          actorName: p.name,
          note: req.body.note ?? r.note,
        });
        await asService(tx, p, async () => {
          await afterRequirementsChanged(tx, em, r.poId);
          const po = await getPo(tx, r.poId);
          await notifyOrderManagers(tx, em, po, {
            title: `${p.name} ${req.body.decision} ${r.label} for ${po.number}`,
            body: req.body.note ?? `${po.vendorName} · ${po.projectName ?? ''}`,
            severity: req.body.decision === 'approved' ? 'success' : 'warning',
          });
        });
        const [row] = await tx<any[]>`
          select r.*, p.number as po_number, p.project_id, p.project_name, p.vendor_name
          from orders.pre_order_requirements r join orders.purchase_orders p on p.id = r.po_id where r.id = ${r.id}`;
        const items = await tx<
          any[]
        >`select code, name, quantity from orders.po_lines where po_id = ${r.poId} order by sort`;
        return { ...row, items };
      });
    },
  );

  app.get(
    '/client/projects/:projectId/storage',
    {
      schema: {
        tags: TAGS,
        summary: 'Received goods on your project by location and status',
        params: ProjectParams,
        response: { 200: ClientStorage },
      },
    },
    async (req) => {
      guard(req.principal, 'client:view');
      return req.tx(async (tx) => {
        const rows = await tx<
          any[]
        >`select * from (${storageItemsSelect(tx)}) x where x.project_id = ${req.params.projectId}
                                     order by x.location_name nulls last, x.code`;
        const locations = new Map<
          string,
          { id: string | null; name: string; kind: string | null; items: any[] }
        >();
        const totals: Record<string, number> = {};
        for (const r of rows) {
          const key = r.storageLocationId ?? 'none';
          if (!locations.has(key))
            locations.set(key, {
              id: r.storageLocationId,
              name: r.locationName ?? 'Unassigned',
              kind: r.locationKind ?? null,
              items: [],
            });
          locations.get(key)!.items.push(r);
          totals[r.status] = (totals[r.status] ?? 0) + r.quantity;
        }
        return { projectId: req.params.projectId, locations: [...locations.values()], totals };
      });
    },
  );

  app.patch(
    '/client/storage-items/:id',
    {
      schema: {
        tags: TAGS,
        summary: 'Mark items staged or installed and note where (e.g. "Room 412")',
        params: IdParams,
        body: ClientStoragePatch,
        response: { 200: ClientStorageItem },
      },
    },
    async (req) => {
      const p = req.principal;
      guard(p, 'client:manage_storage');
      return req.tx(async (tx) => {
        const [item] = await tx<
          any[]
        >`select * from orders.storage_items where id = ${req.params.id} for update`;
        if (!item) throw notFound('Storage item');
        if (item.status === 'damaged' || item.status === 'in_transit')
          throw unprocessable(`Items that are ${item.status.replace('_', ' ')} cannot be updated here`);
        const b = req.body;
        // Splitting off part of a row inserts a new one: storage_items has no client insert policy, so do it as
        // service after the RLS check above; the update below runs under the owner's own policy.
        const target = b.quantity
          ? await asService(tx, p, () => splitStorageItem(tx, item, b.quantity))
          : item.id;
        const sets = Object.fromEntries(
          Object.entries({ status: b.status, areaNote: b.areaNote, updatedByName: p.name }).filter(
            ([, v]) => v !== undefined,
          ),
        );
        await tx`update orders.storage_items set ${tx(sets as never)} where id = ${target}`;
        const [row] = await tx`select * from (${storageItemsSelect(tx)}) x where x.id = ${target}`;
        return row as never;
      });
    },
  );

  app.get(
    '/client/claims',
    {
      schema: {
        tags: TAGS,
        summary: 'Claims on your projects',
        querystring: ClientClaimsQuery,
        response: { 200: z.array(ClientClaim) },
      },
    },
    async (req) => {
      guard(req.principal, 'client:view');
      const q = req.query;
      return req.tx(
        (tx) =>
          tx`
          select c.*, p.number as po_number, p.vendor_name from orders.claims c
          left join orders.purchase_orders p on p.id = c.po_id
          where true
            ${q.projectId ? tx`and c.project_id = ${q.projectId}` : tx``}
            ${q.status?.length ? tx`and c.status in ${tx(q.status)}` : tx``}
          order by c.reported_at desc limit 500` as never,
      );
    },
  );

  app.get(
    '/client/claims/:id',
    { schema: { tags: TAGS, summary: 'Claim detail', params: IdParams, response: { 200: ClientClaim } } },
    async (req) => {
      guard(req.principal, 'client:view');
      return req.tx((tx) => clientClaim(tx, req.params.id));
    },
  );

  app.post(
    '/client/claims',
    {
      schema: {
        tags: TAGS,
        summary: 'Report damaged, missing or wrong items',
        body: ClientClaimBody,
        response: { 201: ClientClaim },
      },
    },
    async (req, reply) => {
      const p = req.principal;
      guard(p, 'client:report_claims');
      const em = requestEmitter(req);
      const b = req.body;
      const claim = await req.tx(async (tx) => {
        // The owner must be able to see the PO (or at least one PO on the project) under their own RLS.
        const [po] = b.poId
          ? await tx<any[]>`select * from orders.purchase_orders where id = ${b.poId}`
          : await tx<any[]>`select * from orders.purchase_orders where project_id = ${b.projectId} limit 1`;
        if (!po || po.projectId !== b.projectId) throw notFound(b.poId ? 'Order' : 'Project');
        if (b.items.length) {
          if (!b.poId) throw unprocessable('Choose the order the items belong to');
          const lines = await tx<{ id: string; quantity: number }[]>`
            select id, quantity from orders.po_lines where po_id = ${po.id} and id in ${tx(b.items.map((i) => i.poLineId))}`;
          const bad = b.items.filter(
            (i) => !lines.some((l) => l.id === i.poLineId && i.quantity <= l.quantity),
          );
          if (bad.length)
            throw unprocessable('Items must be on the order', { poLineIds: bad.map((x) => x.poLineId) });
        }
        // Validated above under the owner's RLS; the claim, its number and items are written as service so the
        // audit log still names the owner (user id/name) while the derived fields stay server-controlled.
        const c = await asService(tx, p, () =>
          openClaim(tx, em, {
            tenantId: p.tenantId,
            projectId: b.projectId,
            poId: b.poId ?? null,
            vendorId: b.poId ? po.vendorId : null,
            vendorOrgId: b.poId ? po.vendorOrgId : null,
            clientOrgId: p.orgId,
            type: b.type,
            description: b.description,
            reportedByName: p.name,
            reportedByActor: 'client',
            photoDocumentIds: b.photoDocumentIds,
            items: b.items,
          }),
        );
        await asService(tx, p, () =>
          notifyOrderManagers(tx, em, po, {
            title: `${p.claims.orgName} reported a ${b.type.replace('_', ' ')} claim (${c.number})`,
            body: `${b.poId ? `${po.number} · ${po.vendorName} — ` : ''}${b.description.slice(0, 300)}`,
            severity: 'warning',
            link: `/app/claims/${c.id}`,
          }),
        );
        return clientClaim(tx, c.id);
      });
      return reply.status(201).send(claim);
    },
  );
}
