import type { AddressInfo } from 'node:net';
import { closeDb, withOwner } from '@procure/platform';
import { auth, createWorld, type World } from '@procure/platform/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sseTiming } from '../src/routes/notifications.js';
import { buildApp, deliver, type Row, stubClients, type TestApp } from './helpers.js';

let app: TestApp;
let a: World;
let b: World;
let base: string;

beforeAll(async () => {
  sseTiming.pollMs = 100;
  sseTiming.heartbeatMs = 150;
  app = await buildApp();
  stubClients();
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  a = await createWorld('Notif');
  b = await createWorld('NotifB');
});
afterAll(async () => {
  await app.close();
  await closeDb();
});

const notifyAdmin = (w: World, title: string, severity = 'info') =>
  deliver(app, 'cmd.notify', w.tenantId, {
    userIds: [w.adminId],
    roles: [],
    title,
    body: 'b',
    link: '/app/inbox',
    severity,
  });

describe('notifications API', () => {
  it('lists, counts and marks read; scoped to the recipient', async () => {
    await notifyAdmin(a, 'First');
    await notifyAdmin(a, 'Second', 'warning');
    const list = (
      await app.inject({ method: 'GET', url: '/notifications', headers: auth(a.adminToken) })
    ).json();
    expect(list.unreadCount).toBe(2);
    expect(list.items.map((n: Row) => n.title)).toEqual(['Second', 'First']);

    // Another user in the same tenant sees nothing; other tenant cannot mark it read.
    const other = await a.tokenAs(['order_manager'], a.vendorUserId);
    expect(
      (await app.inject({ method: 'GET', url: '/notifications', headers: auth(other) })).json().items,
    ).toHaveLength(0);
    const id = list.items[0].id;
    expect(
      (await app.inject({ method: 'POST', url: `/notifications/${id}/read`, headers: auth(b.adminToken) }))
        .statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: 'POST', url: `/notifications/${id}/read`, headers: auth(other) }))
        .statusCode,
    ).toBe(404);

    const read = await app.inject({
      method: 'POST',
      url: `/notifications/${id}/read`,
      headers: auth(a.adminToken),
    });
    expect(read.json().readAt).toBeTruthy();
    const unread = (
      await app.inject({ method: 'GET', url: '/notifications?unreadOnly=true', headers: auth(a.adminToken) })
    ).json();
    expect(unread).toMatchObject({ unreadCount: 1, items: [{ title: 'First' }] });
    const all = (
      await app.inject({ method: 'POST', url: '/notifications/read-all', headers: auth(a.adminToken) })
    ).json();
    expect(all.updated).toBe(1);
  });

  it('vendor and client users get their own notifications', async () => {
    await deliver(app, 'cmd.notify', a.tenantId, {
      userIds: [a.vendorUserId, a.clientUserId],
      roles: [],
      title: 'Portal note',
      body: '',
      link: null,
    });
    for (const token of [a.vendorToken, a.clientToken]) {
      const r = (await app.inject({ method: 'GET', url: '/notifications', headers: auth(token) })).json();
      expect(r.items.map((n: Row) => n.title)).toContain('Portal note');
    }
  });

  it('preferences round-trip with defaults', async () => {
    expect(
      (
        await app.inject({ method: 'GET', url: '/notification-preferences', headers: auth(b.adminToken) })
      ).json(),
    ).toEqual({ emailDigest: 'none', mutedTypes: [] });
    await app.inject({
      method: 'PUT',
      url: '/notification-preferences',
      headers: auth(b.adminToken),
      payload: { emailDigest: 'immediate_critical', mutedTypes: ['mention', 'mention'] },
    });
    expect(
      (
        await app.inject({ method: 'GET', url: '/notification-preferences', headers: auth(b.adminToken) })
      ).json(),
    ).toEqual({ emailDigest: 'immediate_critical', mutedTypes: ['mention'] });
    // immediate_critical → a critical notification also queues an email
    await notifyAdmin(b, 'Ship date after hotel opening', 'critical');
    const cmds = await withOwner(
      (tx) => tx<Row[]>`
      select data from platform.outbox where tenant_id = ${b.tenantId} and type = 'cmd.email.send'`,
    );
    expect(cmds.find((c) => c.data.subject === 'Ship date after hotel opening')?.data.to).toHaveLength(1);
  });
});

describe('SSE stream', () => {
  async function open(url: string, headers: Record<string, string> = {}) {
    const ctrl = new AbortController();
    const res = await fetch(url, { headers, signal: ctrl.signal });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const until = async (pred: (s: string) => boolean, ms = 4000) => {
      const deadline = Date.now() + ms;
      while (!pred(buf)) {
        if (Date.now() > deadline) throw new Error(`timeout; got: ${buf}`);
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value);
      }
      return buf;
    };
    return { res, until, close: () => ctrl.abort() };
  }

  it('pushes new notifications (token via query) and heartbeats', async () => {
    await notifyAdmin(a, 'Before connect');
    const s = await open(`${base}/notifications/stream?token=${encodeURIComponent(a.adminToken)}`);
    expect(s.res.status).toBe(200);
    expect(s.res.headers.get('content-type')).toContain('text/event-stream');
    await s.until((x) => x.includes(': connected'));
    await notifyAdmin(a, 'Live update');
    const out = await s.until((x) => x.includes('Live update') && x.includes(': heartbeat'));
    expect(out).toContain('event: notification');
    expect(out).not.toContain('Before connect');
    expect(out.match(/Live update/g)).toHaveLength(1);
    const data = JSON.parse(/data: (.+)\n/.exec(out)![1]!);
    expect(data).toMatchObject({ title: 'Live update', link: '/app/inbox' });
    s.close();
  });

  it('accepts a bearer header and never streams other users or tenants', async () => {
    const s = await open(`${base}/notifications/stream`, auth(b.adminToken));
    await s.until((x) => x.includes(': connected'));
    await notifyAdmin(a, 'Alpha secret');
    await notifyAdmin(b, 'Bravo update');
    const out = await s.until((x) => x.includes('Bravo update'));
    expect(out).not.toContain('Alpha secret');
    s.close();
  });

  it('rejects missing or bad tokens', async () => {
    expect((await fetch(`${base}/notifications/stream`)).status).toBe(401);
    expect((await fetch(`${base}/notifications/stream?token=garbage`)).status).toBe(401);
  });
});

describe('emails & mailboxes admin', () => {
  it('requires org:admin and is tenant scoped', async () => {
    await deliver(app, 'cmd.email.send', a.tenantId, {
      to: ['x@y.example'],
      subject: 'Alpha mail',
      text: 'hi',
      html: null,
      replyTo: null,
      threadId: null,
    });
    const list = (
      await app.inject({ method: 'GET', url: '/emails?q=Alpha', headers: auth(a.adminToken) })
    ).json();
    expect(list.items[0]).toMatchObject({ subject: 'Alpha mail', status: 'delivered-local' });
    expect(
      (await app.inject({ method: 'GET', url: `/emails/${list.items[0].id}`, headers: auth(b.adminToken) }))
        .statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: 'GET', url: '/emails', headers: auth(await a.tokenAs(['order_manager'])) }))
        .statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ method: 'GET', url: '/emails', headers: auth(a.vendorToken) })).statusCode,
    ).toBe(403);

    const mb = (
      await app.inject({
        method: 'POST',
        url: '/mailboxes',
        headers: auth(a.adminToken),
        payload: { address: '@notif-a.example' },
      })
    ).json();
    expect(
      (await app.inject({ method: 'DELETE', url: `/mailboxes/${mb.id}`, headers: auth(b.adminToken) }))
        .statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: 'DELETE', url: `/mailboxes/${mb.id}`, headers: auth(a.adminToken) }))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/mailboxes',
          headers: auth(a.adminToken),
          payload: { address: 'no-at-sign' },
        })
      ).statusCode,
    ).toBe(400);
  });
});
