import { closeDb, consume, rootLogger, withOwner } from '@procure/platform';
import { createWorld, type World } from '@procure/platform/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { costExpirySweep, costRequestReminders } from '../src/jobs.js';
import { subscriptions } from '../src/subscriptions.js';
import {
  allKeys,
  build,
  type Client,
  client,
  daysFromNow,
  internal,
  seedQuote,
  type TestApp,
  uuid,
} from './helpers.js';

// ------------------------------------------------------------------ other services (mocked)
const mocks = vi.hoisted(() => ({
  vendors: new Map<string, any>(),
  projects: new Map<string, any>(),
  catalogDown: false,
  documentsDown: false,
  rendered: [] as any[],
  specDocs: new Map<string, any[]>(),
  brandStandards: new Map<string, any>(),
}));
vi.mock('../src/clients.js', async (orig) => {
  const real = await orig<typeof import('../src/clients.js')>();
  const fail = (what: string) => Object.assign(new Error(`${what} unavailable`), { status: 502 });
  return {
    ...real,
    catalog: {
      vendor: vi.fn(async (_t: string, id: string) => {
        if (mocks.catalogDown) throw fail('catalog');
        const v = mocks.vendors.get(id);
        if (!v) throw Object.assign(new Error('not found'), { status: 404 });
        return v;
      }),
      brandStandard: vi.fn(async (_t: string, id: string) => {
        const s = mocks.brandStandards.get(id);
        if (!s) throw Object.assign(new Error('not found'), { status: 404 });
        return s;
      }),
    },
    projects: {
      get: vi.fn(async (_t: string, id: string) => {
        const p = mocks.projects.get(id);
        if (!p) throw Object.assign(new Error('not found'), { status: 404 });
        return p;
      }),
    },
    documents: {
      render: vi.fn(async (body: any) => {
        if (mocks.documentsDown) throw fail('documents');
        mocks.rendered.push(body);
        return { id: crypto.randomUUID(), filename: body.filename, kind: 'report' };
      }),
      list: vi.fn(async (_t: string, _et: string, id: string) => mocks.specDocs.get(id) ?? []),
    },
    identity: { org: vi.fn(async (_p: unknown, id: string) => ({ id, name: 'JM Hospitality Solutions' })) },
  };
});

let app: TestApp;
let a: World;
let b: World;
let A: Client;
let B: Client;

const outbox = async (type: string, tenantId: string) =>
  withOwner(
    (tx) =>
      tx<
        { data: any }[]
      >`select data from platform.outbox where type = ${type} and tenant_id = ${tenantId} order by occurred_at`,
  );

function registerVendor(w: World, id = uuid(), extra: Record<string, unknown> = {}) {
  mocks.vendors.set(id, {
    id,
    name: 'Kimball Hospitality',
    orgId: w.vendorOrgId,
    website: null,
    categories: [],
    profile: {
      leadTimeWeeks: 10,
      preferred: true,
      primaryContact: { name: 'Kim Rep', email: 'quotes@kimball.example', phone: null },
    },
    ...extra,
  });
  return id;
}
function registerProject(w: World, id = uuid()) {
  mocks.projects.set(id, {
    id,
    number: 'P-26-0001',
    name: 'Hampton Inn Raleigh',
    propertyName: 'Hampton Inn',
    brandId: null,
    clientOrgId: w.clientOrgId,
    address: {},
    contacts: [
      { name: 'Pat GM', email: 'gm@lakeside.example', phone: null, company: 'Lakeside', role: 'owner' },
    ],
  });
  return id;
}

beforeAll(async () => {
  app = await build();
  a = await createWorld('Alpha');
  b = await createWorld('Bravo');
  A = client(app, a.adminToken);
  B = client(app, b.adminToken);
});
afterAll(async () => {
  await app.close();
  await closeDb();
});
beforeEach(() => {
  mocks.catalogDown = false;
  mocks.documentsDown = false;
  mocks.rendered.length = 0;
});

// ==================================================================== specs
describe('spec library', () => {
  it('creates specs, records cost history, blocks deleting used specs', async () => {
    const s = (
      await A.post('/specs', {
        code: `X-${uuid().slice(0, 5)}`,
        name: 'Desk chair',
        category: 'seating',
        cost: 210,
      })
    ).body;
    expect(s.costStatus).toBe('ok');
    const p = await A.patch(`/specs/${s.id}`, { cost: 225, costExpiresAt: daysFromNow(5) });
    expect(p.status).toBe(200);
    expect(p.body.costStatus).toBe('expiring');
    // A partial update must not reset defaulted fields it didn't mention.
    expect(p.body.category).toBe('seating');
    const d = (await A.get(`/specs/${s.id}`)).body;
    expect(d.costHistory.map((h: any) => h.cost)).toEqual([225, 210]);
    expect(d.usage.quoteCount).toBe(0);

    const dup = await A.post('/specs', { code: s.code, name: 'Dup' });
    expect(dup.status).toBe(409);

    const { q } = await seedQuote(A, a);
    await A.post(`/quotes/${q.id}/lines`, { specIds: [s.id] });
    expect((await A.del(`/specs/${s.id}`)).status).toBe(409);
    expect((await A.get(`/specs/${s.id}`)).body.usage.quotes[0].quoteId).toBe(q.id);

    const act = (await A.get(`/specs/${s.id}/activity`)).body;
    expect(act.some((e: any) => e.action === 'update' && e.changes.cost)).toBe(true);

    const expiring = (await A.get('/specs?costStatus=expiring')).body;
    expect(expiring.items.map((x: any) => x.id)).toContain(s.id);
  });

  it('imports rows with per-row errors and upserts by code', async () => {
    const code = `IMP-${uuid().slice(0, 5)}`;
    const r1 = await A.post('/specs/import', {
      rows: [
        { code, name: 'Lounge chair', category: 'Soft Seating', cost: '$1,250.00' },
        { code: 'BAD-1', name: 'x', category: 'spaceships' },
        { name: 'no code' },
      ],
    });
    expect(r1.status).toBe(200);
    expect(r1.body).toMatchObject({ created: 1, updated: 0 });
    expect(r1.body.errors.map((e: any) => e.row)).toEqual([1, 2]);
    const r2 = await A.post('/specs/import', { rows: [{ code, name: 'Lounge chair', cost: 1300 }] });
    expect(r2.body).toMatchObject({ created: 0, updated: 1 });
    const list = (await A.get(`/specs?q=${code}`)).body;
    expect(list.items[0]).toMatchObject({ category: 'soft_seating', cost: 1300 });
  });

  it('creates specs from a brand standard with vendor assignment', async () => {
    const stdId = uuid();
    const item = {
      id: uuid(),
      code: `BS-${uuid().slice(0, 4)}`,
      name: 'Brand desk',
      category: 'casegoods',
      dimensions: '48"W',
    };
    mocks.brandStandards.set(stdId, {
      id: stdId,
      brandId: uuid(),
      brandName: 'Hampton',
      name: 'Hampton FF&E',
      version: 3,
      items: [item],
    });
    const vid = registerVendor(a);
    const r = await A.post('/specs/from-brand-standard', {
      standardId: stdId,
      vendorAssignments: { [item.id]: vid },
    });
    expect(r.status).toBe(200);
    expect(r.body.created).toBe(1);
    expect(r.body.specs[0]).toMatchObject({
      brandStandardItemId: item.id,
      vendorId: vid,
      vendorName: 'Kimball Hospitality',
    });
  });
});

// ==================================================================== quantities & structure
describe('quantities', () => {
  it('per-room quantity, attic stock, handing; room count change cascades', async () => {
    const s = await seedQuote(A, a);
    const [line] = (
      await A.post(`/quotes/${s.q.id}/lines`, {
        locationId: s.kingLoc.id,
        specIds: [s.nightstand.id],
        qtyPerRoom: { [s.king.id]: 2, [s.qq.id]: 1 },
        atticStockPct: 2,
      })
    ).body;
    // 2×62 + 1×48 = 172, attic ceil(3.44)=4
    expect(line).toMatchObject({
      qtyMode: 'per_room',
      quantity: 176,
      unitCost: 150,
      markupPct: 20,
      unitPrice: 180,
    });

    const bad = await A.patch(`/quotes/${s.q.id}/lines/${line.id}`, { handing: { left: 80, right: 80 } });
    expect(bad.status).toBe(422);
    const ok = await A.patch(`/quotes/${s.q.id}/lines/${line.id}`, { handing: { left: 88, right: 88 } });
    expect(ok.body.handing).toEqual({ left: 88, right: 88 });

    const rt = await A.patch(`/quotes/${s.q.id}/room-types/${s.king.id}`, { count: 70 });
    expect(rt.body.linesRecomputed).toBe(1);
    const after = (await A.get(`/quotes/${s.q.id}/lines`)).body.items[0];
    // 2×70 + 48 = 188, attic ceil(3.76)=4 → 192, handing rescaled
    expect(after.quantity).toBe(192);
    expect(after.handing.left + after.handing.right).toBe(192);
    expect(after.extendedPrice).toBe(192 * 180);

    // Removing a room type drops it from per-room quantities.
    await A.del(`/quotes/${s.q.id}/room-types/${s.qq.id}`);
    expect((await A.get(`/quotes/${s.q.id}/lines`)).body.items[0].quantity).toBe(140 + 3);
  });

  it('location tree: move, cycle protection, template apply, delete moves lines', async () => {
    const s = await seedQuote(A, a);
    const cyc = await A.patch(`/quotes/${s.q.id}/locations/${s.guest.id}`, { parentId: s.kingLoc.id });
    expect(cyc.status).toBe(409);
    const tpl = (
      await A.post('/location-templates', {
        name: 'Select-service prototype',
        tree: [{ name: 'Back of house', children: [{ name: 'Laundry' }, { name: 'Fitness' }] }],
      })
    ).body;
    const ap = await A.post(`/quotes/${s.q.id}/locations/apply-template`, { locationTemplateId: tpl.id });
    expect(ap.body.created).toBe(3);
    expect(ap.body.locations.map((l: any) => l.path)).toContain('Back of house > Laundry');

    const [line] = (
      await A.post(`/quotes/${s.q.id}/lines`, {
        locationId: s.lobby.id,
        specIds: [s.carpet.id],
        qtyFixed: 300,
      })
    ).body;
    await A.del(`/quotes/${s.q.id}/locations/${s.pub.id}?moveLinesTo=${s.guest.id}`);
    const l2 = (await A.get(`/quotes/${s.q.id}/lines`)).body.items.find((x: any) => x.id === line.id);
    expect(l2.locationId).toBe(s.guest.id);

    const fromQuote = await A.post('/location-templates', { name: 'Captured', quoteId: s.q.id });
    expect(fromQuote.status).toBe(201);
    expect(JSON.stringify(fromQuote.body.tree)).toContain('Laundry');
  });
});

// ==================================================================== pricing
describe('merchandising & summary', () => {
  it('applies category/location markups and solves for target margin', async () => {
    const s = await seedQuote(A, a);
    await A.post(`/quotes/${s.q.id}/lines`, {
      locationId: s.kingLoc.id,
      specIds: [s.carpet.id],
      qtyFixed: 100,
    });
    await A.post(`/quotes/${s.q.id}/lines`, {
      locationId: s.lobby.id,
      specIds: [s.carpet.id],
      qtyFixed: 100,
    });
    await A.post(`/quotes/${s.q.id}/lines`, {
      locationId: s.kingLoc.id,
      specIds: [s.headboard.id],
      qtyPerRoom: { [s.king.id]: 1 },
    });
    const r = await A.post(`/quotes/${s.q.id}/merchandise`, {
      rules: [
        { category: 'carpet', locationId: s.guest.id, markupPct: 12 },
        { category: 'carpet', locationId: s.pub.id, markupPct: 22 },
        { category: 'casegoods', markupPct: 25 },
      ],
    });
    expect(r.status).toBe(200);
    const lines = (await A.get(`/quotes/${s.q.id}/lines`)).body.items;
    const by = (code: string, loc: string) => lines.find((l: any) => l.code === code && l.locationId === loc);
    expect(by(s.carpet.code, s.kingLoc.id).markupPct).toBe(12);
    expect(by(s.carpet.code, s.lobby.id).markupPct).toBe(22);
    expect(by(s.headboard.code, s.kingLoc.id)).toMatchObject({ markupPct: 25, unitPrice: 500 });

    // Price override is respected by default.
    const hb = by(s.headboard.code, s.kingLoc.id);
    await A.patch(`/quotes/${s.q.id}/lines/${hb.id}`, { unitPrice: 520 });
    const t = await A.post(`/quotes/${s.q.id}/merchandise`, { rules: [], targetMarginPct: 30 });
    expect(t.body.solvedMarkupPct).toBeGreaterThan(0);
    expect(t.body.totals.marginPct).toBeCloseTo(30, 0);
    expect(
      (await A.get(`/quotes/${s.q.id}/lines`)).body.items.find((l: any) => l.id === hb.id).unitPrice,
    ).toBe(520);

    const sum = (await A.get(`/quotes/${s.q.id}/summary`)).body;
    expect(sum.byLocation.map((x: any) => x.label).sort()).toEqual(['Guestrooms', 'Public']);
    expect(sum.byCategory.map((x: any) => x.label).sort()).toEqual(['carpet', 'casegoods']);
    expect(sum.totals.grandTotal).toBe(sum.totals.sellSubtotal);
    // Saved rules apply to new lines added later.
    const q2 = (await A.get(`/quotes/${s.q.id}`)).body;
    expect(q2.status).toBe('merchandising');
  });

  it('flags below cost and min margin; designers cannot see costs', async () => {
    const s = await seedQuote(A, a);
    await A.patch(`/quotes/${s.q.id}`, { minMarginPct: 25 });
    const [l] = (await A.post(`/quotes/${s.q.id}/lines`, { specIds: [s.headboard.id], qtyFixed: 2 })).body;
    expect(l.flags).toContain('below_min_margin');
    const lo = await A.patch(`/quotes/${s.q.id}/lines/${l.id}`, { unitPrice: 300 });
    expect(lo.body.flags).toEqual(expect.arrayContaining(['below_cost', 'below_min_margin']));
    const q = (await A.get(`/quotes/${s.q.id}`)).body;
    expect(q.totals.flagCounts.below_cost).toBe(1);

    const designer = client(app, await a.tokenAs(['designer']));
    const dl = (await designer.get(`/quotes/${s.q.id}/lines`)).body.items[0];
    expect(dl.unitCost).toBeNull();
    expect(dl.marginPct).toBeNull();
    expect(dl.unitPrice).toBe(300);
    expect((await designer.get(`/quotes/${s.q.id}/summary`)).status).toBe(403);
    expect((await designer.patch(`/quotes/${s.q.id}/lines/${l.id}`, { unitCost: 1 })).status).toBe(403);
  });

  it('refresh-costs pulls updated library costs into draft quotes', async () => {
    const s = await seedQuote(A, a);
    const [l] = (await A.post(`/quotes/${s.q.id}/lines`, { specIds: [s.nightstand.id], qtyFixed: 10 })).body;
    await A.patch(`/specs/${s.nightstand.id}`, { cost: 160 });
    const r = await A.post(`/quotes/${s.q.id}/refresh-costs`, {});
    expect(r.body.changed).toEqual([
      expect.objectContaining({
        lineId: l.id,
        from: expect.objectContaining({ unitCost: 150 }),
        to: expect.objectContaining({ unitCost: 160 }),
      }),
    ]);
    expect((await A.get(`/quotes/${s.q.id}/lines`)).body.items[0].unitPrice).toBe(192);
  });
});

describe('price matrix', () => {
  it('builds competing options and selects a winner', async () => {
    const s = await seedQuote(A, a);
    const ofs = (
      await A.post('/specs', {
        code: `OFS-${uuid().slice(0, 4)}`,
        name: 'Desk chair OFS',
        category: 'seating',
        vendorId: uuid(),
        vendorName: 'OFS',
        cost: 310,
        leadTimeWeeks: 8,
      })
    ).body;
    const mts = (
      await A.post('/specs', {
        code: `MTS-${uuid().slice(0, 4)}`,
        name: 'Desk chair MTS',
        category: 'seating',
        vendorId: uuid(),
        vendorName: 'MTS',
        cost: 280,
        leadTimeWeeks: 14,
      })
    ).body;
    const kim = (
      await A.post('/specs', {
        code: `KIM-${uuid().slice(0, 4)}`,
        name: 'Desk chair Kimball',
        category: 'seating',
        vendorId: s.vendorId,
        vendorName: 'Kimball',
        cost: 295,
      })
    ).body;
    const [base] = (
      await A.post(`/quotes/${s.q.id}/lines`, {
        locationId: s.kingLoc.id,
        specIds: [kim.id],
        qtyPerRoom: { [s.king.id]: 1 },
      })
    ).body;
    const alts = await A.post(`/quotes/${s.q.id}/lines/${base.id}/alternates`, { specIds: [ofs.id, mts.id] });
    expect(alts.status).toBe(201);
    expect(alts.body.every((l: any) => !l.isSelected && l.quantity === 62)).toBe(true);

    const m = (await A.get(`/quotes/${s.q.id}/price-matrix`)).body;
    expect(m.slots).toHaveLength(1);
    const slot = m.slots[0];
    expect(slot.lowestUnitCost).toBe(280);
    expect(slot.selectedLineId).toBe(base.id);
    expect(slot.options.find((o: any) => o.vendorName === 'OFS').deltaVsLowest).toBe(30);

    const before = (await A.get(`/quotes/${s.q.id}`)).body.totals.costSubtotal;
    expect(before).toBe(295 * 62);
    const mtsLine = slot.options.find((o: any) => o.vendorName === 'MTS').lineId;
    const sel = await A.post(`/quotes/${s.q.id}/price-matrix/select`, {
      selections: { [slot.masterSpecId]: mtsLine },
    });
    expect(sel.body).toMatchObject({ selected: 1, deselected: 2 });
    expect((await A.get(`/quotes/${s.q.id}`)).body.totals.costSubtotal).toBe(280 * 62);
    const del = await A.post(`/quotes/${s.q.id}/price-matrix/select`, {
      selections: { [slot.masterSpecId]: mtsLine },
      deleteOthers: true,
    });
    expect(del.body.deleted).toBe(2);
    expect((await A.get(`/quotes/${s.q.id}/lines`)).body.total).toBe(1);
  });
});

// ==================================================================== templates & concurrency
describe('templates and versions', () => {
  it('copies a template deep into a new project quote', async () => {
    const s = await seedQuote(A, a);
    await A.post(`/quotes/${s.q.id}/lines`, {
      locationId: s.kingLoc.id,
      specIds: [s.headboard.id],
      qtyPerRoom: { [s.king.id]: 1 },
    });
    await A.post(`/quotes/${s.q.id}/merchandise`, {
      rules: [{ category: 'casegoods', locationId: s.guest.id, markupPct: 30 }],
    });
    const tpl = await A.post(`/quotes/${s.q.id}/copy`, {
      name: 'Home2 Suites prototype master quote',
      asTemplate: true,
    });
    expect(tpl.status).toBe(201);
    expect(tpl.body).toMatchObject({ isTemplate: true, projectId: null });

    const pid = registerProject(a);
    const q = await A.post('/quotes', { projectId: pid, name: 'Home2 Durham', templateId: tpl.body.id });
    expect(q.status).toBe(201);
    expect(q.body.clientOrgId).toBe(a.clientOrgId);
    expect(q.body.roomTypes.map((r: any) => r.code)).toEqual(['K', 'QQ']);
    expect(q.body.locations.map((l: any) => l.path)).toContain('Guestrooms > King');
    const lines = (await A.get(`/quotes/${q.body.id}/lines`)).body.items;
    expect(lines[0]).toMatchObject({ quantity: 62, unitPrice: 520 });
    // room-type ids were remapped to the new quote's room types
    expect(Object.keys(lines[0].qtyPerRoom)).toEqual([q.body.roomTypes[0].id]);
    expect(lines[0].locationId).toBe(q.body.locations.find((l: any) => l.path === 'Guestrooms > King').id);
    expect(q.body.markupRules[0].locationId).toBe(
      q.body.locations.find((l: any) => l.path === 'Guestrooms').id,
    );
    const tl = (await A.get('/quotes?isTemplate=true')).body.items.map((x: any) => x.id);
    expect(tl).toContain(tpl.body.id);
    expect(tl).not.toContain(q.body.id);
  });

  it('rejects stale If-Match with 409', async () => {
    const { q } = await seedQuote(A, a);
    const cur = (await A.get(`/quotes/${q.id}`)).body;
    const ok = await A.patch(`/quotes/${q.id}`, { notes: 'v1' }, { 'if-match': `"${cur.version}"` });
    expect(ok.status).toBe(200);
    expect(ok.body.version).toBe(cur.version + 1);
    const stale = await A.patch(`/quotes/${q.id}`, { notes: 'v2' }, { 'if-match': `"${cur.version}"` });
    expect(stale.status).toBe(409);
    expect(stale.body.detail.currentVersion).toBe(cur.version + 1);
  });

  it('activity covers the quote and its lines', async () => {
    const s = await seedQuote(A, a);
    const [l] = (await A.post(`/quotes/${s.q.id}/lines`, { specIds: [s.headboard.id], qtyFixed: 1 })).body;
    await A.patch(`/quotes/${s.q.id}/lines/${l.id}`, { qtyFixed: 3 });
    const act = (await A.get(`/quotes/${s.q.id}/activity`)).body;
    expect(act.some((e: any) => e.entityType === 'quote_line' && e.changes.qtyFixed)).toBe(true);
  });
});

// ==================================================================== tenant isolation
describe('tenant isolation', () => {
  it("cannot see or modify another tenant's quotes and specs", async () => {
    const s = await seedQuote(A, a);
    expect((await B.get(`/quotes/${s.q.id}`)).status).toBe(404);
    expect((await B.patch(`/quotes/${s.q.id}`, { name: 'pwned' })).status).toBe(404);
    expect((await B.get(`/specs/${s.headboard.id}`)).status).toBe(404);
    expect((await B.get('/quotes')).body.items.map((q: any) => q.id)).not.toContain(s.q.id);
    expect((await B.post(`/quotes/${s.q.id}/lines`, { specIds: [s.headboard.id] })).status).toBe(404);
    // B cannot place A's spec on its own quote either
    const sb = await seedQuote(B, b);
    expect((await B.post(`/quotes/${sb.q.id}/lines`, { specIds: [s.headboard.id] })).status).toBe(400);
  });

  it('external actors cannot use internal routes', async () => {
    const s = await seedQuote(A, a);
    const V = client(app, a.vendorToken);
    const C = client(app, a.clientToken);
    for (const c of [V, C]) {
      expect((await c.get('/specs')).status).toBe(403);
      expect((await c.get(`/quotes/${s.q.id}`)).status).toBe(403);
    }
  });
});

// ==================================================================== cost requests
describe('cost request lifecycle', () => {
  it('sends per vendor, vendor responds via portal, staff compare and apply to quote + spec', async () => {
    const vid = registerVendor(a);
    const otherVendor = registerVendor(b); // B's vendor (orgId = b.vendorOrgId)
    const s = await seedQuote(A, a, { vendorId: vid });
    const lines = (
      await A.post(`/quotes/${s.q.id}/lines`, {
        locationId: s.kingLoc.id,
        specIds: [s.headboard.id, s.nightstand.id, s.carpet.id],
        qtyFixed: 10,
      })
    ).body;
    await A.patch(`/quotes/${s.q.id}/lines/${lines[2].id}`, { unitCost: null }); // carpet: no vendor
    void otherVendor;

    const sent = await A.post(`/quotes/${s.q.id}/cost-requests`, {
      dueDate: daysFromNow(7),
      message: 'Please quote by Friday',
    });
    expect(sent.status).toBe(201);
    expect(sent.body.requests).toHaveLength(1);
    expect(sent.body.skipped.map((x: any) => x.code)).toEqual([s.carpet.code]);
    const cr = sent.body.requests[0];
    expect(cr).toMatchObject({
      status: 'sent',
      vendorOrgId: a.vendorOrgId,
      vendorEmail: 'quotes@kimball.example',
      lineCount: 2,
    });
    expect(cr.documentId).toBeTruthy();
    expect(mocks.rendered.at(-1)).toMatchObject({
      template: 'cost_request',
      visibility: 'vendor',
      vendorOrgId: a.vendorOrgId,
    });
    const ev = await outbox('quoting.cost_request.sent', a.tenantId);
    expect(ev.at(-1)!.data).toMatchObject({ costRequestId: cr.id, vendorOrgId: a.vendorOrgId, lineCount: 2 });
    expect((await A.get(`/quotes/${s.q.id}`)).body.status).toBe('costing');

    // ---- vendor portal
    const V = client(app, a.vendorToken);
    const list = await V.get('/vendor/cost-requests');
    expect(list.status).toBe(200);
    expect(list.body.items.map((x: any) => x.id)).toEqual([cr.id]);
    const det = await V.get(`/vendor/cost-requests/${cr.id}`);
    expect(det.status).toBe(200);
    expect(det.body.status).toBe('viewed');
    const forbiddenKeys = [
      'unitPrice',
      'markupPct',
      'marginPct',
      'extendedPrice',
      'currentCost',
      'quoteId',
      'vendorId',
      'vendorName',
      'notes',
      'clientOrgId',
      'createdByName',
    ];
    for (const k of forbiddenKeys) expect(allKeys(det.body).has(k)).toBe(false);
    for (const k of forbiddenKeys) expect(allKeys(list.body).has(k)).toBe(false);

    // Another tenant's vendor (and the other world's vendor token) sees nothing.
    const VB = client(app, b.vendorToken);
    expect((await VB.get(`/vendor/cost-requests/${cr.id}`)).status).toBe(404);
    expect((await VB.get('/vendor/cost-requests')).body.items).toHaveLength(0);
    // Vendor cannot touch internal cost-request routes.
    expect((await V.get(`/cost-requests/${cr.id}`)).status).toBe(403);

    const hbLine = det.body.lines.find((l: any) => l.code === s.headboard.code);
    const nsLine = det.body.lines.find((l: any) => l.code === s.nightstand.code);
    const notYet = await V.post(`/vendor/cost-requests/${cr.id}/submit`);
    expect(notYet.status).toBe(422);
    const r1 = await V.put(`/vendor/cost-requests/${cr.id}/lines/${hbLine.id}`, {
      cost: 425,
      expiresAt: daysFromNow(60),
      leadTimeWeeks: 12,
      notes: 'Price includes walnut upcharge',
      specChanges: { dimensions: { from: '80"W x 2"D x 48"H', to: '80 1/4"W x 2"D x 48"H' } },
    });
    expect(r1.status).toBe(200);
    for (const k of forbiddenKeys) expect(allKeys(r1.body).has(k)).toBe(false);
    await V.put(`/vendor/cost-requests/${cr.id}/lines/${nsLine.id}`, {
      cost: 155,
      expiresAt: daysFromNow(60),
    });
    const sub = await V.post(`/vendor/cost-requests/${cr.id}/submit`);
    expect(sub.status).toBe(200);
    expect(sub.body.status).toBe('responded');
    expect((await outbox('quoting.cost_request.responded', a.tenantId)).at(-1)!.data).toMatchObject({
      costRequestId: cr.id,
      source: 'portal',
    });
    expect((await outbox('cmd.notify', a.tenantId)).some((e) => e.data.roles.includes('procurement'))).toBe(
      true,
    );

    // Vendor activity is attributed in the audit log (external actor insert allowed).
    const act = await withOwner(
      (tx) => tx<{ actorType: string }[]>`
      select actor_type from platform.activity_log where entity_type = 'cost_request' and entity_id = ${cr.id} and actor_type = 'vendor'`,
    );
    expect(act.length).toBeGreaterThan(0);

    // ---- compare
    const cmp = (await A.get(`/cost-requests/${cr.id}/compare`)).body;
    const hbRow = cmp.rows.find((r: any) => r.line.code === s.headboard.code);
    expect(hbRow.vendorResponse.cost).toBe(425);
    expect(hbRow.librarySpec.cost).toBe(400);
    expect(hbRow.quoteLine.unitCost).toBe(400);
    expect(hbRow.differences.map((d: any) => d.field).sort()).toEqual([
      'cost',
      'dimensions',
      'leadTimeWeeks',
    ]);
    expect(hbRow.projectedMarginPct).toBeCloseTo(16.67, 1);

    // ---- apply headboard to quote + spec + spec corrections
    const ap = await A.post(`/cost-requests/${cr.id}/apply`, {
      lineIds: [hbLine.id],
      applyToSpec: true,
      applySpecChanges: true,
    });
    expect(ap.status).toBe(200);
    expect(ap.body).toMatchObject({ applied: 1, specsUpdated: 1, status: 'partially_applied' });
    const ql = (await A.get(`/quotes/${s.q.id}/lines`)).body.items.find(
      (l: any) => l.code === s.headboard.code,
    );
    expect(ql).toMatchObject({
      unitCost: 425,
      leadTimeWeeks: 12,
      dimensions: '80 1/4"W x 2"D x 48"H',
      unitPrice: 510,
    });
    const spec = (await A.get(`/specs/${s.headboard.id}`)).body;
    expect(spec).toMatchObject({ cost: 425, dimensions: '80 1/4"W x 2"D x 48"H' });
    expect(spec.costHistory[0]).toMatchObject({ cost: 425, source: 'cost_request', costRequestId: cr.id });

    // Another draft quote using the spec picks it up with refresh-costs.
    const other = await seedQuote(A, a, { vendorId: vid });
    const [ol] = (await A.post(`/quotes/${other.q.id}/lines`, { specIds: [s.headboard.id] })).body;
    expect(ol.unitCost).toBe(425); // new lines snapshot latest
    // ---- apply remaining → applied
    const ap2 = await A.post(`/cost-requests/${cr.id}/apply`, {});
    expect(ap2.body).toMatchObject({ applied: 1, status: 'applied' });
    // Vendor can no longer respond after apply/close
    await A.post(`/cost-requests/${cr.id}/close`);
    const late = await V.put(`/vendor/cost-requests/${cr.id}/lines/${nsLine.id}`, { cost: 1 });
    expect(late.status).toBe(409);
  });

  it('vendor RLS blocks direct writes to other vendors and quote data', async () => {
    const vid = registerVendor(a);
    const s = await seedQuote(A, a, { vendorId: vid });
    await A.post(`/quotes/${s.q.id}/lines`, { specIds: [s.headboard.id], qtyFixed: 1 });
    const cr = (await A.post(`/quotes/${s.q.id}/cost-requests`, {})).body.requests[0];
    // Simulate a vendor-context transaction: quotes/specs/lines invisible, only own request visible.
    const { withContext } = await import('@procure/platform');
    const seen = await withContext(
      { tenantId: a.tenantId, userId: a.vendorUserId, orgId: a.vendorOrgId, actor: 'vendor' },
      async (tx) => ({
        quotes: (await tx`select id from quoting.quotes`).length,
        lines: (await tx`select id from quoting.quote_lines`).length,
        specs: (await tx`select id from quoting.specs`).length,
        crs: (await tx`select id, vendor_org_id from quoting.cost_requests`) as any[],
        updQuote: (await tx`update quoting.quote_lines set unit_price = 0 returning id`).length,
      }),
    );
    expect(seen).toMatchObject({ quotes: 0, lines: 0, specs: 0, updQuote: 0 });
    expect(seen.crs.map((r) => r.id)).toContain(cr.id);
    expect(seen.crs.every((r) => r.vendorOrgId === a.vendorOrgId)).toBe(true);
    // A different vendor org in the same tenant sees none of them.
    const other = await withContext(
      { tenantId: a.tenantId, userId: b.vendorUserId, orgId: b.vendorOrgId, actor: 'vendor' },
      async (tx) => (await tx`select id from quoting.cost_requests`).length,
    );
    expect(other).toBe(0);
    const otherVendor = await withContext(
      { tenantId: a.tenantId, userId: b.vendorUserId, orgId: b.vendorOrgId, actor: 'vendor' },
      async (tx) => (await tx`update quoting.cost_request_lines set response_cost = 1 returning id`).length,
    );
    expect(otherVendor).toBe(0);
  });

  it('manual responses, internal AI responses, reminders and missing-cost filtering', async () => {
    const vid = registerVendor(a);
    const s = await seedQuote(A, a, { vendorId: vid });
    const [hb, ns] = (
      await A.post(`/quotes/${s.q.id}/lines`, { specIds: [s.headboard.id, s.nightstand.id], qtyFixed: 4 })
    ).body;
    await A.patch(`/quotes/${s.q.id}/lines/${ns.id}`, { costExpiresAt: daysFromNow(-1) });
    const sent = (
      await A.post(`/quotes/${s.q.id}/cost-requests`, {
        onlyExpiredOrMissing: true,
        dueDate: daysFromNow(-2),
      })
    ).body;
    expect(sent.requests[0].lineCount).toBe(1);
    const cr = (await A.get(`/cost-requests/${sent.requests[0].id}`)).body;
    expect(cr.lines[0].quoteLineId).toBe(ns.id);
    void hb;

    const internalGet = await app.inject({
      method: 'GET',
      url: `/internal/cost-requests/${cr.id}?tenantId=${a.tenantId}`,
      headers: internal,
    });
    expect(internalGet.json().lines[0]).toMatchObject({ id: cr.lines[0].id, currentCost: 150 });
    const ai = await app.inject({
      method: 'POST',
      url: `/internal/cost-requests/${cr.id}/responses?tenantId=${a.tenantId}`,
      headers: internal,
      payload: {
        source: 'ai_pdf',
        lines: [{ costRequestLineId: cr.lines[0].id, cost: 149, expiresAt: daysFromNow(30) }],
      },
    });
    expect(ai.statusCode).toBe(200);
    expect(ai.json().status).toBe('responded');
    const man = await A.put(`/cost-requests/${cr.id}/lines/${cr.lines[0].id}/response`, {
      cost: 148,
      notes: 'Phoned in',
    });
    expect(man.body).toMatchObject({ responseCost: 148, responseSource: 'manual' });

    // Reminder job: request 2 is overdue and never reminded.
    const vid2 = registerVendor(a);
    const s2 = await seedQuote(A, a, { vendorId: vid2 });
    await A.post(`/quotes/${s2.q.id}/lines`, { specIds: [s2.headboard.id] });
    const cr2 = (await A.post(`/quotes/${s2.q.id}/cost-requests`, { dueDate: daysFromNow(-1) })).body
      .requests[0];
    const run = () => withOwner((tx) => costRequestReminders(tx as never, new Date()));
    const r1 = await run();
    expect(r1.sent).toBeGreaterThanOrEqual(1);
    const r2 = await run();
    expect(r2.sent).toBe(0); // max one per 3 days
    const emails = await outbox('cmd.email.send', a.tenantId);
    expect(emails.some((e) => e.data.text.includes(`/vendor/cost-requests/${cr2.id}`))).toBe(true);
    expect((await A.post(`/cost-requests/${cr2.id}/remind`, {})).status).toBe(200);
  });

  it('tolerates catalog and documents being unavailable', async () => {
    const s = await seedQuote(A, a);
    await A.post(`/quotes/${s.q.id}/lines`, { specIds: [s.headboard.id] });
    mocks.catalogDown = true;
    mocks.documentsDown = true;
    const r = await A.post(`/quotes/${s.q.id}/cost-requests`, {});
    expect(r.status).toBe(201);
    expect(r.body.requests[0]).toMatchObject({ vendorOrgId: null, documentId: null });
    expect(r.body.warnings.length).toBeGreaterThanOrEqual(2);
  });
});

// ==================================================================== approvals & client
async function readyQuote(w: World, c: Client, markup = 25) {
  const pid = registerProject(w);
  const vid = registerVendor(w);
  const s = await seedQuote(c, w, { projectId: pid, vendorId: vid });
  await c.post(`/quotes/${s.q.id}/lines`, {
    locationId: s.kingLoc.id,
    specIds: [s.headboard.id],
    qtyPerRoom: { [s.king.id]: 1 },
  });
  await c.post(`/quotes/${s.q.id}/lines`, {
    locationId: s.lobby.id,
    specIds: [s.carpet.id],
    qtyFixed: 50,
    markupPct: 10,
  });
  await c.post(`/quotes/${s.q.id}/merchandise`, {
    rules: [{ category: 'casegoods', markupPct: markup }],
    saveRules: false,
  });
  return { ...s, projectId: pid };
}

describe('approval rules engine', () => {
  it('blocks send-to-client until approvals are decided; rejection and invalidation', async () => {
    const w = await createWorld('Gamma');
    const G = client(app, w.adminToken);
    const pol = await G.post('/approval-policies', {
      name: 'Casegoods margin floor',
      condition: { type: 'line_margin_below', pct: 22, category: 'casegoods' },
      approverRole: 'executive',
    });
    expect(pol.status).toBe(201);
    await G.post('/approval-policies', {
      name: 'Big quotes',
      condition: { type: 'quote_total_above', amount: 1_000_000 },
      approverRole: 'executive',
    });
    const badPol = await G.post('/approval-policies', {
      name: 'x',
      condition: { type: 'nope' },
      approverRole: 'admin',
    });
    expect(badPol.status).toBe(400);

    const s = await readyQuote(w, G, 20); // casegoods margin 16.67% < 22
    // policy floor shows up as a flag
    const hb = (await G.get(`/quotes/${s.q.id}/lines?category=casegoods`)).body.items[0];
    expect(hb.flags).toContain('below_min_margin');

    const send = await G.post(`/quotes/${s.q.id}/send-to-client`, {});
    expect(send.status).toBe(409);
    expect(send.body.detail.approvals[0]).toMatchObject({
      policyName: 'Casegoods margin floor',
      approverRole: 'executive',
    });
    expect((await G.get(`/quotes/${s.q.id}`)).body).toMatchObject({
      status: 'pending_internal_approval',
      pendingApprovals: 1,
    });
    expect((await outbox('quoting.approval.requested', w.tenantId)).length).toBe(1);

    // PM (requester role lacks approvals:decide) cannot decide; executive can.
    const pmId = w.adminId;
    const pm = client(app, await w.tokenAs(['project_manager'], pmId));
    const mine = (
      await client(app, await w.tokenAs(['executive'], uuid())).get('/approvals?mine=true&status=pending')
    ).body;
    expect(mine.items).toHaveLength(1);
    const apr = mine.items[0];
    expect(apr.details.lines[0].code).toBe(s.headboard.code);
    expect((await pm.post(`/approvals/${apr.id}/decide`, { decision: 'approved' })).status).toBe(403);
    const procurement = client(app, await w.tokenAs(['procurement'], uuid()));
    expect((await procurement.post(`/approvals/${apr.id}/decide`, { decision: 'approved' })).status).toBe(
      403,
    );

    // Reject → back to merchandising, send still blocked until resubmitted & approved
    const execUser = (
      await withOwner(
        (tx) => tx<{ id: string }[]>`
      insert into identity.users (email, name) values (${`exec.${uuid().slice(0, 6)}@example.com`}, 'Exec') returning id`,
      )
    )[0]!.id;
    const exec = client(app, await w.tokenAs(['executive'], execUser));
    const rej = await exec.post(`/approvals/${apr.id}/decide`, {
      decision: 'rejected',
      comment: 'Raise casegoods to 25%',
    });
    expect(rej.body).toMatchObject({
      status: 'rejected',
      quoteStatus: 'merchandising',
      quoteApproved: false,
    });
    const again = await G.post(`/quotes/${s.q.id}/submit-for-approval`);
    expect(again.body.approved).toBe(false);
    const apr2 = again.body.requests[0];
    const ok = await exec.post(`/approvals/${apr2.id}/decide`, {
      decision: 'approved',
      comment: 'OK for this owner',
    });
    expect(ok.body).toMatchObject({ quoteApproved: true, quoteStatus: 'merchandising' });
    expect((await outbox('quoting.approval.decided', w.tenantId)).length).toBe(2);

    // A pricing change after approval invalidates it.
    await G.patch(`/quotes/${s.q.id}/lines/${hb.id}`, { markupPct: 21 });
    expect((await G.get(`/quotes/${s.q.id}`)).body.internalApprovedAt).toBeNull();
    // Fix the margin → policies pass → send works.
    await G.patch(`/quotes/${s.q.id}/lines/${hb.id}`, { markupPct: 30 });
    const sendOk = await G.post(`/quotes/${s.q.id}/send-to-client`, { message: 'Please review' });
    expect(sendOk.status).toBe(200);
    expect(sendOk.body).toMatchObject({ status: 'sent', sentTo: ['gm@lakeside.example'] });
  });

  it('vendor_not_preferred skips with a warning when catalog is down; below-cost lines block send', async () => {
    const w = await createWorld('Delta');
    const D = client(app, w.adminToken);
    await D.post('/approval-policies', {
      name: 'Preferred vendors',
      condition: { type: 'vendor_not_preferred' },
      approverRole: 'procurement',
    });
    const s = await readyQuote(w, D);
    mocks.catalogDown = true;
    const r = await D.post(`/quotes/${s.q.id}/submit-for-approval`);
    expect(r.body.approved).toBe(true);
    expect(r.body.warnings[0]).toMatch(/skipped/);
    mocks.catalogDown = false;
    mocks.vendors.get(s.vendorId).profile.preferred = false;
    const r2 = await D.post(`/quotes/${s.q.id}/submit-for-approval`);
    expect(r2.body.approved).toBe(false);
    expect(r2.body.requests[0].approverRole).toBe('procurement');

    const s2 = await readyQuote(w, D);
    const hb = (await D.get(`/quotes/${s2.q.id}/lines?category=casegoods`)).body.items[0];
    await D.patch(`/quotes/${s2.q.id}/lines/${hb.id}`, { unitPrice: 100 });
    const send = await D.post(`/quotes/${s2.q.id}/send-to-client`, {});
    expect(send.status).toBe(409);
    expect(send.body.title).toMatch(/below cost/);
  });
});

describe('client portal and ordering handoff', () => {
  it('client sees sell-side only, approves with signature; ordering handoff; PO subscription', async () => {
    const s = await readyQuote(a, A);
    // Not yet sent → invisible to client
    const C = client(app, a.clientToken);
    expect((await C.get(`/client/quotes/${s.q.id}`)).status).toBe(404);
    // ready_to_order is not allowed before client approval
    const hb = (await A.get(`/quotes/${s.q.id}/lines?category=casegoods`)).body.items[0];
    expect((await A.patch(`/quotes/${s.q.id}/lines/${hb.id}`, { readyToOrder: true })).status).toBe(409);

    const sent = await A.post(`/quotes/${s.q.id}/send-to-client`, {});
    expect(sent.status).toBe(200);
    expect(mocks.rendered.at(-1)).toMatchObject({
      template: 'quote',
      visibility: 'client',
      clientOrgId: a.clientOrgId,
    });
    const pdfKeys = allKeys(mocks.rendered.at(-1).data);
    for (const k of ['unitCost', 'marginPct', 'vendor', 'cost']) expect(pdfKeys.has(k)).toBe(false);
    expect((await outbox('quoting.quote.sent_to_client', a.tenantId)).at(-1)!.data.quoteId).toBe(s.q.id);
    // Quote content is locked once sent.
    expect((await A.patch(`/quotes/${s.q.id}/lines/${hb.id}`, { markupPct: 50 })).status).toBe(409);

    const list = await C.get('/client/quotes');
    expect(list.status).toBe(200);
    expect(list.body.items.map((x: any) => x.id)).toEqual([s.q.id]);
    const d = await C.get(`/client/quotes/${s.q.id}`);
    expect(d.status).toBe(200);
    const keys = allKeys(d.body);
    for (const k of [
      'unitCost',
      'extendedCost',
      'markupPct',
      'marginPct',
      'vendorId',
      'vendorName',
      'vendorSku',
      'flags',
      'notes',
      'costExpiresAt',
      'freightUnit',
      'costSubtotal',
    ])
      expect(keys.has(k)).toBe(false);
    expect(d.body.sections.map((x: any) => x.location)).toEqual(['Guestrooms > King', 'Public > Lobby']);
    expect(d.body.sections[0].lines[0]).toMatchObject({ quantity: 62, unitPrice: 500 });
    expect(d.body.total).toBe(d.body.totals.total);

    // Other tenant's client and other client orgs see nothing
    expect((await client(app, b.clientToken).get(`/client/quotes/${s.q.id}`)).status).toBe(404);
    // Client cannot use internal lines endpoint
    expect((await C.get(`/quotes/${s.q.id}/lines`)).status).toBe(403);
    // Client viewer without approve permission
    const viewer = client(
      app,
      await (await import('@procure/platform/testing')).tokenFor({
        userId: a.clientUserId,
        orgId: a.clientOrgId,
        tenantId: a.tenantId,
        actor: 'client',
        roles: ['client_viewer'],
      }),
    );
    expect(
      (
        await viewer.post(`/client/quotes/${s.q.id}/decision`, {
          decision: 'approved',
          signatureName: 'Pat GM',
        })
      ).status,
    ).toBe(403);

    const dec = await C.post(`/client/quotes/${s.q.id}/decision`, {
      decision: 'approved',
      signatureName: 'Pat Owner',
      comment: 'Looks good',
    });
    expect(dec.status).toBe(200);
    expect(dec.body).toMatchObject({ status: 'client_approved', clientSignatureName: 'Pat Owner' });
    expect(
      (
        await C.post(`/client/quotes/${s.q.id}/decision`, {
          decision: 'rejected',
          signatureName: 'Pat Owner',
        })
      ).status,
    ).toBe(409);
    expect((await outbox('quoting.quote.client_decided', a.tenantId)).at(-1)!.data).toMatchObject({
      quoteId: s.q.id,
      decision: 'approved',
    });

    // ---- ordering handoff
    const all = (await A.get(`/quotes/${s.q.id}/lines`)).body.items;
    const bulk = await A.post(`/quotes/${s.q.id}/lines/bulk`, {
      lineIds: all.map((l: any) => l.id),
      patch: { readyToOrder: true },
    });
    expect(bulk.status).toBe(200);
    const ol = await app.inject({
      method: 'GET',
      url: `/internal/quotes/${s.q.id}/order-lines?tenantId=${a.tenantId}`,
      headers: internal,
    });
    expect(ol.statusCode).toBe(200);
    const olb = ol.json();
    expect(olb.quote).toMatchObject({ id: s.q.id, status: 'client_approved' });
    expect(olb.lines).toHaveLength(2);
    expect(olb.lines.find((l: any) => l.id === hb.id)).toMatchObject({
      locationName: 'Guestrooms > King',
      quantity: 62,
      unitCost: 400,
      readyToOrder: true,
      poId: null,
    });
    // Wrong tenant → 404
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/internal/quotes/${s.q.id}/order-lines?tenantId=${b.tenantId}`,
          headers: internal,
        })
      ).statusCode,
    ).toBe(404);
    // No internal header → 403
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/internal/quotes/${s.q.id}/order-lines?tenantId=${a.tenantId}`,
        })
      ).statusCode,
    ).toBe(403);

    const summary = await app.inject({
      method: 'GET',
      url: `/internal/quotes/summary?tenantId=${a.tenantId}&projectId=${s.projectId}`,
      headers: internal,
    });
    expect(summary.json().quotes[0]).toMatchObject({ id: s.q.id, status: 'client_approved' });
    expect(summary.json().quotes[0].approvedAt).toBeTruthy();

    // ---- orders.po.created subscription
    const log = rootLogger('quoting-test');
    const poId = uuid();
    const ev = (lineIds: string[], id = uuid()) => ({
      id,
      type: 'orders.po.created',
      version: 1,
      occurredAt: new Date().toISOString(),
      source: 'orders',
      tenantId: a.tenantId,
      actor: null,
      data: {
        poId,
        projectId: s.projectId,
        vendorId: s.vendorId,
        number: 'PO-26-0001',
        total: 1,
        quoteId: s.q.id,
        quoteLineIds: lineIds,
      },
    });
    const e1 = ev([hb.id]);
    expect(await consume('quoting', e1 as never, subscriptions, log)).toBe('processed');
    expect(await consume('quoting', e1 as never, subscriptions, log)).toBe('duplicate');
    expect((await A.get(`/quotes/${s.q.id}`)).body.status).toBe('client_approved'); // carpet still unordered
    const carpet = all.find((l: any) => l.id !== hb.id);
    await consume('quoting', ev([carpet.id]) as never, subscriptions, log);
    const after = (await A.get(`/quotes/${s.q.id}/lines`)).body.items;
    expect(after.every((l: any) => l.poNumber === 'PO-26-0001')).toBe(true);
    expect((await A.get(`/quotes/${s.q.id}`)).body.status).toBe('ordered');
    // Ordered lines are protected.
    expect((await A.del(`/quotes/${s.q.id}/lines/${hb.id}`)).status).toBe(409);
    expect((await A.patch(`/quotes/${s.q.id}/lines/${hb.id}`, { readyToOrder: false })).status).toBe(409);
  });

  it('client rejection lets the team revise and resend', async () => {
    const s = await readyQuote(a, A);
    await A.post(`/quotes/${s.q.id}/send-to-client`, {});
    const C = client(app, a.clientToken);
    const r = await C.post(`/client/quotes/${s.q.id}/decision`, {
      decision: 'rejected',
      signatureName: 'Pat Owner',
      comment: 'Too high',
    });
    expect(r.body.status).toBe('client_rejected');
    const hb = (await A.get(`/quotes/${s.q.id}/lines?category=casegoods`)).body.items[0];
    expect((await A.patch(`/quotes/${s.q.id}/lines/${hb.id}`, { markupPct: 22 })).status).toBe(200);
    expect((await A.get(`/quotes/${s.q.id}`)).body.status).toBe('merchandising');
    const resend = await A.post(`/quotes/${s.q.id}/send-to-client`, {});
    expect(resend.status).toBe(200);
    expect((await C.get(`/client/quotes/${s.q.id}`)).body.clientDecision).toBeNull();
  });

  it('renders internal report and spec book', async () => {
    const s = await readyQuote(a, A);
    mocks.specDocs.set(s.headboard.id, [
      { id: uuid(), filename: 'cut.pdf', kind: 'spec_sheet', includeInSpecBook: true },
      { id: uuid(), filename: 'internal.pdf', kind: 'other', includeInSpecBook: false },
    ]);
    const rep = await A.post(`/quotes/${s.q.id}/report`, { variant: 'internal' });
    expect(rep.status).toBe(200);
    expect(mocks.rendered.at(-1)).toMatchObject({ template: 'quote', visibility: 'internal' });
    expect(allKeys(mocks.rendered.at(-1).data).has('unitCost')).toBe(true);
    const designer = client(app, await a.tokenAs(['designer']));
    expect((await designer.post(`/quotes/${s.q.id}/report`, { variant: 'internal' })).status).toBe(403);

    const sb = await A.post(`/quotes/${s.q.id}/spec-book`, { includeDocuments: true });
    expect(sb.status).toBe(200);
    expect(sb.body.specCount).toBe(2);
    const data = mocks.rendered.at(-1).data;
    expect(mocks.rendered.at(-1).template).toBe('spec_book');
    expect(data.specs.find((x: any) => x.code === s.headboard.code)).toMatchObject({
      location: 'Guestrooms > King',
      documentIds: [expect.any(String)],
    });
  });
});

// ==================================================================== jobs
describe('cost expiry sweep', () => {
  it('recomputes expiry flags and notifies procurement once per newly flagged quote', async () => {
    const w = await createWorld('Echo');
    const E = client(app, w.adminToken);
    const s = await seedQuote(E, w);
    const [l] = (await E.post(`/quotes/${s.q.id}/lines`, { specIds: [s.headboard.id], qtyFixed: 1 })).body;
    expect(l.flags).toEqual([]);
    // Time passes: run the sweep "80 days later" (cost expires in 90 → within 14 days)
    const later = new Date(Date.now() + 80 * 86_400_000);
    const r = await withOwner((tx) => costExpirySweep(tx as never, later));
    expect(r.tenantsNotified).toBeGreaterThanOrEqual(1);
    const flagged = (await E.get(`/quotes/${s.q.id}/lines`)).body.items[0];
    expect(flagged.flags).toContain('cost_expiring');
    const notes = (await outbox('cmd.notify', w.tenantId)).filter((n) => n.data.title.includes('expiring'));
    expect(notes).toHaveLength(1);
    expect(notes[0]!.data.body).toContain(s.q.number);
    await withOwner((tx) => costExpirySweep(tx as never, later));
    expect(
      (await outbox('cmd.notify', w.tenantId)).filter((n) => n.data.title.includes('expiring')),
    ).toHaveLength(1);
  });
});

describe('contract', () => {
  it('publishes an OpenAPI document with every public route tagged and summarized', async () => {
    const r = await app.inject({ method: 'GET', url: '/openapi.json' });
    expect(r.statusCode).toBe(200);
    const paths = r.json().paths as Record<string, Record<string, { tags?: string[]; summary?: string }>>;
    expect(Object.keys(paths).length).toBeGreaterThan(40);
    for (const [path, ops] of Object.entries(paths))
      for (const [m, op] of Object.entries(ops)) {
        expect(op.tags?.length, `${m} ${path} tags`).toBeTruthy();
        expect(op.summary, `${m} ${path} summary`).toBeTruthy();
      }
  });
});
