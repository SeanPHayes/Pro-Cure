import { createHash, randomBytes } from 'node:crypto';
import { Address, ClientRole, InternalRole, OrgType, Role, VendorRole } from '@procure/domain';
import {
  type App,
  badRequest,
  config,
  conflict,
  forbidden,
  jwks,
  must,
  notFound,
  type ServiceDefinition,
  unauthorized,
  withSystem,
  z,
} from '@procure/platform';
import * as jose from 'jose';
import { contextsFor, hashToken, issueTokens } from './tokens.js';

const TokenResponse = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresIn: z.number(),
  user: z.object({ id: z.string(), email: z.string(), name: z.string() }),
  context: z.object({
    orgId: z.string(),
    orgName: z.string(),
    orgType: z.string(),
    tenantId: z.string(),
    actor: z.string(),
    roles: z.array(z.string()),
    permissions: z.array(z.string()),
  }),
  contexts: z.array(
    z.object({
      orgId: z.string(),
      orgName: z.string(),
      orgType: z.string(),
      tenantId: z.string(),
      tenantName: z.string(),
      roles: z.array(z.string()),
    }),
  ),
});

const toResponse = (r: Awaited<ReturnType<typeof issueTokens>>) => ({
  accessToken: r.accessToken,
  refreshToken: r.refreshToken,
  expiresIn: r.expiresIn,
  user: { id: r.claims.sub, email: r.claims.email, name: r.claims.name },
  context: {
    orgId: r.claims.org,
    orgName: r.claims.orgName,
    orgType: r.claims.orgType,
    tenantId: r.claims.tenant,
    actor: r.claims.actor,
    roles: r.claims.roles,
    permissions: r.claims.perms,
  },
  contexts: r.contexts,
});

const Org = z.object({
  id: z.string(),
  type: OrgType,
  name: z.string(),
  legalName: z.string().nullable(),
  slug: z.string(),
  website: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  address: z.record(z.string(), z.unknown()),
  logoUrl: z.string().nullable(),
  status: z.string(),
  relationship: z.string().nullable().optional(),
  memberCount: z.number().optional(),
  createdAt: z.string(),
});

const Member = z.object({
  membershipId: z.string(),
  userId: z.string(),
  email: z.string(),
  name: z.string(),
  title: z.string().nullable(),
  phone: z.string().nullable(),
  orgId: z.string(),
  orgName: z.string(),
  orgType: z.string(),
  roles: z.array(z.string()),
  status: z.string(),
  lastLoginAt: z.string().nullable(),
});

const slugify = (s: string) =>
  `${s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48)}-${randomBytes(2).toString('hex')}`;

const rolesValidFor = (type: OrgType, roles: string[]) => {
  const allowed: readonly string[] =
    type === 'vendor' ? VendorRole.options : type === 'client' ? ClientRole.options : InternalRole.options;
  return roles.every((r) => allowed.includes(r));
};

let cognitoJwks: ReturnType<typeof jose.createRemoteJWKSet> | undefined;

async function routes(app: App) {
  // ---------------------------------------------------------------- keys
  app.get('/.well-known/jwks.json', { config: { public: true }, schema: { hide: true } }, async () => jwks());

  // ---------------------------------------------------------------- dev sign-in (local only)
  app.get(
    '/auth/dev/users',
    {
      config: { public: true },
      schema: {
        tags: ['auth'],
        summary: 'Demo users available for passwordless sign-in (local environments only)',
        response: {
          200: z.array(
            z.object({
              id: z.string(),
              email: z.string(),
              name: z.string(),
              title: z.string().nullable(),
              orgName: z.string(),
              orgType: z.string(),
              roles: z.array(z.string()),
            }),
          ),
        },
      },
    },
    async () => {
      if (!config().AUTH_DEV_LOGIN) throw notFound('Route');
      const rows = await withSystem<any[]>(
        (tx) =>
          tx`
          select distinct on (u.id) u.id, u.email, u.name, u.title, o.name as org_name, o.type as org_type, m.roles
          from identity.users u
          join identity.memberships m on m.user_id = u.id
          join identity.organizations o on o.id = m.org_id
          where u.status = 'active'
          order by u.id, m.is_default desc` as never,
      );
      return rows.sort(
        (a, b) =>
          a.orgType.localeCompare(b.orgType) ||
          a.orgName.localeCompare(b.orgName) ||
          a.name.localeCompare(b.name),
      );
    },
  );

  app.post(
    '/auth/dev/login',
    {
      config: { public: true },
      schema: {
        tags: ['auth'],
        summary: 'Passwordless sign-in as a seeded user (local environments only)',
        body: z.object({ email: z.email(), orgId: z.uuid().optional(), tenantId: z.uuid().optional() }),
        response: { 200: TokenResponse },
      },
    },
    async (req) => {
      if (!config().AUTH_DEV_LOGIN) throw notFound('Route');
      const [u] = await withSystem(
        (tx) =>
          tx<{ id: string }[]>`select id from identity.users where lower(email) = lower(${req.body.email})`,
      );
      if (!u) throw unauthorized('Unknown user');
      return toResponse(await issueTokens(u.id, req.body, req.headers['user-agent']));
    },
  );

  // ---------------------------------------------------------------- Cognito federation (AWS)
  app.post(
    '/auth/exchange',
    {
      config: { public: true },
      schema: {
        tags: ['auth'],
        summary:
          'Exchange a Cognito ID token (Entra ID / Google SSO or password) for a Pro-Cure access token',
        body: z.object({ idToken: z.string(), orgId: z.uuid().optional(), tenantId: z.uuid().optional() }),
        response: { 200: TokenResponse },
      },
    },
    async (req) => {
      const { COGNITO_USER_POOL_ID: pool, COGNITO_CLIENT_ID: client, COGNITO_REGION: region } = config();
      if (!pool || !client) throw badRequest('SSO is not configured in this environment');
      const issuer = `https://cognito-idp.${region}.amazonaws.com/${pool}`;
      cognitoJwks ??= jose.createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
      let payload: jose.JWTPayload;
      try {
        ({ payload } = await jose.jwtVerify(req.body.idToken, cognitoJwks, { issuer, audience: client }));
      } catch {
        throw unauthorized('Invalid identity token');
      }
      const email = String(payload.email ?? '').toLowerCase();
      if (!email || payload.email_verified === false) throw unauthorized('Email not verified');
      const userId = await withSystem(async (tx) => {
        const [u] = await tx<{ id: string }[]>`
          select id from identity.users where cognito_sub = ${payload.sub!} or lower(email) = ${email}
          order by (cognito_sub = ${payload.sub!}) desc limit 1`;
        if (!u)
          throw forbidden('No Pro-Cure account for this email. Ask your administrator for an invitation.');
        await tx`update identity.users set cognito_sub = ${payload.sub!}, status = 'active' where id = ${u.id}`;
        return u.id;
      });
      return toResponse(await issueTokens(userId, req.body, req.headers['user-agent']));
    },
  );

  app.post(
    '/auth/refresh',
    {
      config: { public: true },
      schema: {
        tags: ['auth'],
        body: z.object({ refreshToken: z.string() }),
        response: { 200: TokenResponse },
      },
    },
    async (req) => {
      const row = await withSystem(async (tx) => {
        const [r] = await tx<{ id: string; userId: string; orgId: string; tenantId: string }[]>`
          update identity.refresh_tokens set revoked_at = now()
          where token_hash = ${hashToken(req.body.refreshToken)} and revoked_at is null and expires_at > now()
          returning id, user_id, org_id, tenant_id`;
        return r;
      });
      if (!row) throw unauthorized('Session expired');
      return toResponse(await issueTokens(row.userId, { orgId: row.orgId, tenantId: row.tenantId }));
    },
  );

  app.post(
    '/auth/switch',
    {
      schema: {
        tags: ['auth'],
        summary: 'Switch the active organization/tenant',
        body: z.object({ orgId: z.uuid(), tenantId: z.uuid() }),
        response: { 200: TokenResponse },
      },
    },
    async (req) => toResponse(await issueTokens(req.principal.userId, req.body, req.headers['user-agent'])),
  );

  app.post(
    '/auth/logout',
    { schema: { tags: ['auth'], body: z.object({ refreshToken: z.string().optional() }).optional() } },
    async (req, reply) => {
      await withSystem(async (tx) => {
        if (req.body?.refreshToken)
          await tx`update identity.refresh_tokens set revoked_at = now() where token_hash = ${hashToken(req.body.refreshToken)}`;
        else
          await tx`update identity.refresh_tokens set revoked_at = now() where user_id = ${req.principal.userId} and revoked_at is null`;
      });
      return reply.status(204).send();
    },
  );

  // ---------------------------------------------------------------- me
  app.get(
    '/me',
    {
      schema: {
        tags: ['users'],
        response: {
          200: z.object({
            id: z.string(),
            email: z.string(),
            name: z.string(),
            title: z.string().nullable(),
            phone: z.string().nullable(),
            avatarUrl: z.string().nullable(),
            preferences: z.record(z.string(), z.unknown()),
            context: TokenResponse.shape.context,
            contexts: TokenResponse.shape.contexts,
          }),
        },
      },
    },
    async (req) => {
      const p = req.principal;
      return withSystem(async (tx) => {
        const [u] = await tx<
          any[]
        >`select id, email, name, title, phone, avatar_url, preferences from identity.users where id = ${p.userId}`;
        return {
          ...must(u, 'User'),
          context: {
            orgId: p.orgId,
            orgName: p.claims.orgName,
            orgType: p.claims.orgType,
            tenantId: p.tenantId,
            actor: p.actor,
            roles: p.claims.roles,
            permissions: p.claims.perms,
          },
          contexts: await contextsFor(tx, p.userId),
        };
      });
    },
  );

  app.patch(
    '/me',
    {
      schema: {
        tags: ['users'],
        body: z.object({
          name: z.string().min(1).optional(),
          title: z.string().nullable().optional(),
          phone: z.string().nullable().optional(),
          preferences: z.record(z.string(), z.unknown()).optional(),
        }),
      },
    },
    async (req) => {
      await req.tx(async (tx) => {
        const b = req.body;
        await tx`update identity.users set
          name = coalesce(${b.name ?? null}, name),
          title = case when ${b.title !== undefined} then ${b.title ?? null} else title end,
          phone = case when ${b.phone !== undefined} then ${b.phone ?? null} else phone end,
          preferences = case when ${b.preferences !== undefined} then preferences || ${tx.json((b.preferences ?? {}) as never)} else preferences end
          where id = ${req.principal.userId}`;
      });
      return { ok: true };
    },
  );

  // ---------------------------------------------------------------- organizations
  app.get(
    '/orgs',
    {
      schema: {
        tags: ['organizations'],
        summary: 'Organizations visible to the current tenant (itself, connected vendors and clients)',
        querystring: z.object({ type: OrgType.optional(), q: z.string().optional() }),
        response: { 200: z.array(Org) },
      },
    },
    async (req) => {
      req.principal.requireInternal();
      const { type, q } = req.query;
      return req.tx(
        (tx) =>
          tx`
          select o.*, r.kind as relationship,
                 (select count(*)::int from identity.memberships m where m.org_id = o.id and m.status = 'active') as member_count
          from identity.organizations o
          left join identity.org_relationships r on r.org_id = o.id and r.tenant_id = ${req.principal.tenantId}
          where (o.id = ${req.principal.tenantId} or r.id is not null)
            ${type ? tx`and o.type = ${type}` : tx``}
            ${q ? tx`and o.name ilike ${`%${q}%`}` : tx``}
          order by o.type, o.name` as never,
      );
    },
  );

  app.get(
    '/orgs/:id',
    { schema: { tags: ['organizations'], params: z.object({ id: z.uuid() }), response: { 200: Org } } },
    async (req) =>
      req.tx(async (tx) => {
        const [o] = await tx<any[]>`
          select o.*, r.kind as relationship from identity.organizations o
          left join identity.org_relationships r on r.org_id = o.id and r.tenant_id = ${req.principal.tenantId}
          where o.id = ${req.params.id}`;
        return must(o, 'Organization');
      }),
  );

  app.post(
    '/orgs',
    {
      schema: {
        tags: ['organizations'],
        summary: 'Create a vendor or client organization and connect it to this tenant',
        body: z.object({
          type: z.enum(['vendor', 'client']),
          name: z.string().min(2),
          legalName: z.string().optional(),
          website: z.string().optional(),
          phone: z.string().optional(),
          email: z.string().optional(),
          address: Address.partial().optional(),
          /** Connect an existing global org (e.g. a vendor already on the network) instead of creating one. */
          existingOrgId: z.uuid().optional(),
        }),
        response: { 201: Org },
      },
    },
    async (req, reply) => {
      req.principal.require('users:write');
      const b = req.body;
      const org = await req.tx(async (tx) => {
        let id = b.existingOrgId;
        if (id) {
          const [o] = await withSystem(
            (stx) => stx<{ type: string }[]>`select type from identity.organizations where id = ${id!}`,
          );
          if (!o || o.type !== b.type) throw badRequest('Organization not found or wrong type');
        } else {
          // No RETURNING: the new org only becomes visible (RLS) once the relationship row exists.
          id = crypto.randomUUID();
          await tx`
            insert into identity.organizations (id, type, name, legal_name, slug, website, phone, email, address)
            values (${id}, ${b.type}, ${b.name}, ${b.legalName ?? null}, ${slugify(b.name)}, ${b.website ?? null},
                    ${b.phone ?? null}, ${b.email ?? null}, ${tx.json((b.address ?? {}) as never)})`;
          await req.emit(tx, 'identity.org.created', { orgId: id, type: b.type, name: b.name });
        }
        await tx`insert into identity.org_relationships (tenant_id, org_id, kind)
                 values (${req.principal.tenantId}, ${id}, ${b.type}) on conflict do nothing`;
        const [row] = await tx<
          any[]
        >`select o.*, ${b.type}::text as relationship from identity.organizations o where id = ${id}`;
        return row;
      });
      return reply.status(201).send(org);
    },
  );

  app.patch(
    '/orgs/:id',
    {
      schema: {
        tags: ['organizations'],
        params: z.object({ id: z.uuid() }),
        body: z.object({
          name: z.string().min(2).optional(),
          legalName: z.string().nullable().optional(),
          website: z.string().nullable().optional(),
          phone: z.string().nullable().optional(),
          email: z.string().nullable().optional(),
          address: Address.partial().optional(),
          logoUrl: z.string().nullable().optional(),
        }),
        response: { 200: Org },
      },
    },
    async (req) => {
      const p = req.principal;
      if (req.params.id !== p.orgId) p.require('users:write');
      else if (!p.can('org:admin') && !p.can('users:write')) throw forbidden();
      return req.tx(async (tx) => {
        const b = req.body;
        const sets = Object.fromEntries(
          Object.entries({
            name: b.name,
            legal_name: b.legalName,
            website: b.website,
            phone: b.phone,
            email: b.email,
            logo_url: b.logoUrl,
            address: b.address ? tx.json(b.address as never) : undefined,
          }).filter(([, v]) => v !== undefined),
        );
        const [o] = Object.keys(sets).length
          ? await tx<
              any[]
            >`update identity.organizations set ${tx(sets as never)} where id = ${req.params.id} returning *`
          : await tx<any[]>`select * from identity.organizations where id = ${req.params.id}`;
        return must(o, 'Organization');
      });
    },
  );

  // ---------------------------------------------------------------- users & memberships
  app.get(
    '/users',
    {
      schema: {
        tags: ['users'],
        summary: 'Members of the tenant and of its connected organizations',
        querystring: z.object({
          orgId: z.uuid().optional(),
          role: z.string().optional(),
          q: z.string().optional(),
        }),
        response: { 200: z.array(Member) },
      },
    },
    async (req) => {
      const p = req.principal;
      p.require('users:read');
      const { orgId, role, q } = req.query;
      // External users may only list their own organization.
      const scopeOrg = p.isInternal ? orgId : p.orgId;
      return req.tx(
        (tx) =>
          tx`
          select m.id as membership_id, u.id as user_id, u.email, u.name, u.title, u.phone,
                 o.id as org_id, o.name as org_name, o.type as org_type, m.roles, m.status, u.last_login_at
          from identity.memberships m
          join identity.users u on u.id = m.user_id
          join identity.organizations o on o.id = m.org_id
          where true
            ${scopeOrg ? tx`and m.org_id = ${scopeOrg}` : tx``}
            ${role ? tx`and ${role} = any(m.roles)` : tx``}
            ${q ? tx`and (u.name ilike ${`%${q}%`} or u.email ilike ${`%${q}%`})` : tx``}
          order by o.type, o.name, u.name` as never,
      );
    },
  );

  app.post(
    '/users/invite',
    {
      schema: {
        tags: ['users'],
        summary: 'Invite a user into this tenant or a connected vendor/client organization',
        body: z.object({
          email: z.email(),
          name: z.string().min(1),
          title: z.string().optional(),
          orgId: z.uuid(),
          roles: z.array(Role).min(1),
        }),
        response: { 201: z.object({ userId: z.string(), membershipId: z.string(), inviteUrl: z.string() }) },
      },
    },
    async (req, reply) => {
      const p = req.principal;
      const b = req.body;
      if (b.orgId === p.orgId) {
        if (!p.can('users:write') && !p.can('org:admin')) throw forbidden();
      } else p.require('users:write');
      const result = await req.tx(async (tx) => {
        const [org] = await tx<
          { id: string; type: OrgType }[]
        >`select id, type from identity.organizations where id = ${b.orgId}`;
        if (!org) throw notFound('Organization');
        if (!rolesValidFor(org.type, b.roles))
          throw badRequest(`Roles not valid for a ${org.type} organization`);
        const existing = await withSystem(
          (stx) =>
            stx<{ id: string }[]>`select id from identity.users where lower(email) = lower(${b.email})`,
        );
        let userId = existing[0]?.id;
        if (!userId) {
          const [u] = await withSystem(
            (stx) => stx<{ id: string }[]>`
              insert into identity.users (email, name, title, status) values (${b.email}, ${b.name}, ${b.title ?? null}, 'invited')
              returning id`,
          );
          userId = u!.id;
        }
        const [m] = await tx<{ id: string }[]>`
          insert into identity.memberships (user_id, org_id, roles, status)
          values (${userId}, ${b.orgId}, ${b.roles}, 'active')
          on conflict (user_id, org_id) do update set roles = excluded.roles, status = 'active'
          returning id`;
        const token = randomBytes(24).toString('base64url');
        await tx`insert into identity.invitations (tenant_id, org_id, email, name, roles, token_hash, invited_by, expires_at)
                 values (${p.tenantId}, ${b.orgId}, ${b.email}, ${b.name}, ${b.roles},
                         ${createHash('sha256').update(token).digest('hex')}, ${p.userId}, now() + interval '14 days')`;
        const inviteUrl = `${config().PUBLIC_WEB_URL}/accept-invite?token=${token}`;
        await req.emit(tx, 'identity.user.invited', { userId, orgId: b.orgId, email: b.email, inviteUrl });
        return { userId, membershipId: m!.id, inviteUrl };
      });
      return reply.status(201).send(result);
    },
  );

  app.patch(
    '/memberships/:id',
    {
      schema: {
        tags: ['users'],
        params: z.object({ id: z.uuid() }),
        body: z.object({
          roles: z.array(Role).min(1).optional(),
          status: z.enum(['active', 'disabled']).optional(),
        }),
      },
    },
    async (req) => {
      req.principal.require('users:write');
      return req.tx(async (tx) => {
        const [m] = await tx<{ orgId: string; type: OrgType; userId: string }[]>`
          select m.org_id, o.type, m.user_id from identity.memberships m join identity.organizations o on o.id = m.org_id
          where m.id = ${req.params.id}`;
        if (!m) throw notFound('Membership');
        if (req.body.roles && !rolesValidFor(m.type, req.body.roles))
          throw badRequest('Invalid roles for organization type');
        if (m.userId === req.principal.userId && req.body.status === 'disabled')
          throw conflict('You cannot disable yourself');
        await tx`update identity.memberships set
                   roles = coalesce(${req.body.roles ?? null}, roles),
                   status = coalesce(${req.body.status ?? null}, status)
                 where id = ${req.params.id}`;
        return { ok: true };
      });
    },
  );

  // ---------------------------------------------------------------- internal lookups
  app.get(
    '/internal/users',
    {
      config: { internal: true },
      schema: {
        hide: true,
        querystring: z.object({
          tenantId: z.uuid(),
          roles: z.string().optional(),
          ids: z.string().optional(),
          orgId: z.uuid().optional(),
        }),
      },
    },
    async (req) => {
      const roles = req.query.roles?.split(',').filter(Boolean) ?? [];
      const ids = req.query.ids?.split(',').filter(Boolean) ?? [];
      return withSystem(
        (tx) => tx`
          select u.id, u.email, u.name, o.id as org_id, o.type as org_type, m.roles
          from identity.memberships m
          join identity.users u on u.id = m.user_id and u.status <> 'disabled'
          join identity.organizations o on o.id = m.org_id
          left join identity.org_relationships r on r.org_id = o.id and r.tenant_id = ${req.query.tenantId}
          where m.status = 'active'
            and (o.id = ${req.query.tenantId} or r.id is not null)
            ${req.query.orgId ? tx`and o.id = ${req.query.orgId}` : tx``}
            ${roles.length ? tx`and m.roles && ${roles}` : tx``}
            ${ids.length ? tx`and u.id in ${tx(ids)}` : tx``}`,
      );
    },
  );
}

export const identityService: ServiceDefinition = {
  name: 'identity',
  title: 'Identity',
  description:
    'Authentication, organizations (procurement firms, vendors, clients), users, roles and tenant access.',
  routes,
};
