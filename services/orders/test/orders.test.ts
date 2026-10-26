import { buildService, closeDb, internalSecret, rootLogger, runJobOnce, withOwner } from '@procure/platform';
import { createWorld, tokenFor, type World } from '@procure/platform/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as clientsModule from '../src/clients.js';
import { addDays, today } from '../src/domain/dates.js';
import { escalations, shipDateConfirmations, trackingMissing, trackingPoll } from '../src/jobs.js';
import { ordersService } from '../src/service.js';
import { SimulatedTrackingProvider, setTrackingProvider } from '../src/tracking/index.js';
import { type Fixture, json, type Mocked, outbox, setupQuote } from './helpers.js';

vi.mock('../src/clients.js', () => ({
  getOrderLines: vi.fn(),
  getVendor: vi.fn(),
  getProject: vi.fn(),
  getOrg: vi.fn(),
  renderReport: vi.fn(),
  openThread: vi.fn(),
}));
const clients = clientsModule as unknown as Mocked;

let app: Awaited<ReturnType<typeof buildService>>;
let a: World;
let b: World;
const log = rootLogger('orders-test');

beforeAll(async () => {
  app = await buildService(ordersService, log);
  a = await createWorld('Alpha');
  b = await createWorld('Bravo');
});
afterAll(async () => {
  setTrackingProvider(undefined);
  await app.close();
  await closeDb();
});
beforeEach(() => {
  vi.clearAllMocks();
});

/** Create POs from the fixture quote (cg, ss → vendor A; lt → vendor B). */
async function createPos(w: World, f: Fixture, body: Record<string, unknown> = {}) {
  const res = await app.inject(
    json('POST', '/purchase-orders/from-quote', w.adminToken, {
      quoteId: f.quoteId,
      lineIds: [f.lines.cg, f.lines.ss, f.lines.lt],
      requestedDeliveryDate: '2027-05-01',
      ...body,
    }),
  );
  expect(res.statusCode, res.body).toBe(201);
  const items = res.json().items as any[];
  return {
    poA: items.find((p) => p.vendorId === f.vendorA),
    poB: items.find((p) => p.vendorId === f.vendorB),
  };
}

async function issue(w: World, poId: string) {
  const res = await app.inject(
    json('POST', `/purchase-orders/${poId}/issue`, w.adminToken, { message: 'Thanks!' }),
  );
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

const COST_KEYS = [
  'unitCost',
  'unit_cost',
  'extended',
  'subtotal',
  'total',
  'freight',
  'tax',
  'paymentTerms',
  'depositPct',
];
const SELL_KEYS = ['unitPrice', 'unit_price', 'sellPrice', 'markup', 'margin'];
const INTERNAL_KEYS = ['notes', 'riskScore', 'riskLevel', 'riskReasons', 'escalationReasons', 'clientOrgId'];
function keysDeep(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) for (const x of v) keysDeep(x, out);
  else if (v && typeof v === 'object')
    for (const [k, x] of Object.entries(v)) {
      out.add(k);
      keysDeep(x, out);
    }
  return out;
}

// =============================================================================================
describe('purchase orders from a quote', () => {
  it('groups lines by vendor into draft POs with vendor terms, defaults and shipment A', async () => {
    const f = setupQuote(clients, a);
    const { poA, poB } = await createPos(a, f);
    expect(clients.getOrderLines).toHaveBeenCalledWith(a.tenantId, f.quoteId, expect.any(Array));
    expect(poA).toMatchObject({
      status: 'draft',
      vendorName: 'Acme Casegoods',
      vendorOrgId: a.vendorOrgId,
      clientOrgId: a.clientOrgId,
      projectId: f.projectId,
      quoteId: f.quoteId,
      paymentTerms: 'Net 30',
      freightTerms: 'FOB origin',
      shipMethod: 'LTL',
      depositPct: 50,
      leadTimeWeeks: 12,
      transitDays: 5,
      origin: 'domestic',
      requestedDeliveryDate: '2027-05-01',
      // 2027-05-01 − 12 weeks − 5 days
      releaseByDate: addDays('2027-05-01', -89),
      vendorContact: { name: 'Val Vendor', email: 'val@acme.example', phone: '555-0100' },
    });
    expect(poA.number).toMatch(/^PO-\d{2}-\d{4}$/);
    expect(poA.lines).toHaveLength(2);
    // totals: 120 × 450.50 + 40 × 899.99
    expect(poA.subtotal).toBe(54060 + 35999.6);
    expect(poA.total).toBe(poA.subtotal);
    expect(poA.lines.find((l: any) => l.code === 'CG-1')).toMatchObject({
      quantity: 120,
      unitCost: 450.5,
      extended: 54060,
    });
    expect(poA.lines[0]).not.toHaveProperty('unitPrice');
    expect(poA.requirements.map((r: any) => [r.kind, r.party])).toEqual([
      ['order_acknowledgement', 'vendor'],
      ['deposit', 'internal'],
      ['shop_drawing_approval', 'client'],
      ['finish_sample_approval', 'client'],
    ]);
    expect(poA.shipments).toHaveLength(1);
    expect(poA.shipments[0]).toMatchObject({
      label: 'A',
      status: 'planned',
      requestedDeliveryDate: '2027-05-01',
    });
    expect(poA.shipments[0].lines.map((l: any) => [l.code, l.quantity])).toEqual([
      ['CG-1', 120],
      ['SS-1', 40],
    ]);
    expect(poA.recipients.map((r: any) => r.email)).toEqual(['sam@hotel.example']);

    expect(poB.lines.map((l: any) => l.code)).toEqual(['LT-1']);
    expect(poB.requirements.map((r: any) => r.kind)).toEqual(['order_acknowledgement']);
    expect(poB.releaseByDate).toBe(addDays('2027-05-01', -56 - 5));

    const created = await outbox(a.tenantId, 'orders.po.created');
    const evA = created.find((e) => e.data.poId === poA.id)!;
    expect(evA.data).toMatchObject({ quoteId: f.quoteId, vendorId: f.vendorA, total: poA.total });
    expect(evA.data.quoteLineIds.sort()).toEqual([f.lines.cg, f.lines.ss].sort());
  });

  it('uses 35 transit days for international vendors', async () => {
    const f = setupQuote(clients, a, { originB: 'international' });
    const { poB } = await createPos(a, f);
    expect(poB).toMatchObject({ origin: 'international', transitDays: 35 });
    expect(poB.releaseByDate).toBe(addDays('2027-05-01', -56 - 35));
  });

  it('409s listing lines that are not ready or already on a PO', async () => {
    const f = setupQuote(clients, a);
    const notReady = await app.inject(
      json('POST', '/purchase-orders/from-quote', a.adminToken, {
        quoteId: f.quoteId,
        lineIds: [f.lines.cg, f.lines.nr],
      }),
    );
    expect(notReady.statusCode).toBe(409);
    expect(notReady.json().detail.lines).toEqual([
      { id: f.lines.nr, code: 'MR-1', reason: 'not_ready_to_order' },
    ]);

    await createPos(a, f);
    const again = await app.inject(
      json('POST', '/purchase-orders/from-quote', a.adminToken, {
        quoteId: f.quoteId,
        lineIds: [f.lines.cg],
      }),
    );
    expect(again.statusCode).toBe(409);
    expect(again.json().detail.lines[0]).toMatchObject({ id: f.lines.cg, code: 'CG-1' });
    expect(again.json().detail.lines[0].reason).toMatch(/^already_on_PO-/);
  });

  it('requires orders:write', async () => {
    const f = setupQuote(clients, a);
    const viewer = await a.tokenAs(['viewer']);
    const res = await app.inject(json('POST', '/purchase-orders/from-quote', viewer, { quoteId: f.quoteId }));
    expect(res.statusCode).toBe(403);
  });
});

// =============================================================================================
describe('order grid', () => {
  it('filters across the portfolio and reports counts', async () => {
    const f = setupQuote(clients, a);
    const { poA, poB } = await createPos(a, f);
    const res = await app.inject(
      json(
        'GET',
        `/purchase-orders?projectId=${f.projectId}&requirementKind=shop_drawing_approval`,
        a.adminToken,
      ),
    );
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.total).toBe(1);
    expect(body.items[0].id).toBe(poA.id);
    expect(body.items[0].counts).toMatchObject({
      pendingRequirements: 4,
      shipments: 1,
      trackingMissing: 0,
    });
    expect(body.items[0].counts.pendingRequirementKinds.sort()).toEqual(
      ['deposit', 'finish_sample_approval', 'order_acknowledgement', 'shop_drawing_approval'].sort(),
    );

    const byVendor = await app.inject(json('GET', `/purchase-orders?vendorId=${f.vendorB}`, a.adminToken));
    expect(byVendor.json().items.map((x: any) => x.id)).toEqual([poB.id]);

    const q = await app.inject(
      json('GET', `/purchase-orders?q=${encodeURIComponent(poB.number)}`, a.adminToken),
    );
    expect(q.json().items.map((x: any) => x.id)).toEqual([poB.id]);

    const multi = await app.inject(
      json('GET', `/purchase-orders?projectId=${f.projectId}&status=draft,issued&limit=1`, a.adminToken),
    );
    expect(multi.json()).toMatchObject({ total: 2, limit: 1, offset: 0 });
    expect(multi.json().items).toHaveLength(1);

    const before = await app.inject(
      json(
        'GET',
        `/purchase-orders?projectId=${f.projectId}&releaseByBefore=${addDays('2027-05-01', -80)}`,
        a.adminToken,
      ),
    );
    expect(before.json().items.map((x: any) => x.id)).toEqual([poA.id]);

    const none = await app.inject(
      json('GET', `/purchase-orders?projectId=${f.projectId}&shipsWithinDays=30`, a.adminToken),
    );
    expect(none.json().total).toBe(0);
  });
});

// =============================================================================================
describe('shipments', () => {
  it('rejects over-allocation with 422 and splits phased shipments', async () => {
    const f = setupQuote(clients, a);
    const { poA } = await createPos(a, f);
    const cg = poA.lines.find((l: any) => l.code === 'CG-1');
    const shipA = poA.shipments[0];

    // Shipment A holds everything; adding more is over-allocation.
    const over = await app.inject(
      json('POST', `/purchase-orders/${poA.id}/shipments`, a.adminToken, {
        note: 'Extra',
        allocations: [{ poLineId: cg.id, quantity: 1 }],
      }),
    );
    expect(over.statusCode).toBe(422);
    expect(over.json().detail.errors[0]).toMatchObject({ poLineId: cg.id, ordered: 120, allocated: 121 });

    // Split floors 3–4 off into B, then floors 5–6 into C.
    const split = await app.inject(
      json('POST', `/shipments/${shipA.id}/split`, a.adminToken, {
        note: 'Floors 3–4',
        requestedDeliveryDate: '2027-06-01',
        lines: [{ poLineId: cg.id, quantity: 40 }],
      }),
    );
    expect(split.statusCode, split.body).toBe(201);
    expect(split.json().created).toMatchObject({
      label: 'B',
      note: 'Floors 3–4',
      requestedDeliveryDate: '2027-06-01',
    });
    expect(split.json().created.lines.map((l: any) => l.quantity)).toEqual([40]);
    expect(split.json().source.lines.find((l: any) => l.code === 'CG-1').quantity).toBe(80);

    const split2 = await app.inject(
      json('POST', `/shipments/${shipA.id}/split`, a.adminToken, {
        note: 'Floors 5–6',
        lines: [{ poLineId: cg.id, quantity: 40 }],
      }),
    );
    expect(split2.json().created.label).toBe('C');

    const tooMuch = await app.inject(
      json('POST', `/shipments/${shipA.id}/split`, a.adminToken, {
        lines: [{ poLineId: cg.id, quantity: 41 }],
      }),
    );
    expect(tooMuch.statusCode).toBe(422);

    // Editing B's allocation above what is free → 422.
    const b2 = split.json().created;
    const patch = await app.inject(
      json('PATCH', `/shipments/${b2.id}`, a.adminToken, {
        allocations: [{ poLineId: cg.id, quantity: 81 }],
      }),
    );
    expect(patch.statusCode).toBe(422);

    const detail = (await app.inject(json('GET', `/purchase-orders/${poA.id}`, a.adminToken))).json();
    expect(detail.shipments.map((s: any) => s.label)).toEqual(['A', 'B', 'C']);
    const total = detail.shipments.flatMap((s: any) => s.lines).filter((l: any) => l.code === 'CG-1');
    expect(total.reduce((x: number, l: any) => x + l.quantity, 0)).toBe(120);
  });

  it('counts ship-date changes, emits events, and notifies delivery recipients on tracking', async () => {
    const f = setupQuote(clients, a);
    const { poA } = await createPos(a, f);
    await issue(a, poA.id);
    const sh = poA.shipments[0];
    for (const d of ['2027-02-01', '2027-02-15', '2027-03-01']) {
      const r = await app.inject(
        json('PATCH', `/shipments/${sh.id}`, a.adminToken, { estimatedShipDate: d }),
      );
      expect(r.statusCode, r.body).toBe(200);
    }
    const s1 = (await app.inject(json('GET', `/shipments/${sh.id}`, a.adminToken))).json();
    expect(s1).toMatchObject({
      estimatedShipDate: '2027-03-01',
      originalShipDate: '2027-02-01',
      shipDateChanges: 2,
    });
    expect(s1.escalation).toBe('at_risk'); // moved later twice
    const changed = (await outbox(a.tenantId, 'orders.shipment.ship_date_changed')).filter(
      (e) => e.data.shipmentId === sh.id,
    );
    expect(changed.map((e) => e.data.current)).toEqual(['2027-02-01', '2027-02-15', '2027-03-01']);

    const t = await app.inject(
      json('PATCH', `/shipments/${sh.id}`, a.adminToken, {
        carrier: 'UPS Freight',
        trackingNumber: '1Z999',
        actualShipDate: today(),
      }),
    );
    expect(t.statusCode, t.body).toBe(200);
    expect(t.json()).toMatchObject({ status: 'shipped', carrier: 'UPS Freight', trackingNumber: '1Z999' });
    expect(t.json().trackingUrl).toContain('ups.com');
    expect(
      (await outbox(a.tenantId, 'orders.shipment.tracking_added')).some((e) => e.data.shipmentId === sh.id),
    ).toBe(true);
    const mail = (await outbox(a.tenantId, 'cmd.email.send')).find(
      (e) => e.data.to.includes('sam@hotel.example') && e.data.text.includes('1Z999'),
    );
    expect(mail).toBeTruthy();
    expect(mail!.data.text).toContain('CG-1');
    expect(mail!.data.text).toContain('qty 120');
    expect(mail!.data.text).toMatch(/Call .*Olivia Order/);
    const po = (await app.inject(json('GET', `/purchase-orders/${poA.id}`, a.adminToken))).json();
    expect(po.status).toBe('shipped');
  });
});

// =============================================================================================
describe('issue and revisions', () => {
  it('issues: renders the PO PDF for the vendor, emails it with the portal link', async () => {
    const f = setupQuote(clients, a);
    clients.openThread.mockResolvedValue('11111111-1111-4111-8111-111111111111');
    const { poA } = await createPos(a, f);
    const res = await issue(a, poA.id);
    expect(res.emailed).toBe(true);
    expect(res.po).toMatchObject({
      status: 'issued',
      revision: 0,
      hasUnissuedChanges: false,
      orderDate: today(),
    });
    expect(clients.renderReport).toHaveBeenCalledTimes(1);
    const call = clients.renderReport.mock.calls[0]![0];
    expect(call).toMatchObject({
      tenantId: a.tenantId,
      template: 'purchase_order',
      visibility: 'vendor',
      vendorOrgId: a.vendorOrgId,
      entityType: 'purchase_order',
      entityId: poA.id,
    });
    expect(call.data.lines).toHaveLength(2);
    expect(call.data.po.releaseBy).toBe(poA.releaseByDate);
    expect(call.data.shipments[0].label).toBe('A');
    expect(clients.openThread).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'purchase_order', entityId: poA.id, visibility: 'vendor' }),
    );

    const issued = (await outbox(a.tenantId, 'orders.po.issued')).find((e) => e.data.poId === poA.id);
    expect(issued!.data).toMatchObject({ revision: 0, number: poA.number });
    const mail = (await outbox(a.tenantId, 'cmd.email.send')).find((e) =>
      e.data.subject.includes(poA.number),
    );
    expect(mail!.data.to).toEqual(['val@acme.example']);
    expect(mail!.data.attachments[0].documentId).toBe(res.documentId);
    expect(mail!.data.text).toContain(`/vendor/orders/${poA.id}`);
    expect(mail!.data.threadId).toBe('11111111-1111-4111-8111-111111111111');

    const again = await app.inject(json('POST', `/purchase-orders/${poA.id}/issue`, a.adminToken, {}));
    expect(again.statusCode).toBe(409);
  });

  it('holds edits to an issued PO, diffs them, and issues a revision PDF', async () => {
    const f = setupQuote(clients, a);
    const { poA } = await createPos(a, f);
    await issue(a, poA.id);
    const cg = poA.lines.find((l: any) => l.code === 'CG-1');
    const ss = poA.lines.find((l: any) => l.code === 'SS-1');

    let r = await app.inject(
      json('PATCH', `/purchase-orders/${poA.id}/lines/${cg.id}`, a.adminToken, { quantity: 130 }),
    );
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ status: 'issued', hasUnissuedChanges: true });
    // single shipment follows the order
    expect(r.json().shipments[0].lines.find((l: any) => l.code === 'CG-1').quantity).toBe(130);

    r = await app.inject(json('DELETE', `/purchase-orders/${poA.id}/lines/${ss.id}`, a.adminToken));
    expect(r.statusCode, r.body).toBe(200);
    r = await app.inject(
      json('POST', `/purchase-orders/${poA.id}/lines`, a.adminToken, {
        code: 'NS-1',
        name: 'Nightstand',
        quantity: 120,
        unitCost: 210,
      }),
    );
    expect(r.statusCode, r.body).toBe(201);

    // If-Match concurrency on the header
    const v = r.json().version;
    const stale = await app.inject(
      json(
        'PATCH',
        `/purchase-orders/${poA.id}`,
        a.adminToken,
        { requestedDeliveryDate: '2027-05-15' },
        { 'if-match': `"${v - 1}"` },
      ),
    );
    expect(stale.statusCode).toBe(412);
    const ok = await app.inject(
      json(
        'PATCH',
        `/purchase-orders/${poA.id}`,
        a.adminToken,
        { requestedDeliveryDate: '2027-05-15' },
        { 'if-match': `"${v}"` },
      ),
    );
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().releaseByDate).toBe(addDays('2027-05-15', -89));
    expect(ok.headers.etag).toBe(`"${v + 1}"`);

    const pending = (
      await app.inject(json('GET', `/purchase-orders/${poA.id}/revisions/1/diff`, a.adminToken))
    ).json();
    expect(pending.pending).toBe(true);
    const fields = pending.changes.map((c: any) => `${c.field}:${c.lineCode ?? ''}`);
    expect(fields).toEqual(
      expect.arrayContaining([
        'requestedDeliveryDate:',
        'releaseByDate:',
        'total:',
        'quantity:CG-1',
        'line_added:NS-1',
        'line_removed:SS-1',
      ]),
    );

    clients.renderReport.mockClear();
    const rev = await app.inject(
      json('POST', `/purchase-orders/${poA.id}/issue-revision`, a.adminToken, { message: 'Qty update' }),
    );
    expect(rev.statusCode, rev.body).toBe(200);
    expect(rev.json().po).toMatchObject({ revision: 1, hasUnissuedChanges: false, status: 'issued' });
    expect(clients.renderReport).toHaveBeenCalledWith(
      expect.objectContaining({
        template: 'po_revision',
        filename: `${poA.number}-R1.pdf`,
        visibility: 'vendor',
      }),
    );
    const data = clients.renderReport.mock.calls[0]![0].data;
    expect(data.changes).toEqual(rev.json().changes);
    expect(data.po.revision).toBe(1);

    const stored = (
      await app.inject(json('GET', `/purchase-orders/${poA.id}/revisions/1/diff`, a.adminToken))
    ).json();
    expect(stored.pending).toBe(false);
    expect(stored.changes).toEqual(rev.json().changes);
    const mail = (await outbox(a.tenantId, 'cmd.email.send')).find(
      (e) => e.data.subject.includes('revision 1') && e.data.subject.includes(poA.number),
    );
    expect(mail!.data.text).toContain('Added NS-1');

    const nothing = await app.inject(
      json('POST', `/purchase-orders/${poA.id}/issue-revision`, a.adminToken, {}),
    );
    expect(nothing.statusCode).toBe(422);

    const act = await app.inject(json('GET', `/purchase-orders/${poA.id}/activity`, a.adminToken));
    expect(act.statusCode).toBe(200);
    const entities = new Set(act.json().map((x: any) => x.entityType));
    expect([...entities]).toEqual(
      expect.arrayContaining(['purchase_order', 'po_line', 'shipment', 'pre_order_requirement']),
    );
  });

  it('cancels a PO and releases its quote lines', async () => {
    const f = setupQuote(clients, a);
    const { poB } = await createPos(a, f);
    const r = await app.inject(
      json('POST', `/purchase-orders/${poB.id}/cancel`, a.adminToken, { reason: 'Value engineered' }),
    );
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().status).toBe('cancelled');
    const ev = (await outbox(a.tenantId, 'orders.po.cancelled')).find((e) => e.data.poId === poB.id);
    expect(ev!.data.quoteLineIds).toEqual([f.lines.lt]);
    // line can be ordered again
    const again = await app.inject(
      json('POST', '/purchase-orders/from-quote', a.adminToken, {
        quoteId: f.quoteId,
        lineIds: [f.lines.lt],
      }),
    );
    expect(again.statusCode, again.body).toBe(201);
  });
});

// =============================================================================================
describe('requirements', () => {
  it('lists cross-portfolio, updates singly and in bulk; all complete → in production', async () => {
    const f = setupQuote(clients, a);
    const { poA } = await createPos(a, f);
    await issue(a, poA.id);
    const list = await app.inject(
      json('GET', `/requirements?projectId=${f.projectId}&party=client`, a.adminToken),
    );
    expect(list.statusCode, list.body).toBe(200);
    expect(
      list
        .json()
        .items.map((x: any) => x.kind)
        .sort(),
    ).toEqual(['finish_sample_approval', 'shop_drawing_approval']);
    expect(list.json().items[0]).toMatchObject({ poNumber: poA.number, vendorName: 'Acme Casegoods' });

    const ack = poA.requirements.find((r: any) => r.kind === 'order_acknowledgement');
    const one = await app.inject(
      json('PATCH', `/purchase-orders/${poA.id}/requirements/${ack.id}`, a.adminToken, {
        status: 'approved',
        note: 'By phone',
      }),
    );
    expect(one.statusCode, one.body).toBe(200);
    expect(one.json()).toMatchObject({ status: 'approved', note: 'By phone', decidedByName: 'Test User' });

    const rest = poA.requirements
      .filter((r: any) => r.kind !== 'order_acknowledgement')
      .map((r: any) => r.id);
    const bulk = await app.inject(
      json('POST', '/requirements/bulk', a.adminToken, { ids: rest, status: 'waived' }),
    );
    expect(bulk.statusCode, bulk.body).toBe(200);
    expect(bulk.json().updated).toBe(3);
    const updated = await outbox(a.tenantId, 'orders.requirement.updated');
    expect(updated.filter((e) => e.data.poId === poA.id)).toHaveLength(4);

    // Acknowledged by vendor → all complete moves to production
    await app.inject(
      json('POST', `/vendor/purchase-orders/${poA.id}/acknowledge`, a.vendorToken, { note: 'ok' }),
    );
    const po = (await app.inject(json('GET', `/purchase-orders/${poA.id}`, a.adminToken))).json();
    expect(po.status).toBe('in_production');

    const overdue = await app.inject(json('GET', '/requirements?overdue=true', a.adminToken));
    expect(overdue.statusCode).toBe(200);
  });
});

// =============================================================================================
describe('vendor portal', () => {
  it('shows only issued POs of the vendor org, without sell price or internal fields', async () => {
    const f = setupQuote(clients, a);
    const { poA, poB } = await createPos(a, f);
    // Draft: invisible to the vendor.
    let list = await app.inject(json('GET', '/vendor/purchase-orders', a.vendorToken));
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().items.map((x: any) => x.id)).not.toContain(poA.id);
    expect(
      (await app.inject(json('GET', `/vendor/purchase-orders/${poA.id}`, a.vendorToken))).statusCode,
    ).toBe(404);

    await issue(a, poA.id);
    await issue(a, poB.id); // Bright Lighting (not this vendor org)
    list = await app.inject(json('GET', '/vendor/purchase-orders', a.vendorToken));
    const ids = list.json().items.map((x: any) => x.id);
    expect(ids).toContain(poA.id);
    expect(ids).not.toContain(poB.id);
    expect(
      (await app.inject(json('GET', `/vendor/purchase-orders/${poB.id}`, a.vendorToken))).statusCode,
    ).toBe(404);

    const d = await app.inject(json('GET', `/vendor/purchase-orders/${poA.id}`, a.vendorToken));
    expect(d.statusCode, d.body).toBe(200);
    const body = d.json();
    expect(body.lines[0].unitCost).toBeGreaterThan(0); // the cost they agreed
    const keys = keysDeep(body);
    for (const k of [...SELL_KEYS, ...INTERNAL_KEYS, 'vendorId', 'quoteId', 'escalation'])
      expect(keys.has(k), k).toBe(false);
    // Their own acknowledgement plus the submittals they provide for owner approval; never deposits.
    expect(body.requirements.map((r: any) => r.kind)).toEqual([
      'order_acknowledgement',
      'shop_drawing_approval',
      'finish_sample_approval',
    ]);
    expect(body.shipTo.city).toBe('Austin');

    // Vendor can't use internal routes
    expect((await app.inject(json('GET', `/purchase-orders/${poA.id}`, a.vendorToken))).statusCode).toBe(403);
    expect((await app.inject(json('GET', '/purchase-orders', a.vendorToken))).statusCode).toBe(403);
  });

  it('acknowledges, confirms ship dates and adds tracking; order managers are notified', async () => {
    const f = setupQuote(clients, a);
    const { poA } = await createPos(a, f);
    await issue(a, poA.id);
    const ack = await app.inject(
      json('POST', `/vendor/purchase-orders/${poA.id}/acknowledge`, a.vendorToken, {
        estimatedShipDate: '2027-03-15',
        note: 'Confirmed, production slot booked',
      }),
    );
    expect(ack.statusCode, ack.body).toBe(200);
    expect(ack.json()).toMatchObject({ status: 'acknowledged' });
    expect(ack.json().requirements[0]).toMatchObject({ kind: 'order_acknowledgement', status: 'approved' });
    expect(ack.json().shipments[0]).toMatchObject({ estimatedShipDate: '2027-03-15', status: 'confirmed' });

    const internal = (await app.inject(json('GET', `/purchase-orders/${poA.id}`, a.adminToken))).json();
    expect(internal.acknowledgedAt).toBeTruthy();
    expect(internal.requirements[0].decidedByName).toBe('Test User');
    const notes = (await outbox(a.tenantId, 'cmd.notify')).filter((e) => e.data.title.includes(poA.number));
    expect(notes.some((n) => n.data.title.includes('acknowledged'))).toBe(true);
    expect(notes[0]!.data.roles).toEqual(['order_manager']);
    expect(notes[0]!.data.userIds).toEqual([f.managerId]);
    expect((await outbox(a.tenantId, 'orders.po.acknowledged')).some((e) => e.data.poId === poA.id)).toBe(
      true,
    );

    // Confirm: request then respond with a change
    const sh = internal.shipments[0];
    const reqConf = await app.inject(
      json('POST', `/shipments/${sh.id}/request-confirmation`, a.adminToken, {}),
    );
    expect(reqConf.statusCode, reqConf.body).toBe(201);
    const conf = await app.inject(
      json('POST', `/vendor/shipments/${sh.id}/confirm`, a.vendorToken, {
        onTrack: false,
        newShipDate: '2027-03-29',
        note: 'Fabric delay',
      }),
    );
    expect(conf.statusCode, conf.body).toBe(200);
    expect(conf.json()).toMatchObject({ estimatedShipDate: '2027-03-29', confirmationPending: false });
    expect(keysDeep(conf.json()).has('riskScore')).toBe(false);
    const hist = (await app.inject(json('GET', `/shipments/${sh.id}/confirmations`, a.adminToken))).json();
    expect(hist[0]).toMatchObject({
      response: 'changed',
      previousDate: '2027-03-15',
      newDate: '2027-03-29',
      channel: 'portal',
    });
    const moved = (await outbox(a.tenantId, 'orders.shipment.ship_date_changed')).filter(
      (e) => e.data.shipmentId === sh.id,
    );
    expect(moved.at(-1)!.data).toMatchObject({
      previous: '2027-03-15',
      current: '2027-03-29',
      source: 'vendor',
    });

    const onTrack = await app.inject(
      json('POST', `/vendor/shipments/${sh.id}/confirm`, a.vendorToken, { onTrack: true }),
    );
    expect(onTrack.statusCode).toBe(200);

    // Tracking from the vendor
    const tr = await app.inject(
      json('POST', `/vendor/shipments/${sh.id}/tracking`, a.vendorToken, {
        carrier: 'FedEx Freight',
        trackingNumber: 'FX123',
        shipDate: today(),
      }),
    );
    expect(tr.statusCode, tr.body).toBe(200);
    expect(tr.json()).toMatchObject({ status: 'shipped', trackingNumber: 'FX123' });
    expect(
      (await outbox(a.tenantId, 'orders.shipment.tracking_added')).some(
        (e) => e.data.trackingNumber === 'FX123',
      ),
    ).toBe(true);
    expect((await outbox(a.tenantId, 'cmd.email.send')).some((e) => e.data.text.includes('FX123'))).toBe(
      true,
    );

    // Audit attribution for the vendor's write
    const act = (await app.inject(json('GET', `/purchase-orders/${poA.id}/activity`, a.adminToken))).json();
    expect(act.some((x: any) => x.entityType === 'shipment' && x.actorType === 'vendor')).toBe(true);
  });

  it('vendor submits shop drawings; vendors cannot act on other vendors or tenants', async () => {
    const f = setupQuote(clients, a);
    const { poA, poB } = await createPos(a, f);
    await issue(a, poA.id);
    await issue(a, poB.id);
    const sd = poA.requirements.find((r: any) => r.kind === 'shop_drawing_approval');
    const doc = crypto.randomUUID();
    const sub = await app.inject(
      json('POST', `/vendor/purchase-orders/${poA.id}/requirements/${sd.id}/submit`, a.vendorToken, {
        documentId: doc,
        note: 'Rev A',
      }),
    );
    expect(sub.statusCode, sub.body).toBe(200);
    expect(sub.json()).toMatchObject({ status: 'submitted', documentId: doc });
    const dep = poA.requirements.find((r: any) => r.kind === 'deposit');
    const depSub = await app.inject(
      json('POST', `/vendor/purchase-orders/${poA.id}/requirements/${dep.id}/submit`, a.vendorToken, {
        documentId: doc,
      }),
    );
    expect(depSub.statusCode).toBe(404);

    const shipB = poB.shipments[0];
    for (const [url, payload] of [
      [`/vendor/purchase-orders/${poB.id}/acknowledge`, {}],
      [`/vendor/shipments/${shipB.id}/confirm`, { onTrack: true }],
      [`/vendor/shipments/${shipB.id}/tracking`, { carrier: 'UPS', trackingNumber: 'X' }],
    ] as const) {
      const r = await app.inject(json('POST', url, a.vendorToken, payload));
      expect(r.statusCode, url).toBe(404);
    }
    // Other tenant's vendor
    const r = await app.inject(json('GET', `/vendor/purchase-orders/${poA.id}`, b.vendorToken));
    expect(r.statusCode).toBe(404);
    // Client token on vendor routes
    expect((await app.inject(json('GET', '/vendor/purchase-orders', a.clientToken))).statusCode).toBe(403);
  });

  it('RLS blocks vendor direct writes outside their rows', async () => {
    const f = setupQuote(clients, a);
    const { poA, poB } = await createPos(a, f);
    await issue(a, poA.id);
    const { withContext } = await import('@procure/platform');
    const ctx = {
      tenantId: a.tenantId,
      userId: a.vendorUserId,
      orgId: a.vendorOrgId,
      actor: 'vendor' as const,
    };
    const counts = await withContext(ctx, async (tx) => {
      const pos = await tx`select id from orders.purchase_orders where project_id = ${f.projectId}`;
      const upd =
        await tx`update orders.purchase_orders set notes = 'hack' where id = ${poA.id} returning id`;
      const updB = await tx`update orders.shipments set note = 'x' where po_id = ${poB.id} returning id`;
      const reqClient = await tx`update orders.pre_order_requirements set status = 'approved'
                                 where po_id = ${poA.id} and party = 'client' returning id`;
      const recips = await tx`select id from orders.delivery_recipients`;
      return {
        pos: pos.length,
        upd: upd.length,
        updB: updB.length,
        reqClient: reqClient.length,
        recips: recips.length,
      };
    });
    expect(counts).toEqual({ pos: 1, upd: 0, updB: 0, reqClient: 0, recips: 0 });
  });
});

// =============================================================================================
describe('client portal', () => {
  it('shows orders on the project without cost, totals or vendor terms', async () => {
    const f = setupQuote(clients, a);
    const { poA, poB } = await createPos(a, f);
    await issue(a, poA.id);
    const res = await app.inject(json('GET', `/client/projects/${f.projectId}/orders`, a.clientToken));
    expect(res.statusCode, res.body).toBe(200);
    const items = res.json().items;
    expect(items.map((x: any) => x.id)).toEqual([poA.id]); // draft poB hidden
    expect(items[0]).toMatchObject({
      vendorName: 'Acme Casegoods',
      orderedCount: 160,
      deliveredCount: 0,
      pendingApprovals: 2,
    });
    expect(items[0].items[0]).toMatchObject({ code: 'CG-1', quantity: 120 });
    const keys = keysDeep(res.json());
    for (const k of [
      ...COST_KEYS,
      ...SELL_KEYS,
      ...INTERNAL_KEYS,
      'vendorContact',
      'freightTerms',
      'shipMethod',
    ])
      expect(keys.has(k), k).toBe(false);
    expect(poB).toBeTruthy();

    // Other tenant's owner sees nothing; internal routes are closed
    const other = await app.inject(json('GET', `/client/projects/${f.projectId}/orders`, b.clientToken));
    expect(other.json().items).toEqual([]);
    expect((await app.inject(json('GET', `/purchase-orders/${poA.id}`, a.clientToken))).statusCode).toBe(403);
  });

  it('approves submittals', async () => {
    const f = setupQuote(clients, a);
    const { poA } = await createPos(a, f);
    await issue(a, poA.id);
    const pending = await app.inject(
      json('GET', `/client/requirements?projectId=${f.projectId}`, a.clientToken),
    );
    expect(pending.statusCode, pending.body).toBe(200);
    expect(
      pending
        .json()
        .map((r: any) => r.kind)
        .sort(),
    ).toEqual(['finish_sample_approval', 'shop_drawing_approval']);
    const sd = pending.json().find((r: any) => r.kind === 'shop_drawing_approval');
    expect(keysDeep(pending.json()).has('unitCost')).toBe(false);
    const dec = await app.inject(
      json('POST', `/client/requirements/${sd.id}/decision`, a.clientToken, {
        decision: 'approved',
        note: 'Looks great',
      }),
    );
    expect(dec.statusCode, dec.body).toBe(200);
    expect(dec.json()).toMatchObject({ status: 'approved', decidedByName: 'Test User', note: 'Looks great' });
    const internalReq = (await app.inject(json('GET', `/purchase-orders/${poA.id}`, a.adminToken)))
      .json()
      .requirements.find((r: any) => r.id === sd.id);
    expect(internalReq.status).toBe('approved');
    // Vendor-party requirement is not decidable by the client
    const ack = poA.requirements.find((r: any) => r.kind === 'order_acknowledgement');
    expect(
      (
        await app.inject(
          json('POST', `/client/requirements/${ack.id}/decision`, a.clientToken, { decision: 'approved' }),
        )
      ).statusCode,
    ).toBe(404);
    // Viewer role cannot approve
    const viewer = await tokenFor({
      userId: a.clientUserId,
      orgId: a.clientOrgId,
      tenantId: a.tenantId,
      actor: 'client',
      roles: ['client_viewer'],
    });
    const fs = pending.json().find((r: any) => r.kind === 'finish_sample_approval');
    expect(
      (
        await app.inject(
          json('POST', `/client/requirements/${fs.id}/decision`, viewer, { decision: 'approved' }),
        )
      ).statusCode,
    ).toBe(403);
  });

  it('owner reports a claim; order managers are notified; claim visible in both portals', async () => {
    const f = setupQuote(clients, a);
    const { poA } = await createPos(a, f);
    await issue(a, poA.id);
    const cg = poA.lines.find((l: any) => l.code === 'CG-1');
    const photo = crypto.randomUUID();
    const res = await app.inject(
      json('POST', '/client/claims', a.clientToken, {
        projectId: f.projectId,
        poId: poA.id,
        type: 'damage',
        description: 'Two headboards scratched in room 412',
        items: [{ poLineId: cg.id, quantity: 2, note: 'Room 412' }],
        photoDocumentIds: [photo],
      }),
    );
    expect(res.statusCode, res.body).toBe(201);
    const c = res.json();
    expect(c).toMatchObject({
      status: 'open',
      type: 'damage',
      poNumber: poA.number,
      vendorName: 'Acme Casegoods',
    });
    expect(c.number).toMatch(/^CL-\d{2}-\d{4}$/);
    expect(c.items[0]).toMatchObject({ code: 'CG-1', quantity: 2 });
    expect(c.photoDocumentIds).toEqual([photo]);
    expect(keysDeep(c).has('creditAmount')).toBe(false);
    expect((await outbox(a.tenantId, 'orders.claim.opened')).some((e) => e.data.claimId === c.id)).toBe(true);
    expect((await outbox(a.tenantId, 'cmd.notify')).some((e) => e.data.title.includes(c.number))).toBe(true);

    const mine = await app.inject(json('GET', '/client/claims', a.clientToken));
    expect(mine.json().map((x: any) => x.id)).toContain(c.id);
    const internal = (await app.inject(json('GET', `/claims/${c.id}`, a.adminToken))).json();
    expect(internal).toMatchObject({ reportedByActor: 'client', reportedByName: 'Test User' });

    // Vendor sees it once submitted to them, then acknowledges
    expect(
      (await app.inject(json('GET', '/vendor/claims', a.vendorToken))).json().map((x: any) => x.id),
    ).not.toContain(c.id);
    const sub = await app.inject(
      json('PATCH', `/claims/${c.id}`, a.adminToken, { status: 'submitted_to_vendor' }),
    );
    expect(sub.statusCode, sub.body).toBe(200);
    const vc = await app.inject(json('GET', '/vendor/claims', a.vendorToken));
    expect(vc.json().map((x: any) => x.id)).toContain(c.id);
    const vack = await app.inject(
      json('PATCH', `/vendor/claims/${c.id}`, a.vendorToken, {
        status: 'replacement_ordered',
        resolution: 'Shipping 2 replacements',
      }),
    );
    expect(vack.statusCode, vack.body).toBe(200);
    expect(vack.json().status).toBe('replacement_ordered');
    const bad = await app.inject(
      json('PATCH', `/vendor/claims/${c.id}`, a.vendorToken, { status: 'vendor_acknowledged' }),
    );
    expect(bad.statusCode).toBe(422);

    // Other tenant's client cannot report against this project
    const x = await app.inject(
      json('POST', '/client/claims', b.clientToken, {
        projectId: f.projectId,
        poId: poA.id,
        type: 'other',
        description: 'x',
      }),
    );
    expect(x.statusCode).toBe(404);

    const pdf = await app.inject(json('POST', `/claims/${c.id}/report`, a.adminToken));
    expect(pdf.statusCode, pdf.body).toBe(200);
    expect(clients.renderReport).toHaveBeenCalledWith(expect.objectContaining({ template: 'claim' }));
  });
});

// =============================================================================================
describe('receiving and storage', () => {
  it('receives into storage; damaged quantity opens a damage claim; all delivered → PO delivered', async () => {
    const f = setupQuote(clients, a);
    const { poA } = await createPos(a, f);
    await issue(a, poA.id);
    const cg = poA.lines.find((l: any) => l.code === 'CG-1');
    const ss = poA.lines.find((l: any) => l.code === 'SS-1');
    const loc = await app.inject(
      json('POST', '/storage-locations', a.adminToken, {
        projectId: f.projectId,
        name: 'Ballroom B',
        kind: 'on_site',
      }),
    );
    expect(loc.statusCode, loc.body).toBe(201);
    const shipA = poA.shipments[0];
    const split = (
      await app.inject(
        json('POST', `/shipments/${shipA.id}/split`, a.adminToken, {
          note: 'Floor 2',
          lines: [{ poLineId: cg.id, quantity: 20 }],
        }),
      )
    ).json();

    const rec = await app.inject(
      json('POST', `/shipments/${shipA.id}/receive`, a.adminToken, {
        storageLocationId: loc.json().id,
        lines: [
          { poLineId: cg.id, qtyReceived: 100, qtyDamaged: 3 },
          { poLineId: ss.id, qtyReceived: 40, qtyDamaged: 0 },
        ],
        notes: 'Forklift damage',
      }),
    );
    expect(rec.statusCode, rec.body).toBe(201);
    const r = rec.json();
    expect(r.receipt.condition).toBe('damaged');
    expect(r.claimId).toBeTruthy();
    expect(r.shipment.status).toBe('delivered');
    expect(r.poStatus).toBe('partially_delivered');
    const claim = (await app.inject(json('GET', `/claims/${r.claimId}`, a.adminToken))).json();
    expect(claim).toMatchObject({ type: 'damage', status: 'open', shipmentId: shipA.id });
    expect(claim.items).toEqual([expect.objectContaining({ code: 'CG-1', quantity: 3 })]);
    expect((await outbox(a.tenantId, 'orders.claim.opened')).some((e) => e.data.claimId === r.claimId)).toBe(
      true,
    );
    expect(
      (await outbox(a.tenantId, 'orders.shipment.delivered')).some((e) => e.data.shipmentId === shipA.id),
    ).toBe(true);

    const items = (
      await app.inject(json('GET', `/storage-items?projectId=${f.projectId}`, a.adminToken))
    ).json();
    const byStatus = Object.fromEntries(
      ['stored', 'damaged'].map((s) => [
        s,
        items.items.filter((i: any) => i.status === s).reduce((x: number, i: any) => x + i.quantity, 0),
      ]),
    );
    expect(byStatus).toEqual({ stored: 137, damaged: 3 });
    const po1 = (await app.inject(json('GET', `/purchase-orders/${poA.id}`, a.adminToken))).json();
    expect(po1.lines.find((l: any) => l.code === 'CG-1').receivedQty).toBe(100);

    // Over-receiving is rejected
    const over = await app.inject(
      json('POST', `/shipments/${split.created.id}/receive`, a.adminToken, {
        lines: [{ poLineId: cg.id, qtyReceived: 21 }],
      }),
    );
    expect(over.statusCode).toBe(422);
    const rest = await app.inject(
      json('POST', `/shipments/${split.created.id}/receive`, a.adminToken, {
        lines: [{ poLineId: cg.id, qtyReceived: 20 }],
      }),
    );
    expect(rest.statusCode, rest.body).toBe(201);
    expect(rest.json()).toMatchObject({ claimId: null, poStatus: 'delivered' });

    // Owner portal: storage by location; owner stages and installs part of an entry
    const st = await app.inject(json('GET', `/client/projects/${f.projectId}/storage`, a.clientToken));
    expect(st.statusCode, st.body).toBe(200);
    const ballroom = st.json().locations.find((l: any) => l.name === 'Ballroom B');
    expect(ballroom.items.length).toBeGreaterThan(0);
    expect(keysDeep(st.json()).has('unitCost')).toBe(false);
    const entry = ballroom.items.find((i: any) => i.code === 'CG-1' && i.status === 'stored');
    const inst = await app.inject(
      json('PATCH', `/client/storage-items/${entry.id}`, a.clientToken, {
        status: 'installed',
        areaNote: 'Room 412',
        quantity: 2,
      }),
    );
    expect(inst.statusCode, inst.body).toBe(200);
    expect(inst.json()).toMatchObject({ status: 'installed', areaNote: 'Room 412', quantity: 2 });
    const damagedEntry = st
      .json()
      .locations.flatMap((l: any) => l.items)
      .find((i: any) => i.status === 'damaged');
    expect(
      (
        await app.inject(
          json('PATCH', `/client/storage-items/${damagedEntry.id}`, a.clientToken, { status: 'installed' }),
        )
      ).statusCode,
    ).toBe(422);
    // Internal move
    const mv = await app.inject(
      json('PATCH', `/storage-items/${entry.id}`, a.adminToken, { status: 'staged' }),
    );
    expect(mv.statusCode, mv.body).toBe(200);
    // Other tenant's owner cannot touch it
    expect(
      (
        await app.inject(
          json('PATCH', `/client/storage-items/${entry.id}`, b.clientToken, { status: 'installed' }),
        )
      ).statusCode,
    ).toBe(404);
  });

  it('manages delivery recipients and bulk-applies them to all POs of a project', async () => {
    const f = setupQuote(clients, a);
    const { poA } = await createPos(a, f);
    const add = await app.inject(
      json('POST', `/projects/${f.projectId}/delivery-recipients`, a.adminToken, {
        name: 'Dock',
        email: 'dock@hotel.example',
        poId: poA.id,
      }),
    );
    expect(add.statusCode, add.body).toBe(201);
    const bulk = await app.inject(
      json('POST', `/projects/${f.projectId}/delivery-recipients/bulk-apply`, a.adminToken, {
        recipients: [
          { name: 'Dock', email: 'dock@hotel.example' },
          { name: 'Installer', email: 'crew@install.example', phone: '555' },
        ],
      }),
    );
    expect(bulk.statusCode, bulk.body).toBe(200);
    expect(bulk.json().purchaseOrders).toBe(2);
    const list = bulk.json().items;
    expect(list.every((r: any) => r.poId === null)).toBe(true);
    expect(list.map((r: any) => r.email).sort()).toEqual([
      'crew@install.example',
      'dock@hotel.example',
      'sam@hotel.example',
    ]);
  });
});

// =============================================================================================
describe('calendar', () => {
  it('returns ship, delivery and release-by events in range', async () => {
    const f = setupQuote(clients, a);
    const { poA } = await createPos(a, f);
    await issue(a, poA.id);
    await app.inject(
      json('PATCH', `/shipments/${poA.shipments[0].id}`, a.adminToken, { estimatedShipDate: '2027-04-20' }),
    );
    const res = await app.inject(
      json('GET', `/calendar?from=2027-01-01&to=2027-05-31&projectId=${f.projectId}`, a.adminToken),
    );
    expect(res.statusCode, res.body).toBe(200);
    const kinds = res
      .json()
      .events.filter((e: any) => e.poId === poA.id)
      .map((e: any) => [e.kind, e.date]);
    expect(kinds).toEqual(
      expect.arrayContaining([
        ['release_by', poA.releaseByDate],
        ['ship', '2027-04-20'],
        ['delivery', '2027-04-25'],
      ]),
    );
  });
});

// =============================================================================================
describe('internal endpoints, risk and subscriptions', () => {
  const internal = (method: string, url: string, payload?: unknown) => ({
    method: method as 'GET',
    url,
    headers: { 'x-procure-internal': internalSecret() },
    ...(payload ? { payload: payload as object } : {}),
  });

  it('requires the internal secret', async () => {
    const r = await app.inject({ method: 'GET', url: `/internal/shipments/open?tenantId=${a.tenantId}` });
    expect(r.statusCode).toBe(403);
  });

  it('lists open shipments with risk features; risk scores escalate and notify', async () => {
    const f = setupQuote(clients, a);
    const { poA } = await createPos(a, f);
    await issue(a, poA.id);
    const open = await app.inject(internal('GET', `/internal/shipments/open?tenantId=${a.tenantId}`));
    expect(open.statusCode, open.body).toBe(200);
    const row = open.json().find((s: any) => s.poId === poA.id);
    expect(row).toMatchObject({
      shipmentId: poA.shipments[0].id,
      poNumber: poA.number,
      vendorId: f.vendorA,
      vendorName: 'Acme Casegoods',
      label: 'A',
      origin: 'domestic',
      leadTimeWeeks: 12,
      transitDays: 5,
      releaseByDate: poA.releaseByDate,
      pendingRequirements: 4,
      shipDateChanges: 0,
      hasTracking: false,
      status: 'planned',
    });
    for (const k of [
      'estimatedShipDate',
      'originalShipDate',
      'estimatedDeliveryDate',
      'daysSinceConfirmation',
      'lastConfirmedAt',
      'issuedAt',
      'requestedDeliveryDate',
      'projectId',
      'projectName',
    ])
      expect(row, k).toHaveProperty(k);
    // Other tenant sees none of it
    const other = await app.inject(internal('GET', `/internal/shipments/open?tenantId=${b.tenantId}`));
    expect(other.json().some((s: any) => s.poId === poA.id)).toBe(false);

    const before = (await app.inject(json('GET', `/purchase-orders/${poA.id}`, a.adminToken))).json();
    expect(before.escalation).toBe('none');
    const rs = await app.inject(
      internal('POST', `/internal/risk-scores?tenantId=${a.tenantId}`, {
        scores: [
          {
            shipmentId: poA.shipments[0].id,
            score: 82,
            level: 'high',
            reasons: ['Vendor shipped late on 4 of last 5 orders'],
          },
        ],
      }),
    );
    expect(rs.statusCode, rs.body).toBe(200);
    expect(rs.json()).toMatchObject({
      updated: 1,
      purchaseOrders: 1,
      escalated: [{ poId: poA.id, from: 'none', to: 'at_risk' }],
    });
    const after = (await app.inject(json('GET', `/purchase-orders/${poA.id}`, a.adminToken))).json();
    expect(after).toMatchObject({ escalation: 'at_risk', riskScore: 82, riskLevel: 'at_risk' });
    expect(after.escalationReasons).toContain('Risk model: Vendor shipped late on 4 of last 5 orders');
    expect(after.shipments[0]).toMatchObject({ riskScore: 82, escalation: 'at_risk' });
    const esc = (await outbox(a.tenantId, 'orders.risk.escalated')).filter((e) => e.data.poId === poA.id);
    expect(esc).toHaveLength(1);
    expect(
      (await outbox(a.tenantId, 'cmd.notify')).some((e) => e.data.title === `${poA.number} is at risk`),
    ).toBe(true);
    // Same score again: no new escalation event
    await app.inject(
      internal('POST', `/internal/risk-scores?tenantId=${a.tenantId}`, {
        scores: [
          {
            shipmentId: poA.shipments[0].id,
            score: 82,
            level: 'high',
            reasons: ['Vendor shipped late on 4 of last 5 orders'],
          },
        ],
      }),
    );
    expect(
      (await outbox(a.tenantId, 'orders.risk.escalated')).filter((e) => e.data.poId === poA.id),
    ).toHaveLength(1);
    // Another tenant's shipment ids are ignored
    const cross = await app.inject(
      internal('POST', `/internal/risk-scores?tenantId=${b.tenantId}`, {
        scores: [{ shipmentId: poA.shipments[0].id, score: 99, level: 'critical', reasons: [] }],
      }),
    );
    expect(cross.json().updated).toBe(0);
  });

  it('internal tracking and requirement endpoints', async () => {
    const f = setupQuote(clients, a);
    const { poA } = await createPos(a, f);
    await issue(a, poA.id);
    const t = await app.inject(
      internal('POST', `/internal/shipments/${poA.shipments[0].id}/tracking?tenantId=${a.tenantId}`, {
        carrier: 'XPO',
        trackingNumber: 'XPO-77',
      }),
    );
    expect(t.statusCode, t.body).toBe(200);
    expect(t.json()).toMatchObject({ status: 'shipped', trackingNumber: 'XPO-77' });
    const r = await app.inject(
      internal('POST', `/internal/purchase-orders/${poA.id}/requirements?tenantId=${a.tenantId}`, {
        kind: 'cfa',
        status: 'submitted',
        note: 'From email',
      }),
    );
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ kind: 'cfa', status: 'submitted', party: 'client' });
    const summary = await app.inject(
      internal('GET', `/internal/purchase-orders/summary?tenantId=${a.tenantId}&projectId=${f.projectId}`),
    );
    expect(summary.json().pos.map((p: any) => p.id)).toContain(poA.id);
    const openPos = await app.inject(
      internal('GET', `/internal/purchase-orders/open?tenantId=${a.tenantId}&vendorId=${f.vendorA}`),
    );
    expect(openPos.json().map((p: any) => p.id)).toContain(poA.id);
  });

  it('finance.vendor_bill.paid (deposit) approves the deposit requirement, idempotently', async () => {
    const f = setupQuote(clients, a);
    const { poA } = await createPos(a, f);
    await issue(a, poA.id);
    const event = {
      id: crypto.randomUUID(),
      type: 'finance.vendor_bill.paid',
      version: 1,
      occurredAt: new Date().toISOString(),
      source: 'finance',
      tenantId: a.tenantId,
      actor: null,
      data: {
        billId: crypto.randomUUID(),
        poId: poA.id,
        vendorId: f.vendorA,
        kind: 'deposit',
        amount: 45029.8,
      },
    };
    const r1 = await app.inject(internal('POST', '/internal/events', event));
    expect(r1.statusCode, r1.body).toBe(200);
    expect(r1.json().result).toBe('processed');
    const dep = (await app.inject(json('GET', `/purchase-orders/${poA.id}`, a.adminToken)))
      .json()
      .requirements.find((r: any) => r.kind === 'deposit');
    expect(dep).toMatchObject({ status: 'approved', decidedByName: 'Accounting (deposit paid)' });
    const r2 = await app.inject(internal('POST', '/internal/events', event));
    expect(r2.json().result).toBe('duplicate');
    // Balance bills are ignored
    const balance = { ...event, id: crypto.randomUUID(), data: { ...event.data, kind: 'balance' } };
    expect((await app.inject(internal('POST', '/internal/events', balance))).json().result).toBe('processed');
  });
});

// =============================================================================================
describe('jobs', () => {
  it('ship-date-confirmations asks vendors for upcoming ship dates once per window', async () => {
    const f = setupQuote(clients, a);
    const { poA } = await createPos(a, f);
    await issue(a, poA.id);
    const sh = poA.shipments[0];
    await app.inject(
      json('PATCH', `/shipments/${sh.id}`, a.adminToken, { estimatedShipDate: addDays(today(), 20) }),
    );
    const before = (await outbox(a.tenantId, 'cmd.email.send')).length;
    const r1 = await runJobOnce('orders', shipDateConfirmations, log);
    expect((r1 as any).requested).toBeGreaterThanOrEqual(1);
    const mails = (await outbox(a.tenantId, 'cmd.email.send')).slice(before);
    const m = mails.find((x) => x.data.subject.includes(poA.number))!;
    expect(m.data.to).toEqual(['val@acme.example']);
    expect(m.data.text).toContain(`/vendor/orders/${poA.id}`);
    const confs = (await app.inject(json('GET', `/shipments/${sh.id}/confirmations`, a.adminToken))).json();
    expect(confs).toHaveLength(1);
    expect(confs[0]).toMatchObject({
      channel: 'email',
      previousDate: addDays(today(), 20),
      respondedAt: null,
    });
    // Second run in the same window: nothing new for this shipment
    await runJobOnce('orders', shipDateConfirmations, log);
    expect(
      (await app.inject(json('GET', `/shipments/${sh.id}/confirmations`, a.adminToken))).json(),
    ).toHaveLength(1);
    // Ship dates 60 days out are not asked yet
    const g = setupQuote(clients, a);
    const { poA: far } = await createPos(a, g);
    await issue(a, far.id);
    await app.inject(
      json('PATCH', `/shipments/${far.shipments[0].id}`, a.adminToken, {
        estimatedShipDate: addDays(today(), 60),
      }),
    );
    await runJobOnce('orders', shipDateConfirmations, log);
    expect(
      (await app.inject(json('GET', `/shipments/${far.shipments[0].id}/confirmations`, a.adminToken))).json(),
    ).toHaveLength(0);
  });

  it('tracking-missing requests tracking; tracking-poll progresses simulated status to delivered', async () => {
    const f = setupQuote(clients, a);
    const { poA } = await createPos(a, f);
    await issue(a, poA.id);
    const sh = poA.shipments[0];
    await app.inject(
      json('PATCH', `/shipments/${sh.id}`, a.adminToken, { estimatedShipDate: addDays(today(), -4) }),
    );
    await runJobOnce('orders', trackingMissing, log);
    const ask = (await outbox(a.tenantId, 'cmd.email.send')).filter(
      (e) => e.data.subject === `Tracking needed: ${poA.number}`,
    );
    expect(ask).toHaveLength(1);
    await runJobOnce('orders', trackingMissing, log);
    expect(
      (await outbox(a.tenantId, 'cmd.email.send')).filter(
        (e) => e.data.subject === `Tracking needed: ${poA.number}`,
      ),
    ).toHaveLength(1);

    // Escalation job: ship date 4 days past with no tracking → critical
    await runJobOnce('orders', escalations, log);
    const esc = (await app.inject(json('GET', `/purchase-orders/${poA.id}`, a.adminToken))).json();
    expect(esc.escalation).toBe('critical');
    expect(esc.escalationReasons.some((r: string) => r.includes('no tracking'))).toBe(true);

    setTrackingProvider(new SimulatedTrackingProvider());
    await app.inject(
      json('PATCH', `/shipments/${sh.id}`, a.adminToken, {
        carrier: 'Estes',
        trackingNumber: 'EST-1',
        actualShipDate: addDays(today(), -2),
      }),
    );
    await runJobOnce('orders', trackingPoll, log);
    let s = (await app.inject(json('GET', `/shipments/${sh.id}`, a.adminToken))).json();
    expect(s.status).toBe('in_transit');
    expect(s.trackingStatus).toBe('in_transit');
    expect(s.estimatedDeliveryDate).toBe(addDays(today(), 3));
    expect(s.trackingEvents.length).toBeGreaterThan(1);

    await withOwner(
      (tx) => tx`update orders.shipments set actual_ship_date = ${addDays(today(), -6)} where id = ${sh.id}`,
    );
    await runJobOnce('orders', trackingPoll, log);
    s = (await app.inject(json('GET', `/shipments/${sh.id}`, a.adminToken))).json();
    expect(s.status).toBe('delivered');
    const po = (await app.inject(json('GET', `/purchase-orders/${poA.id}`, a.adminToken))).json();
    expect(po).toMatchObject({ status: 'delivered', escalation: 'none' });
    expect(
      (await outbox(a.tenantId, 'orders.shipment.delivered')).some((e) => e.data.shipmentId === sh.id),
    ).toBe(true);
  });
});

// =============================================================================================
describe('tenant isolation', () => {
  it("never shows or changes another tenant's orders", async () => {
    const f = setupQuote(clients, a);
    const { poA } = await createPos(a, f);
    const list = await app.inject(json('GET', '/purchase-orders?includeClosed=true&limit=500', b.adminToken));
    expect(list.json().items.map((x: any) => x.id)).not.toContain(poA.id);
    for (const [m, url, body] of [
      ['GET', `/purchase-orders/${poA.id}`, undefined],
      ['PATCH', `/purchase-orders/${poA.id}`, { notes: 'x' }],
      ['POST', `/purchase-orders/${poA.id}/issue`, {}],
      ['GET', `/shipments/${poA.shipments[0].id}`, undefined],
      [
        'POST',
        `/shipments/${poA.shipments[0].id}/split`,
        { lines: [{ poLineId: poA.lines[0].id, quantity: 1 }] },
      ],
    ] as const) {
      const r = await app.inject(json(m, url, b.adminToken, body));
      expect(r.statusCode, `${m} ${url}`).toBe(404);
    }
    expect(
      (await app.inject(json('GET', '/shipments', b.adminToken)))
        .json()
        .items.some((s: any) => s.poId === poA.id),
    ).toBe(false);
    expect(
      (await app.inject(json('GET', '/requirements', b.adminToken)))
        .json()
        .items.some((r: any) => r.poId === poA.id),
    ).toBe(false);
    const cal = await app.inject(json('GET', '/calendar?from=2026-01-01&to=2028-01-01', b.adminToken));
    expect(cal.json().events.some((e: any) => e.poId === poA.id)).toBe(false);
  });
});
