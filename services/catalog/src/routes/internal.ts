import { type App, badRequest, conflict, must, notFound, z } from '@procure/platform';
import {
  getStandard,
  internalTx,
  like,
  listItems,
  toInternalVendor,
  upsertItems,
  vendorColumns,
  withProfiles,
} from '../repo.js';
import {
  IdParams,
  InternalBrandStandard,
  InternalVendor,
  UpsertItemsBody,
  UpsertItemsResult,
} from '../schemas.js';

/**
 * Service-to-service routes (x-procure-internal). Tenant comes from the query string and is applied
 * through withTenant, so a tenant's private vendor profile is only ever merged for that tenant.
 */
export async function internalRoutes(app: App) {
  app.get(
    '/internal/vendors/:vendorId',
    {
      config: { internal: true },
      schema: {
        hide: true,
        params: z.object({ vendorId: z.uuid() }),
        querystring: z.object({ tenantId: z.uuid() }),
        response: { 200: InternalVendor },
      },
    },
    async (req) =>
      internalTx(req.query.tenantId, async (tx) => {
        const [v] = await tx<
          any[]
        >`select ${vendorColumns(tx)} from catalog.vendors v where v.id = ${req.params.vendorId}`;
        const [withP] = await withProfiles(tx, [must(v, 'Vendor')]);
        return toInternalVendor(withP);
      }),
  );

  app.get(
    '/internal/vendors',
    {
      config: { internal: true },
      schema: {
        hide: true,
        querystring: z.object({
          tenantId: z.uuid(),
          q: z.string().trim().min(1).optional(),
          domain: z.string().trim().toLowerCase().min(3).optional(),
          ids: z.string().optional(),
          orgId: z.uuid().optional(),
          limit: z.coerce.number().int().min(1).max(500).default(50),
        }),
        response: { 200: z.array(InternalVendor) },
      },
    },
    async (req) => {
      const { tenantId, q, domain, ids, orgId, limit } = req.query;
      const idList = ids?.split(',').filter(Boolean) ?? [];
      if (idList.some((i) => !z.uuid().safeParse(i).success)) throw badRequest('ids must be uuids');
      const bare = domain?.replace(/^.*@/, '').replace(/^www\./, '');
      return internalTx(tenantId, async (tx) => {
        const rows = await tx<any[]>`
          select ${vendorColumns(tx)}
          from catalog.vendors v
          left join catalog.vendor_profiles p on p.vendor_id = v.id and p.tenant_id = ${tenantId}
          where true
            ${q ? tx`and (v.name ilike ${like(q)} or v.name % ${q})` : tx``}
            ${idList.length ? tx`and v.id in ${tx(idList)}` : tx``}
            ${orgId ? tx`and v.org_id = ${orgId}` : tx``}
            ${
              bare
                ? tx`and (${bare} = any(v.email_domains)
                       or v.website ilike ${like(bare)}
                       or lower(p.primary_contact ->> 'email') like ${`%@${bare}`}
                       or exists (select 1 from jsonb_array_elements(coalesce(p.contacts, '[]'::jsonb)) c
                                  where lower(c ->> 'email') like ${`%@${bare}`}))`
                : tx``
            }
          order by (p.id is not null) desc, ${q ? tx`similarity(v.name, ${q}) desc,` : tx``} v.name
          limit ${limit}`;
        return (await withProfiles(tx, rows)).map(toInternalVendor);
      });
    },
  );

  app.get(
    '/internal/brand-standards/:id',
    {
      config: { internal: true },
      schema: {
        hide: true,
        params: IdParams,
        querystring: z.object({ tenantId: z.uuid().optional() }),
        response: { 200: InternalBrandStandard },
      },
    },
    async (req) =>
      internalTx(req.query.tenantId, async (tx) => {
        const s = must(await getStandard(tx, req.params.id, req.query.tenantId ?? null), 'Brand standard');
        return {
          id: s.id,
          brandId: s.brandId,
          brandName: s.brandName,
          name: s.name,
          version: s.version,
          status: s.status,
          items: await listItems(tx, s.id),
        };
      }),
  );

  app.post(
    '/internal/brand-standards/:id/items',
    {
      config: { internal: true },
      schema: {
        hide: true,
        params: IdParams,
        querystring: z.object({ tenantId: z.uuid().optional() }),
        body: UpsertItemsBody,
        response: { 200: UpsertItemsResult },
      },
    },
    async (req) =>
      internalTx(req.query.tenantId, async (tx) => {
        const s = await getStandard(tx, req.params.id, req.query.tenantId ?? null);
        if (!s) throw notFound('Brand standard');
        // Imports (e.g. AI extraction of a brand PDF) land in the contributor's working copy only.
        if (!['draft', 'submitted'].includes(s.status))
          throw conflict(`Cannot import items into a ${s.status} brand standard`);
        if (req.query.tenantId && s.contributedByTenantId !== req.query.tenantId)
          throw notFound('Brand standard');
        try {
          return await upsertItems(tx, s.id, req.body.items);
        } catch (err) {
          const dupe = (err as { dupe?: string }).dupe;
          if (dupe) throw badRequest(`Duplicate item code in request: ${dupe}`);
          throw err;
        }
      }),
  );
}
