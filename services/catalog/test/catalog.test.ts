import { buildService, closeDb, internalSecret, withContext, withOwner } from '@procure/platform';
import { auth, createWorld, tokenFor, type World } from '@procure/platform/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { catalogService } from '../src/service.js';

let app: Awaited<ReturnType<typeof buildService>>;
let a: World;
let b: World;
let curatorToken: string;
const internal = { 'x-procure-internal': internalSecret() };
const sfx = crypto.randomUUID().slice(0, 6);

beforeAll(async () => {
  app = await buildService(catalogService);
  a = await createWorld('Alpha');
  b = await createWorld('Bravo');
  curatorToken = await tokenFor({
    userId: crypto.randomUUID(),
    orgId: crypto.randomUUID(),
    tenantId: crypto.randomUUID(),
    actor: 'platform',
    roles: ['catalog_curator'],
    name: 'Cat Curator',
  });
});
afterAll(async () => {
  await app.close();
  await closeDb();
});

const post = (url: string, token: string, payload: unknown) =>
  app.inject({ method: 'POST', url, headers: auth(token), payload: payload as never });
const get = (url: string, token: string) => app.inject({ method: 'GET', url, headers: auth(token) });

async function brand(name = `Hampton by Hilton ${sfx}`) {
  const res = await post('/brands', a.adminToken, {
    name,
    parentCompany: 'Hilton',
    segment: 'focused service',
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

describe('brands & brand standards', () => {
  let brandId: string;
  let standardId: string;

  it('creates a brand and rejects a duplicate name', async () => {
    const br = await brand();
    brandId = br.id;
    const dupe = await post('/brands', b.adminToken, { name: br.name.toUpperCase() });
    expect(dupe.statusCode).toBe(409);
    const list = await get(`/brands?q=${encodeURIComponent('Hampton')}`, b.adminToken);
    expect(list.json().map((x: any) => x.id)).toContain(brandId);
  });

  it('creates a draft standard with items, visible only to the contributing tenant', async () => {
    const res = await post('/brand-standards', a.adminToken, {
      brandId,
      name: 'Hampton Inn Forever Young Prototype – Guestroom FF&E',
      version: '2026.1',
      effectiveDate: '2026-01-01',
      items: [
        {
          code: 'GR-01',
          area: 'Guestroom',
          category: 'casegoods',
          name: 'King Headboard',
          description: 'Upholstered panel headboard, wall mounted',
          dimensions: '80"W x 2"D x 60"H',
          finish: 'Driftwood laminate',
          approvedVendors: [{ name: 'Acme Casegoods', model: 'HB-80' }],
          quantityBasis: '1 per king room',
        },
        {
          code: 'GR-02',
          area: 'Guestroom',
          category: 'lighting',
          name: 'Nightstand Lamp',
          description: 'Ceramic table lamp with USB',
        },
        { code: 'PL-01', area: 'Public – Lobby', category: 'soft_seating', name: 'Lobby Lounge Chair' },
      ],
    });
    expect(res.statusCode).toBe(201);
    const s = res.json();
    standardId = s.id;
    expect(s).toMatchObject({ status: 'draft', mine: true, itemCount: 3, contributedByTenantId: a.tenantId });
    expect(s.items).toHaveLength(3);

    const bGet = await get(`/brand-standards/${standardId}`, b.adminToken);
    expect(bGet.statusCode).toBe(404);
    const bList = await get(`/brand-standards?brandId=${brandId}`, b.adminToken);
    expect(bList.json().total).toBe(0);
    const aList = await get(`/brand-standards?brandId=${brandId}`, a.adminToken);
    expect(aList.json()).toMatchObject({ total: 1, limit: 50, offset: 0 });
    expect(aList.json().items[0].itemCount).toBe(3);
  });

  it('filters items, lists areas and upserts by code', async () => {
    const areas = await get(`/brand-standards/${standardId}/areas`, a.adminToken);
    expect(areas.json()).toEqual(
      expect.arrayContaining([
        { area: 'Guestroom', count: 2 },
        { area: 'Public – Lobby', count: 1 },
      ]),
    );
    const lighting = await get(`/brand-standards/${standardId}?category=lighting`, a.adminToken);
    expect(lighting.json().items.map((i: any) => i.code)).toEqual(['GR-02']);
    const text = await get(`/brand-standards/${standardId}?q=headboard`, a.adminToken);
    expect(text.json().items.map((i: any) => i.code)).toEqual(['GR-01']);

    const up = await post(`/brand-standards/${standardId}/items`, a.adminToken, {
      items: [
        { code: 'GR-02', area: 'Guestroom', category: 'lighting', name: 'Nightstand Lamp (rev)' },
        { code: 'GR-03', area: 'Guestroom', category: 'mirrors', name: 'Vanity Mirror' },
      ],
    });
    expect(up.statusCode).toBe(200);
    expect(up.json()).toMatchObject({ created: 1, updated: 1 });

    const dup = await post(`/brand-standards/${standardId}/items`, a.adminToken, {
      items: [
        { code: 'X', name: 'a' },
        { code: 'X', name: 'b' },
      ],
    });
    expect(dup.statusCode).toBe(400);

    const item = up.json().items.find((i: any) => i.code === 'GR-03');
    const patch = await app.inject({
      method: 'PATCH',
      url: `/brand-standards/${standardId}/items/${item.id}`,
      headers: auth(a.adminToken),
      payload: { finish: 'Polished edge' },
    });
    expect(patch.json().finish).toBe('Polished edge');

    // Tenant B cannot edit A's draft.
    const bPatch = await app.inject({
      method: 'PATCH',
      url: `/brand-standards/${standardId}/items/${item.id}`,
      headers: auth(b.adminToken),
      payload: { finish: 'hacked' },
    });
    expect(bPatch.statusCode).toBe(404);

    const del = await app.inject({
      method: 'DELETE',
      url: `/brand-standards/${standardId}/items/${item.id}`,
      headers: auth(a.adminToken),
    });
    expect(del.statusCode).toBe(204);
  });

  it('only a curator can publish; once published every tenant sees it', async () => {
    const sub = await post(`/brand-standards/${standardId}/submit`, a.adminToken, {});
    expect(sub.statusCode).toBe(200);
    expect(sub.json().status).toBe('submitted');

    // Tenant admin holds catalog:curate for its own tenant but is not a platform curator.
    const notCurator = await post(`/brand-standards/${standardId}/publish`, a.adminToken, {});
    expect(notCurator.statusCode).toBe(403);
    const designer = await post(`/brand-standards/${standardId}/publish`, await a.tokenAs(['designer']), {});
    expect(designer.statusCode).toBe(403);

    const curatorList = await get('/brand-standards?status=submitted', curatorToken);
    expect(curatorList.json().items.map((s: any) => s.id)).toContain(standardId);

    const pub = await post(`/brand-standards/${standardId}/publish`, curatorToken, {});
    expect(pub.statusCode).toBe(200);
    expect(pub.json().status).toBe('published');

    const bGet = await get(`/brand-standards/${standardId}`, b.adminToken);
    expect(bGet.statusCode).toBe(200);
    expect(bGet.json().mine).toBe(false);
    expect(bGet.json().items.length).toBe(3);

    // Contributor can no longer change published shared intelligence.
    const late = await post(`/brand-standards/${standardId}/items`, a.adminToken, {
      items: [{ code: 'GR-09', name: 'Late add' }],
    });
    expect(late.statusCode).toBe(409);

    const events = await withOwner(
      (tx) => tx`select type, data from platform.outbox where type like 'catalog.brand_standard.%'
                 and data ->> 'standardId' = ${standardId}`,
    );
    expect(events.map((e: any) => e.type).sort()).toEqual([
      'catalog.brand_standard.published',
      'catalog.brand_standard.submitted',
    ]);
  });

  it('vendor and client actors can read published standards', async () => {
    const v = await get(`/brand-standards/${standardId}`, a.vendorToken);
    expect(v.statusCode).toBe(200);
    const c = await get(`/brands/${brandId}`, b.clientToken);
    expect(c.json().standards.map((s: any) => s.id)).toContain(standardId);
  });

  it('serves the internal brand-standard contract', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/internal/brand-standards/${standardId}`,
      headers: internal,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: standardId, brandId, brandName: expect.any(String) });
    expect(res.json().items.length).toBe(3);
    const noSecret = await app.inject({ method: 'GET', url: `/internal/brand-standards/${standardId}` });
    expect(noSecret.statusCode).toBe(403);
  });

  it('links approved vendors named in imported items to network vendors', async () => {
    const vname2 = `Riverside Millwork ${sfx}`;
    const v = await post('/vendors', a.adminToken, { name: vname2 });
    expect(v.statusCode).toBe(201);
    const draft = await post('/brand-standards', a.adminToken, {
      brandId,
      name: 'Linking test',
      version: '1',
    });
    const res = await app.inject({
      method: 'POST',
      url: `/internal/brand-standards/${draft.json().id}/items?tenantId=${a.tenantId}`,
      headers: internal,
      payload: {
        items: [
          {
            code: 'MW-01',
            name: 'Reception desk',
            area: 'Lobby',
            approvedVendors: [
              { name: `${vname2}, Inc.`, model: null },
              { name: 'Totally Unknown Fabricators' },
            ],
          },
        ],
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    const [linked, unknown] = res.json().items[0].approvedVendors;
    expect(linked).toMatchObject({ vendorId: v.json().id, name: `${vname2}, Inc.` });
    expect(linked).not.toHaveProperty('model');
    expect(unknown.vendorId).toBeUndefined();
  });

  it('search honours limit', async () => {
    const one = await get('/search?q=lobby&limit=1', a.adminToken);
    expect(one.statusCode).toBe(200);
    expect(one.json().brandStandardItems.length).toBeLessThanOrEqual(1);
  });

  it('internal item import works on a tenant draft', async () => {
    const draft = await post('/brand-standards', b.adminToken, {
      brandId,
      name: 'Bravo Public Space',
      version: '1',
    });
    const res = await app.inject({
      method: 'POST',
      url: `/internal/brand-standards/${draft.json().id}/items?tenantId=${b.tenantId}`,
      headers: internal,
      payload: { items: [{ code: 'PS-01', name: 'Lobby Sofa', category: 'soft_seating', area: 'Lobby' }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().created).toBe(1);
    const wrongTenant = await app.inject({
      method: 'POST',
      url: `/internal/brand-standards/${draft.json().id}/items?tenantId=${a.tenantId}`,
      headers: internal,
      payload: { items: [{ code: 'PS-02', name: 'x' }] },
    });
    expect(wrongTenant.statusCode).toBe(404);
  });
});

describe('vendors', () => {
  let vendorId: string;
  const vname = `Lakeshore Casegoods ${sfx}`;

  it('creates a network vendor with my private profile', async () => {
    const res = await post('/vendors', a.adminToken, {
      name: vname,
      website: 'https://www.lakeshore-cg.example',
      categories: ['casegoods', 'millwork'],
      hqCity: 'Grand Rapids',
      hqRegion: 'MI',
      hqCountry: 'US',
      orgId: a.vendorOrgId,
      profile: {
        paymentTerms: '50% deposit, balance net 30',
        depositPct: 50,
        leadTimeWeeks: 14,
        shipMethod: 'LTL',
        freightTerms: 'FOB origin',
        origin: 'domestic',
        primaryContact: { name: 'Dana Reps', email: 'dana@lakeshore-cg.example', phone: '555-0100' },
        rating: 4.5,
        preferred: true,
        accountNumber: 'JMH-001',
      },
    });
    expect(res.statusCode).toBe(201);
    const v = res.json();
    vendorId = v.id;
    expect(v.emailDomains).toContain('lakeshore-cg.example');
    expect(v.profile).toMatchObject({ leadTimeWeeks: 14, depositPct: 50, preferred: true, rating: 4.5 });
  });

  it('returns 409 with suggestions for a near-duplicate unless forced', async () => {
    const dupe = await post('/vendors', b.adminToken, { name: `Lakeshore Casegoods, Inc. ${sfx}` });
    expect(dupe.statusCode).toBe(409);
    expect(dupe.json().detail.suggestions[0]).toMatchObject({ id: vendorId, name: vname });
    const forced = await post('/vendors', b.adminToken, {
      name: `Lakeshore Casegoods, Inc. ${sfx}`,
      force: true,
    });
    expect(forced.statusCode).toBe(201);
  });

  it("isolates tenant-private profiles: B sees network data but not A's terms", async () => {
    const bView = await get(`/vendors/${vendorId}`, b.adminToken);
    expect(bView.statusCode).toBe(200);
    expect(bView.json().name).toBe(vname);
    expect(bView.json().profile).toBeNull();

    const bMine = await get('/vendors?onlyMine=true', b.adminToken);
    expect(bMine.json().items.map((v: any) => v.id)).not.toContain(vendorId);
    const aMine = await get('/vendors?onlyMine=true', a.adminToken);
    expect(aMine.json().items.map((v: any) => v.id)).toContain(vendorId);
    const aPreferred = await get('/vendors?preferred=true&category=casegoods', a.adminToken);
    expect(aPreferred.json().items[0].profile.preferred).toBe(true);

    // B creates its own profile; A's is unchanged.
    const put = await app.inject({
      method: 'PUT',
      url: `/vendors/${vendorId}/profile`,
      headers: auth(b.adminToken),
      payload: { leadTimeWeeks: 20, paymentTerms: 'Net 45' },
    });
    expect(put.statusCode).toBe(200);
    const aAgain = await get(`/vendors/${vendorId}`, a.adminToken);
    expect(aAgain.json().profile.leadTimeWeeks).toBe(14);

    // Both firms now hold separate private rows for the same network vendor.
    const rows = await withOwner(
      (tx) => tx`select tenant_id from catalog.vendor_profiles where vendor_id = ${vendorId}`,
    );
    expect(rows).toHaveLength(2);
  });

  it("vendor activity shows my firm's profile history but never another firm's private terms", async () => {
    const aAct = await get(`/vendors/${vendorId}/activity`, a.adminToken);
    expect(aAct.statusCode).toBe(200);
    expect(aAct.json().some((e: { entityType: string }) => e.entityType === 'vendor_profile')).toBe(true);
    const bAct = await get(`/vendors/${vendorId}/activity`, b.adminToken);
    expect(bAct.statusCode).toBe(200);
    const leaked = JSON.stringify(bAct.json());
    expect(leaked).not.toContain('JMH-001');
    expect(leaked).not.toContain('dana@lakeshore-cg.example');
  });

  it('serves the internal vendor contract scoped to the tenant', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/internal/vendors/${vendorId}?tenantId=${a.tenantId}`,
      headers: internal,
    });
    expect(res.json()).toMatchObject({
      id: vendorId,
      orgId: a.vendorOrgId,
      profile: {
        leadTimeWeeks: 14,
        paymentTerms: '50% deposit, balance net 30',
        primaryContact: { email: 'dana@lakeshore-cg.example' },
        preferred: true,
        accountNumber: 'JMH-001',
      },
    });
    const byDomain = await app.inject({
      method: 'GET',
      url: `/internal/vendors?tenantId=${a.tenantId}&domain=someone@lakeshore-cg.example`,
      headers: internal,
    });
    expect(byDomain.json().map((v: any) => v.id)).toContain(vendorId);
    const bView = await app.inject({
      method: 'GET',
      url: `/internal/vendors/${vendorId}?tenantId=${b.tenantId}`,
      headers: internal,
    });
    expect(bView.json().profile.leadTimeWeeks).toBe(20);
    expect(bView.json().profile.accountNumber).toBeNull();
  });

  it('requires vendors:write to edit a profile', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/vendors/${vendorId}/profile`,
      headers: auth(await a.tokenAs(['designer'])),
      payload: { leadTimeWeeks: 1 },
    });
    expect(res.statusCode).toBe(403);
  });

  it('vendor actor sees and edits only its own network record', async () => {
    const dir = await get('/vendors', a.vendorToken);
    expect(dir.statusCode).toBe(403);
    const other = await get(`/vendors/${vendorId}`, a.vendorToken);
    expect(other.statusCode).toBe(403);

    const me = await get('/vendor/profile', a.vendorToken);
    expect(me.statusCode).toBe(200);
    expect(me.json().id).toBe(vendorId);
    expect(me.json()).not.toHaveProperty('profile');

    const patch = await app.inject({
      method: 'PATCH',
      url: '/vendor/profile',
      headers: auth(a.vendorToken),
      payload: { description: 'Domestic casegoods since 1962', categories: ['casegoods'], hqCity: 'Holland' },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json()).toMatchObject({ description: 'Domestic casegoods since 1962', hqCity: 'Holland' });
    expect(patch.json()).not.toHaveProperty('profile');

    // B's vendor org has no listing.
    const none = await get('/vendor/profile', b.vendorToken);
    expect(none.statusCode).toBe(404);
    const noneP = await app.inject({
      method: 'PATCH',
      url: '/vendor/profile',
      headers: auth(b.vendorToken),
      payload: { description: 'x' },
    });
    expect(noneP.statusCode).toBe(404);

    // Vendor users never read private profiles, even via the DB.
    const client = await get('/vendor/profile', a.clientToken);
    expect(client.statusCode).toBe(403);
  });

  describe('products & search', () => {
    let productId: string;
    it('creates, updates and lists products', async () => {
      const res = await post('/products', a.adminToken, {
        vendorId,
        sku: 'HB-80',
        name: 'Forever Young King Headboard',
        category: 'casegoods',
        description: 'Upholstered wall-mounted headboard',
        finishes: ['Driftwood'],
        typicalLeadTimeWeeks: 12,
      });
      expect(res.statusCode).toBe(201);
      productId = res.json().id;
      expect(res.json().vendorName).toBe(vname);

      const dupe = await post('/products', a.adminToken, { vendorId, sku: 'HB-80', name: 'x' });
      expect(dupe.statusCode).toBe(409);

      const patch = await app.inject({
        method: 'PATCH',
        url: `/products/${productId}`,
        headers: auth(a.adminToken),
        payload: { typicalLeadTimeWeeks: 10 },
      });
      expect(patch.json().typicalLeadTimeWeeks).toBe(10);

      const list = await get(`/products?vendorId=${vendorId}&q=headboard`, b.adminToken);
      expect(list.json()).toMatchObject({ total: 1 });
      const byVendor = await get(`/vendors/${vendorId}/products`, a.adminToken);
      expect(byVendor.json().total).toBe(1);
      const vendorCount = await get(`/vendors/${vendorId}`, a.adminToken);
      expect(vendorCount.json().productCount).toBe(1);

      const viewer = await post('/products', await a.tokenAs(['viewer']), { vendorId, sku: 'Z', name: 'Z' });
      expect(viewer.statusCode).toBe(403);
    });

    it('global search returns items, products and vendors', async () => {
      const res = await get('/search?q=headboard', a.adminToken);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.brandStandardItems.map((i: any) => i.code)).toContain('GR-01');
      expect(body.products.map((p: any) => p.id)).toContain(productId);

      const v = await get(`/search?q=${encodeURIComponent('Lakeshore')}`, a.adminToken);
      const hit = v.json().vendors.find((x: any) => x.id === vendorId);
      expect(hit.hasProfile).toBe(true);

      const asVendor = await get('/search?q=headboard', a.vendorToken);
      expect(asVendor.json().products).toEqual([]);
      expect(asVendor.json().vendors).toEqual([]);
    });
  });
});

describe('row-level security (app role)', () => {
  it('vendor_profiles are tenant-scoped and hidden from portal actors', async () => {
    const ctx = (w: World, actor: 'internal' | 'vendor' | 'client', orgId: string) => ({
      tenantId: w.tenantId,
      userId: null,
      orgId,
      actor,
    });
    const count = (c: ReturnType<typeof ctx>) =>
      withContext(c, async (tx) => {
        const [r] = await tx<{ n: number }[]>`select count(*)::int as n from catalog.vendor_profiles`;
        return r!.n;
      });
    const aCount = await count(ctx(a, 'internal', a.tenantId));
    expect(aCount).toBeGreaterThan(0);
    const aTenants = await withContext(
      ctx(a, 'internal', a.tenantId),
      (tx) => tx<{ tenantId: string }[]>`select distinct tenant_id from catalog.vendor_profiles`,
    );
    expect(aTenants.map((r) => r.tenantId)).toEqual([a.tenantId]);
    expect(await count(ctx(a, 'vendor', a.vendorOrgId))).toBe(0);
    expect(await count(ctx(a, 'client', a.clientOrgId))).toBe(0);
    await expect(
      withContext(ctx(a, 'internal', a.tenantId), async (tx) => {
        const [v] = await tx<{ id: string }[]>`select id from catalog.vendors limit 1`;
        await tx`insert into catalog.vendor_profiles (tenant_id, vendor_id) values (${b.tenantId}, ${v!.id})`;
      }),
    ).rejects.toThrow(/row-level security/);
  });
});

describe('auth', () => {
  it('rejects unauthenticated requests', async () => {
    const res = await app.inject({ method: 'GET', url: '/brands' });
    expect(res.statusCode).toBe(401);
  });
});
