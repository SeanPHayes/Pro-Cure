import { type AccessClaims, type ActorType, permissionsFor, type Role } from '@procure/domain';
import * as jose from 'jose';
import { jwks, setVerifyKey, signAccessToken } from './auth.js';

/**
 * Test helpers. Integration tests run against a real Postgres (the same migrations as production) so
 * row-level security, triggers and constraints are exercised. See tools/test-setup.ts.
 */
let ready = false;
export async function useLocalAuth() {
  if (ready) return;
  const { keys } = await jwks();
  setVerifyKey(await jose.importJWK(keys[0]!, 'RS256'));
  ready = true;
}

export interface TestActor {
  userId: string;
  orgId: string;
  tenantId: string;
  actor?: ActorType;
  roles?: Role[];
  name?: string;
  email?: string;
  orgName?: string;
}

export async function tokenFor(a: TestActor): Promise<string> {
  await useLocalAuth();
  const actor = a.actor ?? 'internal';
  const roles = a.roles ?? ['admin'];
  const claims: AccessClaims = {
    sub: a.userId,
    email: a.email ?? 'test@example.com',
    name: a.name ?? 'Test User',
    org: a.orgId,
    orgType:
      actor === 'internal'
        ? 'procurement_firm'
        : actor === 'vendor'
          ? 'vendor'
          : actor === 'client'
            ? 'client'
            : 'platform',
    orgName: a.orgName ?? 'Test Org',
    tenant: a.tenantId,
    actor,
    roles,
    perms: permissionsFor(roles),
  };
  return signAccessToken(claims, 600);
}

export const auth = (token: string) => ({ authorization: `Bearer ${token}` });

/**
 * Creates an isolated world for a test: a procurement firm (tenant) with an admin, a connected vendor
 * org with a vendor user, and a connected client org with a client user. Returns ids and tokens.
 */
export async function createWorld(label = 'Test') {
  const { withOwner } = await import('./db.js');
  const suffix = crypto.randomUUID().slice(0, 8);
  return withOwner(async (tx) => {
    const org = async (type: string, name: string) => {
      const [o] = await tx<{ id: string }[]>`
        insert into identity.organizations (type, name, slug) values (${type}, ${name}, ${`${name.toLowerCase().replace(/\W+/g, '-')}-${suffix}`})
        returning id`;
      return o!.id;
    };
    const user = async (orgId: string, name: string, roles: string[]) => {
      const [u] = await tx<{ id: string }[]>`
        insert into identity.users (email, name) values (${`${name.toLowerCase().replace(/\W+/g, '.')}.${suffix}@example.com`}, ${name})
        returning id`;
      await tx`insert into identity.memberships (user_id, org_id, roles, is_default) values (${u!.id}, ${orgId}, ${roles}, true)`;
      return u!.id;
    };
    const tenantId = await org('procurement_firm', `${label} Procurement`);
    const vendorOrgId = await org('vendor', `${label} Vendor`);
    const clientOrgId = await org('client', `${label} Hotel Group`);
    await tx`insert into identity.org_relationships (tenant_id, org_id, kind) values
      (${tenantId}, ${vendorOrgId}, 'vendor'), (${tenantId}, ${clientOrgId}, 'client')`;
    const adminId = await user(tenantId, `${label} Admin`, ['admin']);
    const vendorUserId = await user(vendorOrgId, `${label} Vendor Rep`, ['vendor_admin']);
    const clientUserId = await user(clientOrgId, `${label} Owner`, ['client_admin']);
    return { tenantId, vendorOrgId, clientOrgId, adminId, vendorUserId, clientUserId };
  }).then(async (w) => ({
    ...w,
    adminToken: await tokenFor({
      userId: w.adminId,
      orgId: w.tenantId,
      tenantId: w.tenantId,
      roles: ['admin'],
    }),
    vendorToken: await tokenFor({
      userId: w.vendorUserId,
      orgId: w.vendorOrgId,
      tenantId: w.tenantId,
      actor: 'vendor',
      roles: ['vendor_admin'],
    }),
    clientToken: await tokenFor({
      userId: w.clientUserId,
      orgId: w.clientOrgId,
      tenantId: w.tenantId,
      actor: 'client',
      roles: ['client_admin'],
    }),
    tokenAs: (roles: Role[], userId = w.adminId) =>
      tokenFor({ userId, orgId: w.tenantId, tenantId: w.tenantId, roles }),
  }));
}
export type World = Awaited<ReturnType<typeof createWorld>>;
