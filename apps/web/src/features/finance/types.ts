/** Shapes returned by the finance service (/api/finance/...). Mirrors services/finance/src/schemas.ts. */

export const INVOICE_KINDS = ['deposit', 'progress', 'final', 'credit_memo'] as const;
export const INVOICE_STATUSES = ['draft', 'sent', 'partially_paid', 'paid', 'overdue', 'void'] as const;
export const BILL_KINDS = ['deposit', 'balance', 'freight', 'other'] as const;
export const BILL_STATUSES = ['open', 'scheduled', 'partially_paid', 'paid', 'void'] as const;
export const PAYMENT_METHODS = ['ach', 'wire', 'check', 'card', 'other'] as const;
export const AGING_BUCKETS = ['current', '1-30', '31-60', '61-90', '90+'] as const;
export const SYNC_ENTITIES = ['customers', 'vendors', 'invoices', 'bills', 'payments'] as const;

export type InvoiceKind = (typeof INVOICE_KINDS)[number];
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];
export type BillKind = (typeof BILL_KINDS)[number];
export type BillStatus = (typeof BILL_STATUSES)[number];
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export type AgingBucket = (typeof AGING_BUCKETS)[number];
export type SyncStatus = 'not_synced' | 'pending' | 'synced' | 'error';
export type SyncEntity = (typeof SYNC_ENTITIES)[number];

export const METHOD_LABEL: Record<PaymentMethod, string> = {
  ach: 'ACH',
  wire: 'Wire',
  check: 'Check',
  card: 'Card',
  other: 'Other',
};

export const KIND_LABEL: Record<InvoiceKind, string> = {
  deposit: 'Deposit',
  progress: 'Progress',
  final: 'Final',
  credit_memo: 'Credit memo',
};

export const AGING_LABEL: Record<AgingBucket, string> = {
  current: 'Current',
  '1-30': '1–30 days',
  '31-60': '31–60 days',
  '61-90': '61–90 days',
  '90+': '90+ days',
};

export interface InvoiceLine {
  id: string;
  description: string;
  quantity: number;
  unitPrice: number;
  amount: number;
  quoteLineId: string | null;
  sort: number;
}

export interface Payment {
  id: string;
  invoiceId: string;
  receivedAt: string;
  amount: number;
  method: PaymentMethod;
  reference: string | null;
  notes: string | null;
  source: 'manual' | 'qbo';
  qboId: string | null;
  createdByName: string | null;
  createdAt: string;
}

export interface Invoice {
  id: string;
  projectId: string;
  projectNumber: string;
  projectName: string;
  clientOrgId: string;
  clientName: string;
  quoteId: string | null;
  quoteNumber: string | null;
  number: string;
  kind: InvoiceKind;
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
  qboSyncStatus: SyncStatus;
  qboSyncedAt: string | null;
  qboError: string | null;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
  agingBucket: AgingBucket | null;
  daysOverdue: number;
}

export interface InvoiceDetail extends Invoice {
  lines: InvoiceLine[];
  payments: Payment[];
}

export interface BillPayment {
  id: string;
  billId: string;
  paidAt: string;
  amount: number;
  method: PaymentMethod;
  reference: string | null;
  qboId: string | null;
  createdByName: string | null;
  createdAt: string;
}

export interface VendorBill {
  id: string;
  projectId: string;
  poId: string | null;
  poNumber: string | null;
  vendorId: string;
  vendorName: string;
  number: string;
  kind: BillKind;
  status: BillStatus;
  billDate: string;
  dueDate: string;
  amount: number;
  amountPaid: number;
  balance: number;
  documentId: string | null;
  notes: string | null;
  qboId: string | null;
  qboSyncStatus: SyncStatus;
  qboSyncedAt: string | null;
  qboError: string | null;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface VendorBillDetail extends VendorBill {
  payments: BillPayment[];
}

export interface MonthCash {
  month: string;
  cashIn: number;
  cashOut: number;
  net: number;
}

export interface ProjectFinancialsData {
  projectId: string;
  contractValue: number;
  estimatedCost: number;
  committedCost: number;
  invoiced: number;
  collected: number;
  arBalance: number;
  overdueAr: number;
  apBilled: number;
  apPaid: number;
  apOpen: number;
  depositsCollected: number;
  uninvoicedContract: number;
  projectedMarginPct: number | null;
  actualMarginToDate: number;
  byMonth: MonthCash[];
  warnings: string[];
}

export interface PortfolioRow {
  projectId: string;
  projectNumber: string;
  projectName: string;
  status: string | null;
  contractValue: number;
  estimatedCost: number;
  committedCost: number;
  invoiced: number;
  collected: number;
  arBalance: number;
  overdueAr: number;
  apBilled: number;
  apPaid: number;
  apOpen: number;
  projectedMarginPct: number | null;
  actualMarginToDate: number;
}

export interface Portfolio {
  asOf: string;
  rows: PortfolioRow[];
  totals: Omit<PortfolioRow, 'projectId' | 'projectNumber' | 'projectName' | 'status'>;
  arAging: Record<AgingBucket, number>;
  apDueNext30: {
    total: number;
    count: number;
    items: {
      id: string;
      number: string;
      vendorName: string;
      projectId: string;
      poNumber: string | null;
      dueDate: string;
      balance: number;
    }[];
  };
  warnings: string[];
}

export interface QboSettings {
  incomeAccountId?: string | null;
  expenseAccountId?: string | null;
  depositAccountId?: string | null;
  bankAccountId?: string | null;
  itemId?: string | null;
  syncPayments: boolean;
}

export interface QboStatus {
  configured: boolean;
  connected: boolean;
  status: 'connected' | 'expired' | 'disconnected' | null;
  environment: 'sandbox' | 'production' | 'simulated' | null;
  realmId: string | null;
  connectedByName: string | null;
  connectedAt: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  accessExpiresAt: string | null;
  settings: QboSettings;
  pending: { invoices: number; bills: number; payments: number; billPayments: number; errors: number };
}

type Counts = { success: number; error: number };
export interface SyncResult {
  customers: Counts;
  vendors: Counts;
  invoices: Counts;
  bills: Counts;
  payments: Counts;
  billPayments: Counts;
  pulledPayments: Counts;
  startedAt: string;
  finishedAt: string;
}

export interface SyncLogEntry {
  id: string;
  entityType: string;
  localId: string | null;
  direction: 'push' | 'pull';
  status: 'success' | 'error';
  qboId: string | null;
  message: string | null;
  createdAt: string;
}

// ---- owner portal (no QuickBooks, audit or internal fields)
export interface ClientInvoice {
  id: string;
  projectId: string;
  projectNumber: string;
  projectName: string;
  number: string;
  kind: InvoiceKind;
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
}

export interface ClientInvoiceDetail extends ClientInvoice {
  lines: { id: string; description: string; quantity: number; unitPrice: number; amount: number }[];
  payments: {
    id: string;
    receivedAt: string;
    amount: number;
    method: PaymentMethod;
    reference: string | null;
  }[];
}

export const OPEN_AR: InvoiceStatus[] = ['sent', 'partially_paid', 'overdue'];
