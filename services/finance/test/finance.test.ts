import { buildService, closeDb, withOwner } from '@procure/platform';
import { auth, createWorld, type World } from '@procure/platform/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addDays, isoDate } from '../src/domain/invoicing.js';
import { markOverdue } from '../src/jobs.js';
import { financeService } from '../src/service.js';
import { event, internalHeaders, outbox, seedProject, stubClients, upstream } from './helpers.js';

let app: Awaited<ReturnType<typeof buildService>>;
let a: World;
let b: World;
const todayIso = () => isoDate(new Date());

beforeAll(async () => {
  app = await buildService(financeService);
  a = await createWorld('Alpha');
  b = await createWorld('Bravo');
});
beforeEach(() => {
  stubClients();
  upstream.quotingDown = false;
});
afterAll(async () => {
  await app.close();
  await closeDb();
});

const post = (token: string, url: string, payload: unknown = {}) =>
  app.inject({ method: 'POST', url, headers: auth(token), payload: payload as never });
const get = (token: string, url: string) => app.inject({ method: 'GET', url, headers: auth(token) });

async function sentInvoice(w: World, amount = 1000, dueInDays = 30) {
  const { projectId } = seedProject(w);
  const created = await post(w.adminToken, '/invoices', {
    projectId,
    dueInDays,
    lines: [{ description: 'Design fee', quantity: 1, unitPrice: amount }],
  });
  expect(created.statusCode).toBe(201);
  const inv = created.json();
  const sent = await post(w.adminToken, `/invoices/${inv.id}/send`, {});
  expect(sent.statusCode).toBe(200);
  return { ...sent.json().invoice, projectId };
}

describe('invoices from quotes', () => {
  it('deposit is 50% of sell total; final bills the remainder', async () => {
    const { projectId, quoteId } = seedProject(a, { sellTotal: 125_000.5 });
    const dep = await post(a.adminToken, '/invoices/from-quote', { quoteId, kind: 'deposit' });
    expect(dep.statusCode).toBe(201);
    const d = dep.json();
    expect(d).toMatchObject({
      kind: 'deposit',
      status: 'draft',
      projectId,
      clientOrgId: a.clientOrgId,
      quoteNumber: 'Q-26-0012',
      total: 62_500.25,
      balance: 62_500.25,
      terms: 'Due on receipt',
      qboSyncStatus: 'pending',
    });
    expect(d.number).toMatch(/^INV-\d{2}-\d{4}$/);
    expect(d.lines[0].description).toBe("Deposit — 50% of Quote Q-26-0012 'Guestroom FF&E'");

    const prog = await post(a.adminToken, '/invoices/from-quote', {
      quoteId,
      kind: 'progress',
      amount: 20_000,
    });
    expect(prog.json().total).toBe(20_000);

    const fin = await post(a.adminToken, '/invoices/from-quote', { quoteId, kind: 'final', dueInDays: 45 });
    expect(fin.statusCode).toBe(201);
    expect(fin.json()).toMatchObject({ total: 42_500.25, terms: 'Net 45' });
    expect(fin.json().dueDate).toBe(addDays(todayIso(), 45));

    const again = await post(a.adminToken, '/invoices/from-quote', { quoteId, kind: 'final' });
    expect(again.statusCode).toBe(422);
  });

  it('voided invoices do not count toward the final invoice', async () => {
    const { quoteId } = seedProject(a, { sellTotal: 10_000 });
    const dep = (
      await post(a.adminToken, '/invoices/from-quote', { quoteId, kind: 'deposit', percent: 40 })
    ).json();
    expect(dep.total).toBe(4000);
    expect(
      (await post(a.adminToken, `/invoices/${dep.id}/void`, { reason: 'wrong pct' })).json().status,
    ).toBe('void');
    const fin = (await post(a.adminToken, '/invoices/from-quote', { quoteId, kind: 'final' })).json();
    expect(fin.total).toBe(10_000);
  });

  it('deposit requires a client-approved quote', async () => {
    const { quoteId } = seedProject(a, { status: 'sent' });
    const res = await post(a.adminToken, '/invoices/from-quote', { quoteId, kind: 'deposit' });
    expect(res.statusCode).toBe(422);
  });

  it('requires finance:write', async () => {
    const { quoteId } = seedProject(a);
    const pm = await a.tokenAs(['project_manager']);
    const res = await post(pm, '/invoices/from-quote', { quoteId, kind: 'deposit' });
    expect(res.statusCode).toBe(403);
    expect((await get(pm, '/invoices')).statusCode).toBe(200);
  });
});

describe('invoice lifecycle', () => {
  it('draft edits, send renders the PDF and emails owner contacts', async () => {
    const { projectId } = seedProject(a);
    const inv = (
      await post(a.adminToken, '/invoices', {
        projectId,
        taxRate: 7.25,
        poReference: 'HIR-PO-778',
        lines: [{ description: 'Lobby chairs', quantity: 4, unitPrice: 250 }],
      })
    ).json();
    expect(inv).toMatchObject({ subtotal: 1000, tax: 72.5, total: 1072.5, terms: 'Net 30' });

    const patched = await app.inject({
      method: 'PATCH',
      url: `/invoices/${inv.id}`,
      headers: auth(a.adminToken),
      payload: { lines: [{ description: 'Lobby chairs', quantity: 2, unitPrice: 250 }], notes: 'Thanks!' },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ subtotal: 500, tax: 36.25, total: 536.25, notes: 'Thanks!' });

    const sent = await post(a.adminToken, `/invoices/${inv.id}/send`, { message: 'Hello' });
    expect(sent.statusCode).toBe(200);
    const body = sent.json();
    expect(body.invoice.status).toBe('sent');
    expect(body.invoice.documentId).toBe(body.documentId);
    expect(body.recipients.sort()).toEqual(['gm@hotel.example', 'olivia@owner.example']);
    const render = upstream.rendered.at(-1)!;
    expect(render.template).toBe('invoice');
    expect(render.clientOrgId).toBe(a.clientOrgId);
    expect(render.data.totals).toEqual({
      subtotal: 500,
      tax: 36.25,
      total: 536.25,
      paid: 0,
      balance: 536.25,
    });

    const issued = await outbox(a.tenantId, 'finance.invoice.issued');
    expect(issued.some((e) => e.data.invoiceId === inv.id)).toBe(true);
    const emails = await outbox(a.tenantId, 'cmd.email.send');
    const email = emails.find((e) => e.data.attachments[0]?.documentId === body.documentId)!;
    expect(email.data.subject).toContain(inv.number);
    expect(email.data.text).toContain('Hello');

    const locked = await app.inject({
      method: 'PATCH',
      url: `/invoices/${inv.id}`,
      headers: auth(a.adminToken),
      payload: { notes: 'too late' },
    });
    expect(locked.statusCode).toBe(422);
  });

  it('payments move status to partially_paid then paid and emit finance.payment.received', async () => {
    const inv = await sentInvoice(a, 1000);
    const draft = (
      await post(a.adminToken, '/invoices', {
        projectId: inv.projectId,
        lines: [{ description: 'x', unitPrice: 5 }],
      })
    ).json();
    expect((await post(a.adminToken, `/invoices/${draft.id}/payments`, { amount: 5 })).statusCode).toBe(422);

    const p1 = await post(a.adminToken, `/invoices/${inv.id}/payments`, {
      amount: 400,
      method: 'ach',
      reference: 'ACH-1',
    });
    expect(p1.statusCode).toBe(201);
    expect(p1.json().invoice).toMatchObject({ status: 'partially_paid', amountPaid: 400, balance: 600 });
    expect((await post(a.adminToken, `/invoices/${inv.id}/payments`, { amount: 600.01 })).statusCode).toBe(
      422,
    );
    const p2 = await post(a.adminToken, `/invoices/${inv.id}/payments`, { amount: 600, method: 'check' });
    expect(p2.json().invoice).toMatchObject({ status: 'paid', balance: 0 });

    const detail = (await get(a.adminToken, `/invoices/${inv.id}`)).json();
    expect(detail.payments.map((p: any) => p.amount)).toEqual([400, 600]);
    const evts = (await outbox(a.tenantId, 'finance.payment.received')).filter(
      (e) => e.data.invoiceId === inv.id,
    );
    expect(evts.map((e) => e.data.amount)).toEqual([400, 600]);

    expect((await post(a.adminToken, `/invoices/${inv.id}/void`, {})).statusCode).toBe(422);

    const activity = await withOwner(
      (tx) =>
        tx`select action from platform.activity_log where entity_type = 'payment' and parent_id = ${inv.id}`,
    );
    expect(activity).toHaveLength(2);
  });

  it('lists with filters, aging and pagination', async () => {
    const inv = await sentInvoice(a, 250);
    const res = await get(
      a.adminToken,
      `/invoices?projectId=${inv.projectId}&status=sent,partially_paid&limit=5`,
    );
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ total: 1, limit: 5, offset: 0 });
    expect(body.items[0]).toMatchObject({ id: inv.id, agingBucket: 'current', daysOverdue: 0 });
    const q = await get(a.adminToken, `/invoices?q=${encodeURIComponent(inv.number)}`);
    expect(q.json().items.map((i: any) => i.id)).toEqual([inv.id]);
  });

  it('overdue job marks past-due invoices and notifies accounting', async () => {
    const inv = await sentInvoice(a, 300, 10);
    const later = addDays(todayIso(), 12);
    const r = await withOwner((tx) => markOverdue(tx, later));
    expect(r.marked).toBeGreaterThanOrEqual(1);
    const after = (await get(a.adminToken, `/invoices/${inv.id}`)).json();
    expect(after.status).toBe('overdue');
    const notes = await outbox(a.tenantId, 'cmd.notify');
    expect(notes.some((n) => n.data.roles.includes('accounting') && n.data.severity === 'warning')).toBe(
      true,
    );
    // Paying it in full clears overdue.
    const paid = await post(a.adminToken, `/invoices/${inv.id}/payments`, { amount: 300 });
    expect(paid.json().invoice.status).toBe('paid');
    // Idempotent: nothing more to mark for this invoice.
    const r2 = await withOwner((tx) => markOverdue(tx, later));
    expect(r2.marked).toBe(0);
  });
});

describe('vendor bills', () => {
  it('payments update balance and emit finance.vendor_bill.paid with kind when fully paid', async () => {
    const { projectId } = seedProject(a);
    const vendorId = crypto.randomUUID();
    upstream.vendors.set(vendorId, {
      id: vendorId,
      name: 'Acme Casegoods',
      depositPct: null,
      paymentTerms: 'Net 15',
    });
    const created = await post(a.adminToken, '/bills', {
      projectId,
      vendorId,
      number: 'AC-9912',
      kind: 'balance',
      amount: 5000,
      billDate: '2026-10-01',
    });
    expect(created.statusCode).toBe(201);
    const bill = created.json();
    expect(bill).toMatchObject({
      vendorName: 'Acme Casegoods',
      dueDate: '2026-10-16',
      status: 'open',
      balance: 5000,
    });

    const p1 = await post(a.adminToken, `/bills/${bill.id}/payments`, { amount: 2000 });
    expect(p1.json().bill).toMatchObject({ status: 'partially_paid', balance: 3000 });
    expect(
      (await outbox(a.tenantId, 'finance.vendor_bill.paid')).filter((e) => e.data.billId === bill.id),
    ).toHaveLength(0);
    const p2 = await post(a.adminToken, `/bills/${bill.id}/payments`, { amount: 3000, method: 'wire' });
    expect(p2.json().bill).toMatchObject({ status: 'paid', balance: 0 });
    const paid = (await outbox(a.tenantId, 'finance.vendor_bill.paid')).filter(
      (e) => e.data.billId === bill.id,
    );
    expect(paid).toHaveLength(1);
    expect(paid[0]!.data).toMatchObject({ kind: 'balance', vendorId, amount: 5000, poId: null });

    const list = await get(a.adminToken, `/bills?vendorId=${vendorId}&status=paid`);
    expect(list.json().total).toBe(1);
    expect((await post(a.adminToken, `/bills/${bill.id}/payments`, { amount: 1 })).statusCode).toBe(422);
  });

  it('orders.po.issued creates a deposit bill once when the vendor requires a deposit', async () => {
    const { projectId } = seedProject(a);
    const vendorId = crypto.randomUUID();
    const poId = crypto.randomUUID();
    upstream.vendors.set(vendorId, { id: vendorId, name: 'Deposit Seating Co', depositPct: 30 });
    const data = { poId, projectId, vendorId, number: 'PO-26-0042', revision: 0, total: 12_345.67 };
    const e1 = event(a.tenantId, 'orders.po.issued', data);
    const r1 = await app.inject({
      method: 'POST',
      url: '/internal/events',
      headers: internalHeaders,
      payload: e1,
    });
    expect(r1.json().result).toBe('processed');
    // Same event redelivered, and a revision re-issue: both no-ops.
    expect(
      (
        await app.inject({ method: 'POST', url: '/internal/events', headers: internalHeaders, payload: e1 })
      ).json().result,
    ).toBe('duplicate');
    await app.inject({
      method: 'POST',
      url: '/internal/events',
      headers: internalHeaders,
      payload: event(a.tenantId, 'orders.po.issued', { ...data, revision: 1 }),
    });
    const bills = (await get(a.adminToken, `/bills?poId=${poId}`)).json();
    expect(bills.total).toBe(1);
    expect(bills.items[0]).toMatchObject({
      kind: 'deposit',
      number: 'DEP-PO-26-0042',
      amount: 3703.7,
      status: 'open',
      dueDate: addDays(todayIso(), 7),
      vendorName: 'Deposit Seating Co',
    });

    const noDep = crypto.randomUUID();
    upstream.vendors.set(noDep, { id: noDep, name: 'Net 30 Lighting', depositPct: 0 });
    const otherPo = crypto.randomUUID();
    await app.inject({
      method: 'POST',
      url: '/internal/events',
      headers: internalHeaders,
      payload: event(a.tenantId, 'orders.po.issued', { ...data, poId: otherPo, vendorId: noDep }),
    });
    expect((await get(a.adminToken, `/bills?poId=${otherPo}`)).json().total).toBe(0);
  });

  it('quote approval drafts a 50% deposit invoice once and notifies accounting', async () => {
    const { projectId, quoteId } = seedProject(a, { sellTotal: 88_000 });
    const data = { quoteId, projectId, decision: 'approved', decidedBy: 'Olivia', comment: null };
    await app.inject({
      method: 'POST',
      url: '/internal/events',
      headers: internalHeaders,
      payload: event(a.tenantId, 'quoting.quote.client_decided', data),
    });
    await app.inject({
      method: 'POST',
      url: '/internal/events',
      headers: internalHeaders,
      payload: event(a.tenantId, 'quoting.quote.client_decided', data),
    });
    const list = (await get(a.adminToken, `/invoices?quoteId=${quoteId}`)).json();
    expect(list.total).toBe(1);
    expect(list.items[0]).toMatchObject({ kind: 'deposit', status: 'draft', total: 44_000 });
    const notes = await outbox(a.tenantId, 'cmd.notify');
    expect(notes.some((n) => n.data.title === 'Deposit invoice ready to send for Q-26-0012')).toBe(true);
  });
});

describe('financials', () => {
  it('project financials combine quotes, POs, AR and AP', async () => {
    const { projectId, quoteId } = seedProject(b, { sellTotal: 100_000, costTotal: 75_000 });
    upstream.pos.set(projectId, [
      {
        id: crypto.randomUUID(),
        number: 'PO-1',
        vendorId: crypto.randomUUID(),
        status: 'issued',
        total: 30_000,
        issuedAt: new Date().toISOString(),
      },
      {
        id: crypto.randomUUID(),
        number: 'PO-2',
        vendorId: crypto.randomUUID(),
        status: 'draft',
        total: 9_999,
        issuedAt: null,
      },
    ]);
    const dep = (await post(b.adminToken, '/invoices/from-quote', { quoteId, kind: 'deposit' })).json();
    await post(b.adminToken, `/invoices/${dep.id}/send`, {});
    await post(b.adminToken, `/invoices/${dep.id}/payments`, { amount: 50_000 });
    const vendorId = crypto.randomUUID();
    const bill = (
      await post(b.adminToken, '/bills', { projectId, vendorId, vendorName: 'V', number: 'B1', amount: 9000 })
    ).json();
    await post(b.adminToken, `/bills/${bill.id}/payments`, { amount: 9000 });

    const f = (await get(b.adminToken, `/projects/${projectId}/financials`)).json();
    expect(f).toMatchObject({
      contractValue: 100_000,
      estimatedCost: 75_000,
      committedCost: 30_000,
      invoiced: 50_000,
      collected: 50_000,
      arBalance: 0,
      apBilled: 9000,
      apPaid: 9000,
      apOpen: 0,
      depositsCollected: 50_000,
      projectedMarginPct: 25,
      actualMarginToDate: 41_000,
      warnings: [],
    });
    expect(f.byMonth).toHaveLength(12);
    expect(f.byMonth.at(-1)).toMatchObject({ cashIn: 50_000, cashOut: 9000, net: 41_000 });

    upstream.quotingDown = true;
    const partial = (await get(b.adminToken, `/projects/${projectId}/financials`)).json();
    expect(partial.contractValue).toBe(0);
    expect(partial.collected).toBe(50_000);
    expect(partial.warnings[0]).toMatch(/quoting unavailable/);

    const portfolio = (await get(b.adminToken, '/financials/portfolio')).json();
    expect(portfolio.rows.some((r: any) => r.projectId === projectId)).toBe(true);
    expect(Object.keys(portfolio.arAging)).toEqual(['current', '1-30', '31-60', '61-90', '90+']);
    expect(portfolio.warnings.length).toBeGreaterThan(0);
  });
});

describe('exports', () => {
  it('CSV and IIF downloads with content-disposition', async () => {
    const inv = await sentInvoice(a, 1234.5);
    const csv = await get(a.adminToken, `/exports/invoices.csv?from=${todayIso()}&to=${todayIso()}`);
    expect(csv.statusCode).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.headers['content-disposition']).toMatch(/attachment; filename="invoices-.*\.csv"/);
    expect(csv.body.split('\r\n')[0]).toMatch(/^Invoice #,Kind,Status/);
    expect(csv.body).toContain(inv.number);

    const bills = await get(a.adminToken, '/exports/bills.csv');
    expect(bills.statusCode).toBe(200);
    expect(bills.body.startsWith('Bill #,')).toBe(true);

    const iif = await get(a.adminToken, `/exports/qbo.iif?from=${todayIso()}`);
    expect(iif.statusCode).toBe(200);
    expect(iif.headers['content-disposition']).toMatch(/\.iif"/);
    const lines = iif.body.split('\r\n');
    expect(lines[0]!.startsWith('!TRNS\tTRNSID\tTRNSTYPE\tDATE\tACCNT\tNAME\tAMOUNT')).toBe(true);
    expect(lines[1]!.startsWith('!SPL\t')).toBe(true);
    expect(lines[2]).toBe('!ENDTRNS');
    expect(iif.body).toContain(`\tINVOICE\t`);
    expect(iif.body).toContain(`\t1234.50\t${inv.number}\t`);

    expect((await get(a.adminToken, '/exports/invoices.csv?from=2026-12-01&to=2026-01-01')).statusCode).toBe(
      400,
    );
  });
});

describe('client portal & isolation', () => {
  it('clients see only their own non-draft invoices, without QBO fields', async () => {
    const sent = await sentInvoice(a, 777);
    const { projectId } = seedProject(a);
    const draft = (
      await post(a.adminToken, '/invoices', { projectId, lines: [{ description: 'd', unitPrice: 1 }] })
    ).json();

    // Another client org of the same tenant.
    const otherClient = await withOwner(async (tx) => {
      const [o] = await tx<{ id: string }[]>`
        insert into identity.organizations (type, name, slug) values ('client', 'Other Owner', ${`other-${crypto.randomUUID().slice(0, 8)}`}) returning id`;
      return o!.id;
    });
    const otherProject = crypto.randomUUID();
    upstream.projects.set(otherProject, {
      ...upstream.projects.get(projectId)!,
      id: otherProject,
      clientOrgId: otherClient,
    });
    const other = (
      await post(a.adminToken, '/invoices', {
        projectId: otherProject,
        lines: [{ description: 'o', unitPrice: 9 }],
      })
    ).json();
    await post(a.adminToken, `/invoices/${other.id}/send`, {});
    await post(a.adminToken, `/invoices/${sent.id}/payments`, { amount: 77, reference: 'CHK-1' });

    const list = await get(a.clientToken, '/client/invoices?limit=100');
    expect(list.statusCode).toBe(200);
    const ids = list.json().items.map((i: any) => i.id);
    expect(ids).toContain(sent.id);
    expect(ids).not.toContain(draft.id);
    expect(ids).not.toContain(other.id);
    for (const item of list.json().items) {
      expect(item).not.toHaveProperty('qboId');
      expect(item).not.toHaveProperty('qboSyncStatus');
      expect(item).not.toHaveProperty('createdByName');
      expect(item).not.toHaveProperty('clientOrgId');
    }

    const detail = await get(a.clientToken, `/client/invoices/${sent.id}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ balance: 700, amountPaid: 77 });
    expect(detail.json().payments[0]).toEqual(expect.objectContaining({ amount: 77, reference: 'CHK-1' }));
    expect(detail.json().payments[0]).not.toHaveProperty('notes');
    expect(detail.json()).not.toHaveProperty('qboError');
    expect((await get(a.clientToken, `/client/invoices/${draft.id}`)).statusCode).toBe(404);
    expect((await get(a.clientToken, `/client/invoices/${other.id}`)).statusCode).toBe(404);

    // Internal routes are closed to clients and vendors; RLS would return nothing anyway.
    expect((await get(a.clientToken, `/invoices/${sent.id}`)).statusCode).toBe(403);
    expect((await get(a.vendorToken, '/bills')).statusCode).toBe(403);
    expect((await get(a.adminToken, '/client/invoices')).statusCode).toBe(403);
  });

  it('RLS: client actors cannot read drafts, other orgs, or bills even with direct SQL', async () => {
    const { withContext } = await import('@procure/platform');
    const ctx = {
      tenantId: a.tenantId,
      userId: a.clientUserId,
      orgId: a.clientOrgId,
      actor: 'client' as const,
    };
    const rows = await withContext(
      ctx,
      (tx) =>
        tx<{ status: string; clientOrgId: string }[]>`select status, client_org_id from finance.invoices`,
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.status !== 'draft' && r.clientOrgId === a.clientOrgId)).toBe(true);
    expect(await withContext(ctx, (tx) => tx`select 1 from finance.vendor_bills`)).toHaveLength(0);
    expect(await withContext(ctx, (tx) => tx`select 1 from finance.qbo_sync_log`)).toHaveLength(0);
    const vctx = {
      tenantId: a.tenantId,
      userId: a.vendorUserId,
      orgId: a.vendorOrgId,
      actor: 'vendor' as const,
    };
    expect(await withContext(vctx, (tx) => tx`select 1 from finance.invoices`)).toHaveLength(0);
  });

  it("tenants cannot see each other's invoices or bills", async () => {
    const inv = await sentInvoice(a, 10);
    expect((await get(b.adminToken, `/invoices/${inv.id}`)).statusCode).toBe(404);
    const bList = (await get(b.adminToken, '/invoices?limit=500')).json();
    expect(bList.items.some((i: any) => i.id === inv.id)).toBe(false);
    expect((await post(b.adminToken, `/invoices/${inv.id}/payments`, { amount: 1 })).statusCode).toBe(404);
  });
});
