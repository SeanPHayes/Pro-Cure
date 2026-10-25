import { describe, expect, it } from 'vitest';
import type { CostRequest, OpenPurchaseOrder, SpecSummary } from '../src/clients.js';
import { heuristicBrandSpec, parseApprovedVendors } from '../src/features/brand-spec/heuristic.js';
import { assignPages, groupAssignments } from '../src/features/drawing-split/heuristic.js';
import {
  classifyIntent,
  findDates,
  findPoNumbers,
  findTracking,
  rankCandidates,
} from '../src/features/inbox/heuristic.js';
import { features, levelFor, scoreFeatures } from '../src/features/risk/model.js';
import {
  observe,
  priorProfile,
  shrink,
  tenantPrior,
  vendorProfiles,
} from '../src/features/risk/performance.js';
import { heuristicVendorQuote } from '../src/features/vendor-quote/heuristic.js';
import { matchQuote } from '../src/features/vendor-quote/match.js';
import { itemsToLines, LocalPdfText } from '../src/text/extract.js';
import { parseDate, parseLeadTimeWeeks, tokenSetSimilarity } from '../src/text/util.js';
import { brandStandardPdf, drawingPacketPdf, scannedPdf, vendorQuotePdf } from './fixtures.js';

const extractor = new LocalPdfText();

describe('text utilities', () => {
  it('parses lead times taking the upper bound', () => {
    expect(parseLeadTimeWeeks('Lead time: 10-12 weeks')).toBe(12);
    expect(parseLeadTimeWeeks('ships in 6 to 8 wks')).toBe(8);
    expect(parseLeadTimeWeeks('45 days ARO')).toBe(7);
    expect(parseLeadTimeWeeks('no lead time')).toBeNull();
  });
  it('parses common date formats', () => {
    expect(parseDate('12/31/2026')).toBe('2026-12-31');
    expect(parseDate('March 1, 2026')).toBe('2026-03-01');
    expect(parseDate('2026-11-05')).toBe('2026-11-05');
    expect(parseDate('Nov 15', new Date('2026-10-20T00:00:00Z'))).toBe('2026-11-15');
  });
  it('token-set similarity ignores order and stopwords', () => {
    expect(
      tokenSetSimilarity('Nightstand 2 drawer walnut', 'Walnut nightstand with 2 drawers'),
    ).toBeGreaterThan(0.5);
    expect(tokenSetSimilarity('desk chair', 'king headboard')).toBe(0);
  });
  it('groups positioned items into lines with column cells', () => {
    const lines = itemsToLines([
      { str: 'Qty', x: 400, y: 700, w: 15, h: 9 },
      { str: 'Item', x: 54, y: 700.5, w: 18, h: 9 },
      { str: 'Next line', x: 54, y: 685, w: 40, h: 9 },
    ]);
    expect(lines).toHaveLength(2);
    expect(lines[0]!.cells).toEqual(['Item', 'Qty']);
  });
});

describe('PDF text extraction (pdfjs)', () => {
  it('returns per-page text and flags scanned pages', async () => {
    const r = await extractor.extract(await scannedPdf());
    expect(r.pageCount).toBe(2);
    expect(r.pages[0]!.scanned).toBe(false);
    expect(r.scannedPages).toEqual([2]);
    expect(r.warnings[0]).toMatch(/scanned/);
  });
});

describe('brand-spec heuristic', () => {
  it('finds codes, areas, categories and attributes', async () => {
    const { pages } = await extractor.extract(await brandStandardPdf());
    const out = heuristicBrandSpec(pages);
    expect(out.standard).toMatchObject({
      brandGuess: 'Hampton by Hilton',
      version: '4.2',
      effectiveDate: '2026-03-01',
    });
    expect(out.items.map((i) => i.code)).toEqual([
      'CG-101',
      'CG-102',
      'ST-12',
      'LT-3',
      'MR-01',
      'FF-04A',
      'CP-2',
    ]);
    const by = Object.fromEntries(out.items.map((i) => [i.code, i]));
    expect(by['CG-101']).toMatchObject({
      area: 'Guestroom',
      category: 'casegoods',
      name: 'King Headboard',
      dimensions: '80"W x 3"D x 54"H',
      finish: 'Hampton Walnut HW-22 thermofoil, matte',
      materials: 'MDF core, high-pressure laminate edges',
      quantityBasis: '1 per king guestroom',
      sourcePage: 1,
    });
    expect(by['CG-101']!.approvedVendors).toEqual([
      { name: 'Formacase', model: 'HB-8054' },
      { name: 'Pacific Coast Furniture', model: null },
    ]);
    expect(by['ST-12']).toMatchObject({
      category: 'seating',
      approvedVendors: [{ name: 'Kimball Hospitality', model: 'KH-350' }],
    });
    // "GUESTROOM (continued)" on page 2 keeps the area and is not appended to ST-12
    expect(by['ST-12']!.description).toBeNull();
    expect(by['LT-3']).toMatchObject({ area: 'Guestroom', category: 'lighting', sourcePage: 2 });
    expect(by['MR-01']).toMatchObject({
      category: 'mirrors',
      description: expect.stringContaining('LED backlit'),
    });
    expect(by['FF-04A']).toMatchObject({ area: 'Public Areas – Lobby', category: 'soft_seating' });
    expect(by['CP-2']).toMatchObject({
      category: 'carpet',
      approvedVendors: [{ name: 'Shaw Hospitality', model: 'Wanderlust' }],
    });
    for (const i of out.items) expect(i.confidence).toBeGreaterThan(0.5);
  });

  it('splits approved vendor lists', () => {
    expect(parseApprovedVendors('Sunrise Seating; Kimball Hospitality or approved equal')).toEqual([
      { name: 'Sunrise Seating', model: null },
      { name: 'Kimball Hospitality', model: null },
    ]);
  });
});

const costRequest: CostRequest = {
  id: '00000000-0000-4000-8000-0000000000c1',
  number: 'CR-26-0007',
  quoteId: '00000000-0000-4000-8000-0000000000a1',
  vendorId: '00000000-0000-4000-8000-0000000000f1',
  status: 'sent',
  lines: [
    {
      id: '00000000-0000-4000-8000-000000000101',
      quoteLineId: null,
      specId: null,
      code: 'CG-101',
      name: 'King Headboard',
      description: 'Walnut thermofoil headboard',
      vendorSku: null,
      quantity: 120,
      currentCost: 410,
    },
    {
      id: '00000000-0000-4000-8000-000000000102',
      quoteLineId: null,
      specId: null,
      code: 'CG-102',
      name: 'Nightstand, 2 drawer',
      description: 'Walnut',
      vendorSku: 'NS-2418',
      quantity: 240,
      currentCost: 205,
    },
    {
      id: '00000000-0000-4000-8000-000000000103',
      quoteLineId: null,
      specId: null,
      code: 'CG-110',
      name: 'Work desk with power grommet',
      description: null,
      vendorSku: null,
      quantity: 120,
      currentCost: 700,
    },
    {
      id: '00000000-0000-4000-8000-000000000104',
      quoteLineId: null,
      specId: null,
      code: 'MR-01',
      name: 'Vanity mirror',
      description: null,
      vendorSku: null,
      quantity: 120,
      currentCost: 150,
    },
  ],
};

describe('vendor-quote heuristic + matching', () => {
  it('extracts header and table lines', async () => {
    const { pages } = await extractor.extract(await vendorQuotePdf());
    const { header, lines, totals } = heuristicVendorQuote(pages);
    expect(header).toMatchObject({
      vendorQuoteNumber: 'FQ-55821',
      quoteDate: '2026-10-15',
      validUntil: '2026-12-31',
      leadTimeWeeks: 12,
      freightTerms: expect.stringContaining('FOB Factory'),
    });
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatchObject({
      vendorSku: 'HB-8054',
      specCode: 'CG-101',
      quantity: 120,
      unitPrice: 425,
      extended: 51000,
      expiresAt: '2026-12-31',
      leadTimeWeeks: 12,
    });
    expect(lines[2]).toMatchObject({
      vendorSku: 'DK-4824',
      unitPrice: 1150,
      leadTimeWeeks: 14,
      notes: expect.stringContaining('HW-22'),
    });
    expect(totals).toEqual({ subtotal: 264350, freight: 8400, total: 272750 });
  });

  it('matches by code, sku and description and flags suspicious values', async () => {
    const { pages } = await extractor.extract(await vendorQuotePdf());
    const { lines } = heuristicVendorQuote(pages);
    const { matches, unmatchedLines, unquotedRequestLines } = matchQuote(lines, costRequest);
    const by = Object.fromEntries(matches.map((m) => [m.code, m]));
    expect(by['CG-101']).toMatchObject({ unitCost: 425, lineIndex: 0, flags: [] });
    expect(by['CG-101']!.reasons.join(' ')).toMatch(/Spec code CG-101/);
    expect(by['CG-102']!.reasons.join(' ')).toMatch(/Vendor SKU NS-2418/);
    expect(by['CG-102']!.flags.join(' ')).toMatch(/Quoted quantity 200 differs from requested 240/);
    expect(by['CG-110']!.reasons.join(' ')).toMatch(/Description/);
    expect(by['CG-110']!.flags.join(' ')).toMatch(/64% above/);
    expect(by['CG-101']!.confidence).toBeGreaterThan(by['CG-110']!.confidence);
    expect(unmatchedLines.map((u) => u.line.vendorSku)).toEqual(['LG-3020']);
    expect(unquotedRequestLines.map((u) => u.code)).toEqual(['MR-01']);
  });
});

const specs: SpecSummary[] = [
  {
    id: '00000000-0000-4000-8000-000000000001',
    code: 'CG-101',
    name: 'King Headboard',
    category: 'casegoods',
    vendorId: null,
    vendorSku: 'HB-8054',
    description: null,
  },
  {
    id: '00000000-0000-4000-8000-000000000002',
    code: 'CG-102',
    name: 'Nightstand',
    category: 'casegoods',
    vendorId: null,
    vendorSku: null,
    description: null,
  },
  {
    id: '00000000-0000-4000-8000-000000000003',
    code: 'CG-110',
    name: 'Work Desk',
    category: 'casegoods',
    vendorId: null,
    vendorSku: 'DK-4824',
    description: null,
  },
];

describe('drawing-split heuristic', () => {
  it('assigns pages including continuation sheets', async () => {
    const { pages } = await extractor.extract(await drawingPacketPdf());
    const a = assignPages(pages, specs);
    expect(a.map((x) => x.via)).toEqual([
      'code',
      'continuation',
      'code',
      'continuation',
      'continuation',
      'sku',
    ]);
    const { groups, unassignedPages } = groupAssignments(a, specs);
    expect(groups.map((g) => [g.code, g.pages])).toEqual([
      ['CG-101', [1, 2]],
      ['CG-102', [3, 4, 5]],
      ['CG-110', [6]],
    ]);
    expect(unassignedPages).toEqual([]);
  });

  it('leaves a page with no spec signal unassigned', async () => {
    const { pages } = await extractor.extract(await drawingPacketPdf());
    // Page 2 (headboard continuation) with the headboard spec not among the candidates.
    const a = assignPages(pages.slice(1, 2), specs.slice(1));
    expect(a[0]!.specId).toBeNull();
  });
});

describe('inbox heuristics', () => {
  it('finds PO numbers in strict and loose formats', () => {
    expect(
      findPoNumbers('Re: PO-26-0042 shipped', 'Also P.O. 260043 and PO# 26-0044', 'Ack_PO 26 0045.pdf'),
    ).toEqual(['PO-26-0042', 'PO-26-0043', 'PO-26-0044', 'PO-26-0045']);
  });
  it('recognizes carriers and tracking numbers', () => {
    expect(findTracking('UPS tracking 1Z999AA10123456784')).toEqual({
      carrier: 'UPS',
      trackingNumber: '1Z999AA10123456784',
    });
    expect(findTracking('FedEx tracking number 123456789012')).toEqual({
      carrier: 'FedEx',
      trackingNumber: '123456789012',
    });
    expect(findTracking('Shipped via Estes, PRO# 1234567890')).toEqual({
      carrier: 'Estes',
      trackingNumber: '1234567890',
    });
    expect(findTracking('Old Dominion PRO 07712345678')).toEqual({
      carrier: 'Old Dominion',
      trackingNumber: '07712345678',
    });
  });
  it('classifies intent and new ship dates', () => {
    const ref = new Date('2026-10-20T00:00:00Z');
    const d = findDates('Due to a fabric delay the new ship date is 11/20/2026.', ref);
    expect(d.newShipDate).toBe('2026-11-20');
    expect(classifyIntent('the new ship date is 11/20/2026', false, true, []).intent).toBe(
      'ship_date_change',
    );
    expect(
      classifyIntent('Attached is our order acknowledgement for your PO', false, false, [
        'SO-1123 Acknowledgement.pdf',
      ]).intent,
    ).toBe('order_acknowledgement');
    expect(
      classifyIntent('Please find the proforma invoice for the 50% deposit', false, false, []).intent,
    ).toBe('proforma_deposit_invoice');
    expect(classifyIntent('Shop drawings attached for your approval', false, false, []).intent).toBe(
      'line_drawings_submittal',
    );
    expect(classifyIntent('Happy holidays from all of us', false, false, []).intent).toBe('general');
  });
  it('ranks candidate POs', () => {
    const pos: OpenPurchaseOrder[] = [
      {
        id: 'a',
        number: 'PO-26-0042',
        projectId: 'p',
        projectName: 'Hampton Inn Raleigh',
        vendorId: 'v1',
        vendorName: 'Formacase',
        status: 'issued',
        revision: 0,
      },
      {
        id: 'b',
        number: 'PO-26-0050',
        projectId: 'p',
        projectName: 'Hampton Inn Raleigh',
        vendorId: 'v1',
        vendorName: 'Formacase',
        status: 'issued',
        revision: 0,
      },
    ];
    const r = rankCandidates(pos, {
      poNumbers: ['PO-26-0042'],
      vendorId: 'v1',
      vendorName: 'Formacase',
      text: '',
    });
    expect(r[0]!.po.id).toBe('a');
    expect(r[0]!.score - r[1]!.score).toBeGreaterThan(0.5);
  });
});

describe('risk model', () => {
  const today = '2026-10-25';
  const base = {
    vendorId: 'v',
    requestedDeliveryDate: '2026-12-15',
    estimatedShipDate: '2026-11-20',
    transitDays: 7,
    origin: 'domestic',
    pendingRequirements: 0,
    shipDateChanges: 0,
    lastConfirmedAt: '2026-10-20',
  };
  const prior = tenantPrior([]);
  const avg = priorProfile(prior, 'v');

  it('more slack → lower score', () => {
    const scores = [-5, 0, 5, 10, 20, 40].map((slack) => {
      const s = { ...base, requestedDeliveryDate: undefined, estimatedDeliveryDate: '2026-12-01' };
      const req = new Date(Date.UTC(2026, 11, 1 + slack)).toISOString().slice(0, 10);
      return scoreFeatures('x', features({ ...s, requestedDeliveryDate: req }, avg, today)).score;
    });
    for (let i = 1; i < scores.length; i++) expect(scores[i]!).toBeLessThanOrEqual(scores[i - 1]!);
    expect(scores[0]!).toBeGreaterThan(scores.at(-1)!);
  });

  it('worse vendor → higher score', () => {
    const good = shrink(
      {
        n: 30,
        onTimeRate: 0.95,
        meanSlipDays: 1,
        p90SlipDays: 3,
        stdSlipDays: 2,
        meanLeadTimeWeeks: 12,
        shipDateChangeRate: 0.2,
      },
      prior,
      'g',
    );
    const bad = shrink(
      {
        n: 30,
        onTimeRate: 0.55,
        meanSlipDays: 12,
        p90SlipDays: 30,
        stdSlipDays: 10,
        meanLeadTimeWeeks: 12,
        shipDateChangeRate: 1.5,
      },
      prior,
      'b',
    );
    const g = scoreFeatures('x', features(base, good, today));
    const b = scoreFeatures('x', features(base, bad, today));
    expect(b.score).toBeGreaterThan(g.score);
    expect(b.reasons.join(' | ')).toMatch(/Vendor ships late \d+% of the time \(avg \d+ days/);
  });

  it('ship date changes, pending requirements and international origin each raise the score', () => {
    const s0 = scoreFeatures('x', features(base, avg, today)).score;
    expect(scoreFeatures('x', features({ ...base, shipDateChanges: 3 }, avg, today)).score).toBeGreaterThan(
      s0,
    );
    expect(
      scoreFeatures(
        'x',
        features({ ...base, pendingRequirements: 2, releaseByDate: '2026-10-20' }, avg, today),
      ).score,
    ).toBeGreaterThan(s0);
    expect(
      scoreFeatures('x', features({ ...base, origin: 'international', transitDays: 7 }, avg, today)).score,
    ).toBeGreaterThan(s0);
    const moved = scoreFeatures('x', features({ ...base, shipDateChanges: 3 }, avg, today));
    expect(moved.reasons.join(' ')).toMatch(/Ship date has moved 3 times/);
  });

  it('levels follow thresholds', () => {
    expect([10, 25, 49, 50, 74, 75].map(levelFor)).toEqual([
      'none',
      'watch',
      'watch',
      'at_risk',
      'at_risk',
      'critical',
    ]);
  });

  it('shrinks small samples toward the prior', () => {
    const hist = [
      ...Array.from({ length: 20 }, (_, i) => ({
        vendorId: 'big',
        origin: 'domestic',
        plannedShipDate: '2026-01-01',
        actualShipDate: i < 10 ? '2026-01-15' : '2026-01-01',
        requestedDeliveryDate: '2026-01-10',
        deliveredAt: i < 10 ? '2026-01-22T00:00:00Z' : '2026-01-08T00:00:00Z',
        shipDateChanges: 1,
      })),
      ...[0, 1].map(() => ({
        vendorId: 'tiny',
        origin: 'domestic',
        plannedShipDate: '2026-01-01',
        actualShipDate: '2026-01-01',
        requestedDeliveryDate: '2026-01-10',
        deliveredAt: '2026-01-08T00:00:00Z',
        shipDateChanges: 0,
      })),
    ];
    expect(observe(hist[0]!)).toMatchObject({ late: true, slipDays: 14 });
    const { prior: p, profiles } = vendorProfiles(hist);
    const tiny = profiles.get('tiny')!;
    expect(tiny.raw.onTimeRate).toBe(1);
    expect(tiny.onTimeRate).toBeLessThan(0.8);
    expect(tiny.onTimeRate).toBeGreaterThan(p.onTimeRate);
    const big = profiles.get('big')!;
    expect(Math.abs(big.onTimeRate - 0.5)).toBeLessThan(Math.abs(tiny.onTimeRate - 1));
  });
});
