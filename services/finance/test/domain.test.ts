import { describe, expect, it } from 'vitest';
import {
  decryptSecret,
  encryptSecret,
  InvalidStateError,
  signState,
  verifyState,
} from '../src/domain/crypto.js';
import { csvCell, iifDate, toCsv, toIif } from '../src/domain/exports.js';
import {
  addDays,
  agingBucket,
  billStatusAfterPayment,
  daysForTerms,
  invoiceStatusAfterPayment,
  invoiceTotals,
  lastMonths,
  priceLines,
  quoteInvoiceLine,
} from '../src/domain/invoicing.js';

const quote = {
  id: 'q1',
  number: 'Q-26-0012',
  name: 'Guestroom FF&E',
  status: 'client_approved',
  sellTotal: 125_000.5,
};
const key = Buffer.alloc(32, 7);

describe('quote invoice math', () => {
  it('deposit defaults to 50% of sell total with a descriptive line', () => {
    const l = quoteInvoiceLine(quote, { kind: 'deposit' }, 0);
    expect(l.unitPrice).toBe(62_500.25);
    expect(l.description).toBe("Deposit — 50% of Quote Q-26-0012 'Guestroom FF&E'");
  });

  it('deposit honors a custom percent and requires approval', () => {
    expect(quoteInvoiceLine(quote, { kind: 'deposit', percent: 30 }, 0).unitPrice).toBe(37_500.15);
    expect(() => quoteInvoiceLine({ ...quote, status: 'sent' }, { kind: 'deposit' }, 0)).toThrow(
      /client approved/,
    );
  });

  it('final = sell total minus previous invoices; nothing left → error', () => {
    expect(quoteInvoiceLine(quote, { kind: 'final' }, 62_500.25).unitPrice).toBe(62_500.25);
    expect(() => quoteInvoiceLine(quote, { kind: 'final' }, 125_000.5)).toThrow(/Nothing left/);
  });

  it('progress by percent or amount, never above the remaining balance', () => {
    expect(quoteInvoiceLine(quote, { kind: 'progress', percent: 25 }, 0).unitPrice).toBe(31_250.13);
    expect(quoteInvoiceLine(quote, { kind: 'progress', amount: 1000 }, 0).unitPrice).toBe(1000);
    expect(() => quoteInvoiceLine(quote, { kind: 'progress' }, 0)).toThrow(/percent or an amount/);
    expect(() => quoteInvoiceLine(quote, { kind: 'progress', amount: 70_000 }, 60_000)).toThrow(/exceeds/);
  });

  it('prices lines and totals with tax via round2', () => {
    const lines = priceLines([
      { description: 'A', quantity: 3, unitPrice: 0.1 },
      { description: 'B', quantity: 1, unitPrice: 0.2 },
    ]);
    expect(lines.map((l) => l.amount)).toEqual([0.3, 0.2]);
    expect(invoiceTotals(lines, 7.25)).toEqual({ subtotal: 0.5, tax: 0.04, total: 0.54 });
  });
});

describe('statuses, dates and aging', () => {
  it('invoice status after payment', () => {
    expect(invoiceStatusAfterPayment('sent', 100, 40, '2026-12-01', '2026-10-01')).toBe('partially_paid');
    expect(invoiceStatusAfterPayment('partially_paid', 100, 100, '2026-12-01', '2026-10-01')).toBe('paid');
    expect(invoiceStatusAfterPayment('sent', 100, 40, '2026-09-01', '2026-10-01')).toBe('overdue');
    expect(invoiceStatusAfterPayment('void', 100, 100, '2026-09-01', '2026-10-01')).toBe('void');
  });

  it('bill status after payment', () => {
    expect(billStatusAfterPayment('open', 100, 50)).toBe('partially_paid');
    expect(billStatusAfterPayment('partially_paid', 100, 100)).toBe('paid');
    expect(billStatusAfterPayment('scheduled', 100, 0)).toBe('scheduled');
  });

  it('aging buckets and helpers', () => {
    expect(agingBucket('2026-10-25', '2026-10-25')).toBe('current');
    expect(agingBucket('2026-10-01', '2026-10-25')).toBe('1-30');
    expect(agingBucket('2026-09-01', '2026-10-25')).toBe('31-60');
    expect(agingBucket('2026-08-01', '2026-10-25')).toBe('61-90');
    expect(agingBucket('2026-01-01', '2026-10-25')).toBe('90+');
    expect(addDays('2026-12-28', 7)).toBe('2027-01-04');
    expect(daysForTerms('Net 45')).toBe(45);
    expect(daysForTerms('Due on receipt')).toBe(0);
    expect(lastMonths('2026-03-15', 4)).toEqual(['2025-12', '2026-01', '2026-02', '2026-03']);
  });
});

describe('crypto', () => {
  it('token encryption round trip; ciphertext is randomized and tamper-evident', () => {
    const a = encryptSecret('refresh-token-123', key);
    const b = encryptSecret('refresh-token-123', key);
    expect(a).not.toBe(b);
    expect(a).not.toContain('refresh-token');
    expect(decryptSecret(a, key)).toBe('refresh-token-123');
    const parts = a.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => decryptSecret(parts.join('.'), key)).toThrow();
    expect(() => decryptSecret(a, Buffer.alloc(32, 8))).toThrow();
  });

  it('OAuth state is signed and expires', () => {
    const s = signState({ tenantId: 't-1', userName: 'Ann' }, key);
    expect(verifyState(s, key)).toMatchObject({ tenantId: 't-1', userName: 'Ann' });
    const [body, sig] = s.split('.');
    const forged = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(body!, 'base64url').toString()), tenantId: 't-2' }),
    ).toString('base64url');
    expect(() => verifyState(`${forged}.${sig}`, key)).toThrow(InvalidStateError);
    const old = signState({ tenantId: 't-1' }, key, 60, Date.now() - 120_000);
    expect(() => verifyState(old, key)).toThrow(/expired/);
  });
});

describe('exports', () => {
  it('CSV escapes quotes, commas and newlines with CRLF rows', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell(null)).toBe('');
    expect(toCsv(['A', 'B'], [[1, 'x\ny']])).toBe('A,B\r\n1,"x\ny"\r\n');
  });

  it('IIF has !TRNS/!SPL/!ENDTRNS headers and balanced transactions', () => {
    const iif = toIif(
      [
        {
          number: 'INV-26-0001',
          date: '2026-10-01',
          dueDate: '2026-10-31',
          customer: 'Lakeside\tHospitality',
          terms: 'Net 30',
          memo: 'P-1',
          total: 1070,
          tax: 70,
          lines: [{ description: 'Deposit', amount: 1000 }],
        },
      ],
      [
        {
          number: 'DEP-PO-26-0001',
          date: '2026-10-02',
          dueDate: '2026-10-09',
          vendor: 'Acme',
          memo: 'Deposit',
          amount: 500,
        },
      ],
    );
    const rows = iif
      .trimEnd()
      .split('\r\n')
      .map((r) => r.split('\t'));
    expect(rows[0]![0]).toBe('!TRNS');
    expect(rows[1]![0]).toBe('!SPL');
    expect(rows[2]).toEqual(['!ENDTRNS']);
    expect(rows[0]!.length).toBe(11);
    expect(rows[3]).toEqual([
      'TRNS',
      '',
      'INVOICE',
      '10/01/2026',
      'Accounts Receivable',
      'Lakeside Hospitality',
      '1070.00',
      'INV-26-0001',
      'P-1',
      '10/31/2026',
      'Net 30',
    ]);
    // Each transaction's TRNS + SPL amounts sum to zero.
    let acc = 0;
    for (const r of rows.slice(3)) {
      if (r[0] === 'TRNS' || r[0] === 'SPL') acc += Number(r[6]);
      if (r[0] === 'ENDTRNS') {
        expect(Math.abs(acc)).toBeLessThan(0.001);
        acc = 0;
      }
    }
    expect(rows.filter((r) => r[0] === 'ENDTRNS')).toHaveLength(2);
    expect(rows.find((r) => r[2] === 'BILL' && r[0] === 'TRNS')![6]).toBe('-500.00');
    expect(iifDate('2026-01-05')).toBe('01/05/2026');
  });
});
