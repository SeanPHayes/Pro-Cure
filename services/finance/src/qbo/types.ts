/**
 * QuickBooks Online Accounting API (REST v3) — the subset Pro-Cure syncs. Field names follow Intuit's
 * JSON exactly so the HTTP client can send these objects as-is.
 */
export interface Ref {
  value: string;
  name?: string;
}

export interface QboEntity {
  Id: string;
  SyncToken: string;
}

export interface QboCustomerInput {
  DisplayName: string;
  CompanyName?: string;
  PrimaryEmailAddr?: { Address: string };
  PrimaryPhone?: { FreeFormNumber: string };
  WebAddr?: { URI: string };
  BillAddr?: {
    Line1?: string;
    Line2?: string;
    City?: string;
    CountrySubDivisionCode?: string;
    PostalCode?: string;
    Country?: string;
  };
}

export interface QboVendorInput {
  DisplayName: string;
  CompanyName?: string;
  AcctNum?: string;
  PrimaryEmailAddr?: { Address: string };
  PrimaryPhone?: { FreeFormNumber: string };
  WebAddr?: { URI: string };
}

export interface QboInvoiceInput {
  Id?: string;
  SyncToken?: string;
  sparse?: boolean;
  DocNumber: string;
  TxnDate: string;
  DueDate: string;
  CustomerRef: Ref;
  PrivateNote?: string;
  CustomerMemo?: { value: string };
  Line: {
    DetailType: 'SalesItemLineDetail';
    Amount: number;
    Description: string;
    SalesItemLineDetail: { ItemRef?: Ref; Qty: number; UnitPrice: number; ItemAccountRef?: Ref };
  }[];
}

export interface QboBillInput {
  Id?: string;
  SyncToken?: string;
  sparse?: boolean;
  DocNumber: string;
  TxnDate: string;
  DueDate: string;
  VendorRef: Ref;
  PrivateNote?: string;
  Line: {
    DetailType: 'AccountBasedExpenseLineDetail';
    Amount: number;
    Description: string;
    AccountBasedExpenseLineDetail: { AccountRef: Ref };
  }[];
}

export interface QboPaymentInput {
  CustomerRef: Ref;
  TotalAmt: number;
  TxnDate: string;
  PaymentRefNum?: string;
  PrivateNote?: string;
  DepositToAccountRef?: Ref;
  Line: { Amount: number; LinkedTxn: { TxnId: string; TxnType: 'Invoice' }[] }[];
}

export interface QboBillPaymentInput {
  VendorRef: Ref;
  PayType: 'Check' | 'CreditCard';
  CheckPayment?: { BankAccountRef: Ref };
  CreditCardPayment?: { CCAccountRef: Ref };
  TotalAmt: number;
  TxnDate: string;
  DocNumber?: string;
  PrivateNote?: string;
  Line: { Amount: number; LinkedTxn: { TxnId: string; TxnType: 'Bill' }[] }[];
}

/** A Payment as read back from QBO (pull). */
export interface QboPayment extends QboEntity {
  TxnDate: string;
  TotalAmt: number;
  PaymentRefNum?: string;
  PaymentMethodRef?: Ref;
  CustomerRef: Ref;
  Line?: { Amount: number; LinkedTxn?: { TxnId: string; TxnType: string }[] }[];
  MetaData?: { CreateTime: string; LastUpdatedTime: string };
}

/**
 * Everything the sync engine needs from QuickBooks. `localId` is the Pro-Cure id of the record being
 * pushed (the simulated client derives deterministic ids from it; the HTTP client ignores it).
 */
export interface QboClient {
  readonly kind: 'http' | 'simulated';
  createCustomer(localId: string, input: QboCustomerInput): Promise<QboEntity>;
  createVendor(localId: string, input: QboVendorInput): Promise<QboEntity>;
  saveInvoice(localId: string, input: QboInvoiceInput): Promise<QboEntity>;
  voidInvoice(localId: string, ref: QboEntity): Promise<QboEntity>;
  saveBill(localId: string, input: QboBillInput): Promise<QboEntity>;
  deleteBill(localId: string, ref: QboEntity): Promise<void>;
  createPayment(localId: string, input: QboPaymentInput): Promise<QboEntity>;
  createBillPayment(localId: string, input: QboBillPaymentInput): Promise<QboEntity>;
  /** Payments created or changed in QBO at or after `since` (ISO instant). */
  paymentsSince(since: string): Promise<QboPayment[]>;
}

export interface QboSettings {
  incomeAccountId?: string | null;
  expenseAccountId?: string | null;
  depositAccountId?: string | null;
  bankAccountId?: string | null;
  itemId?: string | null;
  syncPayments: boolean;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  /** ISO instants. */
  accessExpiresAt: string;
  refreshExpiresAt: string | null;
}
