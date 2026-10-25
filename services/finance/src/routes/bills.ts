import { round2 } from '@procure/domain';
import { type App, badRequest, unprocessable, z } from '@procure/platform';
import { clients } from '../clients.js';
import { addDays, billStatusAfterPayment, daysForTerms } from '../domain/invoicing.js';
import { applyBillPayment, type BillRow, billDetail, getBill, today } from '../repo.js';
import {
  BillListQuery,
  BillPayment,
  CreateBillBody,
  IdParams,
  page,
  RecordBillPaymentBody,
  UpdateBillBody,
  VendorBill,
  VendorBillDetail,
  VoidBody,
} from '../schemas.js';

const TAGS = ['vendor bills'];

export async function billRoutes(app: App) {
  app.get(
    '/bills',
    {
      schema: {
        tags: TAGS,
        summary: 'List vendor bills (accounts payable)',
        querystring: BillListQuery,
        response: { 200: page(VendorBill) },
      },
    },
    async (req) => {
      req.principal.require('finance:read');
      const q = req.query;
      return req.tx(async (tx) => {
        const where = tx`
          where true
          ${q.projectId ? tx`and project_id = ${q.projectId}` : tx``}
          ${q.poId ? tx`and po_id = ${q.poId}` : tx``}
          ${q.vendorId ? tx`and vendor_id = ${q.vendorId}` : tx``}
          ${q.status?.length ? tx`and status in ${tx(q.status)}` : tx``}
          ${q.kind?.length ? tx`and kind in ${tx(q.kind)}` : tx``}
          ${
            q.dueWithinDays !== undefined
              ? tx`and status in ('open', 'scheduled', 'partially_paid') and due_date <= current_date + ${q.dueWithinDays}::int`
              : tx``
          }
          ${q.q ? tx`and (number || ' ' || vendor_name || ' ' || coalesce(po_number, '')) ilike ${`%${q.q}%`}` : tx``}`;
        const cols: Record<string, string> = {
          dueDate: 'due_date',
          billDate: 'bill_date',
          amount: 'amount',
          balance: 'balance',
          vendorName: 'vendor_name',
          createdAt: 'created_at',
        };
        const sort = q.sort ?? 'dueDate';
        const desc = sort.startsWith('-');
        const col = cols[sort.replace(/^-/, '')] ?? 'due_date';
        const [items, [count]] = await Promise.all([
          tx<BillRow[]>`select * from finance.vendor_bills ${where}
            order by ${tx.unsafe(`${col} ${desc ? 'desc' : 'asc'}`)}, created_at desc
            limit ${q.limit} offset ${q.offset}`,
          tx<{ n: number }[]>`select count(*)::int as n from finance.vendor_bills ${where}`,
        ]);
        return { items, total: count!.n, limit: q.limit, offset: q.offset };
      });
    },
  );

  app.post(
    '/bills',
    {
      schema: {
        tags: TAGS,
        summary: 'Enter a vendor bill',
        body: CreateBillBody,
        response: { 201: VendorBill },
      },
    },
    async (req, reply) => {
      req.principal.require('finance:write');
      const p = req.principal;
      const b = req.body;
      let vendorName = b.vendorName;
      let termsDays: number | null = null;
      if (!vendorName || !b.dueDate) {
        const v = await clients.vendor(p.tenantId, b.vendorId).catch(() => null);
        vendorName ??= v?.name;
        termsDays = daysForTerms(v?.profile?.paymentTerms);
      }
      if (!vendorName) throw badRequest('vendorName is required (vendor could not be looked up)');
      const billDate = b.billDate ?? today();
      const dueDate = b.dueDate ?? addDays(billDate, termsDays ?? 30);
      if (dueDate < billDate) throw unprocessable('Due date cannot be before the bill date');
      const bill = await req.tx(async (tx) => {
        const [row] = await tx<BillRow[]>`
          insert into finance.vendor_bills ${tx({
            tenantId: p.tenantId,
            projectId: b.projectId,
            poId: b.poId ?? null,
            poNumber: b.poNumber ?? null,
            vendorId: b.vendorId,
            vendorName,
            number: b.number,
            kind: b.kind,
            status: b.status,
            billDate,
            dueDate,
            amount: round2(b.amount),
            amountPaid: 0,
            balance: round2(b.amount),
            documentId: b.documentId ?? null,
            notes: b.notes ?? null,
            qboSyncStatus: 'pending',
            createdByName: p.name,
          })} returning *`;
        return row!;
      });
      return reply.status(201).send(bill);
    },
  );

  app.get(
    '/bills/:id',
    {
      schema: {
        tags: TAGS,
        summary: 'Get a vendor bill with its payments',
        params: IdParams,
        response: { 200: VendorBillDetail },
      },
    },
    async (req) => {
      req.principal.require('finance:read');
      return req.tx((tx) => billDetail(tx, req.params.id));
    },
  );

  app.patch(
    '/bills/:id',
    {
      schema: {
        tags: TAGS,
        summary: 'Edit a vendor bill',
        params: IdParams,
        body: UpdateBillBody,
        response: { 200: VendorBillDetail },
      },
    },
    async (req) => {
      req.principal.require('finance:write');
      const b = req.body;
      return req.tx(async (tx) => {
        const bill = await getBill(tx, req.params.id, { forUpdate: true });
        if (bill.status === 'void' || bill.status === 'paid')
          throw unprocessable(`A ${bill.status} bill cannot be edited`);
        const amount = b.amount !== undefined ? round2(b.amount) : bill.amount;
        if (amount < bill.amountPaid) throw unprocessable('Amount cannot be less than what has been paid');
        const billDate = b.billDate ?? bill.billDate;
        const dueDate = b.dueDate ?? bill.dueDate;
        if (dueDate < billDate) throw unprocessable('Due date cannot be before the bill date');
        const requested = b.status ?? (bill.status === 'scheduled' ? 'scheduled' : 'open');
        const status = billStatusAfterPayment(requested, amount, bill.amountPaid);
        await tx`update finance.vendor_bills set ${tx({
          number: b.number ?? bill.number,
          kind: b.kind ?? bill.kind,
          billDate,
          dueDate,
          amount,
          balance: round2(amount - bill.amountPaid),
          status,
          documentId: b.documentId === undefined ? bill.documentId : b.documentId,
          notes: b.notes === undefined ? bill.notes : b.notes,
          poNumber: b.poNumber === undefined ? bill.poNumber : b.poNumber,
          qboSyncStatus: 'pending',
        })} where id = ${bill.id}`;
        return billDetail(tx, bill.id);
      });
    },
  );

  app.post(
    '/bills/:id/payments',
    {
      schema: {
        tags: TAGS,
        summary: 'Record a payment to the vendor',
        description: 'When the bill becomes fully paid, emits finance.vendor_bill.paid (with the bill kind).',
        params: IdParams,
        body: RecordBillPaymentBody,
        response: { 201: z.object({ payment: BillPayment, bill: VendorBill }) },
      },
    },
    async (req, reply) => {
      req.principal.require('finance:write');
      const p = req.principal;
      const result = await req.tx(async (tx) => {
        const { payment } = await applyBillPayment(
          tx,
          req.params.id,
          {
            amount: req.body.amount,
            paidAt: req.body.paidAt ?? today(),
            method: req.body.method,
            reference: req.body.reference ?? null,
            createdByName: p.name,
          },
          { tenantId: p.tenantId, actor: { userId: p.userId, orgId: p.orgId, name: p.name } },
        );
        return { payment, bill: await getBill(tx, req.params.id) };
      });
      return reply.status(201).send(result);
    },
  );

  app.post(
    '/bills/:id/void',
    {
      schema: {
        tags: TAGS,
        summary: 'Void a vendor bill (no payments may be recorded against it)',
        params: IdParams,
        body: VoidBody,
        response: { 200: VendorBill },
      },
    },
    async (req) => {
      req.principal.require('finance:write');
      return req.tx(async (tx) => {
        const bill = await getBill(tx, req.params.id, { forUpdate: true });
        if (bill.status === 'void') return bill;
        if (bill.amountPaid > 0) throw unprocessable('Bill has payments and cannot be voided');
        const reason = req.body.reason?.trim();
        const [row] = await tx<BillRow[]>`
          update finance.vendor_bills set status = 'void', balance = 0,
            notes = ${reason ? [bill.notes, `Voided: ${reason}`].filter(Boolean).join('\n') : bill.notes},
            qbo_sync_status = ${bill.qboId ? 'pending' : 'not_synced'}
          where id = ${bill.id} returning *`;
        return row!;
      });
    },
  );
}
