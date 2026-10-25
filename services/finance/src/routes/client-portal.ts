import { type App, forbidden, must } from '@procure/platform';
import { ClientInvoice, ClientInvoiceDetail, ClientInvoiceListQuery, IdParams, page } from '../schemas.js';

const TAGS = ['client portal'];

/**
 * Owner portal. RLS (platform.client_ok + status <> 'draft') limits rows to the caller's own org's
 * issued invoices; the Client* response schemas strip QuickBooks, audit and internal fields.
 */
export async function clientPortalRoutes(app: App) {
  const requireClient = (p: { isClient: boolean; require: (x: 'client:view') => void }) => {
    if (!p.isClient) throw forbidden('Client portal only');
    p.require('client:view');
  };

  app.get(
    '/client/invoices',
    {
      schema: {
        tags: TAGS,
        summary: "List my organization's invoices",
        querystring: ClientInvoiceListQuery,
        response: { 200: page(ClientInvoice) },
      },
    },
    async (req) => {
      requireClient(req.principal);
      const q = req.query;
      return req.tx(async (tx) => {
        const where = tx`
          where client_org_id = ${req.principal.orgId} and status <> 'draft'
          ${q.projectId ? tx`and project_id = ${q.projectId}` : tx``}
          ${q.status?.length ? tx`and status in ${tx(q.status)}` : tx``}
          ${q.q ? tx`and (number || ' ' || project_name || ' ' || coalesce(po_reference, '')) ilike ${`%${q.q}%`}` : tx``}`;
        const [items, [count]] = await Promise.all([
          tx`select * from finance.invoices ${where} order by issue_date desc, number desc limit ${q.limit} offset ${q.offset}`,
          tx<{ n: number }[]>`select count(*)::int as n from finance.invoices ${where}`,
        ]);
        return { items: items as never, total: count!.n, limit: q.limit, offset: q.offset };
      });
    },
  );

  app.get(
    '/client/invoices/:id',
    {
      schema: {
        tags: TAGS,
        summary: 'Get one of my invoices with lines, payments and balance',
        params: IdParams,
        response: { 200: ClientInvoiceDetail },
      },
    },
    async (req) => {
      requireClient(req.principal);
      return req.tx(async (tx) => {
        const [inv] =
          await tx`select * from finance.invoices where id = ${req.params.id} and status <> 'draft'`;
        must(inv, 'Invoice');
        const [lines, payments] = await Promise.all([
          tx`select id, description, quantity, unit_price, amount from finance.invoice_lines
             where invoice_id = ${req.params.id} order by sort, id`,
          tx`select id, received_at, amount, method, reference from finance.payments
             where invoice_id = ${req.params.id} order by received_at, created_at`,
        ]);
        return { ...(inv as Record<string, unknown>), lines, payments } as never;
      });
    },
  );
}
