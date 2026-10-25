import { page } from '@procure/domain';
import { type App, badRequest, conflict, forbidden, must, notFound, type Tx, z } from '@procure/platform';
import {
  catalogTx,
  contributorTenant,
  isCurator,
  type Req,
  requireContribute,
  requireCurator,
  requireStandardsRead,
} from '../access.js';
import { countOf, getStandard, like, listItems, standardSelect, upsertItems } from '../repo.js';
import {
  AreaCount,
  BrandStandard,
  BrandStandardDetail,
  BrandStandardDetailQuery,
  BrandStandardInput,
  BrandStandardItem,
  BrandStandardItemPatch,
  BrandStandardListQuery,
  BrandStandardPatch,
  IdParams,
  UpsertItemsBody,
  UpsertItemsResult,
} from '../schemas.js';

const ItemParams = z.object({ id: z.uuid(), itemId: z.uuid() });

/**
 * Load a standard the caller may modify. Contributors edit their own packages while they are draft or
 * submitted; once published only a curator can change shared intelligence.
 */
async function editable(tx: Tx, req: Req, id: string) {
  const s = must(await getStandard(tx, id, req.principal.tenantId), 'Brand standard');
  if (isCurator(req.principal)) return s;
  if (!s.mine) throw forbidden('Only the contributing firm or a curator can edit this brand standard');
  if (!['draft', 'submitted'].includes(s.status))
    throw conflict(`A ${s.status} brand standard can only be changed by a catalog curator`);
  return s;
}

const dupeGuard = async <T>(fn: () => Promise<T>) => {
  try {
    return await fn();
  } catch (err) {
    const dupe = (err as { dupe?: string }).dupe;
    if (dupe) throw badRequest(`Duplicate item code in request: ${dupe}`);
    throw err;
  }
};

export async function brandStandardRoutes(app: App) {
  app.get(
    '/brand-standards',
    {
      schema: {
        tags: ['brand-standards'],
        summary: 'List brand-standard packages: published ones plus drafts contributed by your firm',
        querystring: BrandStandardListQuery,
        response: { 200: page(BrandStandard) },
      },
    },
    async (req) => {
      requireStandardsRead(req.principal);
      const { brandId, status, q, mine, limit, offset } = req.query;
      const tenantId = req.principal.tenantId;
      return catalogTx(req, async (tx) => {
        const where = tx`
          where true
            ${brandId ? tx`and s.brand_id = ${brandId}` : tx``}
            ${status ? tx`and s.status = ${status}` : tx``}
            ${mine ? tx`and s.contributed_by_tenant_id = ${tenantId}` : tx``}
            ${q ? tx`and (s.name ilike ${like(q)} or b.name ilike ${like(q)} or b.parent_company ilike ${like(q)})` : tx``}`;
        const total = countOf(
          await tx<{ total: number }[]>`
          select count(*)::int as total from catalog.brand_standards s
          join catalog.brands b on b.id = s.brand_id ${where}`,
        );
        const items = await tx<any[]>`
          ${standardSelect(tx, tenantId)} ${where}
          order by b.name, (s.status = 'published') desc, s.effective_date desc nulls last, s.name, s.version desc
          limit ${limit} offset ${offset}`;
        return { items, total, limit, offset };
      });
    },
  );

  app.get(
    '/brand-standards/:id',
    {
      schema: {
        tags: ['brand-standards'],
        summary: 'Get a brand-standard package with its items (filter by area, category or text)',
        params: IdParams,
        querystring: BrandStandardDetailQuery,
        response: { 200: BrandStandardDetail },
      },
    },
    async (req) => {
      requireStandardsRead(req.principal);
      return catalogTx(req, async (tx) => {
        const s = must(await getStandard(tx, req.params.id, req.principal.tenantId), 'Brand standard');
        return { ...s, items: await listItems(tx, s.id, req.query) };
      });
    },
  );

  app.get(
    '/brand-standards/:id/areas',
    {
      schema: {
        tags: ['brand-standards'],
        summary: 'Distinct areas in a brand-standard package with item counts',
        params: IdParams,
        response: { 200: z.array(AreaCount) },
      },
    },
    async (req) => {
      requireStandardsRead(req.principal);
      return catalogTx(req, async (tx) => {
        must(await getStandard(tx, req.params.id, req.principal.tenantId), 'Brand standard');
        return tx<any[]>`
          select area, count(*)::int as count from catalog.brand_standard_items
          where standard_id = ${req.params.id} group by area order by min(sort), area`;
      });
    },
  );

  app.post(
    '/brand-standards',
    {
      schema: {
        tags: ['brand-standards'],
        summary: 'Create a draft brand-standard package owned by your firm (optionally with items)',
        body: BrandStandardInput,
        response: { 201: BrandStandardDetail },
      },
    },
    async (req, reply) => {
      requireContribute(req.principal);
      const b = req.body;
      const result = await catalogTx(req, async (tx) => {
        const [brand] = await tx<{ id: string }[]>`select id from catalog.brands where id = ${b.brandId}`;
        if (!brand) throw notFound('Brand');
        const [row] = await tx<{ id: string }[]>`
          insert into catalog.brand_standards ${tx({
            brand_id: b.brandId,
            name: b.name,
            version: b.version,
            effective_date: b.effectiveDate ?? null,
            source_document_id: b.sourceDocumentId ?? null,
            notes: b.notes ?? null,
            status: 'draft',
            contributed_by_tenant_id: contributorTenant(req.principal),
          } as never)}
          returning id`;
        if (b.items?.length) await dupeGuard(() => upsertItems(tx, row!.id, b.items!));
        const s = must(await getStandard(tx, row!.id, req.principal.tenantId), 'Brand standard');
        return { ...s, items: await listItems(tx, s.id) };
      });
      return reply.status(201).send(result);
    },
  );

  app.patch(
    '/brand-standards/:id',
    {
      schema: {
        tags: ['brand-standards'],
        summary: 'Update a brand-standard package header',
        params: IdParams,
        body: BrandStandardPatch,
        response: { 200: BrandStandard },
      },
    },
    async (req) => {
      requireContribute(req.principal);
      return catalogTx(req, async (tx) => {
        await editable(tx, req, req.params.id);
        const b = req.body;
        const sets = Object.fromEntries(
          Object.entries({
            name: b.name,
            version: b.version,
            effective_date: b.effectiveDate,
            source_document_id: b.sourceDocumentId,
            notes: b.notes,
          }).filter(([, v]) => v !== undefined),
        );
        if (Object.keys(sets).length)
          await tx`update catalog.brand_standards set ${tx(sets as never)} where id = ${req.params.id}`;
        return must(await getStandard(tx, req.params.id, req.principal.tenantId), 'Brand standard');
      });
    },
  );

  app.post(
    '/brand-standards/:id/submit',
    {
      schema: {
        tags: ['brand-standards'],
        summary: 'Submit a draft package to the catalog curators for publication',
        params: IdParams,
        response: { 200: BrandStandard },
      },
    },
    async (req) => {
      requireContribute(req.principal);
      return catalogTx(req, async (tx) => {
        const s = await editable(tx, req, req.params.id);
        if (s.status !== 'draft') throw conflict(`Only drafts can be submitted (status is ${s.status})`);
        if (!s.itemCount) throw conflict('Add at least one item before submitting');
        await tx`update catalog.brand_standards set status = 'submitted', submitted_at = now()
                 where id = ${s.id}`;
        await req.emit(tx, 'catalog.brand_standard.submitted', {
          standardId: s.id,
          brandId: s.brandId,
          name: s.name,
          version: s.version,
          itemCount: s.itemCount,
        });
        return must(await getStandard(tx, s.id, req.principal.tenantId), 'Brand standard');
      });
    },
  );

  app.post(
    '/brand-standards/:id/publish',
    {
      schema: {
        tags: ['brand-standards'],
        summary: 'Publish a package to every tenant (curators only); supersedes older published versions',
        params: IdParams,
        response: { 200: BrandStandard },
      },
    },
    async (req) => {
      req.principal.require('catalog:curate');
      requireCurator(req.principal);
      return catalogTx(req, async (tx) => {
        const s = must(await getStandard(tx, req.params.id, req.principal.tenantId), 'Brand standard');
        if (!['draft', 'submitted'].includes(s.status))
          throw conflict(`Only draft or submitted packages can be published (status is ${s.status})`);
        if (!s.itemCount) throw conflict('Cannot publish a package with no items');
        const superseded = await tx<{ id: string }[]>`
          update catalog.brand_standards set status = 'superseded'
          where brand_id = ${s.brandId} and lower(name) = lower(${s.name}) and status = 'published' and id <> ${s.id}
          returning id`;
        await tx`update catalog.brand_standards
                 set status = 'published', published_at = now(), published_by = ${req.principal.userId}
                 where id = ${s.id}`;
        await req.emit(tx, 'catalog.brand_standard.published', {
          standardId: s.id,
          brandId: s.brandId,
          name: s.name,
          version: s.version,
          itemCount: s.itemCount,
          contributedByTenantId: s.contributedByTenantId ?? null,
          supersededIds: superseded.map((r) => r.id),
        });
        return must(await getStandard(tx, s.id, req.principal.tenantId), 'Brand standard');
      });
    },
  );

  app.post(
    '/brand-standards/:id/items',
    {
      schema: {
        tags: ['brand-standards'],
        summary: 'Bulk upsert items into a package, matched by item code',
        params: IdParams,
        body: UpsertItemsBody,
        response: { 200: UpsertItemsResult },
      },
    },
    async (req) => {
      requireContribute(req.principal);
      return catalogTx(req, async (tx) => {
        const s = await editable(tx, req, req.params.id);
        return dupeGuard(() => upsertItems(tx, s.id, req.body.items));
      });
    },
  );

  app.patch(
    '/brand-standards/:id/items/:itemId',
    {
      schema: {
        tags: ['brand-standards'],
        summary: 'Update one item of a package',
        params: ItemParams,
        body: BrandStandardItemPatch,
        response: { 200: BrandStandardItem },
      },
    },
    async (req) => {
      requireContribute(req.principal);
      return catalogTx(req, async (tx) => {
        await editable(tx, req, req.params.id);
        const b = req.body;
        const sets = Object.fromEntries(
          Object.entries({
            code: b.code,
            area: b.area,
            category: b.category,
            name: b.name,
            description: b.description,
            dimensions: b.dimensions,
            finish: b.finish,
            materials: b.materials,
            attributes: b.attributes === undefined ? undefined : tx.json(b.attributes as never),
            approved_vendors:
              b.approvedVendors === undefined ? undefined : tx.json(b.approvedVendors as never),
            quantity_basis: b.quantityBasis,
            sort: b.sort,
          }).filter(([, v]) => v !== undefined),
        );
        const [row] = Object.keys(sets).length
          ? await tx<any[]>`
              update catalog.brand_standard_items set ${tx(sets as never)}
              where id = ${req.params.itemId} and standard_id = ${req.params.id} returning id`
          : await tx<any[]>`
              select id from catalog.brand_standard_items
              where id = ${req.params.itemId} and standard_id = ${req.params.id}`;
        must(row, 'Brand standard item');
        const items = await listItems(tx, req.params.id);
        return must(
          items.find((i) => i.id === req.params.itemId),
          'Brand standard item',
        );
      });
    },
  );

  app.delete(
    '/brand-standards/:id/items/:itemId',
    {
      schema: {
        tags: ['brand-standards'],
        summary: 'Remove an item from a package',
        params: ItemParams,
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      requireContribute(req.principal);
      await catalogTx(req, async (tx) => {
        await editable(tx, req, req.params.id);
        const rows = await tx`
          delete from catalog.brand_standard_items
          where id = ${req.params.itemId} and standard_id = ${req.params.id} returning id`;
        if (!rows.length) throw notFound('Brand standard item');
      });
      return reply.status(204).send(null);
    },
  );
}
