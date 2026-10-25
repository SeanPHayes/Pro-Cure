import {
  BillKind,
  BillStatus,
  InvoiceKind,
  InvoiceStatus,
  IsoDate,
  PageQuery,
  page,
  SyncStatus,
} from '@procure/domain';
import { z } from '@procure/platform';
import { AGING_BUCKETS } from './domain/invoicing.js';

/** API contract for the finance service. Portal (client) schemas are separate and strip internal fields. */

export const IdParams = z.object({ id: z.uuid() });
export const PaymentMethod = z.enum(['ach', 'wire', 'check', 'card', 'other']);
export const AgingBucket = z.enum(AGING_BUCKETS);

/** Accepts `?status=a,b` and `?status=a&status=b`. */
const multi = <T extends z.ZodType>(item: T) =>
  z
    .preprocess(
      (v) =>
        v === undefined || v === ''
          ? undefined
          : (Array.isArray(v) ? v : [v]).flatMap((s) => String(s).split(',')).filter(Boolean),
      z.array(item).optional(),
    )
    .optional();

const boolQuery = z
  .enum(['true', 'false', '1', '0'])
  .optional()
  .transform((v) => (v === undefined ? undefined : v === 'true' || v === '1'));

const money = z.number().finite();
const positiveMoney = z.number().finite().positive();

// ---------------------------------------------------------------- invoices
export const InvoiceLine = z.object({
  id: z.string(),
  description: z.string(),
  quantity: z.number(),
  unitPrice: z.number(),
  amount: z.number(),
  quoteLineId: z.string().nullable(),
  sort: z.number(),
});

export const Payment = z.object({
  id: z.string(),
  invoiceId: z.string(),
  receivedAt: z.string(),
  amount: z.number(),
  method: PaymentMethod,
  reference: z.string().nullable(),
  notes: z.string().nullable(),
  source: z.enum(['manual', 'qbo']),
  qboId: z.string().nullable(),
  createdByName: z.string().nullable(),
  createdAt: z.string(),
});

export const Invoice = z.object({
  id: z.string(),
  projectId: z.string(),
  projectNumber: z.string(),
  projectName: z.string(),
  clientOrgId: z.string(),
  clientName: z.string(),
  quoteId: z.string().nullable(),
  quoteNumber: z.string().nullable(),
  number: z.string(),
  kind: InvoiceKind,
  status: InvoiceStatus,
  issueDate: z.string(),
  dueDate: z.string(),
  terms: z.string(),
  poReference: z.string().nullable(),
  notes: z.string().nullable(),
  subtotal: z.number(),
  taxRate: z.number(),
  tax: z.number(),
  total: z.number(),
  amountPaid: z.number(),
  balance: z.number(),
  documentId: z.string().nullable(),
  sentAt: z.string().nullable(),
  voidedAt: z.string().nullable(),
  qboId: z.string().nullable(),
  qboSyncStatus: SyncStatus,
  qboSyncedAt: z.string().nullable(),
  qboError: z.string().nullable(),
  createdByName: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  agingBucket: AgingBucket.nullable(),
  daysOverdue: z.number().int(),
});

export const InvoiceDetail = Invoice.extend({
  lines: z.array(InvoiceLine),
  payments: z.array(Payment),
});

export const InvoiceListQuery = PageQuery.extend({
  projectId: z.uuid().optional(),
  clientOrgId: z.uuid().optional(),
  quoteId: z.uuid().optional(),
  status: multi(InvoiceStatus),
  kind: multi(InvoiceKind),
  overdue: boolQuery,
  /** Open invoices whose days past due fall in any of these buckets. */
  aging: multi(AgingBucket),
});

export const LineInput = z.object({
  description: z.string().trim().min(1).max(2000),
  quantity: z.number().finite().default(1),
  unitPrice: money,
  quoteLineId: z.uuid().nullable().optional(),
});

const InvoiceHeaderFields = {
  issueDate: IsoDate.optional(),
  dueDate: IsoDate.optional(),
  dueInDays: z.number().int().min(0).max(365).optional(),
  terms: z.string().trim().min(1).max(60).optional(),
  poReference: z.string().trim().max(120).nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
  taxRate: z.number().min(0).max(100).optional(),
};

export const CreateInvoiceBody = z.object({
  projectId: z.uuid(),
  clientOrgId: z.uuid().optional(),
  clientName: z.string().trim().min(1).optional(),
  quoteId: z.uuid().optional(),
  kind: InvoiceKind.default('progress'),
  ...InvoiceHeaderFields,
  lines: z.array(LineInput).min(1).max(500),
});

export const FromQuoteBody = z.object({
  quoteId: z.uuid(),
  kind: z.enum(['deposit', 'progress', 'final']),
  percent: z.number().gt(0).max(100).optional(),
  amount: positiveMoney.optional(),
  dueInDays: z.number().int().min(0).max(365).optional(),
  poReference: z.string().trim().max(120).nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
  taxRate: z.number().min(0).max(100).optional(),
});

export const UpdateInvoiceBody = z
  .object({
    ...InvoiceHeaderFields,
    kind: InvoiceKind.optional(),
    clientName: z.string().trim().min(1).optional(),
    lines: z.array(LineInput).min(1).max(500).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, 'Nothing to update');

export const SendInvoiceBody = z
  .object({
    to: z.array(z.email()).min(1).max(20).optional(),
    cc: z.array(z.email()).max(20).optional(),
    message: z.string().max(4000).optional(),
  })
  .default({});

export const SendInvoiceResponse = z.object({
  invoice: Invoice,
  documentId: z.string(),
  recipients: z.array(z.string()),
});

export const RecordPaymentBody = z.object({
  amount: positiveMoney,
  receivedAt: IsoDate.optional(),
  method: PaymentMethod.default('check'),
  reference: z.string().trim().max(120).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

export const VoidBody = z.object({ reason: z.string().max(500).optional() }).default({});

// ---------------------------------------------------------------- vendor bills
export const BillPayment = z.object({
  id: z.string(),
  billId: z.string(),
  paidAt: z.string(),
  amount: z.number(),
  method: PaymentMethod,
  reference: z.string().nullable(),
  qboId: z.string().nullable(),
  createdByName: z.string().nullable(),
  createdAt: z.string(),
});

export const VendorBill = z.object({
  id: z.string(),
  projectId: z.string(),
  poId: z.string().nullable(),
  poNumber: z.string().nullable(),
  vendorId: z.string(),
  vendorName: z.string(),
  number: z.string(),
  kind: BillKind,
  status: BillStatus,
  billDate: z.string(),
  dueDate: z.string(),
  amount: z.number(),
  amountPaid: z.number(),
  balance: z.number(),
  documentId: z.string().nullable(),
  notes: z.string().nullable(),
  qboId: z.string().nullable(),
  qboSyncStatus: SyncStatus,
  qboSyncedAt: z.string().nullable(),
  qboError: z.string().nullable(),
  createdByName: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const VendorBillDetail = VendorBill.extend({ payments: z.array(BillPayment) });

export const BillListQuery = PageQuery.extend({
  projectId: z.uuid().optional(),
  poId: z.uuid().optional(),
  vendorId: z.uuid().optional(),
  status: multi(BillStatus),
  kind: multi(BillKind),
  dueWithinDays: z.coerce.number().int().min(0).max(3650).optional(),
});

export const CreateBillBody = z.object({
  projectId: z.uuid(),
  poId: z.uuid().nullable().optional(),
  poNumber: z.string().trim().max(60).nullable().optional(),
  vendorId: z.uuid(),
  vendorName: z.string().trim().min(1).optional(),
  number: z.string().trim().min(1).max(60),
  kind: BillKind.default('balance'),
  status: z.enum(['open', 'scheduled']).default('open'),
  billDate: IsoDate.optional(),
  dueDate: IsoDate.optional(),
  amount: positiveMoney,
  documentId: z.uuid().nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
});

export const UpdateBillBody = z
  .object({
    number: z.string().trim().min(1).max(60).optional(),
    kind: BillKind.optional(),
    status: z.enum(['open', 'scheduled']).optional(),
    billDate: IsoDate.optional(),
    dueDate: IsoDate.optional(),
    amount: positiveMoney.optional(),
    documentId: z.uuid().nullable().optional(),
    notes: z.string().max(4000).nullable().optional(),
    poNumber: z.string().trim().max(60).nullable().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, 'Nothing to update');

export const RecordBillPaymentBody = z.object({
  amount: positiveMoney,
  paidAt: IsoDate.optional(),
  method: PaymentMethod.default('ach'),
  reference: z.string().trim().max(120).nullable().optional(),
});

// ---------------------------------------------------------------- financials
export const MonthCash = z.object({
  month: z.string(),
  cashIn: z.number(),
  cashOut: z.number(),
  net: z.number(),
});

export const ProjectFinancials = z.object({
  projectId: z.string(),
  contractValue: z.number(),
  estimatedCost: z.number(),
  committedCost: z.number(),
  invoiced: z.number(),
  collected: z.number(),
  arBalance: z.number(),
  overdueAr: z.number(),
  apBilled: z.number(),
  apPaid: z.number(),
  apOpen: z.number(),
  depositsCollected: z.number(),
  uninvoicedContract: z.number(),
  projectedMarginPct: z.number().nullable(),
  actualMarginToDate: z.number(),
  byMonth: z.array(MonthCash),
  warnings: z.array(z.string()),
});

export const AgingTotals = z.object({
  current: z.number(),
  '1-30': z.number(),
  '31-60': z.number(),
  '61-90': z.number(),
  '90+': z.number(),
});

export const PortfolioRow = z.object({
  projectId: z.string(),
  projectNumber: z.string(),
  projectName: z.string(),
  status: z.string().nullable(),
  contractValue: z.number(),
  estimatedCost: z.number(),
  committedCost: z.number(),
  invoiced: z.number(),
  collected: z.number(),
  arBalance: z.number(),
  overdueAr: z.number(),
  apBilled: z.number(),
  apPaid: z.number(),
  apOpen: z.number(),
  projectedMarginPct: z.number().nullable(),
  actualMarginToDate: z.number(),
});

export const Portfolio = z.object({
  asOf: z.string(),
  rows: z.array(PortfolioRow),
  totals: PortfolioRow.omit({ projectId: true, projectNumber: true, projectName: true, status: true }),
  arAging: AgingTotals,
  apDueNext30: z.object({
    total: z.number(),
    count: z.number().int(),
    items: z.array(
      z.object({
        id: z.string(),
        number: z.string(),
        vendorName: z.string(),
        projectId: z.string(),
        poNumber: z.string().nullable(),
        dueDate: z.string(),
        balance: z.number(),
      }),
    ),
  }),
  warnings: z.array(z.string()),
});

// ---------------------------------------------------------------- QuickBooks
export const QboSettings = z.object({
  incomeAccountId: z.string().nullable().optional(),
  expenseAccountId: z.string().nullable().optional(),
  depositAccountId: z.string().nullable().optional(),
  bankAccountId: z.string().nullable().optional(),
  itemId: z.string().nullable().optional(),
  syncPayments: z.boolean().default(true),
});

export const QboStatus = z.object({
  configured: z.boolean(),
  connected: z.boolean(),
  status: z.enum(['connected', 'expired', 'disconnected']).nullable(),
  environment: z.enum(['sandbox', 'production', 'simulated']).nullable(),
  realmId: z.string().nullable(),
  connectedByName: z.string().nullable(),
  connectedAt: z.string().nullable(),
  lastSyncAt: z.string().nullable(),
  lastError: z.string().nullable(),
  accessExpiresAt: z.string().nullable(),
  settings: QboSettings,
  pending: z.object({
    invoices: z.number().int(),
    bills: z.number().int(),
    payments: z.number().int(),
    billPayments: z.number().int(),
    errors: z.number().int(),
  }),
});

export const SyncEntity = z.enum(['customers', 'vendors', 'invoices', 'bills', 'payments']);
export const SyncBody = z.object({ entities: z.array(SyncEntity).min(1).optional() }).default({});

const Counts = z.object({ success: z.number().int(), error: z.number().int() });
export const SyncResult = z.object({
  customers: Counts,
  vendors: Counts,
  invoices: Counts,
  bills: Counts,
  payments: Counts,
  billPayments: Counts,
  pulledPayments: Counts,
  startedAt: z.string(),
  finishedAt: z.string(),
});

export const SyncLogEntry = z.object({
  id: z.string(),
  entityType: z.string(),
  localId: z.string().nullable(),
  direction: z.enum(['push', 'pull']),
  status: z.enum(['success', 'error']),
  qboId: z.string().nullable(),
  message: z.string().nullable(),
  createdAt: z.string(),
});

export const SyncLogQuery = PageQuery.extend({
  entityType: z.string().optional(),
  status: z.enum(['success', 'error']).optional(),
  localId: z.uuid().optional(),
});

// ---------------------------------------------------------------- exports
export const ExportQuery = z.object({
  from: IsoDate.optional(),
  to: IsoDate.optional(),
  projectId: z.uuid().optional(),
});

// ---------------------------------------------------------------- client portal (no QBO, no cost, no internal fields)
export const ClientInvoiceLine = z.object({
  id: z.string(),
  description: z.string(),
  quantity: z.number(),
  unitPrice: z.number(),
  amount: z.number(),
});

export const ClientPayment = z.object({
  id: z.string(),
  receivedAt: z.string(),
  amount: z.number(),
  method: PaymentMethod,
  reference: z.string().nullable(),
});

export const ClientInvoice = z.object({
  id: z.string(),
  projectId: z.string(),
  projectNumber: z.string(),
  projectName: z.string(),
  number: z.string(),
  kind: InvoiceKind,
  status: InvoiceStatus,
  issueDate: z.string(),
  dueDate: z.string(),
  terms: z.string(),
  poReference: z.string().nullable(),
  notes: z.string().nullable(),
  subtotal: z.number(),
  taxRate: z.number(),
  tax: z.number(),
  total: z.number(),
  amountPaid: z.number(),
  balance: z.number(),
  documentId: z.string().nullable(),
  sentAt: z.string().nullable(),
});

export const ClientInvoiceDetail = ClientInvoice.extend({
  lines: z.array(ClientInvoiceLine),
  payments: z.array(ClientPayment),
});

export const ClientInvoiceListQuery = PageQuery.extend({
  projectId: z.uuid().optional(),
  status: multi(InvoiceStatus),
});

export { page };
