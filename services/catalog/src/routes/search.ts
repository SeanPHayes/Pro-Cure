import { type App, z } from '@procure/platform';
import { catalogTx, requireStandardsRead } from '../access.js';
import { like, prefixQuery } from '../repo.js';
import { SearchResult } from '../schemas.js';

export async function searchRoutes(app: App) {
  app.get(
    '/search',
    {
      schema: {
        tags: ['search'],
        summary: 'Command-palette search across brand-standard items, products and vendors (top 10 each)',
        querystring: z.object({ q: z.string().trim().min(1).max(200) }),
        response: { 200: SearchResult },
      },
    },
    async (req) => {
      const p = req.principal;
      requireStandardsRead(p);
      const { q } = req.query;
      const tsq = prefixQuery(q);
      // External actors only get brand-standard items (public intelligence), never the directory.
      const internal = p.isInternal || p.actor === 'platform';
      return catalogTx(req, async (tx) => {
        const match = (alias: string) =>
          tsq
            ? tx`(${tx.unsafe(alias)}.search @@ to_tsquery('english', ${tsq}) or ${tx.unsafe(alias)}.name % ${q} or ${tx.unsafe(alias)}.name ilike ${like(q)})`
            : tx`(${tx.unsafe(alias)}.name % ${q} or ${tx.unsafe(alias)}.name ilike ${like(q)})`;
        const rank = (alias: string) =>
          tsq
            ? tx`(ts_rank(${tx.unsafe(alias)}.search, to_tsquery('english', ${tsq})) + similarity(${tx.unsafe(alias)}.name, ${q}))`
            : tx`similarity(${tx.unsafe(alias)}.name, ${q})`;

        const brandStandardItems = await tx<any[]>`
          select i.id, i.standard_id, s.name as standard_name, b.name as brand_name, i.code, i.name, i.area,
                 i.category, round(${rank('i')}::numeric, 4)::float8 as rank
          from catalog.brand_standard_items i
          join catalog.brand_standards s on s.id = i.standard_id
          join catalog.brands b on b.id = s.brand_id
          where s.status <> 'superseded' and (${match('i')} or i.code ilike ${like(q)})
          order by rank desc, i.code
          limit 10`;
        if (!internal) return { brandStandardItems, products: [], vendors: [] };

        const products = await tx<any[]>`
          select pr.id, pr.vendor_id, v.name as vendor_name, pr.sku, pr.name, pr.category,
                 round(${rank('pr')}::numeric, 4)::float8 as rank
          from catalog.products pr
          join catalog.vendors v on v.id = pr.vendor_id
          where pr.status = 'active' and (${match('pr')} or pr.sku ilike ${like(q)})
          order by rank desc, pr.name
          limit 10`;
        const vendors = await tx<any[]>`
          select v.id, v.name, v.categories, v.hq_city, v.hq_region, (vp.id is not null) as has_profile,
                 round((similarity(v.name, ${q}) + case when vp.id is not null then 0.25 else 0 end)::numeric, 4)::float8 as rank
          from catalog.vendors v
          left join catalog.vendor_profiles vp on vp.vendor_id = v.id and vp.tenant_id = ${p.tenantId}
          where v.name % ${q} or v.name ilike ${like(q)}
          order by rank desc, v.name
          limit 10`;
        return { brandStandardItems, products, vendors };
      });
    },
  );
}
