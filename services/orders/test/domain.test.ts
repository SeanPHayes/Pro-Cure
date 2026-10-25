import { describe, expect, it } from 'vitest';
import { allocationErrors, nextLabel, unallocated } from '../src/domain/allocation.js';
import { canTransitionClaim } from '../src/domain/claims.js';
import { addDays, daysBetween } from '../src/domain/dates.js';
import {
  combine,
  evaluatePo,
  maxLevel,
  normalizeRiskLevel,
  poFindings,
  type ShipmentFacts,
  shipmentFindings,
} from '../src/domain/escalation.js';
import { releaseByDate, transitDaysFor } from '../src/domain/release-by.js';
import { defaultRequirements } from '../src/domain/requirements.js';
import { diffSnapshots, type PoSnapshot } from '../src/domain/revision.js';
import { derivePoStatus } from '../src/domain/status.js';
import { poTotals } from '../src/domain/totals.js';

const TODAY = '2026-10-25';
const NOW = new Date(`${TODAY}T12:00:00Z`);

describe('release-by date', () => {
  it('is requested delivery − lead time − transit (domestic default 5 days)', () => {
    expect(
      releaseByDate({ requestedDeliveryDate: '2027-03-01', leadTimeWeeks: 12, origin: 'domestic' }),
    ).toBe(addDays('2027-03-01', -84 - 5));
    expect(
      releaseByDate({ requestedDeliveryDate: '2027-03-01', leadTimeWeeks: 12, origin: 'domestic' }),
    ).toBe('2026-12-02');
  });
  it('uses 35 transit days for international, or the vendor profile value', () => {
    expect(
      releaseByDate({ requestedDeliveryDate: '2027-03-01', leadTimeWeeks: 10, origin: 'international' }),
    ).toBe(addDays('2027-03-01', -70 - 35));
    expect(releaseByDate({ requestedDeliveryDate: '2027-03-01', leadTimeWeeks: 10, transitDays: 21 })).toBe(
      addDays('2027-03-01', -91),
    );
    expect(transitDaysFor('international', null)).toBe(35);
    expect(transitDaysFor('international', 28)).toBe(28);
  });
  it('is unknown without a requested date or lead time', () => {
    expect(releaseByDate({ requestedDeliveryDate: null, leadTimeWeeks: 8 })).toBeNull();
    expect(releaseByDate({ requestedDeliveryDate: '2027-01-01', leadTimeWeeks: null })).toBeNull();
  });
});

describe('default requirements', () => {
  it('always asks for an acknowledgement; deposit only when terms require it', () => {
    expect(defaultRequirements({ depositPct: 0, categories: ['lighting'] }).map((r) => r.kind)).toEqual([
      'order_acknowledgement',
    ]);
    const r = defaultRequirements({ depositPct: 50, categories: ['lighting'] });
    expect(r.map((x) => [x.kind, x.party])).toEqual([
      ['order_acknowledgement', 'vendor'],
      ['deposit', 'internal'],
    ]);
  });
  it('adds shop drawings for casegoods/millwork/soft seating and finish samples for textiles', () => {
    expect(defaultRequirements({ depositPct: 0, categories: ['casegoods'] }).map((x) => x.kind)).toEqual([
      'order_acknowledgement',
      'shop_drawing_approval',
    ]);
    expect(defaultRequirements({ depositPct: 0, categories: ['carpet', null] }).map((x) => x.kind)).toEqual([
      'order_acknowledgement',
      'finish_sample_approval',
    ]);
    const ss = defaultRequirements({ depositPct: 30, categories: ['soft_seating'] });
    expect(ss.map((x) => x.kind)).toEqual([
      'order_acknowledgement',
      'deposit',
      'shop_drawing_approval',
      'finish_sample_approval',
    ]);
    expect(ss.filter((x) => x.party === 'client')).toHaveLength(2);
  });
});

describe('totals', () => {
  it('rounds per line and sums', () => {
    expect(poTotals([{ extended: 100.1 }, { extended: 200.2 }], 50, 12.345)).toEqual({
      subtotal: 300.3,
      freight: 50,
      tax: 12.35,
      total: 362.65,
    });
  });
});

describe('allocation', () => {
  const lines = [
    { id: 'a', code: 'CG-1', quantity: 10 },
    { id: 'b', code: 'LT-1', quantity: 4 },
  ];
  it('accepts allocations within the ordered quantity across shipments', () => {
    expect(
      allocationErrors(lines, [
        { poLineId: 'a', quantity: 6 },
        { poLineId: 'a', quantity: 4 },
        { poLineId: 'b', quantity: 4 },
      ]),
    ).toEqual([]);
  });
  it('rejects over-allocation, unknown lines and non-positive quantities', () => {
    const errs = allocationErrors(lines, [
      { poLineId: 'a', quantity: 6 },
      { poLineId: 'a', quantity: 5 },
      { poLineId: 'x', quantity: 1 },
      { poLineId: 'b', quantity: 0 },
    ]);
    expect(errs.map((e) => e.poLineId).sort()).toEqual(['a', 'b', 'x']);
    expect(errs.find((e) => e.poLineId === 'a')).toMatchObject({ ordered: 10, allocated: 11 });
  });
  it('reports unallocated remainder', () => {
    expect(unallocated(lines, [{ poLineId: 'a', quantity: 7 }])).toEqual([
      { poLineId: 'a', code: 'CG-1', quantity: 3 },
      { poLineId: 'b', code: 'LT-1', quantity: 4 },
    ]);
  });
  it('labels shipments A, B … Z, AA', () => {
    expect(nextLabel([])).toBe('A');
    expect(nextLabel(['A', 'B'])).toBe('C');
    expect(nextLabel(['Z'])).toBe('AA');
    expect(nextLabel(['A', 'C', 'custom'])).toBe('D');
  });
});

describe('revision diff', () => {
  const base: PoSnapshot = {
    header: {
      requestedDeliveryDate: '2027-01-10',
      shipTo: { line1: '1 Main', city: 'Austin' },
      freight: 100,
      total: 1100,
    },
    lines: [
      {
        id: '1',
        code: 'CG-1',
        name: 'King headboard',
        description: null,
        finish: 'Walnut',
        quantity: 10,
        unitCost: 100,
        extended: 1000,
      },
      {
        id: '2',
        code: 'LT-1',
        name: 'Lamp',
        description: null,
        finish: null,
        quantity: 5,
        unitCost: 20,
        extended: 100,
      },
    ],
  };
  it('is empty for identical snapshots, ignoring key order and empty values', () => {
    const same = structuredClone(base);
    same.header.shipTo = { city: 'Austin', line1: '1 Main', line2: '' };
    expect(diffSnapshots(base, same)).toEqual([]);
  });
  it('lists header changes, line field changes, added and removed lines', () => {
    const next = structuredClone(base);
    next.header.requestedDeliveryDate = '2027-02-01';
    next.lines[0]!.quantity = 12;
    next.lines[0]!.extended = 1200;
    next.lines.splice(1, 1);
    next.lines.push({
      id: '3',
      code: 'MR-1',
      name: 'Mirror',
      description: null,
      finish: null,
      quantity: 2,
      unitCost: 50,
      extended: 100,
    });
    expect(diffSnapshots(base, next)).toEqual([
      { field: 'requestedDeliveryDate', from: '2027-01-10', to: '2027-02-01' },
      { field: 'quantity', lineCode: 'CG-1', from: 10, to: 12 },
      { field: 'extended', lineCode: 'CG-1', from: 1000, to: 1200 },
      { field: 'line_added', lineCode: 'MR-1', from: null, to: '2 × Mirror' },
      { field: 'line_removed', lineCode: 'LT-1', from: '5 × Lamp', to: null },
    ]);
  });
});

const ship = (o: Partial<ShipmentFacts> = {}): ShipmentFacts => ({
  status: 'confirmed',
  origin: 'domestic',
  requestedDeliveryDate: '2027-01-30',
  estimatedShipDate: '2027-01-10',
  estimatedDeliveryDate: null,
  transitDays: 5,
  hasTracking: false,
  shipDateSlips: 0,
  lastConfirmationRequestedAt: null,
  lastConfirmedAt: null,
  ...o,
});

describe('escalation rules', () => {
  it('release-by passed with pending requirements is critical; within 7 at_risk; within 21 watch', () => {
    expect(poFindings({ releaseByDate: '2026-10-20', pendingRequirements: 2 }, TODAY)[0]?.level).toBe(
      'critical',
    );
    expect(poFindings({ releaseByDate: '2026-10-30', pendingRequirements: 1 }, TODAY)[0]?.level).toBe(
      'at_risk',
    );
    expect(poFindings({ releaseByDate: '2026-11-10', pendingRequirements: 1 }, TODAY)[0]?.level).toBe(
      'watch',
    );
    expect(poFindings({ releaseByDate: '2026-12-31', pendingRequirements: 1 }, TODAY)).toEqual([]);
    expect(poFindings({ releaseByDate: '2026-10-20', pendingRequirements: 0 }, TODAY)).toEqual([]);
  });
  it('names the pending requirements in the reason', () => {
    const [f] = poFindings(
      {
        releaseByDate: '2026-10-20',
        pendingRequirements: 1,
        pendingRequirementLabels: ['Shop drawing approval'],
      },
      TODAY,
    );
    expect(f!.reason).toContain('5 days ago');
    expect(f!.reason).toContain('Shop drawing approval');
  });
  it('estimated delivery after requested delivery is critical', () => {
    const f = shipmentFindings(ship({ estimatedShipDate: '2027-01-28' }), TODAY, NOW);
    expect(f.map((x) => x.level)).toContain('critical');
    expect(f[0]!.reason).toMatch(/after the requested/);
    expect(shipmentFindings(ship({ estimatedDeliveryDate: '2027-01-31' }), TODAY, NOW)[0]?.level).toBe(
      'critical',
    );
  });
  it('ship date passed >3 days without tracking is critical (not at exactly 3)', () => {
    expect(
      shipmentFindings(ship({ estimatedShipDate: '2026-10-21' }), TODAY, NOW).map((x) => x.level),
    ).toContain('critical');
    expect(
      shipmentFindings(
        ship({ estimatedShipDate: '2026-10-22', requestedDeliveryDate: '2026-12-01' }),
        TODAY,
        NOW,
      ),
    ).toEqual([]);
    expect(
      shipmentFindings(
        ship({ estimatedShipDate: '2026-10-01', hasTracking: true, requestedDeliveryDate: '2026-12-01' }),
        TODAY,
        NOW,
      ),
    ).toEqual([]);
  });
  it('two or more later ship dates is at_risk', () => {
    expect(shipmentFindings(ship({ shipDateSlips: 2 }), TODAY, NOW).map((x) => x.level)).toEqual(['at_risk']);
    expect(shipmentFindings(ship({ shipDateSlips: 1 }), TODAY, NOW)).toEqual([]);
  });
  it('no confirmation response for 10+ days is at_risk', () => {
    expect(
      shipmentFindings(ship({ lastConfirmationRequestedAt: '2026-10-14T12:00:00Z' }), TODAY, NOW).map(
        (x) => x.level,
      ),
    ).toEqual(['at_risk']);
    expect(
      shipmentFindings(ship({ lastConfirmationRequestedAt: '2026-10-20T12:00:00Z' }), TODAY, NOW),
    ).toEqual([]);
    expect(
      shipmentFindings(
        ship({
          lastConfirmationRequestedAt: '2026-10-01T12:00:00Z',
          lastConfirmedAt: '2026-10-02T12:00:00Z',
        }),
        TODAY,
        NOW,
      ),
    ).toEqual([]);
  });
  it('international with under 14 days of slack is watch', () => {
    const s = ship({
      origin: 'international',
      transitDays: 35,
      estimatedShipDate: '2026-12-20',
      requestedDeliveryDate: '2027-02-01',
    });
    expect(daysBetween(addDays('2026-12-20', 35), '2027-02-01')).toBe(8);
    expect(shipmentFindings(s, TODAY, NOW).map((x) => x.level)).toEqual(['watch']);
    expect(shipmentFindings({ ...s, requestedDeliveryDate: '2027-03-01' }, TODAY, NOW)).toEqual([]);
  });
  it('delivered shipments never escalate', () => {
    expect(
      shipmentFindings(ship({ status: 'delivered', estimatedShipDate: '2026-01-01' }), TODAY, NOW),
    ).toEqual([]);
  });
  it('final level is max(rule level, AI risk level)', () => {
    expect(combine([{ level: 'watch', reason: 'x' }], 'critical', ['vendor late 4 of 5 times']).level).toBe(
      'critical',
    );
    expect(combine([{ level: 'critical', reason: 'x' }], 'watch').level).toBe('critical');
    expect(combine([], 'at_risk', ['slow vendor']).reasons).toEqual(['Risk model: slow vendor']);
    expect(maxLevel('none', 'watch', null)).toBe('watch');
    expect(normalizeRiskLevel('high')).toBe('at_risk');
    expect(normalizeRiskLevel('Critical')).toBe('critical');
    expect(normalizeRiskLevel('garbage')).toBeNull();
  });
  it('PO level rolls up shipments with labelled reasons', () => {
    const r = evaluatePo({
      po: { releaseByDate: '2026-11-05', pendingRequirements: 1 },
      shipments: [
        { ...ship(), id: 'a', label: 'A' },
        { ...ship({ shipDateSlips: 3 }), id: 'b', label: 'B' },
      ],
      today: TODAY,
      now: NOW,
    });
    expect(r.level).toBe('at_risk');
    expect(r.reasons.some((x) => x.startsWith('Shipment B:'))).toBe(true);
    expect(r.shipments.find((s) => s.id === 'a')!.level).toBe('none');
    expect(r.shipments.find((s) => s.id === 'b')!.level).toBe('at_risk');
  });
});

describe('PO status', () => {
  it('derives from shipments', () => {
    const d = (current: any, ss: string[], rc = true) =>
      derivePoStatus({ current, shipmentStatuses: ss, requirementsComplete: rc });
    expect(d('in_production', ['shipped', 'planned'])).toBe('partially_shipped');
    expect(d('partially_shipped', ['shipped', 'in_transit'])).toBe('shipped');
    expect(d('shipped', ['delivered', 'in_transit'])).toBe('partially_delivered');
    expect(d('partially_delivered', ['delivered', 'delivered'])).toBe('delivered');
    expect(d('acknowledged', ['confirmed'])).toBe('in_production');
    expect(d('acknowledged', ['confirmed'], false)).toBe('acknowledged');
    expect(d('issued', ['planned'])).toBe('issued');
    expect(d('draft', ['delivered'])).toBe('draft');
    expect(d('cancelled', ['planned'])).toBe('cancelled');
  });
});

describe('claim transitions', () => {
  it('limits vendors to acknowledgement and replacement', () => {
    expect(canTransitionClaim('submitted_to_vendor', 'vendor_acknowledged', 'vendor')).toBe(true);
    expect(canTransitionClaim('submitted_to_vendor', 'credited', 'vendor')).toBe(false);
    expect(canTransitionClaim('open', 'resolved')).toBe(true);
    expect(canTransitionClaim('resolved', 'credited')).toBe(false);
  });
});
