import { describe, expect, it } from 'vitest';
import { evaluatePolicies } from '../src/domain/approvals.js';
import { diffCompare } from '../src/domain/compare.js';
import { matchRule, merchandise } from '../src/domain/merchandising.js';
import { priceLine } from '../src/domain/pricing.js';
import { computeQuantity, handingError, rescaleHanding } from '../src/domain/quantity.js';
import { quoteTotals } from '../src/domain/totals.js';

describe('quantity', () => {
  const rooms = [
    { id: 'king', count: 62 },
    { id: 'qq', count: 48 },
    { id: 'suite', count: 6 },
  ];
  it('sums per-room quantities across room types', () => {
    const r = computeQuantity(
      { qtyMode: 'per_room', qtyFixed: 0, qtyPerRoom: { king: 2, qq: 2, suite: 1 }, atticStockPct: 0 },
      rooms,
    );
    expect(r).toEqual({ base: 226, atticStock: 0, quantity: 226 });
  });
  it('adds attic stock rounded up to whole units', () => {
    const r = computeQuantity(
      { qtyMode: 'per_room', qtyFixed: 0, qtyPerRoom: { king: 1 }, atticStockPct: 5 },
      rooms,
    );
    expect(r).toEqual({ base: 62, atticStock: 4, quantity: 66 }); // 3.1 → 4
    const exact = computeQuantity(
      { qtyMode: 'fixed', qtyFixed: 120, qtyPerRoom: {}, atticStockPct: 5 },
      rooms,
    );
    expect(exact.atticStock).toBe(6); // no float-noise round-up to 7
  });
  it('ignores room types that no longer exist', () => {
    expect(
      computeQuantity({ qtyMode: 'per_room', qtyFixed: 0, qtyPerRoom: { gone: 3 }, atticStockPct: 0 }, rooms)
        .quantity,
    ).toBe(0);
  });
  it('fixed mode uses qty_fixed', () => {
    expect(
      computeQuantity({ qtyMode: 'fixed', qtyFixed: 3, qtyPerRoom: { king: 9 }, atticStockPct: 0 }, rooms)
        .quantity,
    ).toBe(3);
  });
  it('validates and rescales handing', () => {
    expect(handingError({ left: 31, right: 31 }, 62)).toBeNull();
    expect(handingError({ left: 30, right: 31 }, 62)).toMatch(/must equal/);
    expect(rescaleHanding({ left: 31, right: 31 }, 70)).toEqual({ left: 35, right: 35 });
    expect(rescaleHanding({ left: 1, right: 2 }, 10)).toEqual({ left: 3, right: 7 });
    expect(rescaleHanding(null, 10)).toBeNull();
  });
});

describe('pricing & flags', () => {
  const ctx = { freightMode: 'per_line' as const, minMarginPct: 20, today: '2026-10-01' };
  const base = {
    quantity: 10,
    unitCost: 100,
    freightUnit: 10,
    markupPct: 25,
    unitPrice: null,
    priceOverride: false,
    costExpiresAt: null,
  };
  it('prices from landed cost and markup', () => {
    const r = priceLine(base, ctx);
    expect(r.unitPrice).toBe(137.5);
    expect(r.extendedCost).toBe(1100);
    expect(r.extendedPrice).toBe(1375);
    expect(r.marginPct).toBe(20);
    expect(r.flags).toEqual([]);
  });
  it('percent freight mode excludes per-line freight from cost', () => {
    expect(priceLine(base, { ...ctx, freightMode: 'percent' }).unitPrice).toBe(125);
  });
  it('flags missing cost/price, below cost, below min margin, expiry', () => {
    expect(priceLine({ ...base, unitCost: null }, ctx).flags).toEqual(['missing_cost', 'missing_price']);
    const below = priceLine({ ...base, priceOverride: true, unitPrice: 100 }, ctx);
    expect(below.flags).toEqual(expect.arrayContaining(['below_cost', 'below_min_margin']));
    expect(priceLine({ ...base, markupPct: 10 }, ctx).flags).toEqual(['below_min_margin']);
    expect(priceLine({ ...base, costExpiresAt: '2026-09-30' }, ctx).flags).toEqual(['cost_expired']);
    expect(priceLine({ ...base, costExpiresAt: '2026-10-15' }, ctx).flags).toEqual(['cost_expiring']);
    expect(priceLine({ ...base, costExpiresAt: '2026-10-16' }, ctx).flags).toEqual([]);
  });
});

describe('merchandising', () => {
  const parents = new Map<string, string | null>([
    ['guest', null],
    ['king', 'guest'],
    ['public', null],
    ['lobby', 'public'],
  ]);
  const rules = [
    { category: 'carpet', locationId: 'guest', markupPct: 12 },
    { category: 'carpet', locationId: 'public', markupPct: 22 },
    { category: 'casegoods', markupPct: 25 },
    { locationId: 'lobby', markupPct: 30 },
  ];
  it('most specific rule wins; location rules cover sub-locations', () => {
    expect(matchRule({ category: 'carpet', locationId: 'king' }, rules, parents)?.markupPct).toBe(12);
    expect(matchRule({ category: 'carpet', locationId: 'lobby' }, rules, parents)?.markupPct).toBe(22);
    expect(matchRule({ category: 'casegoods', locationId: 'king' }, rules, parents)?.markupPct).toBe(25);
    expect(matchRule({ category: 'casegoods', locationId: 'lobby' }, rules, parents)?.markupPct).toBe(30);
    expect(matchRule({ category: 'lighting', locationId: 'king' }, rules, parents)).toBeUndefined();
  });
  it('solves unmatched lines to hit a target margin', () => {
    const lines = [
      {
        id: 'a',
        category: 'casegoods',
        locationId: 'king',
        isSelected: true,
        quantity: 10,
        landedCost: 100,
        priceOverride: false,
        unitPrice: null,
      },
      {
        id: 'b',
        category: 'lighting',
        locationId: 'king',
        isSelected: true,
        quantity: 10,
        landedCost: 100,
        priceOverride: false,
        unitPrice: null,
      },
    ];
    const r = merchandise(lines, [{ category: 'casegoods', markupPct: 25 }], parents, {
      targetMarginPct: 30,
      respectOverrides: true,
    });
    expect(r.markups.get('a')).toBe(25);
    // total cost 2000 → sell 2857.14; fixed sell 1250 → b sells 1607.14 → markup 60.714%
    expect(r.solvedMarkupPct).toBeCloseTo(60.714, 2);
  });
  it('respects price overrides unless told otherwise', () => {
    const lines = [
      {
        id: 'a',
        category: 'casegoods',
        locationId: null,
        isSelected: true,
        quantity: 1,
        landedCost: 100,
        priceOverride: true,
        unitPrice: 150,
      },
    ];
    expect(
      merchandise(lines, [{ category: 'casegoods', markupPct: 25 }], parents, { respectOverrides: true })
        .markups.size,
    ).toBe(0);
    const r = merchandise(lines, [{ category: 'casegoods', markupPct: 25 }], parents, {
      respectOverrides: false,
    });
    expect(r.markups.get('a')).toBe(25);
    expect(r.clearedOverrides).toEqual(['a']);
  });
});

describe('totals', () => {
  it('sums selected lines only; percent freight and tax', () => {
    const l = (id: string, cost: number, sell: number, isSelected = true) => ({
      id,
      isSelected,
      locationId: null,
      category: 'casegoods',
      vendorId: null,
      vendorName: null,
      quantity: 1,
      freightUnit: 0,
      extendedCost: cost,
      extendedPrice: sell,
      flags: [],
    });
    const t = quoteTotals({ freightMode: 'percent', freightPct: 10, taxRate: 7.25 }, [
      l('a', 800, 1000),
      l('b', 500, 900, false),
    ]);
    expect(t).toMatchObject({
      costSubtotal: 800,
      sellSubtotal: 1000,
      freight: 100,
      tax: 79.75,
      grandTotal: 1179.75,
      marginPct: 20,
    });
  });
});

describe('approval policy evaluation', () => {
  const lines = [
    {
      id: '1',
      code: 'CG-1',
      name: 'Desk',
      category: 'casegoods',
      vendorId: 'v1',
      vendorName: 'Kimball',
      isSelected: true,
      marginPct: 12,
      flags: [],
    },
    {
      id: '2',
      code: 'LT-1',
      name: 'Lamp',
      category: 'lighting',
      vendorId: 'v2',
      vendorName: 'Lumen',
      isSelected: true,
      marginPct: 30,
      flags: ['cost_expired'],
    },
    {
      id: '3',
      code: 'CG-2',
      name: 'Alt desk',
      category: 'casegoods',
      vendorId: 'v3',
      vendorName: 'OFS',
      isSelected: false,
      marginPct: -5,
      flags: ['below_cost'],
    },
  ];
  const quote = { sellSubtotal: 1000, grandTotal: 1100, marginPct: 18 };
  const pol = (id: string, condition: any) => ({ id, name: id, condition, approverRole: 'executive' });
  it('evaluates every condition type against selected lines', () => {
    const r = evaluatePolicies(
      [
        pol('lm', { type: 'line_margin_below', pct: 15 }),
        pol('lmc', { type: 'line_margin_below', pct: 15, category: 'lighting' }),
        pol('qm', { type: 'quote_margin_below', pct: 20 }),
        pol('qt', { type: 'quote_total_above', amount: 1000 }),
        pol('bc', { type: 'line_below_cost' }),
        pol('ce', { type: 'cost_expired_lines' }),
        pol('vp', { type: 'vendor_not_preferred' }),
      ],
      quote,
      lines,
      (id) => (id === 'v1' ? false : id === 'v2' ? null : true),
    );
    expect(r.failures.map((f) => f.policyId).sort()).toEqual(['ce', 'lm', 'qm', 'qt', 'vp']);
    expect(r.failures.find((f) => f.policyId === 'lm')!.details.lines!.map((l) => l.code)).toEqual(['CG-1']);
    expect(r.warnings[0]).toMatch(/Lumen/);
  });
});

describe('compare', () => {
  it('reports fields where vendor differs from library or quote', () => {
    const d = diffCompare(
      { cost: 110, dimensions: '24 1/4"W', finish: null },
      { cost: 100, dimensions: '24"W', finish: 'Walnut' },
      { cost: 100, dimensions: '24"W', finish: 'Walnut' },
      ['cost', 'dimensions', 'finish'],
    );
    expect(d.map((x) => x.field)).toEqual(['cost', 'dimensions']);
  });
});
