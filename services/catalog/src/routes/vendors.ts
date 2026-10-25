import { page } from '@procure/domain';
import {
  ActivityEntry,
  type App,
  conflict,
  forbidden,
  listActivity,
  must,
  notFound,
  type Tx,
  z,
} from '@procure/platform';
import { catalogTx, contributorTenant, isCurator, requireDirectoryRead } from '../access.js';
import { countOf, like, productSelect, upsertProfile, vendorColumns, withProfiles } from '../repo.js';
import {
  IdParams,
  Product,
  ProductListQuery,
  Vendor,
  VendorInput,
  VendorListQuery,
  VendorProfile,
  VendorProfileInput,
  VendorSelf,
  VendorSelfPatch,
  VendorSuggestion,
} from '../schemas.js';

/** Trigram similarity above which a new vendor is considered a likely duplicate. */
export const DUPLICATE_THRESHOLD = 0.6;

/** Strip legal suffixes / punctuation so "Acme Furniture, Inc." and "ACME Furniture" compare equal. */
export const normalizeVendorName = (name: string) =>
  name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[.,'"()]/g, ' ')
    .replace(/\b(inc|llc|ltd|co|corp|corporation|company|limited|gmbh|sa|srl)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export async function similarVendors(tx: Tx, name: string) {
  const n = normalizeVendorName(name);
  return tx<{ id: string; name: string; similarity: number }[]>`
    select id, name, round(greatest(similarity(lower(name), ${n}), similarity(name, ${name}))::numeric, 3) as similarity
    from catalog.vendors
    where lower(name) % ${n} or name % ${name} or lower(name) = lower(${name})
    order by 3 desc
    limit 5`;
}

const domainOf = (website: string | null | undefined) => {
  if (!website) return null;
  try {
    const u = new URL(website.includes('://') ? website : `https://${website}`);
    return u.hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
};

async function loadVendor(tx: Tx, id: string) {
  const [v] = await tx<any[]>`
    select ${vendorColumns(tx)},
           (select count(*)::int from catalog.products p where p.vendor_id = v.id) as product_count
    from catalog.vendors v where v.id = ${id}`;
  if (!v) return undefined;
  const [withP] = await withProfiles(tx, [v]);
  return withP;
}

export async function vendorRoutes(app: App) {
  app.get(
    '/vendors',
    {
      schema: {
        tags: ['vendors'],
        summary: 'Search the network vendor directory, merged with your firm’s private profile',
        querystring: VendorListQuery,
        response: { 200: page(Vendor) },
      },
    },
    async (req) => {
      requireDirectoryRead(req.principal);
      const { q, category, preferred, onlyMine, limit, offset } = req.query;
      return req.tx(async (tx) => {
        const mineOnly = onlyMine || preferred !== undefined;
        const where = tx`
          where true
            ${q ? tx`and (v.name ilike ${like(q)} or v.name % ${q} or ${q.toLowerCase()} = any(v.email_domains))` : tx``}
            ${category ? tx`and ${category} = any(v.categories)` : tx``}
            ${mineOnly ? tx`and p.id is not null` : tx``}
            ${preferred !== undefined ? tx`and p.preferred = ${preferred}` : tx``}`;
        const from = tx`
          from catalog.vendors v
          left join catalog.vendor_profiles p on p.vendor_id = v.id and p.tenant_id = ${req.principal.tenantId}`;
        const total = countOf(
          await tx<{ total: number }[]>`
          select count(*)::int as total ${from} ${where}`,
        );
        const rows = await tx<any[]>`
          select ${vendorColumns(tx)},
                 (select count(*)::int from catalog.products pr where pr.vendor_id = v.id) as product_count
          ${from} ${where}
          order by ${q ? tx`similarity(v.name, ${q}) desc,` : tx``} (p.preferred is true) desc, (p.id is not null) desc, v.name
          limit ${limit} offset ${offset}`;
        return { items: await withProfiles(tx, rows), total, limit, offset };
      });
    },
  );

  app.get(
    '/vendors/:id',
    {
      schema: {
        tags: ['vendors'],
        summary: 'Get a vendor: network data, your private profile and product count',
        params: IdParams,
        response: { 200: Vendor },
      },
    },
    async (req) => {
      requireDirectoryRead(req.principal);
      return req.tx(async (tx) => must(await loadVendor(tx, req.params.id), 'Vendor'));
    },
  );

  app.post(
    '/vendors',
    {
      schema: {
        tags: ['vendors'],
        summary:
          'Add a vendor to the network directory and create your private profile (409 with suggestions on a likely duplicate)',
        body: VendorInput,
        response: { 201: Vendor },
      },
    },
    async (req, reply) => {
      const p = req.principal;
      if (!p.isInternal && p.actor !== 'platform') throw forbidden('Internal users only');
      p.require('vendors:write');
      const b = req.body;
      const vendor = await catalogTx(req, async (tx) => {
        if (!b.force) {
          const similar = (await similarVendors(tx, b.name)).filter(
            (s) => s.similarity > DUPLICATE_THRESHOLD,
          );
          if (similar.length)
            throw conflict('A vendor with a similar name already exists in the network', {
              suggestions: z.array(VendorSuggestion).parse(similar),
            });
        }
        if (b.orgId) {
          const [taken] = await tx<
            { id: string }[]
          >`select id from catalog.vendors where org_id = ${b.orgId}`;
          if (taken)
            throw conflict('That vendor organization is already linked to a network vendor', {
              vendorId: taken.id,
            });
        }
        const domain = domainOf(b.website);
        const domains = [...new Set([...(b.emailDomains ?? []), ...(domain ? [domain] : [])])];
        const id = crypto.randomUUID();
        await tx`
          insert into catalog.vendors ${tx({
            id,
            org_id: b.orgId ?? null,
            name: b.name,
            website: b.website ?? null,
            email_domains: domains,
            categories: b.categories ?? [],
            hq_city: b.hqCity ?? null,
            hq_region: b.hqRegion ?? null,
            hq_country: b.hqCountry ?? null,
            description: b.description ?? null,
            verified: isCurator(p),
            created_by_tenant_id: isCurator(p) ? null : contributorTenant(p),
          } as never)}`;
        if (p.actor !== 'platform') await upsertProfile(tx, p.tenantId, id, b.profile ?? {});
        await req.emit(tx, 'catalog.vendor.created', { vendorId: id, name: b.name, orgId: b.orgId ?? null });
        return must(await loadVendor(tx, id), 'Vendor');
      });
      return reply.status(201).send(vendor);
    },
  );

  app.put(
    '/vendors/:id/profile',
    {
      schema: {
        tags: ['vendors'],
        summary:
          'Create or update your firm’s private relationship with a vendor (terms, lead time, contacts)',
        params: IdParams,
        body: VendorProfileInput,
        response: { 200: VendorProfile },
      },
    },
    async (req) => {
      const p = req.principal;
      if (!p.isInternal) throw forbidden('Internal users only');
      p.require('vendors:write');
      return req.tx(async (tx) => {
        const [v] = await tx<{ id: string }[]>`select id from catalog.vendors where id = ${req.params.id}`;
        if (!v) throw notFound('Vendor');
        return upsertProfile(tx, p.tenantId, v.id, req.body);
      });
    },
  );

  app.get(
    '/vendors/:id/activity',
    {
      schema: {
        tags: ['vendors'],
        summary: 'Field-level history of the vendor record, your private profile and its products',
        params: IdParams,
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }),
        response: { 200: z.array(ActivityEntry) },
      },
    },
    async (req) => {
      requireDirectoryRead(req.principal);
      return req.tx(async (tx) => {
        must(await loadVendor(tx, req.params.id), 'Vendor');
        return listActivity(tx, 'vendor', req.params.id, { includeChildren: true, limit: req.query.limit });
      });
    },
  );

  app.get(
    '/vendors/:id/products',
    {
      schema: {
        tags: ['vendors'],
        summary: 'Products offered by a vendor',
        params: IdParams,
        querystring: ProductListQuery.omit({ vendorId: true }),
        response: { 200: page(Product) },
      },
    },
    async (req) => {
      requireDirectoryRead(req.principal, 'catalog:read');
      const { q, category, status, limit, offset } = req.query;
      return req.tx(async (tx) => {
        const where = tx`
          where p.vendor_id = ${req.params.id}
            ${category ? tx`and p.category = ${category}` : tx``}
            ${status ? tx`and p.status = ${status}` : tx``}
            ${q ? tx`and (p.name ilike ${like(q)} or p.sku ilike ${like(q)})` : tx``}`;
        const total = countOf(
          await tx<{ total: number }[]>`
          select count(*)::int as total from catalog.products p ${where}`,
        );
        const items = await tx<
          any[]
        >`${productSelect(tx)} ${where} order by p.name limit ${limit} offset ${offset}`;
        return { items, total, limit, offset };
      });
    },
  );

  // ---------------------------------------------------------------- vendor portal
  app.get(
    '/vendor/profile',
    {
      schema: {
        tags: ['vendor-portal'],
        summary: 'Your company’s network directory listing (vendor portal)',
        response: { 200: VendorSelf },
      },
    },
    async (req) => {
      const p = req.principal;
      if (!p.isVendor) throw forbidden('Vendor users only');
      p.require('vendor:respond');
      return req.tx(async (tx) => {
        const [v] = await tx<
          any[]
        >`select ${vendorColumns(tx)} from catalog.vendors v where v.org_id = ${p.orgId}`;
        return must(v, 'Vendor listing');
      });
    },
  );

  app.patch(
    '/vendor/profile',
    {
      schema: {
        tags: ['vendor-portal'],
        summary: 'Update your company’s public listing: website, description, categories, headquarters',
        body: VendorSelfPatch,
        response: { 200: VendorSelf },
      },
    },
    async (req) => {
      const p = req.principal;
      if (!p.isVendor) throw forbidden('Vendor users only');
      p.require('vendor:respond');
      const b = req.body;
      return req.tx(async (tx) => {
        const sets = Object.fromEntries(
          Object.entries({
            website: b.website,
            description: b.description,
            categories: b.categories,
            hq_city: b.hqCity,
            hq_region: b.hqRegion,
            hq_country: b.hqCountry,
          }).filter(([, v]) => v !== undefined),
        );
        const [v] = Object.keys(sets).length
          ? await tx<any[]>`update catalog.vendors v set ${tx(sets as never)} where v.org_id = ${p.orgId}
                            returning ${vendorColumns(tx)}`
          : await tx<any[]>`select ${vendorColumns(tx)} from catalog.vendors v where v.org_id = ${p.orgId}`;
        return must(v, 'Vendor listing');
      });
    },
  );
}
