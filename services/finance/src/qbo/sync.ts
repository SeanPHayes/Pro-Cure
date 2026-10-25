import { round2 } from '@procure/domain';
import { type Db, type DbContext, type Principal, withContext } from '@procure/platform';
import { clients } from '../clients.js';
import type { Logger } from '../log.js';
import { applyInvoicePayment, type BillRow, type InvoiceLineRow, type InvoiceRow, today } from '../repo.js';
import {
  acquireSyncLock,
  type ConnectionRow,
  getConnection,
  markExpired,
  qboClientFactory,
  releaseSyncLock,
} from './connection.js';
import { QboFaultError } from './http-client.js';
import { OAuthError } from './oauth.js';
import type { QboClient, QboEntity, QboInvoiceInput, QboPayment, QboSettings } from './types.js';

/**
 * Two-way QuickBooks Online sync.
 *   push: customers (client orgs) → invoices → payments; vendors → bills → bill payments
 *   pull: QBO payments applied to mapped invoices since the last sync → local payments (deduped by qbo_id)
 * Each record is pushed in its own transaction so one failure never blocks the rest; QBO is called
 * outside DB transactions. Every attempt is written to finance.qbo_sync_log.
 */
export type SyncEntityName = 'customers' | 'vendors' | 'invoices' | 'bills' | 'payments';
export const ALL_SYNC_ENTITIES: SyncEntityName[] = ['customers', 'vendors', 'invoices', 'bills', 'payments'];

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

type MapType = 'customer' | 'vendor' | 'invoice' | 'bill' | 'payment' | 'bill_payment';

const zero = (): Counts => ({ success: 0, error: 0 });

/** Abort the whole run (auth failures): no point continuing with a dead token. */
class AbortSync extends Error {}

export async function getMapping(tx: Db, type: MapType, localId: string) {
  const [m] = await tx<{ qboId: string; syncToken: string | null }[]>`
    select qbo_id, sync_token from finance.qbo_entity_map where entity_type = ${type} and local_id = ${localId}`;
  return m ?? null;
}

async function putMapping(tx: Db, tenantId: string, type: MapType, localId: string, e: QboEntity) {
  await tx`
    insert into finance.qbo_entity_map (tenant_id, entity_type, local_id, qbo_id, sync_token)
    values (${tenantId}, ${type}, ${localId}, ${e.Id}, ${e.SyncToken})
    on conflict (tenant_id, entity_type, local_id)
    do update set qbo_id = excluded.qbo_id, sync_token = excluded.sync_token, updated_at = now()`;
}

async function log(
  tx: Db,
  tenantId: string,
  entityType: MapType,
  localId: string | null,
  direction: 'push' | 'pull',
  status: 'success' | 'error',
  qboId: string | null,
  message: string | null,
) {
  await tx`insert into finance.qbo_sync_log ${tx({ tenantId, entityType, localId, direction, status, qboId, message })}`;
}

const errMessage = (err: unknown) => (err as Error).message?.slice(0, 1000) ?? 'Unknown error';

export class SyncEngine {
  private readonly result: SyncResult;
  private qbo!: QboClient;
  private settings!: QboSettings;

  constructor(
    private readonly ctx: DbContext,
    private readonly tenantId: string,
    private readonly opts: { principal?: Principal | null; log?: Logger; now?: Date } = {},
  ) {
    const startedAt = (opts.now ?? new Date()).toISOString();
    this.result = {
      customers: zero(),
      vendors: zero(),
      invoices: zero(),
      bills: zero(),
      payments: zero(),
      billPayments: zero(),
      pulledPayments: zero(),
      startedAt,
      finishedAt: startedAt,
    };
  }

  private tx<T>(fn: (tx: Db) => Promise<T>) {
    return withContext(this.ctx, fn);
  }

  /** Run a sync. Returns null when no connection or another run holds the lock (and `throwIfBusy` is false). */
  async run(entities: SyncEntityName[] = ALL_SYNC_ENTITIES, throwIfBusy = true): Promise<SyncResult | null> {
    const locked = await acquireSyncLock(this.ctx, this.tenantId, throwIfBusy);
    if (!locked) return null;
    let lastError: string | null = null;
    let conn: ConnectionRow | null = null;
    try {
      conn = await this.tx((tx) => getConnection(tx, this.tenantId));
      if (!conn || conn.status !== 'connected') return null;
      this.qbo = qboClientFactory.create(conn, this.ctx);
      this.settings = conn.settings;
      const want = new Set(entities);
      if (want.has('customers') || want.has('invoices')) await this.pushCustomers();
      if (want.has('vendors') || want.has('bills')) await this.pushVendors();
      if (want.has('invoices')) await this.pushInvoices();
      if (want.has('bills')) await this.pushBills();
      if (want.has('payments') && this.settings.syncPayments) {
        await this.pushPayments();
        await this.pushBillPayments();
        await this.pullPayments(conn);
      }
    } catch (err) {
      lastError = errMessage(err);
      if (!(err instanceof AbortSync)) throw err;
    } finally {
      const errors = Object.values(this.result).reduce(
        (n, c) => n + (typeof c === 'object' ? c.error : 0),
        0,
      );
      if (!lastError && errors) lastError = `${errors} record(s) failed to sync — see the sync log`;
      await releaseSyncLock(this.ctx, this.tenantId, { lastError });
    }
    this.result.finishedAt = new Date().toISOString();
    return this.result;
  }

  /** Classify a QBO failure: auth problems stop the run, everything else is per-record. */
  private async onError(err: unknown) {
    if ((err instanceof QboFaultError && err.isAuth) || (err instanceof OAuthError && err.isInvalidGrant)) {
      await this.tx((tx) => markExpired(tx, this.tenantId, 'QuickBooks authorization expired — reconnect'));
      throw new AbortSync('QuickBooks authorization expired — reconnect');
    }
    this.opts.log?.warn({ err: errMessage(err) }, 'qbo record sync failed');
  }

  // ------------------------------------------------------------------ customers
  private async pushCustomers() {
    const missing = await this.tx(
      (tx) => tx<{ clientOrgId: string; clientName: string }[]>`
        select distinct on (i.client_org_id) i.client_org_id, i.client_name
        from finance.invoices i
        where i.status not in ('draft') and (i.qbo_sync_status in ('pending', 'error') or i.qbo_id is null)
          and not exists (select 1 from finance.qbo_entity_map m
                          where m.entity_type = 'customer' and m.local_id = i.client_org_id)
        order by i.client_org_id, i.created_at desc`,
    );
    for (const c of missing) await this.ensureCustomer(c.clientOrgId, c.clientName);
  }

  private async ensureCustomer(orgId: string, fallbackName: string): Promise<string | null> {
    const existing = await this.tx((tx) => getMapping(tx, 'customer', orgId));
    if (existing) return existing.qboId;
    try {
      const org = await clients.org(this.opts.principal ?? null, orgId).catch(() => null);
      const name = org?.legalName || org?.name || fallbackName;
      const addr = (org?.address ?? {}) as Record<string, string>;
      const e = await this.qbo.createCustomer(orgId, {
        DisplayName: name.slice(0, 100),
        CompanyName: name.slice(0, 100),
        ...(org?.email ? { PrimaryEmailAddr: { Address: org.email } } : {}),
        ...(org?.phone ? { PrimaryPhone: { FreeFormNumber: org.phone } } : {}),
        ...(org?.website ? { WebAddr: { URI: org.website } } : {}),
        ...(addr.line1
          ? {
              BillAddr: {
                Line1: addr.line1,
                Line2: addr.line2,
                City: addr.city,
                CountrySubDivisionCode: addr.region,
                PostalCode: addr.postalCode,
                Country: addr.country,
              },
            }
          : {}),
      });
      await this.tx(async (tx) => {
        await putMapping(tx, this.tenantId, 'customer', orgId, e);
        await log(
          tx,
          this.tenantId,
          'customer',
          orgId,
          'push',
          'success',
          e.Id,
          `Customer "${name}" created`,
        );
      });
      this.result.customers.success++;
      return e.Id;
    } catch (err) {
      await this.tx((tx) =>
        log(tx, this.tenantId, 'customer', orgId, 'push', 'error', null, errMessage(err)),
      );
      this.result.customers.error++;
      await this.onError(err);
      return null;
    }
  }

  // ------------------------------------------------------------------ vendors
  private async pushVendors() {
    const missing = await this.tx(
      (tx) => tx<{ vendorId: string; vendorName: string }[]>`
        select distinct on (b.vendor_id) b.vendor_id, b.vendor_name
        from finance.vendor_bills b
        where b.status <> 'void' and (b.qbo_sync_status in ('pending', 'error') or b.qbo_id is null)
          and not exists (select 1 from finance.qbo_entity_map m
                          where m.entity_type = 'vendor' and m.local_id = b.vendor_id)
        order by b.vendor_id, b.created_at desc`,
    );
    for (const v of missing) await this.ensureVendor(v.vendorId, v.vendorName);
  }

  private async ensureVendor(vendorId: string, fallbackName: string): Promise<string | null> {
    const existing = await this.tx((tx) => getMapping(tx, 'vendor', vendorId));
    if (existing) return existing.qboId;
    try {
      const v = await clients.vendor(this.tenantId, vendorId).catch(() => null);
      const name = v?.name || fallbackName;
      const contact = v?.profile?.primaryContact;
      const e = await this.qbo.createVendor(vendorId, {
        DisplayName: name.slice(0, 100),
        CompanyName: name.slice(0, 100),
        ...(v?.profile?.accountNumber ? { AcctNum: v.profile.accountNumber } : {}),
        ...(contact?.email ? { PrimaryEmailAddr: { Address: contact.email } } : {}),
        ...(contact?.phone ? { PrimaryPhone: { FreeFormNumber: contact.phone } } : {}),
        ...(v?.website ? { WebAddr: { URI: v.website } } : {}),
      });
      await this.tx(async (tx) => {
        await putMapping(tx, this.tenantId, 'vendor', vendorId, e);
        await log(tx, this.tenantId, 'vendor', vendorId, 'push', 'success', e.Id, `Vendor "${name}" created`);
      });
      this.result.vendors.success++;
      return e.Id;
    } catch (err) {
      await this.tx((tx) =>
        log(tx, this.tenantId, 'vendor', vendorId, 'push', 'error', null, errMessage(err)),
      );
      this.result.vendors.error++;
      await this.onError(err);
      return null;
    }
  }

  // ------------------------------------------------------------------ invoices
  private async pushInvoices() {
    const rows = await this.tx(
      (tx) => tx<InvoiceRow[]>`
        select * from finance.invoices
        where qbo_sync_status in ('pending', 'error') and status <> 'draft'
        order by issue_date, number limit 500`,
    );
    for (const inv of rows) await this.pushInvoice(inv);
  }

  private async pushInvoice(inv: InvoiceRow) {
    const mark = (tx: Db, status: 'synced' | 'error', qboId: string | null, error: string | null) =>
      tx`update finance.invoices set qbo_sync_status = ${status}, qbo_error = ${error},
           qbo_id = coalesce(${qboId}, qbo_id), qbo_synced_at = case when ${status} = 'synced' then now() else qbo_synced_at end
         where id = ${inv.id}`;
    try {
      const map = await this.tx((tx) => getMapping(tx, 'invoice', inv.id));
      if (inv.status === 'void') {
        if (map) {
          const e = await this.qbo.voidInvoice(inv.id, { Id: map.qboId, SyncToken: map.syncToken ?? '0' });
          await this.tx(async (tx) => {
            await putMapping(tx, this.tenantId, 'invoice', inv.id, e);
            await mark(tx, 'synced', e.Id, null);
            await log(
              tx,
              this.tenantId,
              'invoice',
              inv.id,
              'push',
              'success',
              e.Id,
              `Invoice ${inv.number} voided`,
            );
          });
        } else {
          await this.tx(
            (tx) =>
              tx`update finance.invoices set qbo_sync_status = 'not_synced', qbo_error = null where id = ${inv.id}`,
          );
        }
        this.result.invoices.success++;
        return;
      }
      const customerId = await this.ensureCustomer(inv.clientOrgId, inv.clientName);
      if (!customerId) throw new Error(`Customer for ${inv.clientName} could not be created in QuickBooks`);
      const lines = await this.tx(
        (tx) => tx<InvoiceLineRow[]>`
          select id, description, quantity, unit_price, amount, quote_line_id, sort
          from finance.invoice_lines where invoice_id = ${inv.id} order by sort, id`,
      );
      const s = this.settings;
      const body: QboInvoiceInput = {
        ...(map ? { Id: map.qboId, SyncToken: map.syncToken ?? '0', sparse: false } : {}),
        DocNumber: inv.number.slice(0, 21),
        TxnDate: inv.issueDate,
        DueDate: inv.dueDate,
        CustomerRef: { value: customerId, name: inv.clientName },
        PrivateNote: [
          `Pro-Cure ${inv.number}`,
          `${inv.projectNumber} ${inv.projectName}`,
          inv.poReference ? `Client PO ${inv.poReference}` : '',
        ]
          .filter(Boolean)
          .join(' · ')
          .slice(0, 4000),
        ...(inv.notes ? { CustomerMemo: { value: inv.notes.slice(0, 1000) } } : {}),
        Line: [
          ...lines.map((l) => ({
            DetailType: 'SalesItemLineDetail' as const,
            Amount: round2(l.amount),
            Description: l.description.slice(0, 4000),
            SalesItemLineDetail: {
              ...(s.itemId ? { ItemRef: { value: s.itemId } } : {}),
              ...(s.incomeAccountId ? { ItemAccountRef: { value: s.incomeAccountId } } : {}),
              Qty: l.quantity,
              UnitPrice: l.unitPrice,
            },
          })),
          // Tax as its own line keeps totals equal without depending on the company's tax setup.
          ...(inv.tax
            ? [
                {
                  DetailType: 'SalesItemLineDetail' as const,
                  Amount: inv.tax,
                  Description: `Sales tax (${inv.taxRate}%)`,
                  SalesItemLineDetail: {
                    ...(s.itemId ? { ItemRef: { value: s.itemId } } : {}),
                    Qty: 1,
                    UnitPrice: inv.tax,
                  },
                },
              ]
            : []),
        ],
      };
      const e = await this.qbo.saveInvoice(inv.id, body);
      await this.tx(async (tx) => {
        await putMapping(tx, this.tenantId, 'invoice', inv.id, e);
        await mark(tx, 'synced', e.Id, null);
        await log(
          tx,
          this.tenantId,
          'invoice',
          inv.id,
          'push',
          'success',
          e.Id,
          `Invoice ${inv.number} ${map ? 'updated' : 'created'}`,
        );
      });
      this.result.invoices.success++;
    } catch (err) {
      if (err instanceof AbortSync) throw err;
      await this.tx(async (tx) => {
        await mark(tx, 'error', null, errMessage(err));
        await log(tx, this.tenantId, 'invoice', inv.id, 'push', 'error', null, errMessage(err));
      });
      this.result.invoices.error++;
      await this.onError(err);
    }
  }

  // ------------------------------------------------------------------ bills
  private async pushBills() {
    const rows = await this.tx(
      (tx) => tx<BillRow[]>`
        select * from finance.vendor_bills where qbo_sync_status in ('pending', 'error')
        order by bill_date, created_at limit 500`,
    );
    for (const b of rows) await this.pushBill(b);
  }

  private async pushBill(b: BillRow) {
    const mark = (
      tx: Db,
      status: 'synced' | 'error' | 'not_synced',
      qboId: string | null,
      error: string | null,
    ) =>
      tx`update finance.vendor_bills set qbo_sync_status = ${status}, qbo_error = ${error},
           qbo_id = case when ${status} = 'not_synced' then null else coalesce(${qboId}, qbo_id) end,
           qbo_synced_at = case when ${status} = 'synced' then now() else qbo_synced_at end
         where id = ${b.id}`;
    try {
      const map = await this.tx((tx) => getMapping(tx, 'bill', b.id));
      if (b.status === 'void') {
        // QBO bills cannot be voided; delete the mirror.
        if (map) await this.qbo.deleteBill(b.id, { Id: map.qboId, SyncToken: map.syncToken ?? '0' });
        await this.tx(async (tx) => {
          await tx`delete from finance.qbo_entity_map where entity_type = 'bill' and local_id = ${b.id}`;
          await mark(tx, 'not_synced', null, null);
          if (map)
            await log(
              tx,
              this.tenantId,
              'bill',
              b.id,
              'push',
              'success',
              map.qboId,
              `Bill ${b.number} deleted (voided)`,
            );
        });
        this.result.bills.success++;
        return;
      }
      const vendorQboId = await this.ensureVendor(b.vendorId, b.vendorName);
      if (!vendorQboId) throw new Error(`Vendor ${b.vendorName} could not be created in QuickBooks`);
      if (!this.settings.expenseAccountId && this.qbo.kind === 'http')
        throw new Error('Choose an expense account in QuickBooks settings before syncing bills');
      const e = await this.qbo.saveBill(b.id, {
        ...(map ? { Id: map.qboId, SyncToken: map.syncToken ?? '0', sparse: false } : {}),
        DocNumber: b.number.slice(0, 21),
        TxnDate: b.billDate,
        DueDate: b.dueDate,
        VendorRef: { value: vendorQboId, name: b.vendorName },
        PrivateNote: [`Pro-Cure ${b.kind} bill`, b.poNumber ? `PO ${b.poNumber}` : '', b.notes ?? '']
          .filter(Boolean)
          .join(' · ')
          .slice(0, 4000),
        Line: [
          {
            DetailType: 'AccountBasedExpenseLineDetail',
            Amount: b.amount,
            Description: `${b.kind === 'deposit' ? 'Deposit' : 'Bill'} ${b.number}${b.poNumber ? ` — PO ${b.poNumber}` : ''}`,
            AccountBasedExpenseLineDetail: {
              AccountRef: { value: this.settings.expenseAccountId ?? 'SIM-ACCT-COGS' },
            },
          },
        ],
      });
      await this.tx(async (tx) => {
        await putMapping(tx, this.tenantId, 'bill', b.id, e);
        await mark(tx, 'synced', e.Id, null);
        await log(
          tx,
          this.tenantId,
          'bill',
          b.id,
          'push',
          'success',
          e.Id,
          `Bill ${b.number} ${map ? 'updated' : 'created'}`,
        );
      });
      this.result.bills.success++;
    } catch (err) {
      if (err instanceof AbortSync) throw err;
      await this.tx(async (tx) => {
        await mark(tx, 'error', null, errMessage(err));
        await log(tx, this.tenantId, 'bill', b.id, 'push', 'error', null, errMessage(err));
      });
      this.result.bills.error++;
      await this.onError(err);
    }
  }

  // ------------------------------------------------------------------ payments (push)
  private async pushPayments() {
    const rows = await this.tx(
      (tx) => tx<
        {
          id: string;
          amount: number;
          receivedAt: string;
          reference: string | null;
          notes: string | null;
          invoiceQboId: string;
          clientOrgId: string;
          clientName: string;
          number: string;
        }[]
      >`
        select p.id, p.amount, p.received_at, p.reference, p.notes, i.qbo_id as invoice_qbo_id,
               i.client_org_id, i.client_name, i.number
        from finance.payments p join finance.invoices i on i.id = p.invoice_id
        where p.qbo_id is null and p.source = 'manual' and i.qbo_id is not null
        order by p.received_at, p.created_at limit 500`,
    );
    for (const p of rows) {
      try {
        const customerId = await this.ensureCustomer(p.clientOrgId, p.clientName);
        if (!customerId) throw new Error('Customer missing in QuickBooks');
        const e = await this.qbo.createPayment(p.id, {
          CustomerRef: { value: customerId },
          TotalAmt: p.amount,
          TxnDate: p.receivedAt,
          ...(p.reference ? { PaymentRefNum: p.reference.slice(0, 21) } : {}),
          ...(p.notes ? { PrivateNote: p.notes.slice(0, 4000) } : {}),
          ...(this.settings.depositAccountId
            ? { DepositToAccountRef: { value: this.settings.depositAccountId } }
            : {}),
          Line: [{ Amount: p.amount, LinkedTxn: [{ TxnId: p.invoiceQboId, TxnType: 'Invoice' }] }],
        });
        await this.tx(async (tx) => {
          await tx`update finance.payments set qbo_id = ${e.Id}, qbo_error = null where id = ${p.id}`;
          await putMapping(tx, this.tenantId, 'payment', p.id, e);
          await log(
            tx,
            this.tenantId,
            'payment',
            p.id,
            'push',
            'success',
            e.Id,
            `Payment ${p.amount.toFixed(2)} on ${p.number}`,
          );
        });
        this.result.payments.success++;
      } catch (err) {
        if (err instanceof AbortSync) throw err;
        await this.tx(async (tx) => {
          await tx`update finance.payments set qbo_error = ${errMessage(err)} where id = ${p.id}`;
          await log(tx, this.tenantId, 'payment', p.id, 'push', 'error', null, errMessage(err));
        });
        this.result.payments.error++;
        await this.onError(err);
      }
    }
  }

  private async pushBillPayments() {
    const rows = await this.tx(
      (tx) => tx<
        {
          id: string;
          amount: number;
          paidAt: string;
          reference: string | null;
          method: string;
          billQboId: string;
          vendorId: string;
          vendorName: string;
          number: string;
        }[]
      >`
        select p.id, p.amount, p.paid_at, p.reference, p.method, b.qbo_id as bill_qbo_id, b.vendor_id, b.vendor_name, b.number
        from finance.bill_payments p join finance.vendor_bills b on b.id = p.bill_id
        where p.qbo_id is null and b.qbo_id is not null
        order by p.paid_at, p.created_at limit 500`,
    );
    for (const p of rows) {
      try {
        const vendorQboId = await this.ensureVendor(p.vendorId, p.vendorName);
        if (!vendorQboId) throw new Error('Vendor missing in QuickBooks');
        const bank = this.settings.bankAccountId ?? this.settings.depositAccountId;
        if (!bank && this.qbo.kind === 'http')
          throw new Error('Choose a bank account in QuickBooks settings before syncing bill payments');
        const card = p.method === 'card';
        const e = await this.qbo.createBillPayment(p.id, {
          VendorRef: { value: vendorQboId },
          PayType: card ? 'CreditCard' : 'Check',
          ...(card
            ? { CreditCardPayment: { CCAccountRef: { value: bank ?? 'SIM-ACCT-CARD' } } }
            : { CheckPayment: { BankAccountRef: { value: bank ?? 'SIM-ACCT-BANK' } } }),
          TotalAmt: p.amount,
          TxnDate: p.paidAt,
          ...(p.reference ? { DocNumber: p.reference.slice(0, 21) } : {}),
          Line: [{ Amount: p.amount, LinkedTxn: [{ TxnId: p.billQboId, TxnType: 'Bill' }] }],
        });
        await this.tx(async (tx) => {
          await tx`update finance.bill_payments set qbo_id = ${e.Id}, qbo_error = null where id = ${p.id}`;
          await putMapping(tx, this.tenantId, 'bill_payment', p.id, e);
          await log(
            tx,
            this.tenantId,
            'bill_payment',
            p.id,
            'push',
            'success',
            e.Id,
            `Bill payment ${p.amount.toFixed(2)} on ${p.number}`,
          );
        });
        this.result.billPayments.success++;
      } catch (err) {
        if (err instanceof AbortSync) throw err;
        await this.tx(async (tx) => {
          await tx`update finance.bill_payments set qbo_error = ${errMessage(err)} where id = ${p.id}`;
          await log(tx, this.tenantId, 'bill_payment', p.id, 'push', 'error', null, errMessage(err));
        });
        this.result.billPayments.error++;
        await this.onError(err);
      }
    }
  }

  // ------------------------------------------------------------------ payments (pull)
  private async pullPayments(conn: ConnectionRow) {
    // Overlap by an hour: QBO LastUpdatedTime has second precision and clocks drift. Duplicates are skipped.
    const sinceMs = Date.parse(conn.lastSyncAt ?? conn.connectedAt) - 3_600_000;
    let remote: QboPayment[];
    try {
      remote = await this.qbo.paymentsSince(new Date(sinceMs).toISOString());
    } catch (err) {
      await this.tx((tx) => log(tx, this.tenantId, 'payment', null, 'pull', 'error', null, errMessage(err)));
      this.result.pulledPayments.error++;
      await this.onError(err);
      return;
    }
    for (const rp of remote) {
      // Payments we pushed ourselves come back in the query — skip them.
      const ours = await this.tx(
        (tx) => tx`select 1 from finance.qbo_entity_map where entity_type = 'payment' and qbo_id = ${rp.Id}`,
      );
      if (ours.length) continue;
      for (const line of rp.Line ?? []) {
        for (const link of line.LinkedTxn ?? []) {
          if (link.TxnType !== 'Invoice') continue;
          await this.pullPaymentLine(rp, link.TxnId, round2(line.Amount));
        }
      }
    }
  }

  private async pullPaymentLine(rp: QboPayment, invoiceQboId: string, amount: number) {
    try {
      const recorded = await this.tx(async (tx) => {
        const [map] = await tx<{ localId: string }[]>`
          select local_id from finance.qbo_entity_map where entity_type = 'invoice' and qbo_id = ${invoiceQboId}`;
        if (!map) return null; // not a Pro-Cure invoice
        const dup =
          await tx`select 1 from finance.payments where invoice_id = ${map.localId} and qbo_id = ${rp.Id}`;
        if (dup.length) return null;
        const { payment } = await applyInvoicePayment(
          tx,
          map.localId,
          {
            amount,
            receivedAt: rp.TxnDate ?? today(),
            method: methodFromQbo(rp.PaymentMethodRef?.name),
            reference: rp.PaymentRefNum ?? null,
            notes: 'Recorded in QuickBooks',
            source: 'qbo',
            qboId: rp.Id,
            createdByName: 'QuickBooks',
          },
          { tenantId: this.tenantId, actor: null },
        );
        await log(
          tx,
          this.tenantId,
          'payment',
          payment.id,
          'pull',
          'success',
          rp.Id,
          `Payment ${amount.toFixed(2)} pulled from QuickBooks`,
        );
        return payment.id;
      });
      if (recorded) this.result.pulledPayments.success++;
    } catch (err) {
      await this.tx((tx) => log(tx, this.tenantId, 'payment', null, 'pull', 'error', rp.Id, errMessage(err)));
      this.result.pulledPayments.error++;
    }
  }
}

const methodFromQbo = (name: string | undefined): 'ach' | 'wire' | 'check' | 'card' | 'other' => {
  const n = (name ?? '').toLowerCase();
  if (n.includes('check') || n.includes('cheque')) return 'check';
  if (n.includes('wire')) return 'wire';
  if (n.includes('ach') || n.includes('eft') || n.includes('bank')) return 'ach';
  if (n.includes('card') || n.includes('visa') || n.includes('master') || n.includes('amex')) return 'card';
  return 'other';
};
