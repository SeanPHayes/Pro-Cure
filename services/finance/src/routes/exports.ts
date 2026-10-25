import { type App, badRequest } from '@procure/platform';
import { type IifBill, type IifInvoice, toCsv, toIif } from '../domain/exports.js';
import type { BillRow, InvoiceRow } from '../repo.js';
import { ExportQuery } from '../schemas.js';

const TAGS = ['exports'];

const range = <T extends { from?: string; to?: string }>(q: T): T => {
  if (q.from && q.to && q.from > q.to) throw badRequest('"from" must be on or before "to"');
  return q;
};

const fileName = (base: string, q: { from?: string; to?: string }, ext: string) =>
  `${base}${q.from ? `-${q.from}` : ''}${q.to ? `-to-${q.to}` : ''}.${ext}`;

export async function exportRoutes(app: App) {
  app.get(
    '/exports/invoices.csv',
    {
      schema: {
        tags: TAGS,
        summary: 'Download invoices (non-draft) as CSV',
        querystring: ExportQuery,
        produces: ['text/csv'],
      },
    },
    async (req, reply) => {
      req.principal.require('finance:read');
      const q = range(req.query);
      const rows = await req.tx(
        (tx) => tx<InvoiceRow[]>`
          select * from finance.invoices
          where status <> 'draft'
            ${q.from ? tx`and issue_date >= ${q.from}` : tx``}
            ${q.to ? tx`and issue_date <= ${q.to}` : tx``}
            ${q.projectId ? tx`and project_id = ${q.projectId}` : tx``}
          order by issue_date, number`,
      );
      const csv = toCsv(
        [
          'Invoice #',
          'Kind',
          'Status',
          'Issue date',
          'Due date',
          'Terms',
          'Client',
          'Project #',
          'Project',
          'Client PO',
          'Subtotal',
          'Tax',
          'Total',
          'Paid',
          'Balance',
          'QuickBooks ID',
        ],
        rows.map((r) => [
          r.number,
          r.kind,
          r.status,
          r.issueDate,
          r.dueDate,
          r.terms,
          r.clientName,
          r.projectNumber,
          r.projectName,
          r.poReference,
          r.subtotal.toFixed(2),
          r.tax.toFixed(2),
          r.total.toFixed(2),
          r.amountPaid.toFixed(2),
          r.balance.toFixed(2),
          r.qboId,
        ]),
      );
      return reply
        .type('text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="${fileName('invoices', q, 'csv')}"`)
        .send(csv);
    },
  );

  app.get(
    '/exports/bills.csv',
    {
      schema: {
        tags: TAGS,
        summary: 'Download vendor bills as CSV',
        querystring: ExportQuery,
        produces: ['text/csv'],
      },
    },
    async (req, reply) => {
      req.principal.require('finance:read');
      const q = range(req.query);
      const rows = await req.tx(
        (tx) => tx<BillRow[]>`
          select * from finance.vendor_bills
          where true
            ${q.from ? tx`and bill_date >= ${q.from}` : tx``}
            ${q.to ? tx`and bill_date <= ${q.to}` : tx``}
            ${q.projectId ? tx`and project_id = ${q.projectId}` : tx``}
          order by bill_date, vendor_name, number`,
      );
      const csv = toCsv(
        [
          'Bill #',
          'Kind',
          'Status',
          'Bill date',
          'Due date',
          'Vendor',
          'PO #',
          'Amount',
          'Paid',
          'Balance',
          'QuickBooks ID',
        ],
        rows.map((r) => [
          r.number,
          r.kind,
          r.status,
          r.billDate,
          r.dueDate,
          r.vendorName,
          r.poNumber,
          r.amount.toFixed(2),
          r.amountPaid.toFixed(2),
          r.balance.toFixed(2),
          r.qboId,
        ]),
      );
      return reply
        .type('text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="${fileName('bills', q, 'csv')}"`)
        .send(csv);
    },
  );

  app.get(
    '/exports/qbo.iif',
    {
      schema: {
        tags: TAGS,
        summary: 'Download invoices and bills as a QuickBooks IIF import file',
        querystring: ExportQuery,
        produces: ['application/x-iif'],
      },
    },
    async (req, reply) => {
      req.principal.require('finance:read');
      const q = range(req.query);
      const { invoices, bills } = await req.tx(async (tx) => {
        const invs = await tx<InvoiceRow[]>`
          select * from finance.invoices
          where status not in ('draft', 'void') and kind <> 'credit_memo'
            ${q.from ? tx`and issue_date >= ${q.from}` : tx``}
            ${q.to ? tx`and issue_date <= ${q.to}` : tx``}
            ${q.projectId ? tx`and project_id = ${q.projectId}` : tx``}
          order by issue_date, number`;
        const lines = invs.length
          ? await tx<{ invoiceId: string; description: string; amount: number }[]>`
              select invoice_id, description, amount from finance.invoice_lines
              where invoice_id in ${tx(invs.map((i) => i.id))} order by sort, id`
          : [];
        const bs = await tx<BillRow[]>`
          select * from finance.vendor_bills
          where status <> 'void'
            ${q.from ? tx`and bill_date >= ${q.from}` : tx``}
            ${q.to ? tx`and bill_date <= ${q.to}` : tx``}
            ${q.projectId ? tx`and project_id = ${q.projectId}` : tx``}
          order by bill_date, number`;
        const iifInvoices: IifInvoice[] = invs.map((i) => ({
          number: i.number,
          date: i.issueDate,
          dueDate: i.dueDate,
          customer: i.clientName,
          terms: i.terms,
          memo: `${i.projectNumber} ${i.projectName}`.trim(),
          total: i.total,
          tax: i.tax,
          lines: lines
            .filter((l) => l.invoiceId === i.id)
            .map((l) => ({ description: l.description, amount: l.amount })),
        }));
        const iifBills: IifBill[] = bs.map((b) => ({
          number: b.number,
          date: b.billDate,
          dueDate: b.dueDate,
          vendor: b.vendorName,
          memo: [b.kind === 'deposit' ? 'Deposit' : 'Bill', b.poNumber ? `PO ${b.poNumber}` : '']
            .filter(Boolean)
            .join(' '),
          amount: b.amount,
        }));
        return { invoices: iifInvoices, bills: iifBills };
      });
      return reply
        .type('application/x-iif; charset=utf-8')
        .header('content-disposition', `attachment; filename="${fileName('pro-cure-qbo', q, 'iif')}"`)
        .send(toIif(invoices, bills));
    },
  );
}
