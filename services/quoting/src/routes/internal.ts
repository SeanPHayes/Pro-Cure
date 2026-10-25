import { type App, notFound, withTenant, z } from '@procure/platform';
import { headerTotals, locationTree, type QuoteRow } from '../repo.js';
import { TenantQuery } from '../schemas.js';
import { importSpecs } from './specs.js';

const ids = (s?: string) =>
  s
    ?.split(',')
    .map((x) => x.trim())
    .filter(Boolean) ?? [];
const uuidList = z
  .string()
  .optional()
  .refine((s) => ids(s).every((x) => /^[0-9a-f-]{36}$/i.test(x)), 'comma-separated uuids');

/** Service-to-service endpoints (contracts in docs/service-contracts.md). */
export async function internalRoutes(app: App) {
  app.get(
    '/internal/quotes/:id/order-lines',
    {
      config: { internal: true },
      schema: {
        hide: true,
        params: z.object({ id: z.uuid() }),
        querystring: TenantQuery.extend({ lineIds: uuidList }),
      },
    },
    async (req) =>
      withTenant(req.query.tenantId, async (tx) => {
        const [q] = await tx<QuoteRow[]>`select * from quoting.quotes where id = ${req.params.id}`;
        if (!q) throw notFound('Quote');
        const lineIds = ids(req.query.lineIds);
        const paths = new Map((await locationTree(tx, q.id)).map((l) => [l.id, l.path]));
        const lines = await tx<Record<string, any>[]>`
          select id, spec_id, code, name, description, category, vendor_id, vendor_sku, finish, dimensions, location_id,
                 quantity, unit_cost, unit_price, ready_to_order, po_id
          from quoting.quote_lines
          where quote_id = ${q.id} and is_selected
            ${lineIds.length ? tx`and id in ${tx(lineIds)}` : tx`and ready_to_order`}
          order by vendor_id, sort, code`;
        return {
          quote: { id: q.id, number: q.number, name: q.name, projectId: q.projectId, status: q.status },
          lines: lines.map(({ locationId, ...l }) => ({
            ...l,
            locationName: locationId ? (paths.get(locationId) ?? null) : null,
            poId: l.poId ?? null,
          })),
        };
      }),
  );

  app.get(
    '/internal/quotes/summary',
    {
      config: { internal: true },
      schema: { hide: true, querystring: TenantQuery.extend({ projectId: z.uuid() }) },
    },
    async (req) =>
      withTenant(req.query.tenantId, async (tx) => {
        const rows = await tx<
          (QuoteRow & { lineCount: number; cost: number; sell: number; approvedAt: string | null })[]
        >`
          select q.*,
            (select count(*)::int from quoting.quote_lines l where l.quote_id = q.id) as line_count,
            coalesce((select sum(extended_cost) from quoting.quote_lines l where l.quote_id = q.id and l.is_selected), 0) as cost,
            coalesce((select sum(extended_price) from quoting.quote_lines l where l.quote_id = q.id and l.is_selected), 0) as sell,
            case when q.client_decision = 'approved' then q.client_decided_at end as approved_at
          from quoting.quotes q
          where q.project_id = ${req.query.projectId} and not q.is_template
          order by q.created_at`;
        return {
          quotes: rows.map((r) => {
            const t = headerTotals(r, r);
            return {
              id: r.id,
              number: r.number,
              name: r.name,
              status: r.status,
              costTotal: t.costSubtotal,
              sellTotal: t.grandTotal,
              approvedAt: r.approvedAt,
            };
          }),
        };
      }),
  );

  app.post(
    '/internal/specs/import',
    {
      config: { internal: true },
      schema: {
        hide: true,
        querystring: TenantQuery,
        body: z.object({ rows: z.array(z.record(z.string(), z.unknown())).min(1).max(5000) }),
      },
    },
    async (req) =>
      withTenant(req.query.tenantId, (tx) => importSpecs(tx, req.query.tenantId, req.body.rows, 'Pro-Cure')),
  );

  app.get(
    '/internal/specs',
    {
      config: { internal: true },
      schema: {
        hide: true,
        querystring: TenantQuery.extend({ quoteId: z.uuid().optional(), ids: uuidList }),
      },
    },
    async (req) =>
      withTenant(req.query.tenantId, async (tx) => {
        const list = ids(req.query.ids);
        if (!req.query.quoteId && !list.length) return [];
        return tx`
          select s.id, s.code, s.name, s.category, s.vendor_id, s.vendor_sku, s.description
          from quoting.specs s
          where true
            ${list.length ? tx`and s.id in ${tx(list)}` : tx``}
            ${req.query.quoteId ? tx`and exists (select 1 from quoting.quote_lines l where l.spec_id = s.id and l.quote_id = ${req.query.quoteId})` : tx``}
          order by s.code`;
      }),
  );
}
