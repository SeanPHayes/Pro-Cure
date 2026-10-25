import { buildService, closeDb, internalSecret, withOwner } from '@procure/platform';
import { auth, createWorld, tokenFor, type World } from '@procure/platform/testing';
import { PDFDocument } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { documentsService } from '../src/service.js';
import { multipart, PNG, SAMPLES, samplePdf, specBook } from './fixtures.js';

let app: Awaited<ReturnType<typeof buildService>>;
let a: World;
let b: World;
const internal = { 'x-procure-internal': internalSecret() };
const poId = crypto.randomUUID();
const specId = crypto.randomUUID();

beforeAll(async () => {
  app = await buildService(documentsService);
  a = await createWorld('Alpha');
  b = await createWorld('Bravo');
});
afterAll(async () => {
  await app.close();
  await closeDb();
});

async function upload(
  token: string,
  fields: Record<string, string | undefined>,
  file: { filename: string; contentType: string; bytes: Buffer } = {
    filename: 'drawing.pdf',
    contentType: 'application/pdf',
    bytes: Buffer.alloc(0),
  },
) {
  const bytes: Buffer = file.bytes.length ? file.bytes : await samplePdf(2);
  const mp = multipart(fields, { ...file, bytes });
  return app.inject({
    method: 'POST',
    url: '/documents',
    headers: { ...auth(token), ...mp.headers },
    payload: mp.payload,
  });
}

const pageCount = async (buf: Buffer) => (await PDFDocument.load(buf)).getPageCount();

describe('upload & download', () => {
  let docId: string;
  let bytes: Buffer;

  it('uploads a PDF, computes sha256/size/pages and emits an event', async () => {
    bytes = await samplePdf(3);
    const res = await upload(
      a.adminToken,
      { entityType: 'purchase_order', entityId: poId, kind: 'shop_drawing', includeInSpecBook: 'true' },
      { filename: 'Shop drawing GR-01.pdf', contentType: 'application/pdf', bytes },
    );
    expect(res.statusCode).toBe(201);
    const d = res.json();
    docId = d.id;
    expect(d).toMatchObject({
      filename: 'Shop drawing GR-01.pdf',
      size: bytes.length,
      pageCount: 3,
      kind: 'shop_drawing',
      visibility: 'internal',
      includeInSpecBook: true,
      entityType: 'purchase_order',
      entityId: poId,
      downloadUrl: `/api/documents/documents/${d.id}/download`,
      uploadedByName: 'Test User',
    });
    expect(d.sha256).toMatch(/^[a-f0-9]{64}$/);
    const [ev] = await withOwner(
      (tx) =>
        tx`select data from platform.outbox where type = 'documents.document.uploaded' and data ->> 'documentId' = ${docId}`,
    );
    expect(ev).toBeTruthy();
  });

  it('downloads the same bytes inline, via header or ?token=', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/documents/${docId}/download`,
      headers: auth(a.adminToken),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toContain('inline; filename="Shop drawing GR-01.pdf"');
    expect(Buffer.compare(res.rawPayload, bytes)).toBe(0);

    const viaQuery = await app.inject({
      method: 'GET',
      url: `/documents/${docId}/download?token=${a.adminToken}`,
    });
    expect(viaQuery.statusCode).toBe(200);
    expect(viaQuery.rawPayload.length).toBe(bytes.length);

    const none = await app.inject({ method: 'GET', url: `/documents/${docId}/download` });
    expect(none.statusCode).toBe(401);
    const bad = await app.inject({
      method: 'GET',
      url: `/documents/${docId}/download?token=${'x'.repeat(40)}`,
    });
    expect(bad.statusCode).toBe(401);
  });

  it('lists by entity including linked documents, and supports link/unlink', async () => {
    const link = await app.inject({
      method: 'POST',
      url: `/documents/${docId}/links`,
      headers: auth(a.adminToken),
      payload: { entityType: 'spec', entityId: specId },
    });
    expect(link.statusCode).toBe(200);
    expect(link.json().links).toEqual([{ entityType: 'spec', entityId: specId }]);

    const bySpec = await app.inject({
      method: 'GET',
      url: `/documents?entityType=spec&entityId=${specId}`,
      headers: auth(a.adminToken),
    });
    expect(bySpec.json()).toMatchObject({ total: 1, limit: 50, offset: 0 });
    expect(bySpec.json().items[0].id).toBe(docId);

    const unlink = await app.inject({
      method: 'DELETE',
      url: `/documents/${docId}/links?entityType=spec&entityId=${specId}`,
      headers: auth(a.adminToken),
    });
    expect(unlink.json().links).toEqual([]);
    const after = await app.inject({
      method: 'GET',
      url: `/documents?entityType=spec&entityId=${specId}`,
      headers: auth(a.adminToken),
    });
    expect(after.json().total).toBe(0);
  });

  it('patches metadata and soft-deletes', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/documents/${docId}`,
      headers: auth(a.adminToken),
      payload: { filename: 'GR-01 shop drawing rev A.pdf', kind: 'line_drawing' },
    });
    expect(res.json()).toMatchObject({ filename: 'GR-01 shop drawing rev A.pdf', kind: 'line_drawing' });
    const needOrg = await app.inject({
      method: 'PATCH',
      url: `/documents/${docId}`,
      headers: auth(a.adminToken),
      payload: { visibility: 'vendor' },
    });
    expect(needOrg.statusCode).toBe(400);

    const tmp = await upload(a.adminToken, { entityType: 'purchase_order', entityId: poId });
    const del = await app.inject({
      method: 'DELETE',
      url: `/documents/${tmp.json().id}`,
      headers: auth(a.adminToken),
    });
    expect(del.statusCode).toBe(204);
    const gone = await app.inject({
      method: 'GET',
      url: `/documents/${tmp.json().id}`,
      headers: auth(a.adminToken),
    });
    expect(gone.statusCode).toBe(404);
  });

  it('validates uploads', async () => {
    const exe = await upload(
      a.adminToken,
      {},
      { filename: 'x.exe', contentType: 'application/x-msdownload', bytes: Buffer.from('MZ') },
    );
    expect(exe.statusCode).toBe(400);
    const badKind = await upload(a.adminToken, { kind: 'nonsense' });
    expect(badKind.statusCode).toBe(400);
    const dwg = await upload(
      a.adminToken,
      {},
      { filename: 'plan.dwg', contentType: 'application/octet-stream', bytes: Buffer.from('AC1032') },
    );
    expect(dwg.statusCode).toBe(201);
    expect(dwg.json().contentType).toBe('image/vnd.dwg');
    const viewer = await upload(await a.tokenAs(['viewer']), {});
    expect(viewer.statusCode).toBe(403);
  });

  it('serves image thumbnails and 404s for PDFs', async () => {
    const img = await upload(
      a.adminToken,
      { kind: 'photo' },
      { filename: 'photo.png', contentType: 'image/png', bytes: PNG },
    );
    const thumb = await app.inject({
      method: 'GET',
      url: `/documents/${img.json().id}/thumbnail?token=${a.adminToken}`,
    });
    expect(thumb.statusCode).toBe(200);
    expect(thumb.headers['content-type']).toBe('image/png');
    const pdfThumb = await app.inject({
      method: 'GET',
      url: `/documents/${docId}/thumbnail`,
      headers: auth(a.adminToken),
    });
    expect(pdfThumb.statusCode).toBe(404);
  });

  it('isolates tenants', async () => {
    const get = await app.inject({ method: 'GET', url: `/documents/${docId}`, headers: auth(b.adminToken) });
    expect(get.statusCode).toBe(404);
    const dl = await app.inject({ method: 'GET', url: `/documents/${docId}/download?token=${b.adminToken}` });
    expect(dl.statusCode).toBe(404);
    const list = await app.inject({
      method: 'GET',
      url: `/documents?entityType=purchase_order&entityId=${poId}`,
      headers: auth(b.adminToken),
    });
    expect(list.json().total).toBe(0);
    const patch = await app.inject({
      method: 'PATCH',
      url: `/documents/${docId}`,
      headers: auth(b.adminToken),
      payload: { filename: 'pwned.pdf' },
    });
    expect(patch.statusCode).toBe(404);
    const internalWrong = await app.inject({
      method: 'GET',
      url: `/internal/documents/${docId}/content?tenantId=${b.tenantId}`,
      headers: internal,
    });
    expect(internalWrong.statusCode).toBe(404);
  });
});

describe('external actors', () => {
  const entityId = crypto.randomUUID();
  let vendorDoc: string;
  let clientDoc: string;
  let internalDoc: string;
  let otherVendorDoc: string;

  beforeAll(async () => {
    internalDoc = (await upload(a.adminToken, { entityType: 'purchase_order', entityId })).json().id;
    vendorDoc = (
      await upload(a.adminToken, {
        entityType: 'purchase_order',
        entityId,
        visibility: 'vendor',
        vendorOrgId: a.vendorOrgId,
      })
    ).json().id;
    otherVendorDoc = (
      await upload(a.adminToken, {
        entityType: 'purchase_order',
        entityId,
        visibility: 'vendor',
        vendorOrgId: crypto.randomUUID(),
      })
    ).json().id;
    clientDoc = (
      await upload(a.adminToken, {
        entityType: 'purchase_order',
        entityId,
        visibility: 'client',
        clientOrgId: a.clientOrgId,
      })
    ).json().id;
  });

  const listAs = async (token: string) =>
    (
      await app.inject({
        method: 'GET',
        url: `/documents?entityType=purchase_order&entityId=${entityId}`,
        headers: auth(token),
      })
    ).json();

  it('vendor sees only vendor-visible documents addressed to its org', async () => {
    const list = await listAs(a.vendorToken);
    expect(list.items.map((d: any) => d.id)).toEqual([vendorDoc]);
    for (const id of [internalDoc, clientDoc, otherVendorDoc]) {
      const r = await app.inject({
        method: 'GET',
        url: `/documents/${id}/download`,
        headers: auth(a.vendorToken),
      });
      expect(r.statusCode).toBe(404);
    }
    const ok = await app.inject({
      method: 'GET',
      url: `/documents/${vendorDoc}/download?token=${a.vendorToken}`,
    });
    expect(ok.statusCode).toBe(200);
    // Bravo's vendor (different tenant + org) sees nothing.
    expect((await listAs(b.vendorToken)).total).toBe(0);
  });

  it('client sees only client-visible documents of its org', async () => {
    const list = await listAs(a.clientToken);
    expect(list.items.map((d: any) => d.id)).toEqual([clientDoc]);
    expect((await listAs(b.clientToken)).total).toBe(0);
  });

  it('vendor uploads are pinned to its own org and vendor visibility', async () => {
    const own = await upload(a.vendorToken, { entityType: 'purchase_order', entityId, kind: 'shop_drawing' });
    expect(own.statusCode).toBe(201);
    expect(own.json()).toMatchObject({
      visibility: 'vendor',
      vendorOrgId: a.vendorOrgId,
      includeInSpecBook: false,
    });
    const internalVis = await upload(a.vendorToken, { visibility: 'internal' });
    expect(internalVis.statusCode).toBe(403);
    const otherOrg = await upload(a.vendorToken, { visibility: 'vendor', vendorOrgId: b.vendorOrgId });
    expect(otherOrg.statusCode).toBe(403);
    // Staff see the vendor's upload.
    const staff = await listAs(a.adminToken);
    expect(staff.items.map((d: any) => d.id)).toContain(own.json().id);
  });

  it('client uploads are pinned to its own org; neither can edit or delete', async () => {
    const own = await upload(
      a.clientToken,
      { entityType: 'purchase_order', entityId, kind: 'photo' },
      {
        filename: 'damage.png',
        contentType: 'image/png',
        bytes: PNG,
      },
    );
    expect(own.statusCode).toBe(201);
    expect(own.json()).toMatchObject({ visibility: 'client', clientOrgId: a.clientOrgId });
    const vendorVis = await upload(a.clientToken, { visibility: 'vendor', vendorOrgId: a.vendorOrgId });
    expect(vendorVis.statusCode).toBe(403);

    for (const token of [a.clientToken, a.vendorToken]) {
      const patch = await app.inject({
        method: 'PATCH',
        url: `/documents/${own.json().id}`,
        headers: auth(token),
        payload: { visibility: 'internal' },
      });
      expect(patch.statusCode).toBe(403);
      const del = await app.inject({
        method: 'DELETE',
        url: `/documents/${own.json().id}`,
        headers: auth(token),
      });
      expect(del.statusCode).toBe(403);
    }
  });

  it('external actors cannot render reports', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/reports/render',
      headers: auth(a.vendorToken),
      payload: { template: 'claim', data: SAMPLES.claim, filename: 'claim' },
    });
    expect(r.statusCode).toBe(403);
  });
});

describe('global documents', () => {
  it('are visible to every authenticated actor of every tenant, read-only for tenants', async () => {
    const bytes = await samplePdf(1, 'Brand standard');
    const created = await app.inject({
      method: 'POST',
      url: '/internal/documents',
      headers: internal,
      payload: {
        tenantId: null,
        filename: 'Hampton FY Prototype.pdf',
        contentType: 'application/pdf',
        base64: bytes.toString('base64'),
        kind: 'spec_sheet',
        entityType: 'brand_standard',
        entityId: crypto.randomUUID(),
      },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;
    expect(created.json()).toMatchObject({ global: true, pageCount: 1 });
    for (const token of [a.adminToken, b.adminToken, a.vendorToken, b.clientToken]) {
      const r = await app.inject({ method: 'GET', url: `/documents/${id}/download`, headers: auth(token) });
      expect(r.statusCode).toBe(200);
    }
    const patch = await app.inject({
      method: 'PATCH',
      url: `/documents/${id}`,
      headers: auth(a.adminToken),
      payload: { filename: 'mine.pdf' },
    });
    expect(patch.statusCode).toBe(403);
  });
});

describe('internal contract', () => {
  it('creates, lists and returns content for a tenant', async () => {
    const entityId = crypto.randomUUID();
    const created = await app.inject({
      method: 'POST',
      url: '/internal/documents',
      headers: internal,
      payload: {
        tenantId: a.tenantId,
        filename: 'vendor-quote.txt',
        contentType: 'text/plain',
        base64: Buffer.from('hello').toString('base64'),
        entityType: 'cost_request',
        entityId,
        kind: 'email_attachment',
        visibility: 'internal',
        uploadedByName: 'Inbound email',
      },
    });
    expect(created.statusCode).toBe(201);
    const list = await app.inject({
      method: 'GET',
      url: `/internal/documents?tenantId=${a.tenantId}&entityType=cost_request&entityId=${entityId}`,
      headers: internal,
    });
    expect(list.json().map((d: any) => d.id)).toEqual([created.json().id]);
    const content = await app.inject({
      method: 'GET',
      url: `/internal/documents/${created.json().id}/content?tenantId=${a.tenantId}`,
      headers: internal,
    });
    expect(Buffer.from(content.json().base64, 'base64').toString()).toBe('hello');
    const noSecret = await app.inject({
      method: 'GET',
      url: `/internal/documents?tenantId=${a.tenantId}&kind=report`,
    });
    expect(noSecret.statusCode).toBe(403);
  });
});

describe('report rendering', () => {
  const templates = Object.keys(SAMPLES) as (keyof typeof SAMPLES)[];

  it.each(templates)('renders %s to a valid PDF and stores it', async (template) => {
    const entityId = crypto.randomUUID();
    const res = await app.inject({
      method: 'POST',
      url: '/internal/reports/render',
      headers: internal,
      payload: {
        tenantId: a.tenantId,
        template,
        data: SAMPLES[template],
        filename: `${template}-sample`,
        entityType: 'project',
        entityId,
        visibility: 'internal',
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const doc = res.json();
    expect(doc).toMatchObject({
      kind: 'report',
      template,
      contentType: 'application/pdf',
      filename: `${template}-sample.pdf`,
    });
    expect(doc.pageCount).toBeGreaterThan(0);
    const dl = await app.inject({
      method: 'GET',
      url: `/documents/${doc.id}/download`,
      headers: auth(a.adminToken),
    });
    expect(dl.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    expect(await pageCount(dl.rawPayload)).toBe(doc.pageCount);
  });

  it('po_revision requires changes and returns field-level errors', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/reports/render',
      headers: auth(a.adminToken),
      payload: { template: 'po_revision', data: { ...SAMPLES.po_revision, changes: [] }, filename: 'rev' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'data.changes' })]),
    );
    const missing = await app.inject({
      method: 'POST',
      url: '/reports/render',
      headers: auth(a.adminToken),
      payload: { template: 'quote', data: { tenant: { name: 'X' } }, filename: 'q' },
    });
    expect(missing.statusCode).toBe(400);
  });

  it('po_revision output contains the change highlights', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/reports/render',
      headers: auth(a.adminToken),
      payload: {
        template: 'po_revision',
        data: SAMPLES.po_revision,
        filename: 'PO-26-0042 rev 1',
        visibility: 'vendor',
        vendorOrgId: a.vendorOrgId,
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().visibility).toBe('vendor');
    // The vendor can fetch the revision it was sent.
    const dl = await app.inject({
      method: 'GET',
      url: `/documents/${res.json().id}/download`,
      headers: auth(a.vendorToken),
    });
    expect(dl.statusCode).toBe(200);
    expect(await pageCount(dl.rawPayload)).toBeGreaterThan(0);
  });

  it('spec_book merges attached PDFs and images in order', async () => {
    const pdf3 = await upload(
      a.adminToken,
      { kind: 'spec_sheet' },
      {
        filename: 'GR-01 spec.pdf',
        contentType: 'application/pdf',
        bytes: await samplePdf(3, 'GR-01 spec sheet'),
      },
    );
    const pdf2 = await upload(
      a.adminToken,
      { kind: 'line_drawing' },
      {
        filename: 'GR-01 drawing.pdf',
        contentType: 'application/pdf',
        bytes: await samplePdf(2, 'GR-01 drawing'),
      },
    );
    const img = await upload(
      a.adminToken,
      { kind: 'image' },
      { filename: 'finish.png', contentType: 'image/png', bytes: PNG },
    );
    const otherTenant = await upload(
      b.adminToken,
      {},
      {
        filename: 'secret.pdf',
        contentType: 'application/pdf',
        bytes: await samplePdf(4),
      },
    );

    const render = (ids: string[][]) =>
      app.inject({
        method: 'POST',
        url: '/reports/render',
        headers: auth(a.adminToken),
        payload: { template: 'spec_book', data: specBook(ids), filename: 'Spec book' },
      });

    const plain = await render([]);
    expect(plain.statusCode, plain.body).toBe(201);
    const basePages = plain.json().pageCount;
    // cover + contents + one page per spec
    expect(basePages).toBe(5);

    const merged = await render([[pdf3.json().id, pdf2.json().id], [img.json().id], [otherTenant.json().id]]);
    expect(merged.statusCode, merged.body).toBe(201);
    // +3 +2 pages for GR-01, +1 image page for GR-02; tenant B's file is not visible → not merged.
    expect(merged.json().pageCount).toBe(basePages + 6);

    const dl = await app.inject({
      method: 'GET',
      url: `/documents/${merged.json().id}/download`,
      headers: auth(a.adminToken),
    });
    expect(await pageCount(dl.rawPayload)).toBe(basePages + 6);
  });

  it('render requires the template’s read permission', async () => {
    const token = await tokenFor({
      userId: a.adminId,
      orgId: a.tenantId,
      tenantId: a.tenantId,
      roles: ['designer'],
    });
    const r = await app.inject({
      method: 'POST',
      url: '/reports/render',
      headers: auth(token),
      payload: { template: 'invoice', data: SAMPLES.invoice, filename: 'inv' },
    });
    expect(r.statusCode).toBe(403);
  });
});
