/**
 * File export formats: CSV (RFC 4180) and QuickBooks Desktop IIF (tab-delimited TRNS/SPL/ENDTRNS).
 * Pure functions — unit tested.
 */

export const csvCell = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const toCsv = (headers: string[], rows: unknown[][]): string =>
  [headers, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';

/** IIF fields cannot contain tabs or newlines; strip them. */
const iifCell = (v: unknown): string =>
  v === null || v === undefined ? '' : String(v).replace(/[\t\r\n]+/g, ' ');

/** IIF dates are MM/DD/YYYY. */
export const iifDate = (iso: string) => {
  const [y, m, d] = iso.split('-');
  return `${m}/${d}/${y}`;
};

const money = (n: number) => n.toFixed(2);

export interface IifInvoice {
  number: string;
  date: string;
  dueDate: string;
  customer: string;
  terms: string;
  memo: string;
  total: number;
  lines: { description: string; amount: number }[];
  tax: number;
}

export interface IifBill {
  number: string;
  date: string;
  dueDate: string;
  vendor: string;
  memo: string;
  amount: number;
}

export interface IifAccounts {
  ar: string;
  ap: string;
  income: string;
  expense: string;
  salesTax: string;
}

export const DEFAULT_IIF_ACCOUNTS: IifAccounts = {
  ar: 'Accounts Receivable',
  ap: 'Accounts Payable',
  income: 'FF&E Sales',
  expense: 'Cost of Goods Sold',
  salesTax: 'Sales Tax Payable',
};

const TRNS_COLS = [
  'TRNSID',
  'TRNSTYPE',
  'DATE',
  'ACCNT',
  'NAME',
  'AMOUNT',
  'DOCNUM',
  'MEMO',
  'DUEDATE',
  'TERMS',
];
const SPL_COLS = ['SPLID', 'TRNSTYPE', 'DATE', 'ACCNT', 'NAME', 'AMOUNT', 'DOCNUM', 'MEMO'];

/**
 * Build an IIF file. Each transaction is a TRNS line (the A/R or A/P side), one SPL line per
 * distribution (signed so the transaction balances to zero), and ENDTRNS.
 */
export function toIif(
  invoices: IifInvoice[],
  bills: IifBill[],
  accounts: IifAccounts = DEFAULT_IIF_ACCOUNTS,
) {
  const out: string[][] = [['!TRNS', ...TRNS_COLS], ['!SPL', ...SPL_COLS], ['!ENDTRNS']];
  for (const inv of invoices) {
    const date = iifDate(inv.date);
    out.push([
      'TRNS',
      '',
      'INVOICE',
      date,
      accounts.ar,
      inv.customer,
      money(inv.total),
      inv.number,
      inv.memo,
      iifDate(inv.dueDate),
      inv.terms,
    ]);
    for (const l of inv.lines)
      out.push([
        'SPL',
        '',
        'INVOICE',
        date,
        accounts.income,
        inv.customer,
        money(-l.amount),
        inv.number,
        l.description,
      ]);
    if (inv.tax)
      out.push([
        'SPL',
        '',
        'INVOICE',
        date,
        accounts.salesTax,
        inv.customer,
        money(-inv.tax),
        inv.number,
        'Sales tax',
      ]);
    out.push(['ENDTRNS']);
  }
  for (const b of bills) {
    const date = iifDate(b.date);
    out.push([
      'TRNS',
      '',
      'BILL',
      date,
      accounts.ap,
      b.vendor,
      money(-b.amount),
      b.number,
      b.memo,
      iifDate(b.dueDate),
      '',
    ]);
    out.push(['SPL', '', 'BILL', date, accounts.expense, b.vendor, money(b.amount), b.number, b.memo]);
    out.push(['ENDTRNS']);
  }
  return out.map((r) => r.map(iifCell).join('\t')).join('\r\n') + '\r\n';
}
