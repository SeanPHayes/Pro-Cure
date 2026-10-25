import { withOwner } from '@procure/platform';
import type { Ctx } from './business.js';

/**
 * Money: owner deposit invoices (drafted automatically when each quote was approved) sent and paid,
 * a progress invoice now past due, vendor deposit bills (created automatically when POs were issued)
 * paid for Hampton, balance bills for delivered goods, and a simulated QuickBooks Online sync.
 */
export async function seed(ctx: Ctx) {
  const { call, day, staff, out } = ctx;
  const ellen = staff.ellen;
  const list = async (q: string) => {
    const r = await call<any>(ellen, 'finance', 'GET', `/invoices?${q}`);
    return (r.items ?? r) as any[];
  };
  const projects = out.projects;

  // Owner invoices ------------------------------------------------------------------------------
  const drafts = await list('status=draft&limit=50');
  for (const inv of drafts) {
    await call(ellen, 'finance', 'POST', `/invoices/${inv.id}/send`, {
      message:
        'Deposit invoice for the approved FF&E package. Production is scheduled on receipt of deposit.',
    });
    if (inv.projectId === projects.hampton.id)
      await call(ellen, 'finance', 'POST', `/invoices/${inv.id}/payments`, {
        amount: inv.total,
        receivedAt: day(-68),
        method: 'wire',
        reference: 'Wire 20260818-CLP',
      });
    else if (inv.projectId === projects.home2.id)
      await call(ellen, 'finance', 'POST', `/invoices/${inv.id}/payments`, {
        amount: Math.round(inv.total * 0.6 * 100) / 100,
        receivedAt: day(-3),
        method: 'ach',
        reference: 'ACH BRHG-55102',
      });
  }
  // Hampton progress billing on delivered goods — now past due.
  const hx = out.quotes.hampton.quote;
  const progress = await call<any>(ellen, 'finance', 'POST', '/invoices/from-quote', {
    quoteId: hx.id,
    kind: 'progress',
    percent: 30,
    dueInDays: 30,
    poReference: 'CLP-PO-1182',
    notes: 'Progress billing — floors 1–2 casegoods, lighting and carpet delivered.',
  });
  await call(ellen, 'finance', 'POST', `/invoices/${progress.id}/send`, {});
  await call(ellen, 'finance', 'POST', `/invoices/${progress.id}/payments`, {
    amount: 25000,
    receivedAt: day(-6),
    method: 'check',
    reference: 'Check 10442',
  });

  // Vendor bills -----------------------------------------------------------------------------------
  const bills = ((await call<any>(ellen, 'finance', 'GET', '/bills?limit=100')).items ?? []) as any[];
  for (const b of bills) {
    if (b.kind !== 'deposit') continue;
    if (b.projectId === projects.hampton.id)
      await call(ellen, 'finance', 'POST', `/bills/${b.id}/payments`, {
        amount: b.balance ?? b.amount,
        paidAt: day(-72),
        method: 'ach',
        reference: `ACH ${b.number}`,
      });
  }
  for (const po of out.pos?.hampton ?? []) {
    if (!['lumen', 'meridian'].some((k) => out.vendorIds[k] === po.vendorId)) continue;
    await call(ellen, 'finance', 'POST', '/bills', {
      projectId: projects.hampton.id,
      poId: po.id,
      poNumber: po.number,
      vendorId: po.vendorId,
      vendorName: po.vendorName,
      number: `INV-${po.number.replace('PO-', '')}`,
      kind: 'balance',
      billDate: day(-12),
      dueDate: day(18),
      amount: po.total,
    });
  }

  // Back-date the Hampton invoices so aging buckets look real.
  await withOwner(async (tx) => {
    await tx`update finance.invoices set issue_date = ${day(-75)}::date, due_date = ${day(-68)}::date,
               sent_at = ${day(-75)}::date + time '09:00'
             where tenant_id = ${ctx.ids.tenantId} and project_id = ${projects.hampton.id} and kind = 'deposit'`;
    await tx`update finance.invoices set issue_date = ${day(-44)}::date, due_date = ${day(-14)}::date,
               sent_at = ${day(-44)}::date + time '09:00', status = 'overdue'
             where id = ${progress.id}`;
    await tx`update finance.invoices set issue_date = ${day(-9)}::date, due_date = ${day(21)}::date,
               sent_at = ${day(-9)}::date + time '09:00'
             where tenant_id = ${ctx.ids.tenantId} and project_id = ${projects.home2.id} and kind = 'deposit'`;
  });

  // QuickBooks Online (simulated in the demo) ---------------------------------------------------
  await call(ellen, 'finance', 'POST', '/integrations/qbo/simulate', {});
  await call(ellen, 'finance', 'POST', '/integrations/qbo/sync', {});
  console.log('  invoices sent and paid, vendor bills, QuickBooks sync');
}
