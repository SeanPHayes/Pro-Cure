import { page, round2 } from '@procure/domain';
import {
  ActivityEntry,
  type App,
  AppError,
  conflict,
  listActivity,
  notFound,
  orderBy,
  type Principal,
  type Tx,
  unprocessable,
  withTenant,
  z,
} from '@procure/platform';
import * as clients from '../clients.js';
import {
  bumpVersion,
  emailVendor,
  getPo,
  loadLines,
  loadPoDetail,
  markChanged,
  notifyOrderManagers,
  poRenderData,
  recalcTotals,
  recomputeEscalation,
  refreshReleaseBy,
  requestEmitter,
  snapshotOf,
  vendorPortalLink,
} from '../core.js';
import { allocationErrors } from '../domain/allocation.js';
import { today } from '../domain/dates.js';
import { transitDaysFor } from '../domain/release-by.js';
import { defaultRequirements } from '../domain/requirements.js';
import { type Change, diffSnapshots, type PoSnapshot } from '../domain/revision.js';
import { extended } from '../domain/totals.js';
import {
  CancelBody,
  DiffResult,
  DocumentResult,
  FromQuoteBody,
  IdParams,
  IssueBody,
  IssueResult,
  LineBody,
  LineParams,
  LinePatchBody,
  PoDetail,
  PoGridRow,
  PoListQuery,
  PoPatchBody,
} from '../schemas.js';

const TAGS = ['purchase-orders'];
const PENDING = ['pending', 'submitted', 'rejected'];
const EDITABLE_CLOSED = new Set(['cancelled', 'closed']);

const preconditionFailed = (current: number) =>
  new AppError(
    412,
    'precondition_failed',
    'The purchase order was changed by someone else; reload and retry',
    {
      version: current,
    },
  );

const parseIfMatch = (h: string | string[] | undefined): number | null => {
  const raw = Array.isArray(h) ? h[0] : h;
  if (!raw) return null;
  const n = Number(raw.replace(/^W\//, '').replace(/"/g, ''));
  return Number.isFinite(n) ? n : null;
};

/** Tenant letterhead for PDFs (identity org); falls back to the token's org name. */
export async function tenantInfo(p: Principal) {
  try {
    const o = await clients.getOrg(p, p.tenantId);
    return { name: o.name, address: o.address ?? {}, phone: o.phone, email: o.email };
  } catch {
    return { name: p.claims.orgName, address: {}, phone: null, email: null };
  }
}

/**
 * The vendor-visible PO thread in comms (created on first issue; idempotent), so vendor replies to PO emails land
 * on it. Looked up outside the DB transaction; failure only means the email goes out unthreaded.
 */
export async function poThread(p: Principal, poId: string): Promise<string | null> {
  const po = await withTenant(p.tenantId, async (tx) => {
    const [r] = await tx<{ number: string; vendorName: string; vendorOrgId: string | null }[]>`
      select number, vendor_name, vendor_org_id from orders.purchase_orders where id = ${poId}`;
    return r;
  });
  if (!po) return null;
  return clients.openThread({
    tenantId: p.tenantId,
    entityType: 'purchase_order',
    entityId: poId,
    subject: `PO ${po.number} — ${po.vendorName}`,
    visibility: 'vendor',
    vendorOrgId: po.vendorOrgId,
  });
}

/** Whether the PO differs from what the vendor last received. */
export async function refreshUnissued(tx: Tx, poId: string) {
  const po = await getPo(tx, poId);
  if (!po.lastIssuedSnapshot || po.status === 'draft') return false;
  const changes = diffSnapshots(po.lastIssuedSnapshot as PoSnapshot, await snapshotOf(tx, poId));
  const has = changes.length > 0;
  if (has !== po.hasUnissuedChanges)
    await tx`update orders.purchase_orders set has_unissued_changes = ${has} where id = ${poId}`;
  return has;
}

/** A PO with a single, not-yet-shipped shipment keeps that shipment allocated to the full order. */
async function syncSingleShipment(tx: Tx, poId: string) {
  const ships = await tx<{ id: string; status: string; tenantId: string }[]>`
    select id, status, tenant_id from orders.shipments where po_id = ${poId}`;
  if (ships.length !== 1 || ['shipped', 'in_transit', 'delivered'].includes(ships[0]!.status)) return;
  const sh = ships[0]!;
  await tx`delete from orders.shipment_lines sl where sl.shipment_id = ${sh.id}
           and not exists (select 1 from orders.po_lines l where l.id = sl.po_line_id)`;
  await tx`
    insert into orders.shipment_lines (tenant_id, shipment_id, po_line_id, quantity)
    select l.tenant_id, ${sh.id}, l.id, l.quantity from orders.po_lines l where l.po_id = ${poId}
    on conflict (shipment_id, po_line_id) do update set quantity = excluded.quantity`;
}

function assertEditable(po: { status: string }) {
  if (EDITABLE_CLOSED.has(po.status)) throw unprocessable(`A ${po.status} purchase order cannot be edited`);
}

export async function purchaseOrderRoutes(app: App) {
  // ------------------------------------------------------------------ create from quote
  app.post(
    '/purchase-orders/from-quote',
    {
      schema: {
        tags: TAGS,
        summary: 'Create draft purchase orders (one per vendor) from ready-to-order quote lines',
        body: FromQuoteBody,
        response: { 201: z.object({ items: z.array(PoDetail) }) },
      },
    },
    async (req, reply) => {
      const p = req.principal;
      p.require('orders:write');
      const { quoteId, lineIds, requestedDeliveryDate } = req.body;
      const ol = await clients.getOrderLines(p.tenantId, quoteId, lineIds);
      let lines = ol.lines;
      if (lineIds?.length) {
        const missing = lineIds.filter((id) => !lines.some((l) => l.id === id));
        if (missing.length) throw unprocessable('Some lines are not on this quote', { lineIds: missing });
        lines = lines.filter((l) => lineIds.includes(l.id));
      } else {
        // Whole quote: take what is ready and not yet ordered.
        lines = lines.filter((l) => l.readyToOrder && !l.poId);
      }
      if (!lines.length) throw unprocessable('No ready-to-order lines on this quote');

      const blocked = lines.filter((l) => !l.readyToOrder || l.poId);
      const already = await req.tx(
        (tx) =>
          tx<{ quoteLineId: string; number: string }[]>`
          select l.quote_line_id, p.number from orders.po_lines l join orders.purchase_orders p on p.id = l.po_id
          where l.quote_line_id in ${tx(lines.map((l) => l.id))} and p.status <> 'cancelled'`,
      );
      if (blocked.length || already.length)
        throw conflict('Some lines are not ready to order or are already on a purchase order', {
          lines: [
            ...blocked.map((l) => ({
              id: l.id,
              code: l.code,
              reason: l.poId ? 'already_ordered' : 'not_ready_to_order',
            })),
            ...already
              .filter((a) => !blocked.some((b) => b.id === a.quoteLineId))
              .map((a) => ({
                id: a.quoteLineId,
                code: lines.find((l) => l.id === a.quoteLineId)?.code ?? null,
                reason: `already_on_${a.number}`,
              })),
          ],
        });
      const noVendor = lines.filter((l) => !l.vendorId);
      if (noVendor.length)
        throw unprocessable('Every line needs a vendor before ordering', {
          codes: noVendor.map((l) => l.code),
        });

      const byVendor = new Map<string, typeof lines>();
      for (const l of lines) byVendor.set(l.vendorId!, [...(byVendor.get(l.vendorId!) ?? []), l]);
      const [project, vendors] = await Promise.all([
        clients.getProject(p.tenantId, ol.quote.projectId),
        Promise.all([...byVendor.keys()].map((v) => clients.getVendor(p.tenantId, v))),
      ]);
      const billTo = await tenantInfo(p);
      const em = requestEmitter(req);
      const orderManagers = project.team.filter((t) => t.role === 'order_manager');
      const c24 = orderManagers[0] ?? project.team.find((t) => t.role === 'project_manager') ?? null;
      const shipTo = {
        name: project.propertyName ?? project.name,
        ...((project.shipToAddress && Object.keys(project.shipToAddress).length
          ? project.shipToAddress
          : project.address) ?? {}),
      };
      const rdd = requestedDeliveryDate ?? project.targetOpenDate ?? null;

      const ids = await req.tx(async (tx) => {
        const created: string[] = [];
        // Project delivery recipients default from project contacts flagged as such (once per project).
        const [{ n }] = (await tx`select count(*)::int as n from orders.delivery_recipients
                                  where project_id = ${project.id}`) as unknown as [{ n: number }];
        if (!n)
          for (const c of project.contacts?.filter((x) => x.isDeliveryRecipient) ?? [])
            await tx`insert into orders.delivery_recipients (tenant_id, project_id, name, email, phone)
                     values (${p.tenantId}, ${project.id}, ${c.name}, ${c.email}, ${c.phone})`;

        for (const vendor of vendors) {
          const vLines = byVendor.get(vendor.id)!;
          const prof = vendor.profile;
          const origin = prof?.origin ?? 'domestic';
          const transit = transitDaysFor(origin, prof?.transitDays);
          const depositPct = prof?.depositPct ?? 0;
          const [{ number }] =
            (await tx`select platform.next_number(${p.tenantId}, 'PO') as number`) as unknown as [
              { number: string },
            ];
          const [po] = await tx<{ id: string; number: string }[]>`
            insert into orders.purchase_orders ${tx({
              tenantId: p.tenantId,
              projectId: project.id,
              projectNumber: project.number,
              projectName: project.name,
              clientOrgId: project.clientOrgId,
              quoteId,
              vendorId: vendor.id,
              vendorName: vendor.name,
              vendorOrgId: vendor.orgId,
              vendorContact: prof?.primaryContact ? tx.json(prof.primaryContact as never) : null,
              number,
              shipTo: tx.json(shipTo as never),
              billTo: tx.json({
                name: billTo.name,
                ...billTo.address,
                phone: billTo.phone,
                email: billTo.email,
              } as never),
              contact24h: c24 ? tx.json({ name: c24.name, email: c24.email, phone: null } as never) : null,
              paymentTerms: prof?.paymentTerms ?? null,
              freightTerms: prof?.freightTerms ?? null,
              shipMethod: prof?.shipMethod ?? null,
              depositPct,
              requestedDeliveryDate: rdd,
              leadTimeWeeks: prof?.leadTimeWeeks ?? null,
              transitDays: transit,
              origin,
              orderManagerIds: orderManagers.map((m) => m.userId) as never,
            } as never)}
            returning id, number`;
          const poId = po!.id;
          let sort = 0;
          for (const l of vLines) {
            const unitCost = l.unitCost ?? 0;
            await tx`insert into orders.po_lines ${tx({
              tenantId: p.tenantId,
              poId,
              quoteLineId: l.id,
              specId: l.specId,
              code: l.code,
              name: l.name,
              description: l.description,
              category: l.category,
              vendorSku: l.vendorSku,
              finish: l.finish,
              dimensions: l.dimensions,
              locationName: l.locationName,
              quantity: l.quantity,
              unitCost,
              extended: extended(l.quantity, unitCost),
              sort: sort++,
            } as never)}`;
          }
          let rs = 0;
          for (const r of defaultRequirements({ depositPct, categories: vLines.map((l) => l.category) }))
            await tx`insert into orders.pre_order_requirements (tenant_id, po_id, kind, label, party, sort)
                     values (${p.tenantId}, ${poId}, ${r.kind}, ${r.label}, ${r.party}, ${rs++})`;
          await tx`insert into orders.shipments (tenant_id, po_id, project_id, label, requested_delivery_date, origin,
                                                ship_method, destination)
                   values (${p.tenantId}, ${poId}, ${project.id}, 'A', ${rdd}, ${origin}, ${prof?.shipMethod ?? null}, 'site')`;
          await syncSingleShipment(tx, poId);
          await refreshReleaseBy(tx, poId);
          const totals = await recalcTotals(tx, poId);
          await em(tx, 'orders.po.created', {
            poId,
            projectId: project.id,
            vendorId: vendor.id,
            number: po!.number,
            total: totals.total,
            quoteId,
            quoteLineIds: vLines.map((l) => l.id),
          });
          created.push(poId);
        }
        return Promise.all(created.map((id) => loadPoDetail(tx, id)));
      });
      return reply.status(201).send({ items: ids as never });
    },
  );

  // ------------------------------------------------------------------ cross-portfolio grid
  app.get(
    '/purchase-orders',
    {
      schema: {
        tags: TAGS,
        summary:
          'Cross-portfolio order grid with pending requirements, next ship/delivery dates and escalation',
        querystring: PoListQuery,
        response: { 200: page(PoGridRow) },
      },
    },
    async (req) => {
      const p = req.principal;
      p.require('orders:read');
      const q = req.query;
      return req.tx(async (tx) => {
        const conds = [tx`true`];
        if (q.projectId) conds.push(tx`p.project_id = ${q.projectId}`);
        if (q.vendorId) conds.push(tx`p.vendor_id = ${q.vendorId}`);
        if (q.status?.length) conds.push(tx`p.status in ${tx(q.status)}`);
        else if (!q.includeClosed) conds.push(tx`p.status not in ('closed', 'cancelled')`);
        if (q.escalation?.length) conds.push(tx`p.escalation in ${tx(q.escalation)}`);
        if (q.pendingRequirements === true) conds.push(tx`r.pending > 0`);
        if (q.pendingRequirements === false) conds.push(tx`coalesce(r.pending, 0) = 0`);
        if (q.requirementKind) conds.push(tx`${q.requirementKind} = any(r.kinds)`);
        if (q.releaseByBefore) conds.push(tx`p.release_by_date <= ${q.releaseByBefore}`);
        if (q.shipsWithinDays !== undefined)
          conds.push(tx`sh.next_ship <= current_date + ${q.shipsWithinDays}::int`);
        if (q.deliversWithinDays !== undefined)
          conds.push(tx`sh.next_delivery <= current_date + ${q.deliversWithinDays}::int`);
        if (q.hasUnissuedChanges !== undefined)
          conds.push(tx`p.has_unissued_changes = ${q.hasUnissuedChanges}`);
        if (q.q) {
          const like = `%${q.q}%`;
          conds.push(
            tx`(p.number ilike ${like} or p.vendor_name ilike ${like} or p.project_name ilike ${like} or p.project_number ilike ${like})`,
          );
        }
        const where = conds.reduce((a, c) => tx`${a} and ${c}`);
        const order = orderBy(
          tx,
          q.sort,
          {
            number: 'p.number',
            releaseByDate: 'p.release_by_date',
            requestedDeliveryDate: 'p.requested_delivery_date',
            nextShipDate: 'sh.next_ship',
            total: 'p.total',
            vendorName: 'p.vendor_name',
            projectName: 'p.project_name',
            escalation: `array_position(array['none','watch','at_risk','critical']::text[], p.escalation)`,
            status: 'p.status',
            createdAt: 'p.created_at',
          },
          '-escalation',
        );
        const rows = await tx<any[]>`
          select p.*, coalesce(r.pending, 0)::int as pending_requirements, coalesce(r.kinds, '{}') as pending_kinds,
                 coalesce(sh.n, 0)::int as shipment_count, sh.next_ship, sh.next_delivery,
                 coalesce(sh.tracking_missing, 0)::int as tracking_missing,
                 count(*) over ()::int as total_count
          from orders.purchase_orders p
          left join lateral (
            select count(*) filter (where status in ${tx(PENDING)}) as pending,
                   array_agg(distinct kind) filter (where status in ${tx(PENDING)}) as kinds
            from orders.pre_order_requirements where po_id = p.id) r on true
          left join lateral (
            select count(*) as n,
                   min(estimated_ship_date) filter (where status not in ('shipped', 'in_transit', 'delivered')) as next_ship,
                   min(coalesce(estimated_delivery_date,
                                estimated_ship_date + coalesce(p.transit_days, 5),
                                requested_delivery_date)) filter (where status <> 'delivered') as next_delivery,
                   count(*) filter (where tracking_number is null and estimated_ship_date <= current_date - 2
                                    and status not in ('shipped', 'in_transit', 'delivered')) as tracking_missing
            from orders.shipments where po_id = p.id) sh on true
          where ${where}
          order by ${order}, p.release_by_date asc nulls last, p.number
          limit ${q.limit} offset ${q.offset}`;
        return {
          items: rows.map((r) => ({
            ...r,
            counts: {
              pendingRequirements: r.pendingRequirements,
              pendingRequirementKinds: r.pendingKinds ?? [],
              shipments: r.shipmentCount,
              nextShipDate: r.nextShip ?? null,
              nextDeliveryDate: r.nextDelivery ?? null,
              trackingMissing: r.trackingMissing,
            },
          })),
          total: rows[0]?.totalCount ?? 0,
          limit: q.limit,
          offset: q.offset,
        };
      });
    },
  );

  // ------------------------------------------------------------------ detail / edit
  app.get(
    '/purchase-orders/:id',
    {
      schema: {
        tags: TAGS,
        summary: 'Purchase order with lines, shipments, requirements, revisions and delivery recipients',
        params: IdParams,
        response: { 200: PoDetail },
      },
    },
    async (req, reply) => {
      req.principal.require('orders:read');
      const po = await req.tx((tx) => loadPoDetail(tx, req.params.id));
      reply.header('etag', `"${po.version}"`);
      return po as never;
    },
  );

  app.patch(
    '/purchase-orders/:id',
    {
      schema: {
        tags: TAGS,
        summary: 'Edit PO header (If-Match: version). Edits to an issued PO are held for a revision.',
        params: IdParams,
        headers: z.object({ 'if-match': z.string().optional() }).passthrough(),
        body: PoPatchBody,
        response: { 200: PoDetail },
      },
    },
    async (req, reply) => {
      req.principal.require('orders:write');
      const expected = parseIfMatch(req.headers['if-match']);
      const em = requestEmitter(req);
      const po = await req.tx(async (tx) => {
        const cur = await getPo(tx, req.params.id, true);
        if (expected !== null && expected !== cur.version) throw preconditionFailed(cur.version);
        assertEditable(cur);
        const b = req.body;
        const sets: Record<string, unknown> = {};
        const jsonKeys = new Set(['vendorContact', 'shipTo', 'billTo', 'contact24h']);
        for (const [k, v] of Object.entries(b)) {
          if (v === undefined) continue;
          sets[k] = jsonKeys.has(k) && v !== null ? tx.json(v as never) : v;
        }
        if (Object.keys(sets).length) {
          await tx`update orders.purchase_orders set ${tx(sets as never)} where id = ${cur.id}`;
          if (b.requestedDeliveryDate !== undefined)
            await tx`update orders.shipments set requested_delivery_date = ${b.requestedDeliveryDate}
                     where po_id = ${cur.id} and status <> 'delivered'
                       and requested_delivery_date is not distinct from ${cur.requestedDeliveryDate}`;
          if (b.origin !== undefined)
            await tx`update orders.shipments set origin = ${b.origin} where po_id = ${cur.id} and status <> 'delivered'`;
          await refreshReleaseBy(tx, cur.id);
          await recalcTotals(tx, cur.id);
          await refreshUnissued(tx, cur.id);
          await bumpVersion(tx, cur.id);
          await recomputeEscalation(tx, cur.id, em);
        }
        return loadPoDetail(tx, cur.id);
      });
      reply.header('etag', `"${po.version}"`);
      return po as never;
    },
  );

  // ------------------------------------------------------------------ lines
  app.post(
    '/purchase-orders/:id/lines',
    {
      schema: {
        tags: TAGS,
        summary: 'Add a line (on an issued PO this is held for the next revision)',
        params: IdParams,
        body: LineBody,
        response: { 201: PoDetail },
      },
    },
    async (req, reply) => {
      req.principal.require('orders:write');
      const em = requestEmitter(req);
      const po = await req.tx(async (tx) => {
        const cur = await getPo(tx, req.params.id, true);
        assertEditable(cur);
        const b = req.body;
        const [{ next }] = (await tx`select coalesce(max(sort) + 1, 0)::int as next from orders.po_lines
                                     where po_id = ${cur.id}`) as unknown as [{ next: number }];
        await tx`insert into orders.po_lines ${tx({
          tenantId: cur.tenantId,
          poId: cur.id,
          code: b.code,
          name: b.name,
          description: b.description ?? null,
          category: b.category ?? null,
          vendorSku: b.vendorSku ?? null,
          finish: b.finish ?? null,
          dimensions: b.dimensions ?? null,
          locationName: b.locationName ?? null,
          quantity: b.quantity,
          unitCost: b.unitCost,
          extended: extended(b.quantity, b.unitCost),
          sort: b.sort ?? next,
        } as never)}`;
        await syncSingleShipment(tx, cur.id);
        await recalcTotals(tx, cur.id);
        await markChanged(tx, cur);
        await refreshUnissued(tx, cur.id);
        await bumpVersion(tx, cur.id);
        await recomputeEscalation(tx, cur.id, em);
        return loadPoDetail(tx, cur.id);
      });
      return reply.status(201).send(po as never);
    },
  );

  app.patch(
    '/purchase-orders/:id/lines/:lineId',
    {
      schema: {
        tags: TAGS,
        summary: 'Edit a line (quantity, cost, description …)',
        params: LineParams,
        body: LinePatchBody,
        response: { 200: PoDetail },
      },
    },
    async (req) => {
      req.principal.require('orders:write');
      const em = requestEmitter(req);
      return req.tx(async (tx) => {
        const cur = await getPo(tx, req.params.id, true);
        assertEditable(cur);
        const [line] = await tx<
          any[]
        >`select * from orders.po_lines where id = ${req.params.lineId} and po_id = ${cur.id}`;
        if (!line) throw notFound('Line');
        const b = req.body;
        const qty = b.quantity ?? line.quantity;
        const cost = b.unitCost ?? line.unitCost;
        if (qty < line.receivedQty)
          throw unprocessable(`${line.code}: ${line.receivedQty} already received; quantity cannot be lower`);
        const allLines = await loadLines(tx, cur.id);
        const ships = await tx<{ id: string }[]>`select id from orders.shipments where po_id = ${cur.id}`;
        if (ships.length > 1) {
          const allocs = await tx<{ poLineId: string; quantity: number }[]>`
            select sl.po_line_id, sl.quantity from orders.shipment_lines sl
            join orders.shipments s on s.id = sl.shipment_id where s.po_id = ${cur.id}`;
          const errs = allocationErrors(
            allLines.map((l) => ({ id: l.id, code: l.code, quantity: l.id === line.id ? qty : l.quantity })),
            allocs,
          );
          if (errs.length)
            throw unprocessable('Reduce shipment allocations before lowering the quantity', { errors: errs });
        }
        const sets = Object.fromEntries(
          Object.entries({ ...b, extended: extended(qty, cost) }).filter(([, v]) => v !== undefined),
        );
        await tx`update orders.po_lines set ${tx(sets as never)} where id = ${line.id}`;
        await syncSingleShipment(tx, cur.id);
        await recalcTotals(tx, cur.id);
        await markChanged(tx, cur);
        await refreshUnissued(tx, cur.id);
        await bumpVersion(tx, cur.id);
        await recomputeEscalation(tx, cur.id, em);
        return loadPoDetail(tx, cur.id) as never;
      });
    },
  );

  app.delete(
    '/purchase-orders/:id/lines/:lineId',
    {
      schema: {
        tags: TAGS,
        summary: 'Remove a line (not allowed once any quantity is received)',
        params: LineParams,
        response: { 200: PoDetail },
      },
    },
    async (req) => {
      req.principal.require('orders:write');
      const em = requestEmitter(req);
      return req.tx(async (tx) => {
        const cur = await getPo(tx, req.params.id, true);
        assertEditable(cur);
        const [line] = await tx<
          any[]
        >`select * from orders.po_lines where id = ${req.params.lineId} and po_id = ${cur.id}`;
        if (!line) throw notFound('Line');
        if (line.receivedQty > 0) throw unprocessable(`${line.code} has been received and cannot be removed`);
        const [{ n }] =
          (await tx`select count(*)::int as n from orders.po_lines where po_id = ${cur.id}`) as unknown as [
            { n: number },
          ];
        if (n <= 1) throw unprocessable('A purchase order needs at least one line; cancel the PO instead');
        await tx`delete from orders.po_lines where id = ${line.id}`;
        await recalcTotals(tx, cur.id);
        await markChanged(tx, cur);
        await refreshUnissued(tx, cur.id);
        await bumpVersion(tx, cur.id);
        await recomputeEscalation(tx, cur.id, em);
        return loadPoDetail(tx, cur.id) as never;
      });
    },
  );

  // ------------------------------------------------------------------ issue / revise / cancel
  app.post(
    '/purchase-orders/:id/issue',
    {
      schema: {
        tags: TAGS,
        summary: 'Issue a draft PO: render the PDF, email it to the vendor with a portal link',
        params: IdParams,
        body: IssueBody,
        response: { 200: IssueResult },
      },
    },
    async (req) => {
      const p = req.principal;
      p.require('orders:issue');
      const em = requestEmitter(req);
      const [tenant, threadId] = await Promise.all([tenantInfo(p), poThread(req.principal, req.params.id)]);
      return req.tx(async (tx) => {
        const cur = await getPo(tx, req.params.id, true);
        if (cur.status !== 'draft')
          throw conflict(`${cur.number} is already ${cur.status}; issue a revision instead`);
        const lines = await loadLines(tx, cur.id);
        if (!lines.length) throw unprocessable('Add at least one line before issuing');
        await tx`update orders.purchase_orders set status = 'issued', order_date = ${today()}, issued_at = now(),
                   issued_by_name = ${p.name}, revision = 0, has_unissued_changes = false
                 where id = ${cur.id}`;
        const snap = await snapshotOf(tx, cur.id);
        await tx`update orders.purchase_orders set last_issued_snapshot = ${tx.json(snap as never)} where id = ${cur.id}`;
        const doc = await clients.renderReport({
          tenantId: p.tenantId,
          template: 'purchase_order',
          data: await poRenderData(tx, cur.id, tenant),
          filename: `${cur.number}.pdf`,
          entityType: 'purchase_order',
          entityId: cur.id,
          visibility: 'vendor',
          vendorOrgId: cur.vendorOrgId,
        });
        await tx`insert into orders.po_revisions (tenant_id, po_id, revision, changes, document_id, message, issued_by_name)
                 values (${cur.tenantId}, ${cur.id}, 0, '[]'::jsonb, ${doc.id}, ${req.body?.message ?? null}, ${p.name})`;
        await bumpVersion(tx, cur.id);
        const po = await getPo(tx, cur.id);
        await em(tx, 'orders.po.issued', {
          poId: cur.id,
          projectId: cur.projectId,
          vendorId: cur.vendorId,
          number: cur.number,
          revision: 0,
          total: po.total,
        });
        const emailed = await emailVendor(tx, em, po, {
          subject: `Purchase order ${po.number} — ${po.projectName ?? ''}`.trim(),
          text: [
            `Hello ${po.vendorContact?.name ?? ''},`.replace(/ ,$/, ','),
            '',
            `Please find attached purchase order ${po.number} from ${tenant.name} for ${po.projectName ?? 'our project'}.`,
            req.body?.message ? `\n${req.body.message}\n` : '',
            `Total: $${round2(po.total).toFixed(2)}. Requested delivery: ${po.requestedDeliveryDate ?? 'TBD'}.`,
            '',
            `Please acknowledge the order and confirm your ship date in the vendor portal:`,
            vendorPortalLink(po.id),
            '',
            `Thank you,`,
            p.name,
          ].join('\n'),
          attachments: [{ documentId: doc.id, filename: doc.filename ?? `${po.number}.pdf` }],
          threadId,
        });
        await recomputeEscalation(tx, cur.id, em);
        return { po: (await loadPoDetail(tx, cur.id)) as never, documentId: doc.id, emailed };
      });
    },
  );

  app.post(
    '/purchase-orders/:id/issue-revision',
    {
      schema: {
        tags: TAGS,
        summary:
          'Issue a revision: diff against what the vendor last received, render and email the change PDF',
        params: IdParams,
        body: IssueBody,
        response: { 200: IssueResult },
      },
    },
    async (req) => {
      const p = req.principal;
      p.require('orders:issue');
      const em = requestEmitter(req);
      const [tenant, threadId] = await Promise.all([tenantInfo(p), poThread(req.principal, req.params.id)]);
      return req.tx(async (tx) => {
        const cur = await getPo(tx, req.params.id, true);
        if (cur.status === 'draft') throw conflict(`${cur.number} has not been issued yet`);
        if (cur.status === 'cancelled') throw unprocessable(`${cur.number} is cancelled`);
        const snap = await snapshotOf(tx, cur.id);
        const changes = diffSnapshots(
          (cur.lastIssuedSnapshot ?? { header: {}, lines: [] }) as PoSnapshot,
          snap,
        );
        if (!changes.length) throw unprocessable('No changes since the last issued revision');
        const revision = cur.revision + 1;
        await tx`update orders.purchase_orders set revision = ${revision}, has_unissued_changes = false,
                   last_issued_snapshot = ${tx.json(snap as never)}
                 where id = ${cur.id}`;
        const doc = await clients.renderReport({
          tenantId: p.tenantId,
          template: 'po_revision',
          data: await poRenderData(tx, cur.id, tenant, changes),
          filename: `${cur.number}-R${revision}.pdf`,
          entityType: 'purchase_order',
          entityId: cur.id,
          visibility: 'vendor',
          vendorOrgId: cur.vendorOrgId,
        });
        await tx`insert into orders.po_revisions (tenant_id, po_id, revision, changes, document_id, message, issued_by_name)
                 values (${cur.tenantId}, ${cur.id}, ${revision}, ${tx.json(changes as never)}, ${doc.id},
                         ${req.body?.message ?? null}, ${p.name})`;
        await bumpVersion(tx, cur.id);
        const po = await getPo(tx, cur.id);
        await em(tx, 'orders.po.issued', {
          poId: cur.id,
          projectId: cur.projectId,
          vendorId: cur.vendorId,
          number: cur.number,
          revision,
          total: po.total,
        });
        const emailed = await emailVendor(tx, em, po, {
          subject: `Revised purchase order ${po.number} (revision ${revision})`,
          text: [
            `Purchase order ${po.number} for ${po.projectName ?? 'our project'} has been revised (revision ${revision}).`,
            req.body?.message ? `\n${req.body.message}\n` : '',
            'Changes:',
            ...changes.map((c) => `  • ${describeChange(c)}`),
            '',
            `Please review and confirm in the vendor portal: ${vendorPortalLink(po.id)}`,
          ].join('\n'),
          attachments: [{ documentId: doc.id, filename: doc.filename ?? `${po.number}-R${revision}.pdf` }],
          threadId,
        });
        await recomputeEscalation(tx, cur.id, em);
        return { po: (await loadPoDetail(tx, cur.id)) as never, documentId: doc.id, emailed, changes };
      });
    },
  );

  app.post(
    '/purchase-orders/:id/cancel',
    {
      schema: {
        tags: TAGS,
        summary: 'Cancel a PO (frees its quote lines; vendor is notified if it was issued)',
        params: IdParams,
        body: CancelBody,
        response: { 200: PoDetail },
      },
    },
    async (req) => {
      const p = req.principal;
      p.require('orders:issue');
      const em = requestEmitter(req);
      return req.tx(async (tx) => {
        const cur = await getPo(tx, req.params.id, true);
        if (cur.status === 'cancelled') return loadPoDetail(tx, cur.id) as never;
        const [{ n }] = (await tx`select count(*)::int as n from orders.shipments where po_id = ${cur.id}
                                  and status in ('shipped', 'in_transit', 'delivered')`) as unknown as [
          { n: number },
        ];
        if (n || ['delivered', 'closed'].includes(cur.status))
          throw unprocessable(`${cur.number} has shipped goods; open a claim or revise quantities instead`);
        await tx`update orders.purchase_orders set status = 'cancelled', cancelled_at = now(),
                   cancel_reason = ${req.body.reason ?? null}, escalation = 'none', escalation_reasons = '{}'
                 where id = ${cur.id}`;
        await bumpVersion(tx, cur.id);
        const quoteLineIds = (
          await tx<
            { quoteLineId: string | null }[]
          >`select quote_line_id from orders.po_lines where po_id = ${cur.id}`
        )
          .map((l) => l.quoteLineId)
          .filter((x): x is string => !!x);
        await em(tx, 'orders.po.cancelled', {
          poId: cur.id,
          projectId: cur.projectId,
          vendorId: cur.vendorId,
          number: cur.number,
          quoteId: cur.quoteId ?? null,
          quoteLineIds,
          reason: req.body.reason ?? null,
        });
        if (cur.status !== 'draft' && req.body.notifyVendor)
          await emailVendor(tx, em, cur, {
            subject: `Purchase order ${cur.number} cancelled`,
            text: `Purchase order ${cur.number} for ${cur.projectName ?? 'our project'} has been cancelled.${
              req.body.reason ? `\n\nReason: ${req.body.reason}` : ''
            }\n\nPlease stop production and confirm in the vendor portal: ${vendorPortalLink(cur.id)}`,
          });
        if (cur.status !== 'draft')
          await notifyOrderManagers(tx, em, cur, {
            title: `${cur.number} cancelled`,
            body: `${cur.vendorName} · ${req.body.reason ?? 'No reason given'}`,
            severity: 'warning',
          });
        return loadPoDetail(tx, cur.id) as never;
      });
    },
  );

  app.get(
    '/purchase-orders/:id/revisions/:rev/diff',
    {
      schema: {
        tags: TAGS,
        summary: 'Changes in a revision; the next revision number shows pending (unissued) changes',
        params: z.object({ id: z.uuid(), rev: z.coerce.number().int().min(0) }),
        response: { 200: DiffResult },
      },
    },
    async (req) => {
      req.principal.require('orders:read');
      return req.tx(async (tx) => {
        const po = await getPo(tx, req.params.id);
        if (req.params.rev === po.revision + 1 && po.status !== 'draft') {
          const changes = diffSnapshots(
            (po.lastIssuedSnapshot ?? { header: {}, lines: [] }) as PoSnapshot,
            await snapshotOf(tx, po.id),
          );
          return { revision: req.params.rev, pending: true, issuedAt: null, changes };
        }
        const [r] = await tx<
          any[]
        >`select * from orders.po_revisions where po_id = ${po.id} and revision = ${req.params.rev}`;
        if (!r) throw notFound('Revision');
        return { revision: r.revision, pending: false, issuedAt: r.issuedAt, changes: r.changes };
      });
    },
  );

  app.get(
    '/purchase-orders/:id/activity',
    {
      schema: {
        tags: TAGS,
        summary: 'Field-level activity for the PO and its lines, shipments, requirements and claims',
        params: IdParams,
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(1000).default(200) }),
        response: { 200: z.array(ActivityEntry) },
      },
    },
    async (req) => {
      req.principal.require('orders:read');
      return req.tx(async (tx) => {
        await getPo(tx, req.params.id);
        return listActivity(tx, 'purchase_order', req.params.id, {
          includeChildren: true,
          limit: req.query.limit,
        });
      });
    },
  );

  app.post(
    '/purchase-orders/:id/report',
    {
      schema: {
        tags: TAGS,
        summary: 'Render the current PO as a PDF (internal copy)',
        params: IdParams,
        response: { 200: DocumentResult },
      },
    },
    async (req) => {
      const p = req.principal;
      p.require('orders:read');
      const tenant = await tenantInfo(p);
      return req.tx(async (tx) => {
        const po = await getPo(tx, req.params.id);
        return clients.renderReport({
          tenantId: p.tenantId,
          template: 'purchase_order',
          data: await poRenderData(tx, po.id, tenant),
          filename: `${po.number}${po.revision ? `-R${po.revision}` : ''}.pdf`,
          entityType: 'purchase_order',
          entityId: po.id,
          visibility: 'internal',
        });
      });
    },
  );
}

const LABELS: Record<string, string> = {
  requestedDeliveryDate: 'Requested delivery',
  releaseByDate: 'Release-by date',
  shipTo: 'Ship-to',
  billTo: 'Bill-to',
  contact24h: '24-hour contact',
  paymentTerms: 'Payment terms',
  freightTerms: 'Freight terms',
  shipMethod: 'Ship method',
  depositPct: 'Deposit %',
  vendorNotes: 'Notes',
  freight: 'Freight',
  tax: 'Tax',
  total: 'Total',
  quantity: 'quantity',
  unitCost: 'unit cost',
  extended: 'extended',
  name: 'name',
  description: 'description',
  finish: 'finish',
};
const show = (v: unknown) =>
  v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v);
export const describeChange = (c: Change) =>
  c.field === 'line_added'
    ? `Added ${c.lineCode}: ${show(c.to)}`
    : c.field === 'line_removed'
      ? `Removed ${c.lineCode}: ${show(c.from)}`
      : `${c.lineCode ? `${c.lineCode} ` : ''}${LABELS[c.field] ?? c.field}: ${show(c.from)} → ${show(c.to)}`;
