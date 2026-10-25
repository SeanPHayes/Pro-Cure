import { createHash, randomBytes } from 'node:crypto';
import { type AccessClaims, actorTypeForOrg, OrgType, permissionsFor, type Role } from '@procure/domain';
import { forbidden, signAccessToken, type Tx, withSystem } from '@procure/platform';

export interface AccessContext {
  orgId: string;
  orgName: string;
  orgType: OrgType;
  tenantId: string;
  tenantName: string;
  roles: Role[];
}

const REFRESH_TTL_DAYS = 30;
export const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

/**
 * Every (org, tenant) pair a user can act in. Internal users act in their own firm; vendor and
 * client users act in each procurement firm their organization is connected to.
 */
export async function contextsFor(tx: Tx, userId: string): Promise<AccessContext[]> {
  return tx<AccessContext[]>`
    select m.org_id, o.name as org_name, o.type as org_type,
           coalesce(r.tenant_id, o.id) as tenant_id,
           coalesce(t.name, o.name) as tenant_name,
           m.roles
    from identity.memberships m
    join identity.organizations o on o.id = m.org_id and o.status = 'active'
    left join identity.org_relationships r on r.org_id = o.id and r.status = 'active' and o.type in ('vendor', 'client')
    left join identity.organizations t on t.id = r.tenant_id
    where m.user_id = ${userId} and m.status = 'active'
      and (o.type in ('procurement_firm', 'platform') or r.tenant_id is not null)
    order by m.is_default desc, o.type, o.name`;
}

export async function issueTokens(
  userId: string,
  want: { orgId?: string; tenantId?: string } = {},
  userAgent?: string,
): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  claims: AccessClaims;
  contexts: AccessContext[];
}> {
  return withSystem(async (tx) => {
    const [user] = await tx<{ id: string; email: string; name: string; status: string }[]>`
      select id, email, name, status from identity.users where id = ${userId}`;
    if (!user || user.status === 'disabled') throw forbidden('User is disabled');
    const contexts = await contextsFor(tx, userId);
    const ctx =
      contexts.find(
        (c) => (!want.orgId || c.orgId === want.orgId) && (!want.tenantId || c.tenantId === want.tenantId),
      ) ?? (want.orgId || want.tenantId ? undefined : contexts[0]);
    if (!ctx) throw forbidden('No access to that organization');

    const roles = ctx.roles.filter(Boolean) as Role[];
    const claims: AccessClaims = {
      sub: user.id,
      email: user.email,
      name: user.name,
      org: ctx.orgId,
      orgType: OrgType.parse(ctx.orgType),
      orgName: ctx.orgName,
      tenant: ctx.tenantId,
      actor: actorTypeForOrg(ctx.orgType),
      roles,
      perms: permissionsFor(roles),
    };
    const ttl = Number(process.env.ACCESS_TOKEN_TTL_SECONDS ?? 3600);
    const accessToken = await signAccessToken(claims, ttl);
    const refreshToken = randomBytes(32).toString('base64url');
    await tx`
      insert into identity.refresh_tokens (user_id, org_id, tenant_id, token_hash, expires_at, user_agent)
      values (${user.id}, ${ctx.orgId}, ${ctx.tenantId}, ${hashToken(refreshToken)},
              now() + make_interval(days => ${REFRESH_TTL_DAYS}), ${userAgent ?? null})`;
    await tx`update identity.users set last_login_at = now() where id = ${user.id}`;
    return { accessToken, refreshToken, expiresIn: ttl, claims, contexts };
  });
}
