import { closeDb } from '@procure/platform';
import { auth, createWorld, type World } from '@procure/platform/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { clients } from '../src/clients.js';
import {
  addUser,
  buildApp,
  INTERNAL,
  notificationsFor,
  outbox,
  type Row,
  stubClients,
  type TestApp,
} from './helpers.js';

let app: TestApp;
let a: World;
let b: World;
let orderManager: { id: string; email: string };

beforeAll(async () => {
  app = await buildApp();
  stubClients();
  a = await createWorld('Alpha');
  b = await createWorld('Bravo');
  orderManager = await addUser(a.tenantId, 'Alpha Order Manager', ['order_manager']);
});
afterAll(async () => {
  await app.close();
  await closeDb();
});

const threadFor = (token: string, q: Record<string, string>) =>
  app.inject({ method: 'GET', url: `/threads/for?${new URLSearchParams(q)}`, headers: auth(token) });
const post = (token: string, threadId: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: `/threads/${threadId}/messages`, headers: auth(token), payload });

describe('thread get-or-create', () => {
  it('is idempotent per entity + audience and gives each thread a reply alias', async () => {
    const entityId = crypto.randomUUID();
    const r1 = await threadFor(a.adminToken, { entityType: 'purchase_order', entityId });
    const r2 = await threadFor(a.adminToken, { entityType: 'purchase_order', entityId });
    expect(r1.statusCode).toBe(200);
    expect(r2.json().id).toBe(r1.json().id);
    expect(r1.json().replyToAddress).toMatch(/^t-[a-z2-7]{8}@inbound\.pro-cure\.local$/);

    // Concurrent first access still yields one thread.
    const other = crypto.randomUUID();
    const all = await Promise.all(
      Array.from({ length: 5 }, () => threadFor(a.adminToken, { entityType: 'quote', entityId: other })),
    );
    expect(new Set(all.map((r) => r.json().id)).size).toBe(1);

    // Vendor audience is a different thread on the same entity.
    const v = await threadFor(a.adminToken, {
      entityType: 'purchase_order',
      entityId,
      visibility: 'vendor',
      vendorOrgId: a.vendorOrgId,
    });
    expect(v.json().id).not.toBe(r1.json().id);
    expect(v.json().visibility).toBe('vendor');
  });

  it('requires the org for vendor/client threads', async () => {
    const r = await threadFor(a.adminToken, {
      entityType: 'project',
      entityId: crypto.randomUUID(),
      visibility: 'client',
    });
    expect(r.statusCode).toBe(422);
  });

  it('internal endpoint is idempotent too', async () => {
    const body = {
      tenantId: a.tenantId,
      entityType: 'purchase_order',
      entityId: crypto.randomUUID(),
      subject: 'PO PO-26-0001',
      visibility: 'vendor',
      vendorOrgId: a.vendorOrgId,
    };
    const r1 = await app.inject({
      method: 'POST',
      url: '/internal/threads',
      headers: INTERNAL,
      payload: body,
    });
    const r2 = await app.inject({
      method: 'POST',
      url: '/internal/threads',
      headers: INTERNAL,
      payload: body,
    });
    expect(r1.statusCode).toBe(200);
    expect(r2.json().id).toBe(r1.json().id);
    const noSecret = await app.inject({ method: 'POST', url: '/internal/threads', payload: body });
    expect(noSecret.statusCode).toBe(403);
  });
});

describe('posting messages', () => {
  it('updates counters, emits comms.message.posted and tracks unread', async () => {
    const t = (
      await threadFor(a.adminToken, { entityType: 'project', entityId: crypto.randomUUID() })
    ).json();
    const r = await post(a.adminToken, t.id, { bodyText: 'Kickoff notes attached' });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ direction: 'internal', channel: 'app', authorActor: 'internal' });

    const detail = (
      await app.inject({ method: 'GET', url: `/threads/${t.id}`, headers: auth(a.adminToken) })
    ).json();
    expect(detail.messageCount).toBe(1);
    expect(detail.lastMessageAt).toBeTruthy();
    expect(detail.unreadCount).toBe(0); // author has read it
    expect(detail.messages.items[0].bodyText).toBe('Kickoff notes attached');
    expect(detail.participants[0]).toMatchObject({ name: 'Test User', messageCount: 1 });

    const events = await outbox(a.tenantId, 'comms.message.posted');
    expect(events.some((e) => e.data.messageId === r.json().id && e.data.threadId === t.id)).toBe(true);

    // Another user sees it as unread until they mark the thread read.
    const pmToken = await a.tokenAs(['project_manager'], orderManager.id);
    const list = (
      await app.inject({ method: 'GET', url: `/threads?entityId=${t.entityId}`, headers: auth(pmToken) })
    ).json();
    expect(list.items[0]).toMatchObject({
      unreadCount: 1,
      lastMessage: { preview: 'Kickoff notes attached' },
    });
    const unread = (
      await app.inject({ method: 'GET', url: '/threads?unread=true&limit=200', headers: auth(pmToken) })
    ).json();
    expect(unread.items.map((i: Row) => i.id)).toContain(t.id);
    await app.inject({ method: 'POST', url: `/threads/${t.id}/read`, headers: auth(pmToken) });
    const after = (
      await app.inject({ method: 'GET', url: `/threads?entityId=${t.entityId}`, headers: auth(pmToken) })
    ).json();
    expect(after.items[0].unreadCount).toBe(0);
  });

  it('mentions notify the mentioned users', async () => {
    const t = (await threadFor(a.adminToken, { entityType: 'quote', entityId: crypto.randomUUID() })).json();
    const designer = await addUser(a.tenantId, 'Alpha Designer', ['designer']);
    await post(a.adminToken, t.id, { bodyText: '@designer please check finishes', mentions: [designer.id] });
    const n = await notificationsFor(designer.id);
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ type: 'mention' });
    expect(n[0]!.link).toContain(`thread=${t.id}`);

    const token = await a.tokenAs(['designer'], designer.id);
    const mine = (
      await app.inject({ method: 'GET', url: '/threads?mine=true', headers: auth(token) })
    ).json();
    expect(mine.items.map((i: Row) => i.id)).toContain(t.id);
  });

  it('emailTo sends the message out with the thread as reply-to', async () => {
    const t = (
      await threadFor(a.adminToken, { entityType: 'purchase_order', entityId: crypto.randomUUID() })
    ).json();
    const r = await post(a.adminToken, t.id, {
      bodyText: 'Please confirm ship date.',
      emailTo: ['rep@vendor.example'],
    });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ direction: 'outbound', channel: 'email' });
    expect(r.json().emailMessageId).toMatch(/^<.+@inbound\.pro-cure\.local>$/);
    const emails = (
      await app.inject({ method: 'GET', url: `/emails?threadId=${t.id}`, headers: auth(a.adminToken) })
    ).json();
    expect(emails.items).toHaveLength(1);
    const detail = (
      await app.inject({ method: 'GET', url: `/emails/${emails.items[0].id}`, headers: auth(a.adminToken) })
    ).json();
    expect(detail).toMatchObject({
      status: 'delivered-local',
      replyTo: t.replyToAddress,
      to: ['rep@vendor.example'],
    });
    // One thread message (not duplicated by the email log).
    const th = (
      await app.inject({ method: 'GET', url: `/threads/${t.id}`, headers: auth(a.adminToken) })
    ).json();
    expect(th.messageCount).toBe(1);
  });

  it('validates input and permissions', async () => {
    const t = (
      await threadFor(a.adminToken, { entityType: 'project', entityId: crypto.randomUUID() })
    ).json();
    expect((await post(a.adminToken, t.id, { bodyText: '   ' })).statusCode).toBe(400);
    const viewer = await a.tokenAs(['viewer']);
    expect((await post(viewer, t.id, { bodyText: 'hi' })).statusCode).toBe(403);
    expect((await post(a.adminToken, crypto.randomUUID(), { bodyText: 'hi' })).statusCode).toBe(404);
  });
});

describe('vendor portal', () => {
  it('vendor can read and post only on its vendor-visible threads', async () => {
    const poId = crypto.randomUUID();
    const internal = (await threadFor(a.adminToken, { entityType: 'purchase_order', entityId: poId })).json();
    await post(a.adminToken, internal.id, { bodyText: 'Margin on this PO is thin — internal only' });
    const vt = (
      await threadFor(a.adminToken, {
        entityType: 'purchase_order',
        entityId: poId,
        visibility: 'vendor',
        vendorOrgId: a.vendorOrgId,
      })
    ).json();
    await post(a.adminToken, vt.id, { bodyText: 'Please send the order acknowledgement.' });

    // Vendor lists: only its vendor thread.
    const list = await app.inject({ method: 'GET', url: '/vendor/threads', headers: auth(a.vendorToken) });
    expect(list.statusCode).toBe(200);
    const ids = list.json().items.map((i: Row) => i.id);
    expect(ids).toContain(vt.id);
    expect(ids).not.toContain(internal.id);
    expect(list.json().items[0]).not.toHaveProperty('vendorOrgId');
    const general = (
      await app.inject({ method: 'GET', url: '/threads', headers: auth(a.vendorToken) })
    ).json();
    expect(general.items.every((i: Row) => i.visibility === 'vendor')).toBe(true);

    // Internal thread is invisible (404, not 403 — no existence leak).
    expect(
      (await app.inject({ method: 'GET', url: `/threads/${internal.id}`, headers: auth(a.vendorToken) }))
        .statusCode,
    ).toBe(404);
    expect((await post(a.vendorToken, internal.id, { bodyText: 'sneaky' })).statusCode).toBe(404);

    // Vendor reads its thread with stripped fields.
    const d = await app.inject({ method: 'GET', url: `/threads/${vt.id}`, headers: auth(a.vendorToken) });
    expect(d.statusCode).toBe(200);
    expect(d.json().messages.items[0]).not.toHaveProperty('authorEmail');
    expect(d.json().messages.items[0]).not.toHaveProperty('mentions');
    expect(d.json()).not.toHaveProperty('emailAlias');

    // get-or-create as vendor returns its own thread; never internal ones.
    const own = await threadFor(a.vendorToken, {
      entityType: 'purchase_order',
      entityId: poId,
      visibility: 'vendor',
    });
    expect(own.json().id).toBe(vt.id);
    expect(
      (await threadFor(a.vendorToken, { entityType: 'purchase_order', entityId: poId })).statusCode,
    ).toBe(403);
    expect(
      (
        await threadFor(a.vendorToken, {
          entityType: 'purchase_order',
          entityId: crypto.randomUUID(),
          visibility: 'vendor',
        })
      ).statusCode,
    ).toBe(404);

    // Vendor posts: inbound message, order managers notified, counters bumped.
    const r = await post(a.vendorToken, vt.id, {
      bodyText: 'Acknowledged — ships week of 11/10.',
      mentions: [a.adminId],
    });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ direction: 'inbound', authorActor: 'vendor', mine: true });
    expect((await post(a.vendorToken, vt.id, { bodyText: 'x', emailTo: ['a@b.co'] })).statusCode).toBe(403);
    const n = await notificationsFor(orderManager.id);
    expect(n.some((x) => x.type === 'message' && x.title.startsWith('New message from Test User'))).toBe(
      true,
    );
    expect(n.find((x) => x.type === 'message')!.link).toContain('/app/orders/');
    // mentions from portal actors are ignored
    expect((await notificationsFor(a.adminId)).some((x) => x.type === 'mention')).toBe(false);

    const staffView = (
      await app.inject({ method: 'GET', url: `/threads/${vt.id}`, headers: auth(a.adminToken) })
    ).json();
    expect(staffView.messageCount).toBe(2);
    expect(staffView.unreadCount).toBe(1);

    // Vendor can mark read.
    expect(
      (await app.inject({ method: 'POST', url: `/threads/${vt.id}/read`, headers: auth(a.vendorToken) }))
        .statusCode,
    ).toBe(200);
  });

  it("another tenant's vendor cannot see the thread", async () => {
    const vt = (
      await threadFor(a.adminToken, {
        entityType: 'cost_request',
        entityId: crypto.randomUUID(),
        visibility: 'vendor',
        vendorOrgId: a.vendorOrgId,
      })
    ).json();
    expect(
      (await app.inject({ method: 'GET', url: `/threads/${vt.id}`, headers: auth(b.vendorToken) }))
        .statusCode,
    ).toBe(404);
    expect((await post(b.vendorToken, vt.id, { bodyText: 'hi' })).statusCode).toBe(404);
  });

  it('client actors cannot use the vendor list', async () => {
    expect(
      (await app.inject({ method: 'GET', url: '/vendor/threads', headers: auth(a.clientToken) })).statusCode,
    ).toBe(403);
  });
});

describe('client portal', () => {
  it('client sees only its client threads and can open one on its own project', async () => {
    const projectId = crypto.randomUUID();
    const internal = (await threadFor(a.adminToken, { entityType: 'project', entityId: projectId })).json();
    const vendorT = (
      await threadFor(a.adminToken, {
        entityType: 'project',
        entityId: projectId,
        visibility: 'vendor',
        vendorOrgId: a.vendorOrgId,
      })
    ).json();

    // Not their project → 404; their project → created.
    vi.mocked(clients.portalCanSee).mockResolvedValueOnce(false);
    expect(
      (await threadFor(a.clientToken, { entityType: 'project', entityId: projectId, visibility: 'client' }))
        .statusCode,
    ).toBe(404);
    vi.mocked(clients.portalCanSee).mockResolvedValueOnce(true);
    const ct = await threadFor(a.clientToken, {
      entityType: 'project',
      entityId: projectId,
      visibility: 'client',
    });
    expect(ct.statusCode).toBe(200);
    expect(ct.json()).not.toHaveProperty('clientOrgId');

    // Vendors can start a conversation on a cost request they can see, but not one they can't.
    const crId = crypto.randomUUID();
    const vq = { entityType: 'cost_request', entityId: crId, visibility: 'vendor' };
    vi.mocked(clients.portalCanSee).mockResolvedValueOnce(false);
    expect((await threadFor(a.vendorToken, vq)).statusCode).toBe(404);
    vi.mocked(clients.portalCanSee).mockResolvedValueOnce(true);
    const vt = await threadFor(a.vendorToken, vq);
    expect(vt.statusCode).toBe(200);
    expect(vi.mocked(clients.portalCanSee).mock.lastCall?.slice(1)).toEqual([
      'quoting',
      `/vendor/cost-requests/${crId}`,
    ]);

    const pm =await addUser(a.tenantId, 'Alpha PM', ['project_manager']);
    const r = await post(a.clientToken, ct.json().id, { bodyText: 'When will the lobby chairs arrive?' });
    expect(r.statusCode).toBe(201);
    expect((await notificationsFor(pm.id)).some((n) => n.type === 'message')).toBe(true);

    const list = (
      await app.inject({ method: 'GET', url: '/client/threads', headers: auth(a.clientToken) })
    ).json();
    const ids = list.items.map((i: Row) => i.id);
    expect(ids).toContain(ct.json().id);
    expect(ids).not.toContain(internal.id);
    expect(ids).not.toContain(vendorT.id);
    for (const id of [internal.id, vendorT.id])
      expect(
        (await app.inject({ method: 'GET', url: `/threads/${id}`, headers: auth(a.clientToken) })).statusCode,
      ).toBe(404);

    // Staff see the client thread and the client's message.
    const staff = (
      await app.inject({ method: 'GET', url: `/threads/${ct.json().id}`, headers: auth(a.adminToken) })
    ).json();
    expect(staff.messages.items[0]).toMatchObject({ authorActor: 'client', authorOrgId: a.clientOrgId });

    // Vendor of the same tenant cannot see the client thread.
    expect(
      (await app.inject({ method: 'GET', url: `/threads/${ct.json().id}`, headers: auth(a.vendorToken) }))
        .statusCode,
    ).toBe(404);
  });
});

describe('tenant isolation', () => {
  it("staff cannot see or post to another tenant's threads", async () => {
    const t = (
      await threadFor(a.adminToken, { entityType: 'project', entityId: crypto.randomUUID() })
    ).json();
    await post(a.adminToken, t.id, { bodyText: 'Alpha only' });
    expect(
      (await app.inject({ method: 'GET', url: `/threads/${t.id}`, headers: auth(b.adminToken) })).statusCode,
    ).toBe(404);
    expect((await post(b.adminToken, t.id, { bodyText: 'x' })).statusCode).toBe(404);
    const list = (
      await app.inject({ method: 'GET', url: '/threads?limit=200', headers: auth(b.adminToken) })
    ).json();
    expect(list.items.map((i: Row) => i.id)).not.toContain(t.id);
    // Same entity id in tenant B is a separate thread.
    const tb = (await threadFor(b.adminToken, { entityType: 'project', entityId: t.entityId })).json();
    expect(tb.id).not.toBe(t.id);
  });

  it('paginates thread lists', async () => {
    const entityId = crypto.randomUUID();
    for (const vis of ['internal', 'vendor'] as const)
      await threadFor(a.adminToken, {
        entityType: 'quote',
        entityId,
        visibility: vis,
        ...(vis === 'vendor' ? { vendorOrgId: a.vendorOrgId } : {}),
      });
    const p1 = (
      await app.inject({
        method: 'GET',
        url: `/threads?entityId=${entityId}&limit=1`,
        headers: auth(a.adminToken),
      })
    ).json();
    expect(p1).toMatchObject({ total: 2, limit: 1, offset: 0 });
    expect(p1.items).toHaveLength(1);
    const p3 = (
      await app.inject({
        method: 'GET',
        url: `/threads?entityId=${entityId}&limit=1&offset=5`,
        headers: auth(a.adminToken),
      })
    ).json();
    expect(p3).toMatchObject({ total: 2, items: [] });
  });
});
