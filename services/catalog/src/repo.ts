import { type Db, type Tx, withSystem, withTenant } from '@procure/platform';
import type { BrandStandardItemInput } from './schemas.js';

/**
 * Shared SQL for the catalog routes. Every function takes a transaction that already carries the
 * caller's RLS context (req.tx / withTenant), so visibility rules live in the database, not here.
 */

/**
 * Internal routes: tenant-scoped when a tenant is given; otherwise a trusted system context (platform
 * tooling such as the seed script or curator-side imports).
 */
export const internalTx = <T>(tenantId: string | undefined, fn: (tx: Tx) => Promise<T>) =>
  tenantId ? withTenant(tenantId, fn) : withSystem(fn);

/** Builds a prefix tsquery (`hampton:* & king:*`) from free text; null when there is nothing to search. */
export const prefixQuery = (q: string): string | null => {
  const words = q
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 0)
    .slice(0, 8);
  return words.length ? words.map((w) => `${w}:*`).join(' & ') : null;
};

export const countOf = (rows: readonly { total: number }[]) => rows[0]?.total ?? 0;

export const like = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

// ---------------------------------------------------------------------------------------------
// Brand standards
// ---------------------------------------------------------------------------------------------
export const standardSelect = (tx: Db, tenantId: string | null) => tx`
  select s.id, s.brand_id, b.name as brand_name, s.name, s.version, s.effective_date, s.source_document_id,
         s.status, s.contributed_by_tenant_id,
         coalesce(s.contributed_by_tenant_id = ${tenantId}::uuid, false) as mine,
         s.notes, s.created_at, s.updated_at, s.submitted_at, s.published_at,
         (select count(*)::int from catalog.brand_standard_items i where i.standard_id = s.id) as item_count
  from catalog.brand_standards s
  join catalog.brands b on b.id = s.brand_id`;

export async function getStandard(tx: Db, id: string, tenantId: string | null) {
  const [row] = await tx<any[]>`${standardSelect(tx, tenantId)} where s.id = ${id}`;
  return row as any;
}

export async function listItems(
  tx: Db,
  standardId: string,
  f: { area?: string; category?: string; q?: string } = {},
) {
  const tsq = f.q ? prefixQuery(f.q) : null;
  return tx<any[]>`
    select id, standard_id, code, area, category, name, description, dimensions, finish, materials,
           attributes, approved_vendors, quantity_basis, sort, created_at, updated_at
    from catalog.brand_standard_items
    where standard_id = ${standardId}
      ${f.area ? tx`and area = ${f.area}` : tx``}
      ${f.category ? tx`and category = ${f.category}` : tx``}
      ${f.q ? tx`and (${tsq ? tx`search @@ to_tsquery('english', ${tsq}) or` : tx``} name ilike ${like(f.q)} or code ilike ${like(f.q)})` : tx``}
    order by area, sort, code`;
}

/** Insert-or-update items by `code` within a standard. Returns created/updated counts and the rows. */
export async function upsertItems(tx: Db, standardId: string, items: BrandStandardItemInput[]) {
  const codes = new Set<string>();
  for (const it of items) {
    if (codes.has(it.code)) throw Object.assign(new Error(`Duplicate code ${it.code}`), { dupe: it.code });
    codes.add(it.code);
  }
  let created = 0;
  let updated = 0;
  const out: any[] = [];
  let i = 0;
  for (const it of items) {
    const row = {
      standard_id: standardId,
      code: it.code,
      area: it.area ?? 'General',
      category: it.category ?? 'other',
      name: it.name,
      description: it.description ?? null,
      dimensions: it.dimensions ?? null,
      finish: it.finish ?? null,
      materials: it.materials ?? null,
      attributes: tx.json((it.attributes ?? {}) as never),
      approved_vendors: tx.json((it.approvedVendors ?? []) as never),
      quantity_basis: it.quantityBasis ?? null,
      sort: it.sort ?? i,
    };
    i++;
    const [r] = await tx<any[]>`
      insert into catalog.brand_standard_items ${tx(row as never)}
      on conflict (standard_id, code) do update set
        area = excluded.area, category = excluded.category, name = excluded.name,
        description = excluded.description, dimensions = excluded.dimensions, finish = excluded.finish,
        materials = excluded.materials, attributes = excluded.attributes,
        approved_vendors = excluded.approved_vendors, quantity_basis = excluded.quantity_basis,
        sort = excluded.sort
      returning id, standard_id, code, area, category, name, description, dimensions, finish, materials,
                attributes, approved_vendors, quantity_basis, sort, created_at, updated_at,
                (xmax = 0) as inserted`;
    if (!r) continue;
    if (r.inserted) created++;
    else updated++;
    const { inserted, ...item } = r;
    out.push(item);
  }
  return { created, updated, items: out };
}

// ---------------------------------------------------------------------------------------------
// Vendors
// ---------------------------------------------------------------------------------------------
export const vendorColumns = (tx: Db) => tx`
  v.id, v.org_id, v.name, v.website, v.email_domains, v.categories, v.hq_city, v.hq_region, v.hq_country,
  v.description, v.verified, v.created_at, v.updated_at`;

export const profileColumns = (tx: Db) => tx`
  p.id, p.vendor_id, p.account_number, p.payment_terms, p.deposit_pct, p.lead_time_weeks, p.ship_method,
  p.freight_terms, p.origin, p.transit_days, p.primary_contact, p.contacts, p.rating, p.on_time_rate,
  p.preferred, p.notes, p.tags, p.created_at, p.updated_at`;

/** Profiles of the current tenant (RLS) for the given vendors, keyed by vendor id. */
export async function profilesFor(tx: Db, vendorIds: string[]) {
  if (!vendorIds.length) return new Map<string, any>();
  const rows = await tx<any[]>`
    select ${profileColumns(tx)} from catalog.vendor_profiles p where p.vendor_id in ${tx(vendorIds)}`;
  return new Map(rows.map((r) => [r.vendorId as string, r]));
}

export async function withProfiles<T extends { id: string }>(tx: Db, vendors: T[]) {
  const profiles = await profilesFor(
    tx,
    vendors.map((v) => v.id),
  );
  return vendors.map((v) => ({ ...v, profile: profiles.get(v.id) ?? null }));
}

/** Contract shape for other services (docs/service-contracts.md). */
export const toInternalVendor = (v: any) => {
  const p = v.profile;
  const pc = p?.primaryContact;
  return {
    id: v.id,
    name: v.name,
    orgId: v.orgId ?? null,
    website: v.website ?? null,
    categories: v.categories ?? [],
    profile: {
      leadTimeWeeks: p?.leadTimeWeeks ?? null,
      shipMethod: p?.shipMethod ?? null,
      freightTerms: p?.freightTerms ?? null,
      paymentTerms: p?.paymentTerms ?? null,
      depositPct: p?.depositPct ?? null,
      primaryContact: pc ? { name: pc.name ?? null, email: pc.email ?? null, phone: pc.phone ?? null } : null,
      rating: p?.rating ?? null,
      onTimeRate: p?.onTimeRate ?? null,
      preferred: p?.preferred ?? false,
      accountNumber: p?.accountNumber ?? null,
    },
  };
};

/** Column map for vendor profile writes (camelCase API → snake_case columns). */
export const profileRow = (tx: Db, b: Record<string, any>) =>
  Object.fromEntries(
    Object.entries({
      account_number: b.accountNumber,
      payment_terms: b.paymentTerms,
      deposit_pct: b.depositPct,
      lead_time_weeks: b.leadTimeWeeks,
      ship_method: b.shipMethod,
      freight_terms: b.freightTerms,
      origin: b.origin,
      transit_days: b.transitDays,
      primary_contact:
        b.primaryContact === undefined ? undefined : b.primaryContact ? tx.json(b.primaryContact) : null,
      contacts: b.contacts === undefined ? undefined : tx.json(b.contacts),
      rating: b.rating,
      on_time_rate: b.onTimeRate,
      preferred: b.preferred,
      notes: b.notes,
      tags: b.tags,
    }).filter(([, v]) => v !== undefined),
  );

export async function upsertProfile(tx: Db, tenantId: string, vendorId: string, b: Record<string, any>) {
  const sets = profileRow(tx, b);
  const [existing] = await tx<{ id: string }[]>`
    select id from catalog.vendor_profiles where tenant_id = ${tenantId} and vendor_id = ${vendorId}`;
  if (existing) {
    if (Object.keys(sets).length)
      await tx`update catalog.vendor_profiles set ${tx(sets as never)} where id = ${existing.id}`;
  } else {
    await tx`insert into catalog.vendor_profiles ${tx({ tenant_id: tenantId, vendor_id: vendorId, ...sets } as never)}`;
  }
  const [row] = await tx<any[]>`
    select ${profileColumns(tx)} from catalog.vendor_profiles p
    where p.tenant_id = ${tenantId} and p.vendor_id = ${vendorId}`;
  return row;
}

// ---------------------------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------------------------
export const productSelect = (tx: Db) => tx`
  select p.id, p.vendor_id, v.name as vendor_name, p.sku, p.name, p.category, p.description, p.dimensions,
         p.materials, p.finishes, p.image_urls, p.attributes, p.typical_lead_time_weeks,
         p.brand_standard_item_ids, p.status, p.created_at, p.updated_at
  from catalog.products p
  join catalog.vendors v on v.id = p.vendor_id`;

export const productRow = (tx: Db, b: Record<string, any>) =>
  Object.fromEntries(
    Object.entries({
      sku: b.sku,
      name: b.name,
      category: b.category,
      description: b.description,
      dimensions: b.dimensions,
      materials: b.materials,
      finishes: b.finishes,
      image_urls: b.imageUrls,
      attributes: b.attributes === undefined ? undefined : tx.json(b.attributes),
      typical_lead_time_weeks: b.typicalLeadTimeWeeks,
      brand_standard_item_ids: b.brandStandardItemIds,
      status: b.status,
    }).filter(([, v]) => v !== undefined),
  );
