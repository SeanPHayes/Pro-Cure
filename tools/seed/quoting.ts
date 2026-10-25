import type { Ctx } from './business.js';

/**
 * Spec library, approval policies and four quotes at different points of the lifecycle:
 *   Hampton Inn Wilmington — approved by the owner, ready to order (orders seed issues POs)
 *   Home2 Suites RDU       — approved by the owner, ready to order; has a price-matrix alternate
 *   Tru by Hilton Cary     — costing: missing/expired prices, open requests to two vendors
 *   Home2 prototype        — a template quote for future Home2 projects
 */

/** Unit cost, sell unit, vendor SKU, lead time by base item code. */
const COSTS: Record<string, { cost: number; unit?: string; sku?: string }> = {
  'CG-01': { cost: 685, sku: 'CC-HB80-W' },
  'CG-02': { cost: 560, sku: 'CC-HB64-W' },
  'CG-03': { cost: 245, sku: 'CC-NS22-WH' },
  'CG-04': { cost: 1180, sku: 'CC-MU72' },
  'CG-05': { cost: 890, sku: 'CC-WR42' },
  'CG-06': { cost: 540, sku: 'CC-DK48-WM' },
  'ST-01': { cost: 365, sku: 'NS-2210' },
  'ST-02': { cost: 615, sku: 'NS-3140' },
  'ST-03': { cost: 1850, sku: 'NS-5590' },
  'ST-04': { cost: 185, sku: 'NS-1020' },
  'TB-01': { cost: 210 },
  'LT-01': { cost: 265, sku: 'LF-FL64-BK' },
  'LT-02': { cost: 120, sku: 'LF-TL18-BB' },
  'LT-03': { cost: 175, sku: 'LF-VS24-BN' },
  'MR-01': { cost: 395, sku: 'LF-MR30-LED' },
  'MR-02': { cost: 160 },
  'WC-01': { cost: 210, unit: 'width', sku: 'HT-BO-RF' },
  'WC-02': { cost: 120, unit: 'width', sku: 'HT-SH-RF' },
  'BD-01': { cost: 65, sku: 'HT-BS-K' },
  'CP-01': { cost: 28, unit: 'sy', sku: 'MCM-FS2424' },
  'FL-01': { cost: 3.9, unit: 'sf', sku: 'MCM-LVT748' },
  'AR-01': { cost: 145 },
  'PL-01': { cost: 3400, sku: 'NS-7700' },
  'PL-02': { cost: 1450, sku: 'NS-7710' },
  'PL-03': { cost: 6200, sku: 'CC-CT120' },
  'PL-04': { cost: 2800, sku: 'LF-PC5-SG' },
  'PB-01': { cost: 245, sku: 'NS-4405' },
  'PB-02': { cost: 320 },
  'PB-03': { cost: 14500, unit: 'ls' },
  'PF-01': { cost: 2200, unit: 'ls' },
  'PC-01': { cost: 34, unit: 'sy', sku: 'MCM-LD12' },
  'PO-01': { cost: 4200, unit: 'set', sku: 'PRF-PATIO4' },
};

/** Where each item goes and how many: per room type code, or a fixed quantity. */
const PLACEMENT: Record<
  string,
  { loc: string; perRoom?: Record<string, number>; fixed?: number; handing?: boolean }
> = {
  'CG-01': { loc: 'Guestrooms', perRoom: { KNG: 1, KS: 1, ADA: 1 } },
  'CG-02': { loc: 'Guestrooms', perRoom: { QQ: 2 } },
  'CG-03': { loc: 'Guestrooms', perRoom: { KNG: 2, KS: 2, ADA: 2, QQ: 1 }, handing: true },
  'CG-04': { loc: 'Guestrooms', perRoom: { KNG: 1, QQ: 1, KS: 1, ADA: 1 } },
  'CG-05': { loc: 'Guestrooms', perRoom: { KNG: 1, QQ: 1, KS: 1, ADA: 1 } },
  'CG-06': { loc: 'Guestrooms', perRoom: { KNG: 1, QQ: 1, KS: 1, ADA: 1 } },
  'ST-01': { loc: 'Guestrooms', perRoom: { KNG: 1, QQ: 1, KS: 1, ADA: 1 } },
  'ST-02': { loc: 'Guestrooms', perRoom: { KNG: 1, KS: 1, ADA: 1 } },
  'ST-03': { loc: 'Guestrooms', perRoom: { KS: 1 } },
  'ST-04': { loc: 'Guestrooms', perRoom: { KNG: 1 } },
  'TB-01': { loc: 'Guestrooms', perRoom: { KNG: 1, KS: 1 } },
  'LT-01': { loc: 'Guestrooms', perRoom: { KNG: 1, QQ: 1, KS: 1, ADA: 1 } },
  'LT-02': { loc: 'Guestrooms', perRoom: { KNG: 1, QQ: 1, KS: 1, ADA: 1 } },
  'MR-02': { loc: 'Guestrooms', perRoom: { KNG: 1, QQ: 1, KS: 1, ADA: 1 } },
  'WC-01': { loc: 'Guestrooms', perRoom: { KNG: 2, QQ: 2, KS: 3, ADA: 2 } },
  'WC-02': { loc: 'Guestrooms', perRoom: { KNG: 2, QQ: 2, KS: 3, ADA: 2 } },
  'BD-01': { loc: 'Guestrooms', perRoom: { KNG: 1, KS: 1, ADA: 1 } },
  'CP-01': { loc: 'Guestrooms', perRoom: { KNG: 28, QQ: 30, KS: 40, ADA: 30 } },
  'AR-01': { loc: 'Guestrooms', perRoom: { KNG: 1, QQ: 1, KS: 1, ADA: 1 } },
  'LT-03': { loc: 'Guestroom baths', perRoom: { KNG: 1, QQ: 1, KS: 1, ADA: 1 } },
  'MR-01': { loc: 'Guestroom baths', perRoom: { KNG: 1, QQ: 1, KS: 1, ADA: 1 } },
  'FL-01': { loc: 'Guestroom baths', perRoom: { KNG: 55, QQ: 55, KS: 70, ADA: 65 } },
  'PL-01': { loc: 'Lobby', fixed: 4 },
  'PL-02': { loc: 'Lobby', fixed: 8 },
  'PL-03': { loc: 'Lobby', fixed: 1 },
  'PL-04': { loc: 'Lobby', fixed: 2 },
  'PB-01': { loc: 'Breakfast', fixed: 48 },
  'PB-02': { loc: 'Breakfast', fixed: 12 },
  'PB-03': { loc: 'Breakfast', fixed: 1 },
  'PF-01': { loc: 'Fitness', fixed: 1 },
  'PC-01': { loc: 'Corridors', fixed: 1450 },
  'PO-01': { loc: 'Exterior', fixed: 3 },
};

const LOCATIONS = ['Guestrooms', 'Guestroom baths', 'Lobby', 'Breakfast', 'Fitness', 'Corridors', 'Exterior'];

const MARKUPS = [
  { category: 'casegoods', markupPct: 24 },
  { category: 'millwork', markupPct: 18 },
  { category: 'seating', markupPct: 28 },
  { category: 'soft_seating', markupPct: 28 },
  { category: 'tables', markupPct: 26 },
  { category: 'lighting', markupPct: 30 },
  { category: 'mirrors', markupPct: 30 },
  { category: 'window_treatments', markupPct: 30 },
  { category: 'bedding', markupPct: 35 },
  { category: 'carpet', markupPct: 14 },
  { category: 'flooring', markupPct: 14 },
  { category: 'artwork', markupPct: 40 },
  { category: 'outdoor', markupPct: 26 },
  { category: 'other', markupPct: 20 },
];

const base = (code: string) => code.replace(/^[A-Z0-9]+-/, '');

export async function seed(ctx: Ctx) {
  const { call, day, staff, out } = ctx;
  const marcus = staff.marcus;
  const priya = staff.priya;

  // --- approval policies -------------------------------------------------------------------------
  await call(staff.sean, 'quoting', 'POST', '/approval-policies', {
    name: 'Margin floor',
    condition: { type: 'line_margin_below', pct: 16 },
    approverRole: 'executive',
    description: 'Any line priced below a 16% gross margin needs an executive to sign off.',
  });
  await call(staff.sean, 'quoting', 'POST', '/approval-policies', {
    name: 'Never sell below cost',
    condition: { type: 'line_below_cost' },
    approverRole: 'executive',
  });
  await call(staff.sean, 'quoting', 'POST', '/approval-policies', {
    name: 'Large quote review',
    condition: { type: 'quote_total_above', amount: 1_500_000 },
    approverRole: 'executive',
    description: 'Quotes over $1.5M get a second look before they go to an owner.',
  });

  // --- spec libraries from the shared standards --------------------------------------------------
  const specsByBrand: Record<string, Record<string, any>> = {};
  for (const brand of ['Home2 Suites by Hilton', 'Hampton by Hilton', 'Tru by Hilton']) {
    specsByBrand[brand] = {};
    for (const pkg of ['Guestroom FF&E', 'Public areas FF&E']) {
      const std = out.standards[`${brand}|${pkg}`];
      for (const item of std.items) {
        const c = COSTS[base(item.code)];
        const vendorId = item.approvedVendors?.[0]?.vendorId ?? null;
        const spec = await call(priya, 'quoting', 'POST', '/specs', {
          code: item.code,
          name: item.name,
          description: item.description,
          category: item.category,
          vendorId,
          vendorSku: c?.sku ?? null,
          finish: item.finish,
          dimensions: item.dimensions,
          materials: item.materials,
          unit: c?.unit ?? 'ea',
          brandStandardId: std.id,
          brandStandardItemId: item.id,
        });
        specsByBrand[brand][base(item.code)] = spec;
      }
    }
  }

  // Costs: Home2 & Hampton fully priced; Tru is still being costed (some missing, some expired).
  const priceSpec = async (spec: any, opts: { expires: string; factor?: number }) => {
    const c = COSTS[base(spec.code)];
    if (!c) return;
    await call(marcus, 'quoting', 'PATCH', `/specs/${spec.id}`, {
      cost: Math.round(c.cost * (opts.factor ?? 1) * 100) / 100,
      costExpiresAt: opts.expires,
    });
  };
  for (const s of Object.values(specsByBrand['Home2 Suites by Hilton']!))
    await priceSpec(s, { expires: day(75) });
  for (const s of Object.values(specsByBrand['Hampton by Hilton']!))
    await priceSpec(s, { expires: day(40), factor: 0.96 });
  const truSpecs = Object.values(specsByBrand['Tru by Hilton']!) as any[];
  for (const [i, s] of truSpecs.entries()) {
    if (['ST-01', 'ST-02', 'ST-03', 'ST-04', 'PL-01', 'PL-02', 'PB-01'].includes(base(s.code))) continue; // Northline: unpriced
    await priceSpec(s, { expires: i % 5 === 0 ? day(-12) : i % 7 === 0 ? day(6) : day(55), factor: 1.04 });
  }

  // Competing import casegoods for the Home2 desk & nightstand (price matrix demo).
  const pacificId = out.vendorIds.pacific;
  const h2 = specsByBrand['Home2 Suites by Hilton']!;
  const alt = {
    'CG-03': await call(priya, 'quoting', 'POST', '/specs', {
      code: 'H2-CG-03-P',
      name: `${h2['CG-03'].name} (import)`,
      category: 'casegoods',
      vendorId: pacificId,
      vendorSku: 'PRF-NS22',
      dimensions: h2['CG-03'].dimensions,
      finish: h2['CG-03'].finish,
      cost: 189,
      costExpiresAt: day(45),
      leadTimeWeeks: 16,
    }),
    'CG-06': await call(priya, 'quoting', 'POST', '/specs', {
      code: 'H2-CG-06-P',
      name: `${h2['CG-06'].name} (import)`,
      category: 'casegoods',
      vendorId: pacificId,
      vendorSku: 'PRF-DK48',
      dimensions: h2['CG-06'].dimensions,
      finish: h2['CG-06'].finish,
      cost: 412,
      costExpiresAt: day(45),
      leadTimeWeeks: 16,
    }),
  };

  // --- quote builder ------------------------------------------------------------------------------
  const buildQuote = async (o: {
    projectId: string | null;
    name: string;
    phase?: string;
    rooms: Record<string, [string, number]>;
    specs: Record<string, any>;
    isTemplate?: boolean;
    skip?: string[];
  }) => {
    const q = await call(marcus, 'quoting', 'POST', '/quotes', {
      projectId: o.projectId,
      name: o.name,
      phase: o.phase ?? null,
      isTemplate: !!o.isTemplate,
      templateName: o.isTemplate ? o.name : null,
      taxRate: 0,
      freightMode: 'percent',
      freightPct: 6,
      defaultMarkupPct: 22,
      minMarginPct: 15,
      validUntil: day(45),
      clientNotes: 'Pricing includes freight to site. Installation quoted separately.',
    });
    const rt: Record<string, string> = {};
    let sort = 0;
    for (const [code, [name, count]] of Object.entries(o.rooms)) {
      const r = await call(marcus, 'quoting', 'POST', `/quotes/${q.id}/room-types`, {
        code,
        name,
        count,
        sort: sort++,
      });
      rt[code] = r.id;
    }
    const loc: Record<string, string> = {};
    sort = 0;
    for (const name of LOCATIONS) {
      const l = await call(marcus, 'quoting', 'POST', `/quotes/${q.id}/locations`, {
        name,
        kind: 'area',
        sort: sort++,
      });
      loc[name] = l.id;
    }
    const lines: Record<string, any> = {};
    for (const [b, place] of Object.entries(PLACEMENT)) {
      if (o.skip?.includes(b)) continue;
      const spec = o.specs[b];
      if (!spec) continue;
      const perRoom = place.perRoom
        ? Object.fromEntries(
            Object.entries(place.perRoom)
              .filter(([k]) => rt[k])
              .map(([k, n]) => [rt[k]!, n]),
          )
        : undefined;
      const [line] = await call(marcus, 'quoting', 'POST', `/quotes/${q.id}/lines`, {
        locationId: loc[place.loc],
        specIds: [spec.id],
        qtyMode: perRoom ? 'per_room' : 'fixed',
        ...(perRoom ? { qtyPerRoom: perRoom } : { qtyFixed: place.fixed }),
        atticStockPct: perRoom && ['casegoods', 'seating', 'lighting'].includes(spec.category) ? 2 : 0,
      });
      lines[b] = line;
      if (place.handing && line.quantity) {
        const left = Math.ceil(line.quantity / 2);
        await call(marcus, 'quoting', 'PATCH', `/quotes/${q.id}/lines/${line.id}`, {
          handing: { left, right: line.quantity - left },
        });
      }
    }
    return { quote: q, lines, rt, loc };
  };

  const ROOMS_H2 = {
    KNG: ['King', 64],
    QQ: ['Queen/Queen', 40],
    KS: ['King suite', 12],
    ADA: ['ADA king', 4],
  } as Record<string, [string, number]>;
  const ROOMS_HX = { KNG: ['King', 52], QQ: ['Queen/Queen', 42], KS: ['King suite', 4] } as Record<
    string,
    [string, number]
  >;
  const ROOMS_TR = { KNG: ['King', 54], QQ: ['Queen/Queen', 34], ADA: ['ADA king', 4] } as Record<
    string,
    [string, number]
  >;

  const merch = (id: string) =>
    call(marcus, 'quoting', 'POST', `/quotes/${id}/merchandise`, { rules: MARKUPS, respectOverrides: true });
  const readyAll = async (id: string) => {
    const lines = await call<any>(
      marcus,
      'quoting',
      'GET',
      `/quotes/${id}/lines?selectedOnly=true&limit=2000`,
    );
    const ids = (lines.items ?? lines).map((l: any) => l.id);
    await call(marcus, 'quoting', 'POST', `/quotes/${id}/lines/bulk`, {
      lineIds: ids,
      patch: { readyToOrder: true },
    });
  };
  const approveByClient = async (id: string, clientEmail: string, signer: string) => {
    await call(ctx.clients[clientEmail]!, 'quoting', 'POST', `/client/quotes/${id}/decision`, {
      decision: 'approved',
      signatureName: signer,
      comment: 'Approved as presented. Please confirm lead times on casegoods.',
    });
  };
  const approvePending = async (id: string) => {
    const pending = await call<any>(
      staff.jordan,
      'quoting',
      'GET',
      `/approvals?status=pending&quoteId=${id}`,
    );
    for (const a of pending.items ?? pending)
      await call(staff.jordan, 'quoting', 'POST', `/approvals/${a.id}/decide`, {
        decision: 'approved',
        comment: 'OK — strategic pricing for a repeat owner.',
      });
  };

  const p = out.projects;
  out.quotes = {};

  // Hampton (renovation, in production): approved and ready to order.
  const hx = await buildQuote({
    projectId: p.hampton.id,
    name: 'Guestroom renovation FF&E',
    phase: 'Phase 1 – floors 1–4',
    rooms: ROOMS_HX,
    specs: specsByBrand['Hampton by Hilton']!,
    skip: ['PL-03', 'PB-03', 'PF-01', 'PO-01'],
  });
  await merch(hx.quote.id);
  await call(marcus, 'quoting', 'POST', `/quotes/${hx.quote.id}/submit-for-approval`, {});
  await approvePending(hx.quote.id);
  await call(staff.dana, 'quoting', 'POST', `/quotes/${hx.quote.id}/send-to-client`, {
    message: 'Beth — attached is the guestroom renovation package for floors 1–4.',
  });
  await approveByClient(hx.quote.id, 'beth@coastallodging.example', 'Beth Ainsley');
  await readyAll(hx.quote.id);
  out.quotes.hampton = hx;

  // Home2 (new build, procurement): price matrix alternates, margin exception approved, owner approved.
  const h2q = await buildQuote({
    projectId: p.home2.id,
    name: 'Guestroom & public area FF&E',
    phase: 'Full property',
    rooms: ROOMS_H2,
    specs: h2,
  });
  for (const b of ['CG-03', 'CG-06'] as const)
    await call(marcus, 'quoting', 'POST', `/quotes/${h2q.quote.id}/lines/${h2q.lines[b].id}/alternates`, {
      lineId: h2q.lines[b].id,
      specIds: [alt[b].id],
    });
  await merch(h2q.quote.id);
  // Sharpened price on the lobby communal table to win the job → below the margin floor.
  await call(marcus, 'quoting', 'PATCH', `/quotes/${h2q.quote.id}/lines/${h2q.lines['PL-03'].id}`, {
    unitPrice: 6950,
  });
  await call(marcus, 'quoting', 'POST', `/quotes/${h2q.quote.id}/submit-for-approval`, {});
  await approvePending(h2q.quote.id);
  await call(staff.dana, 'quoting', 'POST', `/quotes/${h2q.quote.id}/send-to-client`, {
    message: 'Hannah — here is the full FF&E package for Home2 RDU. Happy to walk through it.',
  });
  await approveByClient(h2q.quote.id, 'hannah@blueridgehg.example', 'Hannah Moore');
  await readyAll(h2q.quote.id);
  out.quotes.home2 = h2q;

  // Tru (quoting): costs missing / expired, pricing requests out to two vendors.
  const tru = await buildQuote({
    projectId: p.tru.id,
    name: 'Guestroom & public FF&E',
    phase: 'Budget pricing',
    rooms: ROOMS_TR,
    specs: specsByBrand['Tru by Hilton']!,
  });
  await merch(tru.quote.id);
  const cr = await call<any>(marcus, 'quoting', 'POST', `/quotes/${tru.quote.id}/cost-requests`, {
    onlyExpiredOrMissing: true,
    dueDate: day(5),
    message:
      'Please confirm current pricing, lead time, and quote validity for the Tru Cary project (92 keys).',
  });
  out.quotes.tru = { ...tru, costRequests: cr.requests };
  // Carolina already answered through the portal; it's waiting for Marcus to compare and apply.
  const carolinaReq = cr.requests.find((r: any) => r.vendorId === out.vendorIds.carolina);
  if (carolinaReq && ctx.vendors.carolina) {
    const v = ctx.vendors.carolina;
    const detail = await call<any>(v, 'quoting', 'GET', `/vendor/cost-requests/${carolinaReq.id}`);
    for (const [i, line] of detail.lines.entries()) {
      await call(v, 'quoting', 'PUT', `/vendor/cost-requests/${carolinaReq.id}/lines/${line.id}`, {
        cost: Math.round((COSTS[base(line.code)]?.cost ?? 300) * 1.07 * 100) / 100,
        expiresAt: day(90),
        leadTimeWeeks: 14,
        notes: i === 0 ? 'Price reflects the 2027 board cost increase.' : null,
        specChanges:
          i === 0 && line.dimensions
            ? { dimensions: { from: line.dimensions, to: line.dimensions.replace('54"H', '54-1/4"H') } }
            : undefined,
      });
    }
    await call(v, 'quoting', 'POST', `/vendor/cost-requests/${carolinaReq.id}/submit`, {});
  }

  // Template for future Home2 projects.
  await buildQuote({
    projectId: null,
    name: 'Home2 Suites prototype – master quote',
    rooms: ROOMS_H2,
    specs: h2,
    isTemplate: true,
  });

  console.log('  3 project quotes + 1 template, 3 approval policies, spec library for 3 brands');
}
