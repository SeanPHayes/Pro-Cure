import { withOwner } from '@procure/platform';
import { CLIENTS, STAFF, TENANT, VENDORS } from './people.js';

export interface SeedIds {
  tenantId: string;
  users: Record<string, string>;
  vendorOrgs: Record<string, string>;
  clientOrgs: Record<string, string>;
  clientUsers: Record<string, string>;
  platformOrgId: string;
  curatorId: string;
}

/** Organizations, people and memberships go straight into the identity schema (there is no public
 *  "create a tenant" API; tenant provisioning is an operator task). */
export async function seedIdentity(): Promise<SeedIds> {
  return withOwner(async (tx) => {
    const org = async (type: string, name: string, slug: string, extra: Record<string, unknown> = {}) => {
      const [o] = await tx<{ id: string }[]>`
        insert into identity.organizations (type, name, slug, website, phone, email, address)
        values (${type}, ${name}, ${slug}, ${(extra.website as string) ?? null}, ${(extra.phone as string) ?? null},
                ${(extra.email as string) ?? null}, ${tx.json((extra.address ?? {}) as never)})
        on conflict (slug) do update set name = excluded.name
        returning id`;
      return o!.id;
    };
    const user = async (
      orgId: string,
      u: { name: string; email: string; title?: string; roles: readonly string[] },
    ) => {
      const [row] = await tx<{ id: string }[]>`
        insert into identity.users (email, name, title, status) values (${u.email}, ${u.name}, ${u.title ?? null}, 'active')
        on conflict (lower(email)) do update set name = excluded.name, title = excluded.title
        returning id`;
      await tx`
        insert into identity.memberships (user_id, org_id, roles, is_default) values (${row!.id}, ${orgId}, ${[...u.roles]}, true)
        on conflict (user_id, org_id) do update set roles = excluded.roles`;
      return row!.id;
    };

    const tenantId = await org('procurement_firm', TENANT.name, TENANT.slug, TENANT);
    const users: Record<string, string> = {};
    for (const s of STAFF) users[s.key] = await user(tenantId, s);

    const vendorOrgs: Record<string, string> = {};
    for (const v of VENDORS) {
      if (!v.portalUser) continue;
      const id = await org('vendor', v.name, `vendor-${v.key}`, {
        website: v.website,
        phone: v.contact.phone,
      });
      vendorOrgs[v.key] = id;
      await tx`insert into identity.org_relationships (tenant_id, org_id, kind) values (${tenantId}, ${id}, 'vendor') on conflict do nothing`;
      await user(id, { ...v.portalUser, roles: ['vendor_admin'] });
    }
    const clientOrgs: Record<string, string> = {};
    const clientUsers: Record<string, string> = {};
    for (const c of CLIENTS) {
      const id = await org('client', c.name, `client-${c.key}`, c);
      clientOrgs[c.key] = id;
      await tx`insert into identity.org_relationships (tenant_id, org_id, kind) values (${tenantId}, ${id}, 'client') on conflict do nothing`;
      for (const u of c.users) clientUsers[u.email] = await user(id, u);
    }
    // Pro-Cure operators curate the shared catalog (brand standards published to every firm).
    const platformOrgId = await org('platform', 'Pro-Cure Network', 'pro-cure-network');
    const curatorId = await user(platformOrgId, {
      name: 'Catalog Curation',
      email: 'curation@pro-cure.example',
      title: 'Brand standards curator',
      roles: ['catalog_curator'],
    });
    return { tenantId, users, vendorOrgs, clientOrgs, clientUsers, platformOrgId, curatorId };
  });
}
