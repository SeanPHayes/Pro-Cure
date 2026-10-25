import { closeDb, withOwner } from '@procure/platform';
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
  rawEmail,
  storedDocs,
  stubClients,
  type TestApp,
} from './helpers.js';

let app: TestApp;
let a: World;
let b: World;
let orderManager: { id: string };

beforeAll(async () => {
  app = await buildApp();
  stubClients();
  a = await createWorld('Inbox');
  b = await createWorld('Other');
  orderManager = await addUser(a.tenantId, 'Inbox Order Manager', ['order_manager']);
});
afterAll(async () => {
  await app.close();
  await closeDb();
});

const vendorThread = async (entityId = crypto.randomUUID()) =>
  (
    await app.inject({
      method: 'GET',
      url: `/threads/for?entityType=purchase_order&entityId=${entityId}&visibility=vendor&vendorOrgId=${a.vendorOrgId}`,
      headers: auth(a.adminToken),
    })
  ).json();

const raw = (rawBase64: string) =>
  app.inject({ method: 'POST', url: '/inbound/raw', headers: INTERNAL, payload: { rawBase64 } });

describe('inbound via thread alias', () => {
  it('routes automatically, strips the quoted reply and stores files', async () => {
    const t = await vendorThread();
    const res = await raw(
      rawEmail({
        from: 'Vince Vendor <vince@vendor.example>',
        to: `PO Desk <${t.replyToAddress}>`,
        subject: `Re: ${t.subject}`,
        text: 'Confirmed, shipping 11/14.\n\nOn Mon, Oct 20, 2026 at 9:00 AM Inbox Procurement <noreply@pro-cure.local> wrote:\n> Please confirm the ship date.\n',
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'routed',
      routedThreadId: t.id,
      tenantResolved: true,
      duplicate: false,
    });

    const d = (
      await app.inject({ method: 'GET', url: `/threads/${t.id}`, headers: auth(a.adminToken) })
    ).json();
    expect(d.messages.items).toHaveLength(1);
    expect(d.messages.items[0]).toMatchObject({
      direction: 'inbound',
      channel: 'email',
      authorName: 'Vince Vendor',
      authorEmail: 'vince@vendor.example',
      authorActor: 'email',
      authorOrgId: a.vendorOrgId,
      bodyText: 'Confirmed, shipping 11/14.',
    });
    const inbound = (
      await app.inject({ method: 'GET', url: `/inbound/${res.json().id}`, headers: auth(a.adminToken) })
    ).json();
    expect(inbound.routing).toMatchObject({ method: 'alias', confidence: 1 });
    expect(inbound.rawDocumentId).toBeTruthy();
    expect(storedDocs.get(inbound.rawDocumentId)?.contentType).toBe('message/rfc822');
    expect((await notificationsFor(orderManager.id)).some((n) => n.type === 'message')).toBe(true);

    // The vendor sees the emailed reply in the portal.
    const v = (
      await app.inject({ method: 'GET', url: `/threads/${t.id}`, headers: auth(a.vendorToken) })
    ).json();
    expect(v.messages.items[0].bodyText).toBe('Confirmed, shipping 11/14.');
  });

  it('attributes the sender to a known vendor user and is idempotent on Message-ID', async () => {
    const t = await vendorThread();
    const vendorEmail = await withOwner(async (tx) => {
      const [u] = await tx<
        { email: string }[]
      >`select email from identity.users where id = ${a.vendorUserId}`;
      return u!.email;
    });
    const msg = rawEmail({
      from: vendorEmail,
      to: t.replyToAddress,
      subject: 'OA attached',
      text: 'See attached.',
      messageId: '<fixed-1@vendor.example>',
    });
    const r1 = await raw(msg);
    const r2 = await raw(msg);
    expect(r2.json()).toMatchObject({ id: r1.json().id, duplicate: true });
    const d = (
      await app.inject({ method: 'GET', url: `/threads/${t.id}`, headers: auth(a.adminToken) })
    ).json();
    expect(d.messageCount).toBe(1);
    expect(d.messages.items[0]).toMatchObject({ authorActor: 'vendor', authorUserId: a.vendorUserId });
  });

  it('ignores aliases on other domains', async () => {
    const t = await vendorThread();
    const res = await raw(
      rawEmail({
        from: 'x@spam.example',
        to: t.replyToAddress.replace('@inbound.pro-cure.local', '@evil.example'),
        subject: 'hi',
        text: 'hi',
      }),
    );
    expect(res.json()).toMatchObject({ status: 'ignored', tenantResolved: false });
  });
});

describe('inbound without alias', () => {
  it('resolves the tenant via mailbox, parks as pending and emits comms.inbound_email.received', async () => {
    const mb = await app.inject({
      method: 'POST',
      url: '/mailboxes',
      headers: auth(a.adminToken),
      payload: { address: 'Purchasing@Inbox-Hotels.example' },
    });
    expect(mb.statusCode).toBe(201);
    expect(mb.json().address).toBe('purchasing@inbox-hotels.example');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/mailboxes',
          headers: auth(b.adminToken),
          payload: { address: 'purchasing@inbox-hotels.example' },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (await app.inject({ method: 'GET', url: '/mailboxes', headers: auth(b.adminToken) })).json(),
    ).toHaveLength(0);

    const res = await app.inject({
      method: 'POST',
      url: '/inbound/ses',
      headers: INTERNAL,
      payload: {
        rawBase64: rawEmail({
          from: 'ap@vendor.example',
          to: 'purchasing@inbox-hotels.example',
          subject: 'Proforma invoice PO-26-0042',
          text: 'Deposit invoice attached.',
        }),
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'pending', tenantResolved: true, routedThreadId: null });
    const events = await outbox(a.tenantId, 'comms.inbound_email.received');
    expect(events.map((e) => e.data.inboundEmailId)).toContain(res.json().id);

    // The AI service reads it via the internal endpoint.
    const ai = await app.inject({
      method: 'GET',
      url: `/internal/inbound/${res.json().id}?tenantId=${a.tenantId}`,
      headers: INTERNAL,
    });
    expect(ai.json()).toMatchObject({
      from: 'ap@vendor.example',
      subject: 'Proforma invoice PO-26-0042',
      status: 'pending',
    });
    // Not visible to another tenant's internal call.
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/internal/inbound/${res.json().id}?tenantId=${b.tenantId}`,
          headers: INTERNAL,
        })
      ).statusCode,
    ).toBe(404);

    const list = (
      await app.inject({
        method: 'GET',
        url: '/inbound?status=pending&q=Proforma',
        headers: auth(a.adminToken),
      })
    ).json();
    expect(list.items.map((i: Row) => i.id)).toContain(res.json().id);
    expect(
      (await app.inject({ method: 'GET', url: '/inbound?q=Proforma', headers: auth(b.adminToken) })).json()
        .total,
    ).toBe(0);
  });

  it('simulate delivers through the same pipeline with attachments', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/inbound/simulate',
      headers: auth(a.adminToken),
      payload: {
        from: 'drawings@vendor.example',
        fromName: 'Drawings Dept',
        to: 'orders@somewhere.example',
        subject: 'Line drawings for review',
        text: 'Attached are the line drawings.',
        attachments: [
          {
            filename: 'drawings.pdf',
            contentType: 'application/pdf',
            base64: Buffer.from('%PDF-1.4 x').toString('base64'),
          },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'pending', tenantResolved: true });
    const d = (
      await app.inject({ method: 'GET', url: `/inbound/${res.json().id}`, headers: auth(a.adminToken) })
    ).json();
    expect(d.fromName).toBe('Drawings Dept');
    expect(d.attachments).toEqual([
      expect.objectContaining({ filename: 'drawings.pdf', contentType: 'application/pdf' }),
    ]);
    expect(d.source).toBe('simulate');

    // Requires inbox:triage.
    const designer = await a.tokenAs(['designer']);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/inbound/simulate',
          headers: auth(designer),
          payload: { from: 'a@b.co', to: 'c@d.co' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/inbound/simulate',
          headers: auth(a.vendorToken),
          payload: { from: 'a@b.co', to: 'c@d.co' },
        })
      ).statusCode,
    ).toBe(403);
  });

  it('manual route files the email on a thread with its attachments', async () => {
    const sim = await app.inject({
      method: 'POST',
      url: '/inbound/simulate',
      headers: auth(a.adminToken),
      payload: {
        from: 'oa@vendor.example',
        to: 'orders@somewhere.example',
        subject: 'Order acknowledgement',
        text: 'OA attached.',
        attachments: [
          {
            filename: 'oa.pdf',
            contentType: 'application/pdf',
            base64: Buffer.from('%PDF').toString('base64'),
          },
        ],
      },
    });
    const poId = crypto.randomUUID();
    const r = await app.inject({
      method: 'POST',
      url: `/inbound/${sim.json().id}/route`,
      headers: auth(a.adminToken),
      payload: {
        entityType: 'purchase_order',
        entityId: poId,
        visibility: 'vendor',
        vendorOrgId: a.vendorOrgId,
      },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({
      status: 'routed',
      routedEntityId: poId,
      routing: { method: 'manual' },
      triagedByName: 'Test User',
    });
    const thread = (
      await app.inject({
        method: 'GET',
        url: `/threads/${r.json().routedThreadId}`,
        headers: auth(a.adminToken),
      })
    ).json();
    expect(thread.messages.items[0].attachmentDocumentIds).toEqual([r.json().attachments[0].documentId]);
    // Repeat is a no-op.
    await app.inject({
      method: 'POST',
      url: `/inbound/${sim.json().id}/route`,
      headers: auth(a.adminToken),
      payload: {
        entityType: 'purchase_order',
        entityId: poId,
        visibility: 'vendor',
        vendorOrgId: a.vendorOrgId,
      },
    });
    expect(
      (await app.inject({ method: 'GET', url: `/threads/${thread.id}`, headers: auth(a.adminToken) })).json()
        .messageCount,
    ).toBe(1);
    // Cannot ignore a routed email.
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/inbound/${sim.json().id}/ignore`,
          headers: auth(a.adminToken),
        })
      ).statusCode,
    ).toBe(409);
    // Other tenant cannot touch it.
    expect(
      (await app.inject({ method: 'GET', url: `/inbound/${sim.json().id}`, headers: auth(b.adminToken) }))
        .statusCode,
    ).toBe(404);
  });

  it('ignore dismisses a pending email', async () => {
    const sim = await app.inject({
      method: 'POST',
      url: '/inbound/simulate',
      headers: auth(a.adminToken),
      payload: { from: 'news@letter.example', to: 'x@y.example', subject: 'Newsletter', text: 'Sale!' },
    });
    const r = await app.inject({
      method: 'POST',
      url: `/inbound/${sim.json().id}/ignore`,
      headers: auth(a.adminToken),
    });
    expect(r.json()).toMatchObject({ status: 'ignored', triagedByName: 'Test User' });
  });
});

describe('AI routing (internal)', () => {
  const pending = async (subject: string) =>
    (
      await app.inject({
        method: 'POST',
        url: '/inbound/simulate',
        headers: auth(a.adminToken),
        payload: { from: 'v@vendor.example', to: 'x@y.example', subject, text: 'Tracking 1Z999 via UPS' },
      })
    ).json().id as string;
  const route = (id: string, payload: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: `/internal/inbound/${id}/route?tenantId=${a.tenantId}`,
      headers: INTERNAL,
      payload,
    });

  it('needs_review stores suggestions and reasons; applying them calls orders', async () => {
    const id = await pending('Tracking for PO-26-0007');
    const shipmentId = crypto.randomUUID();
    const poId = crypto.randomUUID();
    const r = await route(id, {
      status: 'needs_review',
      entityType: 'purchase_order',
      entityId: poId,
      vendorOrgId: a.vendorOrgId,
      confidence: 0.62,
      reasons: ['PO number PO-26-0007 in subject', 'Sender domain matches vendor'],
      suggestions: [
        {
          type: 'set_tracking',
          label: 'Add UPS 1Z999 to shipment 1',
          payload: { shipmentId, carrier: 'UPS', trackingNumber: '1Z999' },
        },
        {
          type: 'complete_requirement',
          label: 'Mark OA received',
          payload: { poId, kind: 'order_acknowledgement' },
        },
      ],
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body).toMatchObject({ status: 'needs_review', routing: { method: 'ai', confidence: 0.62 } });
    expect(body.routing.reasons).toHaveLength(2);
    expect(body.suggestions.map((s: Row) => s.type)).toEqual([
      'route_to_thread',
      'set_tracking',
      'complete_requirement',
    ]);

    const t1 = await app.inject({
      method: 'POST',
      url: `/inbound/${id}/suggestions/1/apply`,
      headers: auth(a.adminToken),
    });
    expect(t1.statusCode).toBe(200);
    expect(clients.setShipmentTracking).toHaveBeenCalledWith(a.tenantId, shipmentId, {
      carrier: 'UPS',
      trackingNumber: '1Z999',
    });
    expect(t1.json().suggestions[1].appliedAt).toBeTruthy();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/inbound/${id}/suggestions/1/apply`,
          headers: auth(a.adminToken),
        })
      ).statusCode,
    ).toBe(409);

    vi.mocked(clients.setPoRequirement).mockRejectedValueOnce(new Error('orders: PO not found'));
    const t2 = await app.inject({
      method: 'POST',
      url: `/inbound/${id}/suggestions/2/apply`,
      headers: auth(a.adminToken),
    });
    expect(t2.json().suggestions[2].error).toContain('PO not found');

    const t0 = await app.inject({
      method: 'POST',
      url: `/inbound/${id}/suggestions/0/apply`,
      headers: auth(a.adminToken),
    });
    expect(t0.json()).toMatchObject({ status: 'routed', routedEntityId: poId, routing: { method: 'ai' } });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/inbound/${id}/suggestions/9/apply`,
          headers: auth(a.adminToken),
        })
      ).statusCode,
    ).toBe(422);
  });

  it('route_to_po suggestions file the email; update_ship_date records an explanatory error', async () => {
    const id = await pending('Updated ship schedule');
    const poId = crypto.randomUUID();
    const r = await route(id, {
      status: 'needs_review',
      confidence: 0.4,
      reasons: ['2 possible purchase orders — needs a human'],
      suggestions: [
        {
          type: 'route_to_po',
          label: 'Route to PO-26-0009',
          payload: { entityType: 'purchase_order', entityId: poId, poNumber: 'PO-26-0009' },
        },
        { type: 'update_ship_date', label: 'Update ship date', payload: { poId, newShipDate: '2026-11-18' } },
      ],
    });
    // route_to_po counts as a routing suggestion: no extra route_to_thread is prepended.
    expect(r.json().suggestions.map((s: Row) => s.type)).toEqual(['route_to_po', 'update_ship_date']);
    const u = await app.inject({
      method: 'POST',
      url: `/inbound/${id}/suggestions/1/apply`,
      headers: auth(a.adminToken),
    });
    expect(u.json().suggestions[1].error).toMatch(/not applied automatically/);
    const t = await app.inject({
      method: 'POST',
      url: `/inbound/${id}/suggestions/0/apply`,
      headers: auth(a.adminToken),
    });
    expect(t.json()).toMatchObject({
      status: 'routed',
      routedEntityType: 'purchase_order',
      routedEntityId: poId,
    });
  });

  it('set_tracking with only a poId uses that PO’s open shipment without tracking', async () => {
    const id = await pending('Tracking by PO');
    const poId = crypto.randomUUID();
    const shipped = crypto.randomUUID();
    const open = crypto.randomUUID();
    vi.mocked(clients.listOpenShipments).mockResolvedValueOnce([
      { id: shipped, poId, hasTracking: true, estimatedShipDate: null },
      { id: open, poId, hasTracking: false, estimatedShipDate: null },
      { id: crypto.randomUUID(), poId: crypto.randomUUID(), hasTracking: false, estimatedShipDate: null },
    ]);
    await route(id, {
      status: 'needs_review',
      confidence: 0.7,
      reasons: [],
      suggestions: [
        { type: 'set_tracking', label: 'Add UPS', payload: { poId, carrier: 'UPS', trackingNumber: '1Z1' } },
      ],
    });
    const r = await app.inject({
      method: 'POST',
      url: `/inbound/${id}/suggestions/0/apply`,
      headers: auth(a.adminToken),
    });
    expect(r.json().suggestions[0].appliedAt).toBeTruthy();
    expect(clients.setShipmentTracking).toHaveBeenLastCalledWith(a.tenantId, open, {
      carrier: 'UPS',
      trackingNumber: '1Z1',
    });
  });

  it('lists by several statuses and counts per status', async () => {
    const id = await pending('Counted');
    const counts = (
      await app.inject({ method: 'GET', url: '/inbound/counts', headers: auth(a.adminToken) })
    ).json();
    expect(counts.pending).toBeGreaterThanOrEqual(1);
    expect(counts.total).toBe(counts.pending + counts.needs_review + counts.routed + counts.ignored);
    const list = (
      await app.inject({
        method: 'GET',
        url: '/inbound?status=pending,needs_review&limit=200',
        headers: auth(a.adminToken),
      })
    ).json();
    expect(list.items.map((i: Row) => i.id)).toContain(id);
    expect(list.items.every((i: Row) => ['pending', 'needs_review'].includes(i.status as string))).toBe(true);
    expect(
      (await app.inject({ method: 'GET', url: '/inbound?status=bogus', headers: auth(a.adminToken) }))
        .statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: 'GET', url: '/inbound/counts', headers: auth(b.adminToken) })).json().total,
    ).toBe(0);
  });

  it('stores inbound files linked to the inbound email', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/inbound/simulate',
      headers: auth(a.adminToken),
      payload: {
        from: 'v@vendor.example',
        to: 'x@y.example',
        subject: 'Linked files',
        text: 'See attached',
        attachments: [{ filename: 'a.pdf', contentType: 'application/pdf', base64: 'JVBERi0xLjQ=' }],
      },
    });
    const id = res.json().id;
    const linked = [...storedDocs.values()].filter((d) => d.entityId === id);
    expect(linked.map((d) => d.kind).sort()).toEqual(['email', 'email_attachment']);
    expect(linked.every((d) => d.entityType === 'inbound_email')).toBe(true);
  });

  it('routed appends to the entity thread (vendor visibility when vendorOrgId given)', async () => {
    const id = await pending('Ship date update');
    const poId = crypto.randomUUID();
    const r = await route(id, {
      status: 'routed',
      entityType: 'purchase_order',
      entityId: poId,
      vendorOrgId: a.vendorOrgId,
      confidence: 0.93,
      reasons: ['PO number match'],
      suggestions: [],
    });
    expect(r.json()).toMatchObject({ status: 'routed', routing: { method: 'ai', confidence: 0.93 } });
    const t = (
      await app.inject({
        method: 'GET',
        url: `/threads/${r.json().routedThreadId}`,
        headers: auth(a.adminToken),
      })
    ).json();
    expect(t).toMatchObject({
      visibility: 'vendor',
      vendorOrgId: a.vendorOrgId,
      entityId: poId,
      messageCount: 1,
    });
  });

  it('a manual decision wins over a late AI result', async () => {
    const id = await pending('Late AI');
    await app.inject({ method: 'POST', url: `/inbound/${id}/ignore`, headers: auth(a.adminToken) });
    const r = await route(id, {
      status: 'routed',
      entityType: 'project',
      entityId: crypto.randomUUID(),
      confidence: 0.9,
      reasons: [],
      suggestions: [],
    });
    expect(r.json().status).toBe('ignored');
  });
});
