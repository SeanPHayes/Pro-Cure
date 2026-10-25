import { round2 } from '@procure/domain';
import { emit, on, type Tx } from '@procure/platform';
import { clients } from './clients.js';
import { addDays, InvoicingRuleError, quoteInvoiceLine } from './domain/invoicing.js';
import type { Logger } from './log.js';
import { createInvoice, invoicedForQuote, today } from './repo.js';

/** Default deposit percentage requested from the client when a quote is approved. */
export const CLIENT_DEPOSIT_PCT = 50;

/**
 * orders.po.issued → deposit bill when the vendor's terms require a deposit.
 * Idempotent on (po_id, kind='deposit') via a partial unique index; revisions re-issue the same PO
 * and are no-ops once the deposit bill exists.
 */
export async function handlePoIssued(
  tx: Tx,
  tenantId: string,
  data: { poId: string; projectId: string; vendorId: string; number: string; total: number },
  log?: Logger,
) {
  const [existing] = await tx`
    select id from finance.vendor_bills where po_id = ${data.poId} and kind = 'deposit' and status <> 'void'`;
  if (existing) return null;
  const vendor = await clients.vendor(tenantId, data.vendorId);
  const pct = vendor.profile?.depositPct ?? 0;
  if (!pct || pct <= 0) return null;
  const amount = round2((data.total * pct) / 100);
  if (amount <= 0) return null;
  const billDate = today();
  const [bill] = await tx<{ id: string }[]>`
    insert into finance.vendor_bills ${tx({
      tenantId,
      projectId: data.projectId,
      poId: data.poId,
      poNumber: data.number,
      vendorId: data.vendorId,
      vendorName: vendor.name,
      number: `DEP-${data.number}`,
      kind: 'deposit',
      status: 'open',
      billDate,
      dueDate: addDays(billDate, 7),
      amount,
      amountPaid: 0,
      balance: amount,
      notes: `${pct}% deposit required by ${vendor.name} on PO ${data.number}`,
      qboSyncStatus: 'pending',
      createdByName: 'Pro-Cure',
    })}
    on conflict do nothing
    returning id`;
  if (bill) log?.info({ poId: data.poId, billId: bill.id, amount }, 'deposit bill created');
  return bill?.id ?? null;
}

/**
 * quoting.quote.client_decided (approved) → draft deposit invoice + notify accounting.
 * Idempotent: skipped if the quote already has a non-void deposit invoice.
 */
export async function handleQuoteApproved(
  tx: Tx,
  tenantId: string,
  data: { quoteId: string; projectId: string; decision: string },
  log?: Logger,
) {
  if (data.decision !== 'approved') return null;
  await tx`select pg_advisory_xact_lock(hashtext(${`finance:quote:${data.quoteId}`}))`;
  const [existing] = await tx`
    select id from finance.invoices where quote_id = ${data.quoteId} and kind = 'deposit' and status <> 'void'`;
  if (existing) return null;
  const [quotes, project] = await Promise.all([
    clients.quoteSummary(tenantId, data.projectId),
    clients.project(tenantId, data.projectId),
  ]);
  const quote = quotes.find((q) => q.id === data.quoteId);
  if (!quote) {
    log?.warn({ quoteId: data.quoteId }, 'approved quote not found in summary; no deposit invoice');
    return null;
  }
  if (!project.clientOrgId) {
    log?.warn({ projectId: data.projectId }, 'project has no client org; no deposit invoice');
    return null;
  }
  let line: ReturnType<typeof quoteInvoiceLine>;
  try {
    // The event says approved even if the summary lags; treat it as approved.
    line = quoteInvoiceLine(
      { ...quote, status: 'client_approved' },
      { kind: 'deposit', percent: CLIENT_DEPOSIT_PCT },
      await invoicedForQuote(tx, quote.id),
    );
  } catch (err) {
    if (err instanceof InvoicingRuleError) {
      log?.info({ quoteId: quote.id, reason: err.message }, 'no deposit invoice');
      return null;
    }
    throw err;
  }
  const [prev] = await tx<{ clientName: string }[]>`
    select client_name from finance.invoices where client_org_id = ${project.clientOrgId} order by created_at desc limit 1`;
  const issueDate = today();
  const id = await createInvoice(tx, {
    tenantId,
    projectId: project.id,
    projectNumber: project.number,
    projectName: project.name,
    clientOrgId: project.clientOrgId,
    clientName: prev?.clientName ?? project.propertyName ?? project.name,
    quoteId: quote.id,
    quoteNumber: quote.number,
    kind: 'deposit',
    issueDate,
    dueDate: issueDate,
    terms: 'Due on receipt',
    taxRate: 0,
    createdByName: 'Pro-Cure',
    lines: [line],
  });
  const [inv] = await tx<
    { number: string; total: number }[]
  >`select number, total from finance.invoices where id = ${id}`;
  await emit(
    tx,
    'finance',
    'cmd.notify',
    {
      userIds: [],
      roles: ['accounting'],
      title: `Deposit invoice ready to send for ${quote.number}`,
      body: `${inv!.number} — ${CLIENT_DEPOSIT_PCT}% deposit ($${inv!.total.toFixed(2)}) for ${project.name} was drafted when the client approved ${quote.number} '${quote.name}'.`,
      link: `/app/invoices/${id}`,
      severity: 'info',
    },
    { tenantId, actor: null },
  );
  return id;
}

export const subscriptions = [
  on('orders.po.issued', async (event, { tx, log }) => {
    if (!event.tenantId) return;
    await handlePoIssued(tx, event.tenantId, event.data, log);
  }),
  on('quoting.quote.client_decided', async (event, { tx, log }) => {
    if (!event.tenantId) return;
    await handleQuoteApproved(tx, event.tenantId, event.data, log);
  }),
];
