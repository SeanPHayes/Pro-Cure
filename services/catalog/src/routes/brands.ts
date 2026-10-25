import { type App, conflict, must, z } from '@procure/platform';
import {
  catalogTx,
  contributorTenant,
  isCurator,
  requireContribute,
  requireStandardsRead,
} from '../access.js';
import { like, standardSelect } from '../repo.js';
import { Brand, BrandDetail, BrandInput, IdParams } from '../schemas.js';

export async function brandRoutes(app: App) {
  app.get(
    '/brands',
    {
      schema: {
        tags: ['brands'],
        summary: 'List hotel brands (shared across all tenants)',
        querystring: z.object({ q: z.string().trim().min(1).optional() }),
        response: { 200: z.array(Brand) },
      },
    },
    async (req) => {
      requireStandardsRead(req.principal);
      const { q } = req.query;
      return req.tx(
        (tx) => tx<any[]>`
          select b.id, b.name, b.parent_company, b.segment, b.logo_url, b.created_at,
                 (select count(*)::int from catalog.brand_standards s where s.brand_id = b.id) as standard_count
          from catalog.brands b
          where true
            ${q ? tx`and (b.name ilike ${like(q)} or b.parent_company ilike ${like(q)} or b.name % ${q})` : tx``}
          order by ${q ? tx`similarity(b.name, ${q}) desc,` : tx``} b.parent_company nulls last, b.name
          limit 500`,
      );
    },
  );

  app.get(
    '/brands/:id',
    {
      schema: {
        tags: ['brands'],
        summary: 'Get a brand with its brand-standard packages visible to the caller',
        params: IdParams,
        response: { 200: BrandDetail },
      },
    },
    async (req) => {
      requireStandardsRead(req.principal);
      return req.tx(async (tx) => {
        const [b] = await tx<any[]>`
          select id, name, parent_company, segment, logo_url, created_at from catalog.brands where id = ${req.params.id}`;
        const brand = must(b, 'Brand');
        const standards = await tx<any[]>`
          ${standardSelect(tx, req.principal.tenantId)}
          where s.brand_id = ${brand.id}
          order by (s.status = 'published') desc, s.effective_date desc nulls last, s.name, s.version desc`;
        return { ...brand, standardCount: standards.length, standards };
      });
    },
  );

  app.post(
    '/brands',
    {
      schema: {
        tags: ['brands'],
        summary: 'Add a hotel brand to the shared catalog',
        body: BrandInput,
        response: { 201: Brand },
      },
    },
    async (req, reply) => {
      requireContribute(req.principal);
      const b = req.body;
      const row = await catalogTx(req, async (tx) => {
        const [dupe] = await tx<{ id: string }[]>`
          select id from catalog.brands where lower(name) = lower(${b.name})`;
        if (dupe) throw conflict('A brand with that name already exists', { brandId: dupe.id });
        const [r] = await tx<any[]>`
          insert into catalog.brands ${tx({
            name: b.name,
            parent_company: b.parentCompany ?? null,
            segment: b.segment ?? null,
            logo_url: b.logoUrl ?? null,
            created_by_tenant_id: isCurator(req.principal) ? null : contributorTenant(req.principal),
          } as never)}
          returning id, name, parent_company, segment, logo_url, created_at`;
        return { ...r, standardCount: 0 };
      });
      return reply.status(201).send(row);
    },
  );
}
