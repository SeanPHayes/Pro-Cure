import { type App, notFound, withTenant } from '@procure/platform';
import { recomputeEscalation, systemEmitter } from '../core.js';
import { normalizeRiskLevel, rank } from '../domain/escalation.js';
import { DEFAULT_PARTY, REQUIREMENT_LABELS } from '../domain/requirements.js';
import { afterRequirementsChanged, applyTracking, changeShipDate, setRequirementStatus } from '../ops.js';
import { InternalRequirementBody, RiskScoresBody, TenantQuery, TrackingBody, z } from './_shared.js';

/** Service-to-service endpoints (x-procure-internal). Tenant comes from the query and is enforced by RLS. */
const internal = { config: { internal: true } } as const;
const PENDING = ['pending', 'submitted', 'rejected'];

export async function internalRoutes(app: App) {
  app.get(
    '/internal/purchase-orders/summary',
    {
      ...internal,
      schema: {
        hide: true,
        querystring: TenantQuery.extend({ projectId: z.uuid().optional() }),
      },
    },
    async (req) =>
      withTenant(req.query.tenantId, async (tx) => ({
        pos: await tx`
          select id, number, vendor_id, vendor_name, status, total, issued_at, revision, escalation
          from orders.purchase_orders
          where true ${req.query.projectId ? tx`and project_id = ${req.query.projectId}` : tx``}
          order by number`,
      })),
  );

  app.get(
    '/internal/purchase-orders/open',
    {
      ...internal,
      schema: { hide: true, querystring: TenantQuery.extend({ vendorId: z.uuid().optional() }) },
    },
    async (req) =>
      withTenant(
        req.query.tenantId,
        (tx) => tx`
          select id, number, project_id, project_name, vendor_id, vendor_name, vendor_org_id, status, revision
          from orders.purchase_orders
          where status not in ('draft', 'delivered', 'closed', 'cancelled')
            ${req.query.vendorId ? tx`and vendor_id = ${req.query.vendorId}` : tx``}
          order by number`,
      ),
  );

  app.get(
    '/internal/purchase-orders/:id',
    { ...internal, schema: { hide: true, params: z.object({ id: z.uuid() }), querystring: TenantQuery } },
    async (req) =>
      withTenant(req.query.tenantId, async (tx) => {
        const [po] = await tx`
          select id, number, project_id, project_name, vendor_id, vendor_name, vendor_org_id, client_org_id, status,
                 revision, deposit_pct, total, issued_at, quote_id
          from orders.purchase_orders where id = ${req.params.id}`;
        if (!po) throw notFound('Purchase order');
        return po;
      }),
  );

  app.get(
    '/internal/shipments/open',
    { ...internal, schema: { hide: true, querystring: TenantQuery } },
    async (req) =>
      withTenant(req.query.tenantId, async (tx) => {
        const rows = await tx<any[]>`
          select s.id as shipment_id, s.id, s.po_id, p.number as po_number, p.project_id, p.project_name, p.vendor_id,
                 p.vendor_name, s.label, coalesce(s.origin, p.origin) as origin,
                 coalesce(s.requested_delivery_date, p.requested_delivery_date) as requested_delivery_date,
                 s.estimated_ship_date, s.original_ship_date, s.estimated_delivery_date,
                 coalesce(p.transit_days, case when p.origin = 'international' then 35 else 5 end) as transit_days,
                 p.lead_time_weeks, p.release_by_date,
                 (select count(*)::int from orders.pre_order_requirements r
                   where r.po_id = p.id and r.status in ${tx(PENDING)}) as pending_requirements,
                 s.ship_date_changes, s.last_confirmed_at,
                 case when s.last_confirmed_at is null then null
                      else (current_date - s.last_confirmed_at::date) end as days_since_confirmation,
                 s.status, (s.tracking_number is not null) as has_tracking, p.issued_at, p.order_date as ordered_at
          from orders.shipments s join orders.purchase_orders p on p.id = s.po_id
          where p.status not in ('draft', 'cancelled', 'closed') and s.status <> 'delivered'
          order by s.estimated_ship_date nulls last`;
        return rows;
      }),
  );

  app.get(
    '/internal/shipments/history',
    { ...internal, schema: { hide: true, querystring: TenantQuery } },
    async (req) =>
      withTenant(
        req.query.tenantId,
        (tx) => tx`
          select p.vendor_id, coalesce(s.origin, p.origin) as origin,
                 coalesce(s.original_ship_date, s.estimated_ship_date) as planned_ship_date, s.actual_ship_date,
                 coalesce(s.requested_delivery_date, p.requested_delivery_date) as requested_delivery_date,
                 s.delivered_at, s.ship_date_changes, p.lead_time_weeks, p.order_date as ordered_at
          from orders.shipments s join orders.purchase_orders p on p.id = s.po_id
          where s.status = 'delivered'
          order by s.delivered_at desc limit 5000`,
      ),
  );

  app.post(
    '/internal/risk-scores',
    { ...internal, schema: { hide: true, querystring: TenantQuery, body: RiskScoresBody } },
    async (req) => {
      const tenantId = req.query.tenantId;
      const em = systemEmitter(tenantId);
      return withTenant(tenantId, async (tx) => {
        const touched = new Set<string>();
        let updated = 0;
        for (const s of req.body.scores) {
          const level = normalizeRiskLevel(s.level) ?? 'none';
          const r = await tx<{ poId: string }[]>`
            update orders.shipments set risk_score = ${Math.round(s.score)}, risk_level = ${level},
              risk_reasons = ${s.reasons}::text[], risk_scored_at = now()
            where id = ${s.shipmentId} returning po_id`;
          if (r[0]) {
            touched.add(r[0].poId);
            updated++;
          }
        }
        const escalated: { poId: string; from: string; to: string }[] = [];
        for (const poId of touched) {
          // Roll up: the PO carries its riskiest open shipment's score.
          const [top] = await tx<any[]>`
            select risk_score, risk_level, risk_reasons from orders.shipments
            where po_id = ${poId} and status <> 'delivered' and risk_level is not null
            order by array_position(array['none','watch','at_risk','critical']::text[], risk_level) desc, risk_score desc
            limit 1`;
          await tx`update orders.purchase_orders set risk_score = ${top?.riskScore ?? null},
                     risk_level = ${top?.riskLevel ?? null}, risk_reasons = ${top?.riskReasons ?? []}::text[],
                     risk_scored_at = now()
                   where id = ${poId}`;
          const r = await recomputeEscalation(tx, poId, em);
          if (rank(r.after) > rank(r.before)) escalated.push({ poId, from: r.before, to: r.after });
        }
        return { updated, purchaseOrders: touched.size, escalated };
      });
    },
  );

  app.post(
    '/internal/shipments/:id/tracking',
    {
      ...internal,
      schema: {
        hide: true,
        params: z.object({ id: z.uuid() }),
        querystring: TenantQuery,
        body: TrackingBody,
      },
    },
    async (req) => {
      const tenantId = req.query.tenantId;
      return withTenant(tenantId, async (tx) => {
        const s = await applyTracking(tx, systemEmitter(tenantId), req.params.id, req.body);
        if (!s) throw notFound('Shipment');
        return { id: s.id, status: s.status, carrier: s.carrier, trackingNumber: s.trackingNumber };
      });
    },
  );

  app.post(
    '/internal/shipments/ship-date',
    {
      ...internal,
      schema: {
        hide: true,
        querystring: TenantQuery,
        body: z.object({
          shipmentId: z.uuid().optional(),
          /** When only the PO is known (e.g. from an email), the earliest open shipment is used. */
          poId: z.uuid().optional(),
          newShipDate: z.iso.date(),
          note: z.string().max(2000).optional(),
        }),
      },
    },
    async (req) => {
      const tenantId = req.query.tenantId;
      const b = req.body;
      if (!b.shipmentId && !b.poId) throw notFound('Shipment');
      return withTenant(tenantId, async (tx) => {
        const [sh] = await tx<{ id: string; poId: string; projectId: string; estimatedShipDate: string | null }[]>`
          select id, po_id, project_id, estimated_ship_date from orders.shipments
          where ${b.shipmentId ? tx`id = ${b.shipmentId}` : tx`po_id = ${b.poId!} and status not in ('shipped', 'in_transit', 'delivered')`}
          order by estimated_ship_date nulls last, label limit 1`;
        if (!sh) throw notFound('Open shipment');
        await changeShipDate(tx, systemEmitter(tenantId), sh, b.newShipDate, 'vendor');
        await tx`insert into orders.ship_date_confirmations
                   (tenant_id, shipment_id, requested_at, responded_at, response, previous_date, new_date, note, channel, responded_by_name)
                 values (${tenantId}, ${sh.id}, now(), now(), 'changed', ${sh.estimatedShipDate}, ${b.newShipDate},
                         ${b.note ?? 'From vendor email'}, 'email', 'Vendor (email)')`;
        await recomputeEscalation(tx, sh.poId, systemEmitter(tenantId));
        return { shipmentId: sh.id, previous: sh.estimatedShipDate, current: b.newShipDate };
      });
    },
  );

  app.post(
    '/internal/purchase-orders/:id/requirements',
    {
      ...internal,
      schema: {
        hide: true,
        params: z.object({ id: z.uuid() }),
        querystring: TenantQuery,
        body: InternalRequirementBody,
      },
    },
    async (req) => {
      const tenantId = req.query.tenantId;
      const em = systemEmitter(tenantId);
      const b = req.body;
      return withTenant(tenantId, async (tx) => {
        const [po] = await tx<{ id: string; tenantId: string }[]>`
          select id, tenant_id from orders.purchase_orders where id = ${req.params.id}`;
        if (!po) throw notFound('Purchase order');
        let [r] = await tx<{ id: string }[]>`
          select id from orders.pre_order_requirements where po_id = ${po.id} and kind = ${b.kind} order by sort limit 1`;
        if (!r)
          [r] = await tx<{ id: string }[]>`
            insert into orders.pre_order_requirements (tenant_id, po_id, kind, label, party, sort)
            values (${po.tenantId}, ${po.id}, ${b.kind}, ${REQUIREMENT_LABELS[b.kind]}, ${DEFAULT_PARTY[b.kind]},
                    (select coalesce(max(sort) + 1, 0) from orders.pre_order_requirements where po_id = ${po.id}))
            returning id`;
        const row = await setRequirementStatus(tx, em, r!.id, b.status, {
          actorName: 'Pro-Cure',
          documentId: b.documentId,
          note: b.note,
        });
        await afterRequirementsChanged(tx, em, po.id);
        return row;
      });
    },
  );
}
