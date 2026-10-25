import { buildService, closeDb } from '@procure/platform';
import { auth, createWorld, type World } from '@procure/platform/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { identityService } from '../src/service.js';

let app: Awaited<ReturnType<typeof buildService>>;
let a: World;
let b: World;

beforeAll(async () => {
  app = await buildService(identityService);
  a = await createWorld('Alpha');
  b = await createWorld('Bravo');
});
afterAll(async () => {
  await app.close();
  await closeDb();
});

describe('auth', () => {
  it('rejects unauthenticated requests with problem+json', async () => {
    const res = await app.inject({ method: 'GET', url: '/me' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json()).toMatchObject({ status: 401, code: 'unauthorized' });
  });

  it('dev login issues a token whose context matches the membership', async () => {
    const users = (await app.inject({ method: 'GET', url: '/auth/dev/users' })).json();
    const vendor = users.find((u: any) => u.name === 'Alpha Vendor Rep');
    const res = await app.inject({
      method: 'POST',
      url: '/auth/dev/login',
      payload: { email: vendor.email },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.context).toMatchObject({ orgId: a.vendorOrgId, tenantId: a.tenantId, actor: 'vendor' });
    expect(body.context.permissions).toContain('vendor:respond');
    expect(body.context.permissions).not.toContain('quotes:costs:read');

    const me = await app.inject({ method: 'GET', url: '/me', headers: auth(body.accessToken) });
    expect(me.statusCode).toBe(200);
    expect(me.json().contexts).toHaveLength(1);
  });

  it('refresh tokens rotate', async () => {
    const users = (await app.inject({ method: 'GET', url: '/auth/dev/users' })).json();
    const admin = users.find((u: any) => u.name === 'Alpha Admin');
    const login = (
      await app.inject({ method: 'POST', url: '/auth/dev/login', payload: { email: admin.email } })
    ).json();
    const r1 = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken: login.refreshToken },
    });
    expect(r1.statusCode).toBe(200);
    const r2 = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken: login.refreshToken },
    });
    expect(r2.statusCode).toBe(401);
  });
});

describe('tenant isolation', () => {
  it('lists only the tenant and its connected organizations', async () => {
    const res = await app.inject({ method: 'GET', url: '/orgs', headers: auth(a.adminToken) });
    expect(res.statusCode).toBe(200);
    const ids = res.json().map((o: any) => o.id);
    expect(ids).toEqual(expect.arrayContaining([a.tenantId, a.vendorOrgId, a.clientOrgId]));
    expect(ids).not.toContain(b.tenantId);
    expect(ids).not.toContain(b.vendorOrgId);
  });

  it("cannot read another tenant's organization even by id", async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/orgs/${b.clientOrgId}`,
      headers: auth(a.adminToken),
    });
    expect(res.statusCode).toBe(404);
  });

  it('vendor users only see members of their own organization', async () => {
    const res = await app.inject({ method: 'GET', url: '/users', headers: auth(a.vendorToken) });
    expect(res.statusCode).toBe(200);
    const orgs = new Set(res.json().map((m: any) => m.orgId));
    expect([...orgs]).toEqual([a.vendorOrgId]);
  });
});

describe('organizations & invitations', () => {
  it('creates a client org, connects it, and invites a user with valid roles only', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/orgs',
      headers: auth(a.adminToken),
      payload: {
        type: 'client',
        name: 'Lakeside Hospitality LLC',
        address: { city: 'Raleigh', region: 'NC' },
      },
    });
    expect(created.statusCode).toBe(201);
    const org = created.json();

    const bad = await app.inject({
      method: 'POST',
      url: '/users/invite',
      headers: auth(a.adminToken),
      payload: { email: 'gm@lakeside.example', name: 'Pat GM', orgId: org.id, roles: ['procurement'] },
    });
    expect(bad.statusCode).toBe(400);

    const ok = await app.inject({
      method: 'POST',
      url: '/users/invite',
      headers: auth(a.adminToken),
      payload: { email: 'gm@lakeside.example', name: 'Pat GM', orgId: org.id, roles: ['client_approver'] },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().inviteUrl).toContain('/accept-invite?token=');

    const members = await app.inject({
      method: 'GET',
      url: `/users?orgId=${org.id}`,
      headers: auth(a.adminToken),
    });
    expect(members.json().map((m: any) => m.email)).toContain('gm@lakeside.example');

    // Tenant B cannot see it.
    const other = await app.inject({
      method: 'GET',
      url: `/users?orgId=${org.id}`,
      headers: auth(b.adminToken),
    });
    expect(other.json()).toHaveLength(0);
  });
});
