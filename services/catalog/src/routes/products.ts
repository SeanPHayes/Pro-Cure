import { page } from '@procure/domain';
import { type App, conflict, must, notFound } from '@procure/platform';
import { catalogTx, contributorTenant, requireContribute, requireDirectoryRead } from '../access.js';
import { countOf, like, prefixQuery, productRow, productSelect } from '../repo.js';
import { IdParams, Product, ProductInput, ProductListQuery, ProductPatch } from '../schemas.js';

export async function productRoutes(app: App) {
  app.get(
    '/products',
    {
      schema: {
        tags: ['products'],
        summary: 'Search the shared product catalog',
        querystring: ProductListQuery,
        response: { 200: page(Product) },
      },
    },
    async (req) => {
      requireDirectoryRead(req.principal, 'catalog:read');
      const { vendorId, category, q, brandStandardItemId, status, limit, offset } = req.query;
      const tsq = q ? prefixQuery(q) : null;
      return req.tx(async (tx) => {
        const where = tx`
          where true
            ${vendorId ? tx`and p.vendor_id = ${vendorId}` : tx``}
            ${category ? tx`and p.category = ${category}` : tx``}
            ${status ? tx`and p.status = ${status}` : tx``}
            ${brandStandardItemId ? tx`and ${brandStandardItemId}::uuid = any(p.brand_standard_item_ids)` : tx``}
            ${q ? tx`and (${tsq ? tx`p.search @@ to_tsquery('english', ${tsq}) or` : tx``} p.name ilike ${like(q)} or p.sku ilike ${like(q)})` : tx``}`;
        const total = countOf(
          await tx<{ total: number }[]>`
          select count(*)::int as total from catalog.products p ${where}`,
        );
        const items = await tx<any[]>`
          ${productSelect(tx)} ${where}
          order by ${tsq ? tx`ts_rank(p.search, to_tsquery('english', ${tsq})) desc,` : tx``} p.name
          limit ${limit} offset ${offset}`;
        return { items, total, limit, offset };
      });
    },
  );

  app.get(
    '/products/:id',
    {
      schema: { tags: ['products'], summary: 'Get a product', params: IdParams, response: { 200: Product } },
    },
    async (req) => {
      requireDirectoryRead(req.principal, 'catalog:read');
      return req.tx(async (tx) => {
        const [p] = await tx<any[]>`${productSelect(tx)} where p.id = ${req.params.id}`;
        return must(p, 'Product');
      });
    },
  );

  app.post(
    '/products',
    {
      schema: {
        tags: ['products'],
        summary: 'Add a product to the shared catalog',
        body: ProductInput,
        response: { 201: Product },
      },
    },
    async (req, reply) => {
      requireContribute(req.principal);
      const b = req.body;
      const product = await catalogTx(req, async (tx) => {
        const [v] = await tx<{ id: string }[]>`select id from catalog.vendors where id = ${b.vendorId}`;
        if (!v) throw notFound('Vendor');
        const [dupe] = await tx<{ id: string }[]>`
          select id from catalog.products where vendor_id = ${b.vendorId} and sku = ${b.sku}`;
        if (dupe) throw conflict('This vendor already has a product with that SKU', { productId: dupe.id });
        const id = crypto.randomUUID();
        await tx`insert into catalog.products ${tx({
          id,
          vendor_id: b.vendorId,
          created_by_tenant_id: contributorTenant(req.principal),
          ...productRow(tx, { ...b, category: b.category ?? 'other' }),
        } as never)}`;
        const [p] = await tx<any[]>`${productSelect(tx)} where p.id = ${id}`;
        return p;
      });
      return reply.status(201).send(product);
    },
  );

  app.patch(
    '/products/:id',
    {
      schema: {
        tags: ['products'],
        summary: 'Update a product in the shared catalog',
        params: IdParams,
        body: ProductPatch,
        response: { 200: Product },
      },
    },
    async (req) => {
      requireContribute(req.principal);
      return catalogTx(req, async (tx) => {
        const sets = productRow(tx, req.body);
        const [row] = Object.keys(sets).length
          ? await tx<
              any[]
            >`update catalog.products set ${tx(sets as never)} where id = ${req.params.id} returning id`
          : await tx<any[]>`select id from catalog.products where id = ${req.params.id}`;
        must(row, 'Product');
        const [p] = await tx<any[]>`${productSelect(tx)} where p.id = ${req.params.id}`;
        return p;
      });
    },
  );
}
