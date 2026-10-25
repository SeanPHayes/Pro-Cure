import { round2 } from '@procure/domain';
import { type Db, type EmitActor, emit, must, notFound, unprocessable } from '@procure/platform';
import {
  type AgingBucket,
  agingBucket,
  billStatusAfterPayment,
  daysBetween,
  type InvoiceStatus,
  invoiceStatusAfterPayment,
  invoiceTotals,
  isoDate,
  type LineInput,
  priceLines,
} from './domain/invoicing.js';

/** Database access shared by routes, subscriptions, jobs and the QuickBooks sync engine. */

export const today = () => isoDate(new Date());

const OPEN_AR: InvoiceStatus[] = ['sent', 'partially_paid', 'overdue'];

export interface InvoiceRow {
  id: string;
  tenantId: string;
  projectId: string;
  projectNumber: string;
  projectName: string;
  clientOrgId: string;
  clientName: string;
  quoteId: string | null;
  quoteNumber: string | null;
  number: string;
  kind: 'deposit' | 'progress' | 'final' | 'credit_memo';
  status: InvoiceStatus;
  issueDate: string;
  dueDate: string;
  terms: string;
  poReference: string | null;
  notes: string | null;
  subtotal: number;
  taxRate: number;
  tax: number;
  total: number;
  amountPaid: number;
  balance: number;
  documentId: string | null;
  sentAt: string | null;
  voidedAt: string | null;
  qboId: string | null;
  qboSyncStatus: 'not_synced' | 'pending' | 'synced' | 'error';
  qboSyncedAt: string | null;
  qboError: string | null;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InvoiceLineRow {
  id: string;
  description: string;
  quantity: number;
  unitPrice: number;
  amount: number;
  quoteLineId: string | null;
  sort: number;
}

export interface PaymentRow {
  id: string;
  tenantId: string;
  invoiceId: string;
  receivedAt: string;
  amount: number;
  method: 'ach' | 'wire' | 'check' | 'card' | 'other';
  reference: string | null;
  notes: string | null;
  source: 'manual' | 'qbo';
  qboId: string | null;
  createdByName: string | null;
  createdAt: string;
}

export interface BillRow {
  id: string;
  tenantId: string;
  projectId: string;
  poId: string | null;
  poNumber: string | null;
  vendorId: string;
  vendorName: string;
  number: string;
  kind: 'deposit' | 'balance' | 'freight' | 'other';
  status: 'open' | 'scheduled' | 'partially_paid' | 'paid' | 'void';
  billDate: string;
  dueDate: string;
  amount: number;
  amountPaid: number;
  balance: number;
  documentId: string | null;
  notes: string | null;
  qboId: string | null;
  qboSyncStatus: 'not_synced' | 'pending' | 'synced' | 'error';
  qboSyncedAt: string | null;
  qboError: string | null;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BillPaymentRow {
  id: string;
  tenantId: string;
  billId: string;
  paidAt: string;
  amount: number;
  method: 'ach' | 'wire' | 'check' | 'card' | 'other';
  reference: string | null;
  qboId: string | null;
  createdByName: string | null;
  createdAt: string;
}

/** Add the derived aging fields to an invoice row. */
export const withAging = <T extends InvoiceRow>(
  inv: T,
  asOf = today(),
): T & { agingBucket: AgingBucket | null; daysOverdue: number } => {
  const open = OPEN_AR.includes(inv.status) && inv.balance > 0;
  return {
    ...inv,
    agingBucket: open ? agingBucket(inv.dueDate, asOf) : null,
    daysOverdue: open ? Math.max(0, daysBetween(inv.dueDate, asOf)) : 0,
  };
};

export async function getInvoice(tx: Db, id: string, opts: { forUpdate?: boolean } = {}) {
  const [row] = await tx<InvoiceRow[]>`
    select * from finance.invoices where id = ${id} ${opts.forUpdate ? tx`for update` : tx``}`;
  return must(row, 'Invoice');
}

export async function invoiceDetail(tx: Db, id: string) {
  const inv = await getInvoice(tx, id);
  const [lines, payments] = await Promise.all([
    tx<InvoiceLineRow[]>`
      select id, description, quantity, unit_price, amount, quote_line_id, sort
      from finance.invoice_lines where invoice_id = ${id} order by sort, id`,
    tx<
      PaymentRow[]
    >`select * from finance.payments where invoice_id = ${id} order by received_at, created_at`,
  ]);
  return { ...withAging(inv), lines, payments };
}

export interface NewInvoice {
  tenantId: string;
  projectId: string;
  projectNumber: string;
  projectName: string;
  clientOrgId: string;
  clientName: string;
  quoteId?: string | null;
  quoteNumber?: string | null;
  kind: InvoiceRow['kind'];
  issueDate: string;
  dueDate: string;
  terms: string;
  poReference?: string | null;
  notes?: string | null;
  taxRate: number;
  createdByName: string | null;
  lines: LineInput[];
}

export async function createInvoice(tx: Db, input: NewInvoice): Promise<string> {
  if (input.dueDate < input.issueDate) throw unprocessable('Due date cannot be before the issue date');
  const lines = priceLines(input.lines);
  const totals = invoiceTotals(lines, input.taxRate);
  const number = await nextNumber(tx, input.tenantId, 'INV');
  const [inv] = await tx<{ id: string }[]>`
    insert into finance.invoices ${tx({
      number,
      tenantId: input.tenantId,
      projectId: input.projectId,
      projectNumber: input.projectNumber,
      projectName: input.projectName,
      clientOrgId: input.clientOrgId,
      clientName: input.clientName,
      quoteId: input.quoteId ?? null,
      quoteNumber: input.quoteNumber ?? null,
      kind: input.kind,
      status: 'draft',
      issueDate: input.issueDate,
      dueDate: input.dueDate,
      terms: input.terms,
      poReference: input.poReference ?? null,
      notes: input.notes ?? null,
      taxRate: input.taxRate,
      ...totals,
      amountPaid: 0,
      balance: totals.total,
      qboSyncStatus: 'pending',
      createdByName: input.createdByName,
    })}
    returning id`;
  await insertLines(tx, input.tenantId, inv!.id, lines);
  return inv!.id;
}

export async function nextNumber(tx: Db, tenantId: string, kind: string): Promise<string> {
  const [r] = await tx<{ n: string }[]>`select platform.next_number(${tenantId}::uuid, ${kind}) as n`;
  return r!.n;
}

export async function insertLines(
  tx: Db,
  tenantId: string,
  invoiceId: string,
  lines: ReturnType<typeof priceLines>,
) {
  if (!lines.length) return;
  await tx`insert into finance.invoice_lines ${tx(
    lines.map((l) => ({
      tenantId,
      invoiceId,
      description: l.description,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      amount: l.amount,
      quoteLineId: l.quoteLineId ?? null,
      sort: l.sort,
    })),
  )}`;
}

/** Σ total of a quote's earlier non-void invoices (credit memos count negative). */
export async function invoicedForQuote(tx: Db, quoteId: string): Promise<number> {
  const [r] = await tx<{ total: number }[]>`
    select coalesce(sum(case when kind = 'credit_memo' then -total else total end), 0)::numeric(14,2) as total
    from finance.invoices where quote_id = ${quoteId} and status <> 'void'`;
  return round2(r?.total ?? 0);
}

export interface EmitMeta {
  tenantId: string;
  actor: EmitActor | null;
}

/**
 * Record a client payment against an invoice: locks the invoice, rejects overpayment, updates paid /
 * balance / status, and emits finance.payment.received in the same transaction.
 */
export async function applyInvoicePayment(
  tx: Db,
  invoiceId: string,
  p: {
    amount: number;
    receivedAt: string;
    method: PaymentRow['method'];
    reference?: string | null;
    notes?: string | null;
    source: 'manual' | 'qbo';
    qboId?: string | null;
    createdByName: string | null;
  },
  meta: EmitMeta,
) {
  const inv = await getInvoice(tx, invoiceId, { forUpdate: true });
  if (inv.status === 'draft') throw unprocessable('Send the invoice before recording payments');
  if (inv.status === 'void') throw unprocessable('Cannot record a payment on a void invoice');
  const amount = round2(p.amount);
  if (amount > round2(inv.balance) + 0.005)
    throw unprocessable(`Payment ${amount.toFixed(2)} exceeds the invoice balance ${inv.balance.toFixed(2)}`);
  const [payment] = await tx<PaymentRow[]>`
    insert into finance.payments ${tx({
      tenantId: inv.tenantId,
      invoiceId,
      receivedAt: p.receivedAt,
      amount,
      method: p.method,
      reference: p.reference ?? null,
      notes: p.notes ?? null,
      source: p.source,
      qboId: p.qboId ?? null,
      createdByName: p.createdByName,
    })} returning *`;
  const amountPaid = round2(inv.amountPaid + amount);
  const status = invoiceStatusAfterPayment(inv.status, inv.total, amountPaid, inv.dueDate, today());
  await tx`
    update finance.invoices set amount_paid = ${amountPaid}, balance = ${round2(inv.total - amountPaid)},
      status = ${status}
    where id = ${invoiceId}`;
  await emit(
    tx,
    'finance',
    'finance.payment.received',
    { invoiceId, projectId: inv.projectId, amount },
    { tenantId: meta.tenantId, actor: meta.actor },
  );
  return { payment: payment!, status };
}

export async function getBill(tx: Db, id: string, opts: { forUpdate?: boolean } = {}) {
  const [row] = await tx<BillRow[]>`
    select * from finance.vendor_bills where id = ${id} ${opts.forUpdate ? tx`for update` : tx``}`;
  return must(row, 'Vendor bill');
}

export async function billDetail(tx: Db, id: string) {
  const bill = await getBill(tx, id);
  const payments = await tx<BillPaymentRow[]>`
    select * from finance.bill_payments where bill_id = ${id} order by paid_at, created_at`;
  return { ...bill, payments };
}

export async function applyBillPayment(
  tx: Db,
  billId: string,
  p: {
    amount: number;
    paidAt: string;
    method: BillPaymentRow['method'];
    reference?: string | null;
    createdByName: string | null;
  },
  meta: EmitMeta,
) {
  const bill = await getBill(tx, billId, { forUpdate: true });
  if (bill.status === 'void') throw unprocessable('Cannot pay a void bill');
  if (bill.status === 'paid') throw unprocessable('Bill is already paid');
  const amount = round2(p.amount);
  if (amount > round2(bill.balance) + 0.005)
    throw unprocessable(`Payment ${amount.toFixed(2)} exceeds the bill balance ${bill.balance.toFixed(2)}`);
  const [payment] = await tx<BillPaymentRow[]>`
    insert into finance.bill_payments ${tx({
      tenantId: bill.tenantId,
      billId,
      paidAt: p.paidAt,
      amount,
      method: p.method,
      reference: p.reference ?? null,
      createdByName: p.createdByName,
    })} returning *`;
  const amountPaid = round2(bill.amountPaid + amount);
  const status = billStatusAfterPayment(bill.status, bill.amount, amountPaid);
  await tx`
    update finance.vendor_bills set amount_paid = ${amountPaid}, balance = ${round2(bill.amount - amountPaid)},
      status = ${status}
    where id = ${billId}`;
  if (status === 'paid')
    await emit(
      tx,
      'finance',
      'finance.vendor_bill.paid',
      { billId, poId: bill.poId, vendorId: bill.vendorId, kind: bill.kind, amount: bill.amount },
      { tenantId: meta.tenantId, actor: meta.actor },
    );
  return { payment: payment!, status };
}

export const assertFound = <T>(row: T | undefined, what: string): T => {
  if (!row) throw notFound(what);
  return row;
};
