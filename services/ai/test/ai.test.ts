import type { Llm } from '@procure/platform';
import { AppError, buildService, closeDb, withOwner } from '@procure/platform';
import { auth, createWorld, type World } from '@procure/platform/testing';
import { PDFDocument } from 'pdf-lib';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as clients from '../src/clients.js';
import { drainJobs, executeJob, sweepStuckJobs } from '../src/engine.js';
import { jobs as scheduled } from '../src/jobs.js';
import { setLlm } from '../src/llm.js';
import { aiService } from '../src/service.js';
import { b64, brandStandardPdf, drawingPacketPdf, vendorQuotePdf } from './fixtures.js';

vi.mock('../src/clients.js', () => ({
  getDocumentContent: vi.fn(),
  createDocument: vi.fn(),
  getVendor: vi.fn(),
  findVendorsByDomain: vi.fn(),
  getBrandStandard: vi.fn(),
  upsertBrandStandardItems: vi.fn(),
  getCostRequest: vi.fn(),
  postCostResponse: vi.fn(),
  listSpecs: vi.fn(),
  importSpecs: vi.fn(),
  listOpenPurchaseOrders: vi.fn(),
  listShipmentHistory: vi.fn(),
  listOpenShipments: vi.fn(),
  postRiskScores: vi.fn(),
  addTracking: vi.fn(),
  setRequirement: vi.fn(),
  getInboundEmail: vi.fn(),
  routeInboundEmail: vi.fn(),
  createThread: vi.fn(),
}));
const m = vi.mocked(clients);

let app: Awaited<ReturnType<typeof buildService>>;
let a: World;
let b: World;
const docs = new Map<string, { filename: string; bytes: Uint8Array }>();
const uuid = () => crypto.randomUUID();

const putDoc = (filename: string, bytes: Uint8Array) => {
  const id = uuid();
  docs.set(id, { filename, bytes });
  return id;
};

const get = (token: string, url: string) => app.inject({ method: 'GET', url, headers: auth(token) });
const post = (token: string, url: string, payload: unknown = {}) =>
  app.inject({ method: 'POST', url, headers: auth(token), payload: payload as never });

/** Create a job and wait for its in-process execution. */
async function run(token: string, url: string, payload: unknown) {
  const res = await post(token, url, payload);
  expect(res.statusCode, res.body).toBe(202);
  await drainJobs();
  return (await get(token, `/jobs/${res.json().id}`)).json();
}

const VENDOR_ID = uuid();
const VENDOR_ORG = uuid();
const costRequest = (): clients.CostRequest => ({
  id: uuid(),
  number: 'CR-26-0007',
  quoteId: uuid(),
  vendorId: VENDOR_ID,
  status: 'sent',
  lines: [
    {
      id: uuid(),
      quoteLineId: uuid(),
      specId: uuid(),
      code: 'CG-101',
      name: 'King Headboard',
      description: 'Walnut thermofoil',
      vendorSku: null,
      quantity: 120,
      currentCost: 410,
    },
    {
      id: uuid(),
      quoteLineId: uuid(),
      specId: uuid(),
      code: 'CG-102',
      name: 'Nightstand, 2 drawer',
      description: null,
      vendorSku: 'NS-2418',
      quantity: 240,
      currentCost: 205,
    },
    {
      id: uuid(),
      quoteLineId: uuid(),
      specId: uuid(),
      code: 'CG-110',
      name: 'Work desk with power grommet',
      description: null,
      vendorSku: null,
      quantity: 120,
      currentCost: 700,
    },
  ],
});

beforeAll(async () => {
  app = await buildService(aiService);
  a = await createWorld('Alpha');
  b = await createWorld('Bravo');
});
afterAll(async () => {
  await drainJobs();
  await app.close();
  await closeDb();
});
beforeEach(() => {
  vi.clearAllMocks();
  setLlm(undefined);
  m.getDocumentContent.mockImplementation(async (_t, id) => {
    const d = docs.get(id);
    if (!d) throw new AppError(404, 'not_found', 'documents: Document not found');
    return { filename: d.filename, contentType: 'application/pdf', base64: b64(d.bytes) };
  });
  m.routeInboundEmail.mockResolvedValue({});
  m.postRiskScores.mockResolvedValue({});
});

// ------------------------------------------------------------------------------------------------
describe('capabilities', () => {
  it('reports heuristic mode offline', async () => {
    const res = await get(a.adminToken, '/capabilities');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      provider: 'heuristic',
      mode: 'heuristic',
      model: null,
      label: expect.stringMatching(/Heuristic/),
    });
    expect(res.json().features).toHaveLength(5);
  });
});

describe('brand-spec extraction (a)', () => {
  it('runs queued → needs_review → applied (specs) with reviewer edits', async () => {
    const documentId = putDoc('hampton-standards.pdf', await brandStandardPdf());
    const job = await run(a.adminToken, '/jobs/brand-spec', { documentId });
    expect(job.status).toBe('needs_review');
    expect(job.provider).toBe('heuristic');
    expect(job.pages).toBe(2);
    expect(job.durationMs).toBeGreaterThanOrEqual(0);
    expect(job.output.items).toHaveLength(7);
    expect(job.output.standard.brandGuess).toBe('Hampton by Hilton');

    // reviewer rejects the carpet and renames the headboard
    const carpet = job.output.items.findIndex((i: any) => i.code === 'CP-2');
    const hb = job.output.items.findIndex((i: any) => i.code === 'CG-101');
    const rev = await post(a.adminToken, `/jobs/${job.id}/review`, {
      review: {
        items: [
          { index: carpet, accepted: false },
          { index: hb, edits: { name: 'King Headboard – Upholstered' } },
        ],
      },
    });
    expect(rev.statusCode, rev.body).toBe(200);

    m.importSpecs.mockResolvedValue({ created: 6, updated: 0 });
    const ap = await post(a.adminToken, `/jobs/${job.id}/apply`, { target: 'specs' });
    expect(ap.statusCode, ap.body).toBe(200);
    expect(ap.json()).toMatchObject({
      status: 'applied',
      appliedByName: 'Test User',
      applyResult: { applied: 6, created: 6 },
    });
    const rows = m.importSpecs.mock.calls[0]![1];
    expect(rows.map((r) => r.code)).not.toContain('CP-2');
    expect(rows.find((r) => r.code === 'CG-101')).toMatchObject({
      name: 'King Headboard – Upholstered',
      category: 'casegoods',
    });

    // second apply conflicts
    expect((await post(a.adminToken, `/jobs/${job.id}/apply`, { target: 'specs' })).statusCode).toBe(409);

    // events: completed + applied in outbox
    const events = await withOwner(
      (tx) => tx`select type, data from platform.outbox where source = 'ai' and data->>'jobId' = ${job.id}`,
    );
    expect(events.map((e: any) => e.type).sort()).toEqual(['ai.job.applied', 'ai.job.completed']);
  });

  it('applies to an existing catalog standard and requires one', async () => {
    const documentId = putDoc('hgi.pdf', await brandStandardPdf());
    const job = await run(a.adminToken, '/jobs/brand-spec', { documentId });
    expect((await post(a.adminToken, `/jobs/${job.id}/apply`, { target: 'catalog' })).statusCode).toBe(422);
    const standardId = uuid();
    m.getBrandStandard.mockResolvedValue({
      id: standardId,
      brandId: uuid(),
      brandName: 'Hampton',
      name: 'FF&E',
      version: '4.2',
      items: [],
    });
    m.upsertBrandStandardItems.mockResolvedValue({});
    const ap = await post(a.adminToken, `/jobs/${job.id}/apply`, {
      target: 'catalog',
      standardId,
      itemIndexes: [0, 1],
    });
    expect(ap.statusCode, ap.body).toBe(200);
    expect(ap.json()).toMatchObject({ entityType: 'brand_standard', entityId: standardId });
    expect(m.upsertBrandStandardItems.mock.calls[0]![2]).toHaveLength(2);
  });

  it('records failures on the job (missing document, non-PDF) without crashing', async () => {
    const job = await run(a.adminToken, '/jobs/brand-spec', { documentId: uuid() });
    expect(job.status).toBe('failed');
    expect(job.error).toMatch(/Document not found/);
    const bad = putDoc('notes.txt', new TextEncoder().encode('hello'));
    const j2 = await run(a.adminToken, '/jobs/brand-spec', { documentId: bad });
    expect(j2).toMatchObject({ status: 'failed', error: expect.stringMatching(/not a PDF/) });
    // retry re-queues; fix the document and it succeeds
    docs.set(bad, { filename: 'notes.pdf', bytes: await brandStandardPdf() });
    const r = await post(a.adminToken, `/jobs/${j2.id}/retry`);
    expect(r.json().status).toBe('queued');
    await drainJobs();
    expect((await get(a.adminToken, `/jobs/${j2.id}`)).json().status).toBe('needs_review');
  });

  it('uses the LLM path when available and records usage', async () => {
    const calls: string[] = [];
    const fake: Llm = {
      provider: 'bedrock',
      model: 'anthropic.claude-test',
      available: true,
      json: async (req, schema) => {
        calls.push(req.prompt);
        const data = schema.parse({
          standard: {
            name: 'Hampton FF&E Standards',
            brandGuess: 'Hampton by Hilton',
            version: '4.2',
            effectiveDate: '2026-03-01',
          },
          items: [
            {
              code: 'CG-101',
              area: 'Guestroom',
              category: 'casegoods',
              name: 'King Headboard',
              description: null,
              dimensions: '80"W',
              finish: null,
              materials: null,
              approvedVendors: [{ name: 'Formacase', model: 'HB-8054' }],
              quantityBasis: '1 per king',
              sourcePage: 1,
              confidence: 0.97,
            },
          ],
          warnings: [],
        });
        return { data, usage: { inputTokens: 1200, outputTokens: 300 } };
      },
    };
    setLlm(fake);
    const documentId = putDoc('hampton.pdf', await brandStandardPdf());
    const job = await run(a.adminToken, '/jobs/brand-spec', { documentId });
    expect(job).toMatchObject({
      status: 'needs_review',
      provider: 'bedrock',
      model: 'anthropic.claude-test',
      inputTokens: 1200,
      outputTokens: 300,
    });
    expect(calls[0]).toContain('<page number="1">');
    expect(job.output.items[0]).toMatchObject({ code: 'CG-101', confidence: 0.97 });
    // heuristic safety net adds the codes the model missed
    expect(job.output.items.map((i: any) => i.code)).toEqual(expect.arrayContaining(['CG-102', 'CP-2']));
    expect((await get(a.adminToken, '/capabilities')).json()).toMatchObject({
      provider: 'bedrock',
      mode: 'llm',
      label: 'AI: Claude via Bedrock (anthropic.claude-test)',
    });
  });

  it('falls back to heuristics when the model fails', async () => {
    setLlm({
      provider: 'anthropic',
      model: 'x',
      available: true,
      json: async () => {
        throw new Error('throttled');
      },
    });
    const job = await run(a.adminToken, '/jobs/brand-spec', {
      documentId: putDoc('h.pdf', await brandStandardPdf()),
    });
    expect(job.status).toBe('needs_review');
    expect(job.provider).toBe('heuristic');
    expect(job.output.warnings[0]).toMatch(/throttled/);
  });
});

describe('vendor quote extraction (b)', () => {
  it('extracts, matches, flags and applies selected matches as a cost response', async () => {
    const cr = costRequest();
    m.getCostRequest.mockResolvedValue(cr);
    const documentId = putDoc('FQ-55821.pdf', await vendorQuotePdf());
    const job = await run(a.adminToken, '/jobs/vendor-quote', { documentId, costRequestId: cr.id });
    expect(job.status, job.error).toBe('needs_review');
    expect(job.entityType).toBe('cost_request');
    expect(job.output.header).toMatchObject({
      vendorQuoteNumber: 'FQ-55821',
      validUntil: '2026-12-31',
      leadTimeWeeks: 12,
    });
    expect(job.output.matches).toHaveLength(3);
    const desk = job.output.matches.find((x: any) => x.code === 'CG-110');
    expect(desk.flags.join(' ')).toMatch(/above the current cost/);
    expect(job.output.unmatchedLines).toHaveLength(1);

    // list summary has counts only
    const list = (await get(a.adminToken, '/jobs?kind=vendor_quote_extract')).json();
    expect(list.items[0].summary).toMatchObject({ matches: 3, unmatched: 1, costRequest: 'CR-26-0007' });

    m.postCostResponse.mockResolvedValue({});
    const headboardIdx = job.output.matches.findIndex((x: any) => x.code === 'CG-101');
    const ap = await post(a.adminToken, `/jobs/${job.id}/apply`, {
      matchIndexes: [headboardIdx],
      edits: [{ index: headboardIdx, set: { unitCost: 419.5 } }],
    });
    expect(ap.statusCode, ap.body).toBe(200);
    const [, crId, body] = m.postCostResponse.mock.calls[0]!;
    expect(crId).toBe(cr.id);
    expect(body).toMatchObject({
      source: 'ai_pdf',
      lines: [
        { costRequestLineId: cr.lines[0]!.id, cost: 419.5, expiresAt: '2026-12-31', leadTimeWeeks: 12 },
      ],
    });
  });

  it('withholds cost output from users without quotes:costs:read', async () => {
    const cr = costRequest();
    m.getCostRequest.mockResolvedValue(cr);
    const job = await run(a.adminToken, '/jobs/vendor-quote', {
      documentId: putDoc('q.pdf', await vendorQuotePdf()),
      costRequestId: cr.id,
    });
    const designer = await a.tokenAs(['designer']);
    const res = await get(designer, `/jobs/${job.id}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ output: null, outputRedacted: true });
    expect(
      (await post(designer, '/jobs/vendor-quote', { documentId: uuid(), costRequestId: cr.id })).statusCode,
    ).toBe(403);
  });
});

describe('drawing packet split (c)', () => {
  it('assigns 6 pages to 3 specs and apply creates 3 documents', async () => {
    const specs: clients.SpecSummary[] = [
      {
        id: uuid(),
        code: 'CG-101',
        name: 'King Headboard',
        category: 'casegoods',
        vendorId: VENDOR_ID,
        vendorSku: 'HB-8054',
        description: null,
      },
      {
        id: uuid(),
        code: 'CG-102',
        name: 'Nightstand',
        category: 'casegoods',
        vendorId: VENDOR_ID,
        vendorSku: 'NS-2418',
        description: null,
      },
      {
        id: uuid(),
        code: 'CG-110',
        name: 'Work Desk',
        category: 'casegoods',
        vendorId: VENDOR_ID,
        vendorSku: 'DK-4824',
        description: null,
      },
    ];
    m.listSpecs.mockResolvedValue(specs);
    const quoteId = uuid();
    const documentId = putDoc('Formacase drawings.pdf', await drawingPacketPdf());
    const job = await run(a.adminToken, '/jobs/drawing-split', { documentId, quoteId });
    expect(job.status, job.error).toBe('needs_review');
    expect(m.listSpecs).toHaveBeenCalledWith(a.tenantId, { quoteId, ids: undefined });
    expect(job.output.groups.map((g: any) => [g.code, g.pages])).toEqual([
      ['CG-101', [1, 2]],
      ['CG-102', [3, 4, 5]],
      ['CG-110', [6]],
    ]);
    expect(job.output.unassignedPages).toEqual([]);

    const created: { filename: string; pages: number; entityId: string }[] = [];
    m.createDocument.mockImplementation(async (_t, body) => {
      const pdf = await PDFDocument.load(Buffer.from(body.base64, 'base64'));
      created.push({ filename: body.filename, pages: pdf.getPageCount(), entityId: body.entityId! });
      expect(body).toMatchObject({
        kind: 'line_drawing',
        entityType: 'spec',
        includeInSpecBook: true,
        contentType: 'application/pdf',
      });
      return {
        id: uuid(),
        filename: body.filename,
        contentType: 'application/pdf',
        kind: 'line_drawing',
        entityType: 'spec',
        entityId: body.entityId!,
      };
    });
    const ap = await post(a.adminToken, `/jobs/${job.id}/apply`, {});
    expect(ap.statusCode, ap.body).toBe(200);
    expect(created).toEqual([
      { filename: 'CG-101 – King Headboard – line drawing.pdf', pages: 2, entityId: specs[0]!.id },
      { filename: 'CG-102 – Nightstand – line drawing.pdf', pages: 3, entityId: specs[1]!.id },
      { filename: 'CG-110 – Work Desk – line drawing.pdf', pages: 1, entityId: specs[2]!.id },
    ]);
    expect(ap.json().applyResult.documents).toHaveLength(3);
  });

  it('resumes a partially failed apply without duplicating documents', async () => {
    const specs: clients.SpecSummary[] = [
      {
        id: uuid(),
        code: 'CG-101',
        name: 'King Headboard',
        category: 'casegoods',
        vendorId: null,
        vendorSku: 'HB-8054',
        description: null,
      },
      {
        id: uuid(),
        code: 'CG-102',
        name: 'Nightstand',
        category: 'casegoods',
        vendorId: null,
        vendorSku: null,
        description: null,
      },
    ];
    m.listSpecs.mockResolvedValue(specs);
    const job = await run(a.adminToken, '/jobs/drawing-split', {
      documentId: putDoc('d.pdf', await drawingPacketPdf()),
      specIds: specs.map((s) => s.id),
    });
    let n = 0;
    m.createDocument.mockImplementation(async (_t, body) => {
      if (++n === 2) throw new AppError(502, 'upstream_error', 'documents: unavailable');
      return {
        id: uuid(),
        filename: body.filename,
        contentType: 'application/pdf',
        kind: 'line_drawing',
        entityType: 'spec',
        entityId: body.entityId!,
      };
    });
    const first = await post(a.adminToken, `/jobs/${job.id}/apply`, {});
    expect(first.statusCode).toBe(502);
    const mid = (await get(a.adminToken, `/jobs/${job.id}`)).json();
    expect(mid).toMatchObject({ status: 'needs_review', applyError: expect.stringMatching(/unavailable/) });
    expect(mid.applyResult.documents).toHaveLength(1);
    const second = await post(a.adminToken, `/jobs/${job.id}/apply`, {});
    expect(second.statusCode, second.body).toBe(200);
    expect(m.createDocument).toHaveBeenCalledTimes(3);
    expect(second.json().applyResult.documents).toHaveLength(2);
  });

  it('validates groups on apply', async () => {
    const specs: clients.SpecSummary[] = [
      {
        id: uuid(),
        code: 'CG-101',
        name: 'King Headboard',
        category: null,
        vendorId: null,
        vendorSku: null,
        description: null,
      },
    ];
    m.listSpecs.mockResolvedValue(specs);
    const job = await run(a.adminToken, '/jobs/drawing-split', {
      documentId: putDoc('d.pdf', await drawingPacketPdf()),
      specIds: [specs[0]!.id],
    });
    expect(
      (await post(a.adminToken, `/jobs/${job.id}/apply`, { groups: [{ specId: uuid(), pages: [1] }] }))
        .statusCode,
    ).toBe(422);
    expect(
      (await post(a.adminToken, `/jobs/${job.id}/apply`, { groups: [{ specId: specs[0]!.id, pages: [99] }] }))
        .statusCode,
    ).toBe(422);
    expect((await post(a.adminToken, '/jobs/drawing-split', { documentId: uuid() })).statusCode).toBe(400);
  });
});

describe('inbox routing (d)', () => {
  const po = (number: string, vendorId = VENDOR_ID): clients.OpenPurchaseOrder => ({
    id: uuid(),
    number,
    projectId: uuid(),
    projectName: 'Hampton Inn Raleigh',
    vendorId,
    vendorName: 'Formacase',
    status: 'issued',
    revision: 0,
  });

  it('routes an email with a PO number and UPS tracking via the event subscription', async () => {
    const target = po('PO-26-0042');
    const other = po('PO-26-0050');
    const emailId = uuid();
    m.getInboundEmail.mockResolvedValue({
      id: emailId,
      from: 'Kim Shipping <shipping@formacase.com>',
      to: 'orders@inbound.pro-cure.local',
      subject: 'Shipment notification – PO# 26-0042',
      text: 'Hello, your order has shipped today via UPS. Tracking number 1Z999AA10123456784. Ship date: 10/24/2026.',
      receivedAt: '2026-10-24T15:00:00Z',
      attachments: [{ documentId: uuid(), filename: 'BOL-77812.pdf', contentType: 'application/pdf' }],
    });
    m.findVendorsByDomain.mockResolvedValue([
      { id: VENDOR_ID, name: 'Formacase', orgId: VENDOR_ORG, website: 'formacase.com' },
    ]);
    m.listOpenPurchaseOrders.mockResolvedValue([target, other]);

    const event = {
      id: uuid(),
      type: 'comms.inbound_email.received',
      version: 1,
      occurredAt: new Date().toISOString(),
      source: 'comms',
      tenantId: a.tenantId,
      actor: null,
      data: { inboundEmailId: emailId },
    };
    const res = await app.inject({
      method: 'POST',
      url: '/internal/events',
      headers: { 'x-procure-internal': 'local-internal-secret' },
      payload: event,
    });
    expect(res.json()).toEqual({ result: 'processed' });
    // duplicate delivery is a no-op
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/internal/events',
          headers: { 'x-procure-internal': 'local-internal-secret' },
          payload: event,
        })
      ).json(),
    ).toEqual({ result: 'duplicate' });
    await drainJobs();

    expect(m.findVendorsByDomain).toHaveBeenCalledWith(a.tenantId, 'formacase.com');
    const [, routedId, body] = m.routeInboundEmail.mock.calls[0]!;
    expect(routedId).toBe(emailId);
    expect(body).toMatchObject({
      status: 'routed',
      entityType: 'purchase_order',
      entityId: target.id,
      vendorOrgId: VENDOR_ORG,
    });
    expect(body.confidence).toBeGreaterThanOrEqual(0.85);
    expect(body.suggestions[0]).toMatchObject({
      type: 'set_tracking',
      payload: {
        poId: target.id,
        carrier: 'UPS',
        trackingNumber: '1Z999AA10123456784',
        shipDate: '2026-10-24',
      },
    });

    const list = (await get(a.adminToken, `/jobs?kind=inbox_route&entityId=${emailId}`)).json();
    expect(list.total).toBe(1);
    const job = (await get(a.adminToken, `/jobs/${list.items[0].id}`)).json();
    expect(job).toMatchObject({ status: 'completed', createdByName: 'Pro-Cure inbox agent' });
    expect(job.output).toMatchObject({
      intent: 'shipping_notification',
      routed: true,
      target: { poNumber: 'PO-26-0042' },
    });
  });

  it('leaves an ambiguous email for review with ranked candidates', async () => {
    const p1 = po('PO-26-0060');
    const p2 = po('PO-26-0061');
    const emailId = uuid();
    m.getInboundEmail.mockResolvedValue({
      id: emailId,
      from: 'sales@formacase.com',
      to: 'orders@x',
      subject: 'Question on your order',
      text: 'Can you confirm the finish selection for the nightstands?',
      receivedAt: '2026-10-24T15:00:00Z',
      attachments: [],
    });
    m.findVendorsByDomain.mockResolvedValue([
      { id: VENDOR_ID, name: 'Formacase', orgId: VENDOR_ORG, website: null },
    ]);
    m.listOpenPurchaseOrders.mockResolvedValue([p1, p2]);
    const job = await run(a.adminToken, '/jobs/inbox-route', { inboundEmailId: emailId });
    expect(job.status).toBe('needs_review');
    expect(job.output.target).toBeNull();
    const [, , body] = m.routeInboundEmail.mock.calls[0]!;
    expect(body.status).toBe('needs_review');
    expect(body.entityId).toBeUndefined();
    expect(
      body.suggestions
        .filter((s: any) => s.type === 'route_to_po')
        .map((s: any) => s.payload.entityId)
        .sort(),
    ).toEqual([p1.id, p2.id].sort());
    expect(job.output.candidates).toHaveLength(2);
  });

  it('requires inbox:triage for manual re-runs', async () => {
    const designer = await a.tokenAs(['designer']);
    expect((await post(designer, '/jobs/inbox-route', { inboundEmailId: uuid() })).statusCode).toBe(403);
  });
});

describe('risk scoring (e)', () => {
  const history = (vendorId: string, n: number, lateEvery: number) =>
    Array.from({ length: n }, (_, i) => ({
      vendorId,
      origin: 'domestic',
      plannedShipDate: '2026-03-01',
      actualShipDate: i % lateEvery === 0 ? '2026-03-15' : '2026-03-01',
      requestedDeliveryDate: '2026-03-12',
      deliveredAt: i % lateEvery === 0 ? '2026-03-22T12:00:00Z' : '2026-03-08T12:00:00Z',
      shipDateChanges: i % lateEvery === 0 ? 2 : 0,
    }));

  it('profiles vendors, scores open shipments, posts scores and serves the summary', async () => {
    const good = uuid();
    const bad = uuid();
    m.listShipmentHistory.mockResolvedValue([...history(good, 20, 10), ...history(bad, 20, 2)]);
    const ship = (vendorId: string, extra: Partial<clients.OpenShipment> = {}): clients.OpenShipment => ({
      shipmentId: uuid(),
      poId: uuid(),
      poNumber: 'PO-26-0042',
      vendorId,
      vendorName: vendorId === good ? 'Reliable Co' : 'Slowpoke Inc',
      origin: 'domestic',
      requestedDeliveryDate: '2026-12-20',
      estimatedShipDate: '2026-12-01',
      transitDays: 7,
      pendingRequirements: 0,
      shipDateChanges: 0,
      lastConfirmedAt: new Date().toISOString(),
      ...extra,
    });
    const open = [
      ship(good),
      ship(bad),
      ship(bad, {
        shipDateChanges: 3,
        requestedDeliveryDate: '2026-12-10',
        origin: 'international',
        transitDays: 7,
      }),
    ];
    m.listOpenShipments.mockResolvedValue(open);
    const job = await run(a.adminToken, '/jobs/risk-score', {});
    expect(job.status, job.error).toBe('completed');
    const scores = m.postRiskScores.mock.calls[0]![1];
    expect(scores).toHaveLength(3);
    const s = Object.fromEntries(scores.map((x) => [x.shipmentId, x]));
    expect(s[open[1]!.shipmentId!]!.score).toBeGreaterThan(s[open[0]!.shipmentId!]!.score);
    expect(s[open[2]!.shipmentId!]!.score).toBeGreaterThan(s[open[1]!.shipmentId!]!.score);
    expect(s[open[2]!.shipmentId!]!.reasons.length).toBeLessThanOrEqual(3);
    expect(s[open[2]!.shipmentId!]!.reasons.join(' ')).toMatch(
      /Ship date has moved 3 times|Vendor ships late/,
    );

    const perf = (await get(a.adminToken, '/vendor-performance')).json();
    expect(perf.total).toBe(2);
    expect(perf.items[0]).toMatchObject({ vendorId: bad, sampleSize: 20 });
    expect(perf.items[0].onTimeRate).toBeLessThan(perf.items[1].onTimeRate);
    const one = (await get(a.adminToken, `/vendor-performance?vendorId=${good}`)).json();
    expect(one.items).toHaveLength(1);

    const sum = (await get(a.adminToken, '/risk/summary')).json();
    expect(sum.run.shipmentsScored).toBe(3);
    expect(sum.top[0].shipmentId).toBe(open[2]!.shipmentId);
    expect(Object.values(sum.counts as Record<string, number>).reduce((x, y) => x + y, 0)).toBe(3);
    expect(sum.narrative).toMatch(/of 3 open shipments/);
  });

  it('scheduled risk-model runs for registered tenants', async () => {
    m.listShipmentHistory.mockResolvedValue([]);
    m.listOpenShipments.mockResolvedValue([]);
    const job = scheduled.find((j) => j.name === 'risk-model')!;
    const log = app.log;
    const res = (await withOwner((tx) => job.run({ tx: tx as never, log, now: new Date() }))) as any;
    expect(res.results[a.tenantId]).toMatchObject({ scored: 0 });
    const runs = (await get(a.adminToken, '/jobs?kind=risk_score&status=completed')).json();
    expect(runs.items.some((j: any) => j.title.includes('scheduled'))).toBe(true);
  });
});

describe('job lifecycle & safety', () => {
  it('honours idempotency keys', async () => {
    const documentId = putDoc('x.pdf', await brandStandardPdf());
    const r1 = await post(a.adminToken, '/jobs/brand-spec', { documentId, idempotencyKey: 'upload-12345' });
    const r2 = await post(a.adminToken, '/jobs/brand-spec', { documentId, idempotencyKey: 'upload-12345' });
    expect(r1.statusCode).toBe(202);
    expect(r2.statusCode).toBe(200);
    expect(r2.json().id).toBe(r1.json().id);
    await drainJobs();
  });

  it('discard closes a job; it can no longer be applied', async () => {
    const job = await run(a.adminToken, '/jobs/brand-spec', {
      documentId: putDoc('x.pdf', await brandStandardPdf()),
    });
    const d = await post(a.adminToken, `/jobs/${job.id}/discard`);
    expect(d.json()).toMatchObject({ status: 'completed', discardedByName: 'Test User' });
    const ap = await post(a.adminToken, `/jobs/${job.id}/apply`, { target: 'specs' });
    expect(ap.statusCode).toBe(409);
    expect(ap.json().title).toMatch(/discarded/);
  });

  it('stuck-job sweep re-runs stale queued jobs and fails exhausted ones', async () => {
    const documentId = putDoc('s.pdf', await brandStandardPdf());
    const [stale, dead] = await withOwner(async (tx) => {
      const ins = (attempts: number, status: string) => tx`
        insert into ai.jobs (tenant_id, kind, status, title, input, attempts, created_at, started_at)
        values (${a.tenantId}, 'brand_spec_extract', ${status}, 'stale', ${tx.json({ documentId })}, ${attempts},
                now() - interval '30 minutes', ${status === 'running' ? tx`now() - interval '30 minutes'` : null})
        returning id`;
      return [(await ins(0, 'queued'))[0]!.id, (await ins(3, 'running'))[0]!.id] as string[];
    });
    const res = await withOwner((tx) => sweepStuckJobs(tx as never, app.log));
    expect(res.failed).toBeGreaterThanOrEqual(1);
    await drainJobs();
    expect((await get(a.adminToken, `/jobs/${stale}`)).json().status).toBe('needs_review');
    expect((await get(a.adminToken, `/jobs/${dead}`)).json()).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/3 attempts/),
    });
  });

  it('a job is claimed once even if executed twice', async () => {
    const r = await post(a.adminToken, '/jobs/brand-spec', {
      documentId: putDoc('c.pdf', await brandStandardPdf()),
    });
    await drainJobs();
    expect(await executeJob(a.tenantId, r.json().id)).toBeNull();
  });

  it('paginates and filters job lists', async () => {
    const res = (await get(a.adminToken, '/jobs?limit=2&offset=0&status=needs_review,failed')).json();
    expect(res.items.length).toBeLessThanOrEqual(2);
    expect(res.total).toBeGreaterThan(2);
    for (const j of res.items) expect(['needs_review', 'failed']).toContain(j.status);
    expect((await get(a.adminToken, '/jobs?status=bogus')).statusCode).toBe(400);
  });
});

describe('tenant isolation & permissions', () => {
  it("cannot see or act on another tenant's jobs", async () => {
    const job = await run(a.adminToken, '/jobs/brand-spec', {
      documentId: putDoc('iso.pdf', await brandStandardPdf()),
    });
    expect((await get(b.adminToken, `/jobs/${job.id}`)).statusCode).toBe(404);
    expect((await post(b.adminToken, `/jobs/${job.id}/apply`, { target: 'specs' })).statusCode).toBe(404);
    expect((await post(b.adminToken, `/jobs/${job.id}/review`, { review: {} })).statusCode).toBe(404);
    const list = (await get(b.adminToken, '/jobs')).json();
    expect(list.items.map((j: any) => j.id)).not.toContain(job.id);
    expect((await get(b.adminToken, '/vendor-performance')).json().total).toBe(0);
  });

  it('RLS hides rows even without a where clause', async () => {
    const { withContext } = await import('@procure/platform');
    const rows = await withContext(
      { tenantId: b.tenantId, userId: b.adminId, orgId: b.tenantId, actor: 'internal' },
      (tx) => tx`select tenant_id from ai.jobs`,
    );
    expect(rows.every((r: any) => r.tenantId === b.tenantId)).toBe(true);
    const vendorRows = await withContext(
      { tenantId: a.tenantId, userId: a.vendorUserId, orgId: a.vendorOrgId, actor: 'vendor' },
      (tx) => tx`select id from ai.jobs`,
    );
    expect(vendorRows).toHaveLength(0);
  });

  it('denies vendors, clients, unauthenticated callers and missing permissions', async () => {
    expect((await get(a.vendorToken, '/jobs')).statusCode).toBe(403);
    expect((await get(a.clientToken, '/capabilities')).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/jobs' })).statusCode).toBe(401);
    const viewer = await a.tokenAs(['viewer']);
    const job = await run(a.adminToken, '/jobs/brand-spec', {
      documentId: putDoc('p.pdf', await brandStandardPdf()),
    });
    expect((await post(viewer, `/jobs/${job.id}/apply`, { target: 'specs' })).statusCode).toBe(403);
    expect(
      (await post(viewer, `/jobs/${job.id}/apply`, { target: 'catalog', standardId: uuid() })).statusCode,
    ).toBe(403);
    // the denied apply did not take the lease
    m.importSpecs.mockResolvedValue({ created: 7, updated: 0 });
    expect((await post(a.adminToken, `/jobs/${job.id}/apply`, { target: 'specs' })).statusCode).toBe(200);
  });
});

describe('LLM paths (stubbed provider)', () => {
  const stub = (respond: (prompt: string) => unknown): Llm => ({
    provider: 'anthropic',
    model: 'claude-test',
    available: true,
    json: async (req, schema) => ({
      data: schema.parse(respond(req.prompt)),
      usage: { inputTokens: 100, outputTokens: 50 },
    }),
  });

  it('vendor quote: uses the model line ids for matching', async () => {
    const cr = costRequest();
    m.getCostRequest.mockResolvedValue(cr);
    setLlm(
      stub(() => ({
        header: {
          vendorName: 'Formacase',
          vendorQuoteNumber: 'FQ-55821',
          quoteDate: '2026-10-15',
          validUntil: '2026-12-31',
          leadTime: '10-12 weeks',
          freightTerms: 'FOB Factory',
        },
        lines: [
          {
            vendorSku: 'NS-2418',
            specCode: null,
            description: 'Bedside table, two drawers',
            quantity: 240,
            unitPrice: 198.5,
            extended: 47640,
            leadTimeWeeks: null,
            expiresAt: null,
            notes: null,
            sourcePage: 1,
            costRequestLineId: cr.lines[1]!.id,
          },
          {
            vendorSku: 'XX-1',
            specCode: null,
            description: 'Mystery item',
            quantity: 1,
            unitPrice: 5,
            extended: 5,
            leadTimeWeeks: 3,
            expiresAt: null,
            notes: null,
            sourcePage: 1,
            costRequestLineId: 'not-a-real-id',
          },
        ],
        totals: { subtotal: 47645, freight: null, total: null },
      })),
    );
    const job = await run(a.adminToken, '/jobs/vendor-quote', {
      documentId: putDoc('q.pdf', await vendorQuotePdf()),
      costRequestId: cr.id,
    });
    expect(job).toMatchObject({ status: 'needs_review', provider: 'anthropic', inputTokens: 100 });
    expect(job.output.matches).toHaveLength(1);
    expect(job.output.matches[0]).toMatchObject({
      costRequestLineId: cr.lines[1]!.id,
      unitCost: 198.5,
      leadTimeWeeks: 12,
      expiresAt: '2026-12-31',
      flags: [],
    });
    expect(job.output.matches[0].reasons).toContain('AI model matched this line');
    expect(job.output.unmatchedLines).toHaveLength(1);
  });

  it('drawing split: model fills pages without printed codes; printed codes win', async () => {
    const specs: clients.SpecSummary[] = [
      {
        id: uuid(),
        code: 'CG-101',
        name: 'King Headboard',
        category: null,
        vendorId: null,
        vendorSku: null,
        description: null,
      },
      {
        id: uuid(),
        code: 'CG-102',
        name: 'Nightstand',
        category: null,
        vendorId: null,
        vendorSku: null,
        description: null,
      },
    ];
    m.listSpecs.mockResolvedValue(specs);
    setLlm(
      stub(() => ({
        pages: [1, 2, 3, 4, 5, 6].map((page) => ({
          page,
          specId: page === 1 ? specs[1]!.id : page <= 2 ? specs[0]!.id : page <= 5 ? specs[1]!.id : null,
          confidence: 0.9,
          reason: 'title block',
        })),
      })),
    );
    const job = await run(a.adminToken, '/jobs/drawing-split', {
      documentId: putDoc('d.pdf', await drawingPacketPdf()),
      specIds: specs.map((s) => s.id),
    });
    expect(job.output.groups.map((g: any) => [g.code, g.pages])).toEqual([
      ['CG-101', [1, 2]],
      ['CG-102', [3, 4, 5]],
    ]);
    expect(job.output.unassignedPages).toEqual([6]);
    expect(job.output.warnings.join(' ')).toMatch(/Page 1: AI suggested a different spec/);
  });

  it('inbox: model classification routes when confident', async () => {
    const target: clients.OpenPurchaseOrder = {
      id: uuid(),
      number: 'PO-26-0077',
      projectId: uuid(),
      projectName: 'Holiday Inn Express Cary',
      vendorId: VENDOR_ID,
      vendorName: 'Formacase',
      status: 'acknowledged',
      revision: 1,
    };
    const emailId = uuid();
    m.getInboundEmail.mockResolvedValue({
      id: emailId,
      from: 'pm@formacase.com',
      to: 'x',
      subject: 'Re: PO-26-0077',
      text: 'Production slipped; we will now ship the week of Dec 7.',
      receivedAt: '2026-10-24T15:00:00Z',
      attachments: [],
    });
    m.findVendorsByDomain.mockResolvedValue([
      { id: VENDOR_ID, name: 'Formacase', orgId: VENDOR_ORG, website: null },
    ]);
    m.listOpenPurchaseOrders.mockResolvedValue([target]);
    setLlm(
      stub((prompt) => {
        expect(prompt).toContain('PO-26-0077');
        return {
          intent: 'ship_date_change',
          poId: target.id,
          confidence: 0.93,
          reasons: ['Vendor states production slipped'],
          extracted: {
            trackingNumber: null,
            carrier: null,
            shipDate: null,
            newShipDate: '2026-12-07',
            amount: null,
          },
        };
      }),
    );
    const job = await run(a.adminToken, '/jobs/inbox-route', { inboundEmailId: emailId });
    expect(job).toMatchObject({ status: 'completed', provider: 'anthropic' });
    expect(job.output).toMatchObject({
      intent: 'ship_date_change',
      routed: true,
      extracted: { newShipDate: '2026-12-07' },
    });
    const [, , body] = m.routeInboundEmail.mock.calls[0]!;
    expect(body.suggestions).toEqual([
      expect.objectContaining({
        type: 'update_ship_date',
        payload: expect.objectContaining({ poId: target.id, newShipDate: '2026-12-07' }),
      }),
    ]);
  });

  it('risk: writes the model narrative into the output', async () => {
    m.listShipmentHistory.mockResolvedValue([]);
    m.listOpenShipments.mockResolvedValue([
      {
        shipmentId: uuid(),
        vendorId: VENDOR_ID,
        requestedDeliveryDate: '2026-11-01',
        estimatedShipDate: '2026-11-01',
      },
    ]);
    setLlm(
      stub(() => ({
        narrative:
          'One shipment is critical because it ships after its delivery date. Call the vendor this week.',
      })),
    );
    const job = await run(a.adminToken, '/jobs/risk-score', {});
    expect(job.output.narrative).toMatch(/^One shipment is critical/);
    expect(job.provider).toBe('anthropic');
  });
});
