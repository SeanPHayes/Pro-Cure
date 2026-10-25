import { closeDb, runJobOnce, withOwner } from '@procure/platform';
import { auth, createWorld, type World } from '@procure/platform/testing';
import { simpleParser } from 'mailparser';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { clients } from '../src/clients.js';
import { buildMime } from '../src/email/mime.js';
import { setEmailSender } from '../src/email/sender.js';
import { jobs, sendDailyDigests } from '../src/jobs.js';
import {
  addUser,
  buildApp,
  deliver,
  notificationsFor,
  type Row,
  stubClients,
  type TestApp,
} from './helpers.js';

let app: TestApp;
let a: World;
let b: World;
let om: { id: string; email: string };
let pm: { id: string; email: string };

beforeAll(async () => {
  app = await buildApp();
  stubClients();
  a = await createWorld('Events');
  b = await createWorld('Elsewhere');
  om = await addUser(a.tenantId, 'Olivia Orders', ['order_manager']);
  pm = await addUser(a.tenantId, 'Pat Projects', ['project_manager']);
});
afterEach(() => setEmailSender(undefined));

/** The single matching row (fails the test otherwise). */
const one = (rows: Row[]): Row => {
  expect(rows).toHaveLength(1);
  return rows[0]!;
};
afterAll(async () => {
  await app.close();
  await closeDb();
});

const emails = (tenantId: string) =>
  withOwner((tx) => tx<Row[]>`select * from comms.emails where tenant_id = ${tenantId} order by created_at`);
const thread = (entityId: string) =>
  withOwner((tx) => tx<Row[]>`select * from comms.threads where entity_id = ${entityId}`);

describe('cmd.email.send', () => {
  it('stores the email with the thread alias as reply-to, fetches attachments and appends to the thread', async () => {
    const t = (
      await app.inject({
        method: 'GET',
        url: `/threads/for?entityType=purchase_order&entityId=${crypto.randomUUID()}&visibility=vendor&vendorOrgId=${a.vendorOrgId}`,
        headers: auth(a.adminToken),
      })
    ).json();
    const docId = crypto.randomUUID();
    const r = await deliver(
      app,
      'cmd.email.send',
      a.tenantId,
      {
        to: ['rep@vendor.example'],
        cc: [],
        subject: 'PO PO-26-0042 issued',
        text: 'Please find PO PO-26-0042 attached.\n\nOpen: http://localhost:5173/vendor/orders/1',
        html: null,
        replyTo: null,
        attachments: [{ documentId: docId, filename: 'PO-26-0042.pdf' }],
        threadId: t.id,
      },
      { userId: a.adminId, orgId: a.tenantId, name: 'Events Admin' },
    );
    expect(r.result).toBe('processed');

    const e = one((await emails(a.tenantId)).filter((x) => x.threadId === t.id));
    expect(e).toMatchObject({
      status: 'delivered-local',
      replyTo: t.replyToAddress,
      attachmentDocumentIds: [docId],
      attempts: 1,
    });
    expect(e.htmlBody).toContain('Events Procurement');
    expect(e.htmlBody).toContain('Sent via Pro-Cure on behalf of Events Procurement');
    expect(e.htmlBody).toContain('href="http://localhost:5173/vendor/orders/1"'); // CTA button
    expect(e.textBody).toContain('Please find PO PO-26-0042 attached.');
    expect(clients.getDocumentContent).toHaveBeenCalledWith(a.tenantId, docId);

    const d = (
      await app.inject({ method: 'GET', url: `/threads/${t.id}`, headers: auth(a.adminToken) })
    ).json();
    expect(d.messages.items).toHaveLength(1);
    expect(d.messages.items[0]).toMatchObject({
      direction: 'outbound',
      channel: 'email',
      authorName: 'Events Admin',
      emailMessageId: e.messageId,
    });

    // Duplicate delivery of the same event is a no-op (platform.inbox).
    const envelope = {
      id: crypto.randomUUID(),
      type: 'cmd.email.send',
      version: 1,
      occurredAt: new Date().toISOString(),
      source: 't',
      tenantId: a.tenantId,
      actor: null,
      data: { to: ['x@y.example'], subject: 's', text: 't', html: null, replyTo: null, threadId: null },
    };
    const h = { 'x-procure-internal': 'local-internal-secret' };
    await app.inject({ method: 'POST', url: '/internal/events', headers: h, payload: envelope });
    const again = await app.inject({
      method: 'POST',
      url: '/internal/events',
      headers: h,
      payload: envelope,
    });
    expect(again.json().result).toBe('duplicate');
  });

  it('records failures and the retry job resends with backoff', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('SES throttled'))
      .mockResolvedValue({ status: 'sent', providerMessageId: 'ses-1' });
    setEmailSender({ name: 'fake', send });
    await deliver(app, 'cmd.email.send', a.tenantId, {
      to: ['retry@vendor.example'],
      subject: 'Retry me',
      text: 'hello',
      html: null,
      replyTo: null,
      threadId: null,
    });
    let e = one((await emails(a.tenantId)).filter((x) => x.subject === 'Retry me'));
    expect(e).toMatchObject({ status: 'failed', error: 'SES throttled', attempts: 1 });
    expect(e.nextAttemptAt).toBeTruthy();

    await withOwner(
      (tx) => tx`update comms.emails set next_attempt_at = now() - interval '1 minute' where id = ${e.id}`,
    );
    const retry = jobs.find((j) => j.name === 'email-retry')!;
    const detail = await runJobOnce('comms', retry, app.log as never);
    expect(detail).toMatchObject({ attempted: 1, sent: 1 });
    e = one((await emails(a.tenantId)).filter((x) => x.subject === 'Retry me'));
    expect(e).toMatchObject({ status: 'sent', providerMessageId: 'ses-1', attempts: 2, error: null });
  });

  it('builds valid MIME with attachments (raw SES path)', async () => {
    const mime = buildMime({
      from: 'Pro-Cure <noreply@pro-cure.local>',
      to: ['Zoë <zoe@x.example>'],
      cc: [],
      replyTo: 't-abcdefgh@inbound.pro-cure.local',
      subject: 'Façade drawings — rev 2',
      text: 'Body',
      html: '<p>Body</p>',
      messageId: '<m1@inbound.pro-cure.local>',
      attachments: [
        { filename: 'drawing.pdf', contentType: 'application/pdf', content: Buffer.from('%PDF-1.4') },
      ],
    });
    const parsed = await simpleParser(mime);
    expect(parsed.subject).toBe('Façade drawings — rev 2');
    expect(parsed.replyTo?.text).toContain('t-abcdefgh@inbound.pro-cure.local');
    expect(parsed.attachments[0]).toMatchObject({ filename: 'drawing.pdf', contentType: 'application/pdf' });
    expect(parsed.text?.trim()).toBe('Body');
  });
});

describe('cmd.notify', () => {
  it('fans out to explicit users and role members, skipping muted types', async () => {
    const muted = await addUser(a.tenantId, 'Muted Manager', ['order_manager']);
    const mutedToken = await a.tokenAs(['order_manager'], muted.id);
    const put = await app.inject({
      method: 'PUT',
      url: '/notification-preferences',
      headers: auth(mutedToken),
      payload: { emailDigest: 'none', mutedTypes: ['notify'] },
    });
    expect(put.statusCode).toBe(200);
    await addUser(b.tenantId, 'Other Tenant OM', ['order_manager']);

    await deliver(app, 'cmd.notify', a.tenantId, {
      userIds: [pm.id],
      roles: ['order_manager'],
      title: 'Deposit received',
      body: 'PO-26-0042',
      link: '/app/orders/1',
      severity: 'success',
    });
    expect((await notificationsFor(pm.id)).map((n) => n.title)).toContain('Deposit received');
    expect((await notificationsFor(om.id)).map((n) => n.title)).toContain('Deposit received');
    expect(await notificationsFor(muted.id)).toHaveLength(0);
    expect(clients.listUsers).toHaveBeenCalledWith(a.tenantId, { roles: ['order_manager'] });
    const all = await withOwner(
      (tx) => tx<Row[]>`select tenant_id from comms.notifications where title = 'Deposit received'`,
    );
    expect(all.every((n) => n.tenantId === a.tenantId)).toBe(true);
  });
});

describe('domain events', () => {
  it('quoting.cost_request.sent opens a vendor thread and emails the vendor a portal link', async () => {
    const id = crypto.randomUUID();
    await deliver(app, 'quoting.cost_request.sent', a.tenantId, {
      costRequestId: id,
      number: 'CR-26-0007',
      quoteId: crypto.randomUUID(),
      vendorId: crypto.randomUUID(),
      vendorOrgId: a.vendorOrgId,
      vendorEmail: 'quotes@vendor.example',
      lineCount: 3,
      dueDate: '2026-11-01',
    });
    const t = one(await thread(id));
    expect(t).toMatchObject({
      visibility: 'vendor',
      vendorOrgId: a.vendorOrgId,
      subject: 'Pricing request CR-26-0007',
    });
    const e = one((await emails(a.tenantId)).filter((x) => x.threadId === t.id));
    expect(e.subject).toBe('Pricing request CR-26-0007 from Events Procurement');
    expect(e.htmlBody).toContain(`http://localhost:5173/vendor/cost-requests/${id}`);
    expect(e.textBody).toContain('2026-11-01');
    expect(e.replyTo).toBe(`t-${t.emailAlias}@inbound.pro-cure.local`);
    // The vendor sees the outbound message on its thread.
    const v = (
      await app.inject({ method: 'GET', url: `/threads/${t.id}`, headers: auth(a.vendorToken) })
    ).json();
    expect(v.messages.items).toHaveLength(1);
  });

  it('orders.po.issued ensures an internal PO thread (idempotent)', async () => {
    const poId = crypto.randomUUID();
    const data = {
      poId,
      projectId: crypto.randomUUID(),
      vendorId: crypto.randomUUID(),
      number: 'PO-26-0009',
      revision: 0,
      total: 1000,
    };
    await deliver(app, 'orders.po.issued', a.tenantId, data);
    await deliver(app, 'orders.po.issued', a.tenantId, { ...data, revision: 1 });
    const ts = await thread(poId);
    expect(ts).toHaveLength(1);
    expect(ts[0]).toMatchObject({ visibility: 'internal', subject: 'PO PO-26-0009' });
  });

  it('notification events route to the right roles and severities', async () => {
    await deliver(app, 'quoting.approval.requested', a.tenantId, {
      approvalId: crypto.randomUUID(),
      entityType: 'quote',
      entityId: crypto.randomUUID(),
      reason: 'Margin below 18%',
      approverRole: 'project_manager',
    });
    expect((await notificationsFor(pm.id)).find((n) => n.type === 'approval_requested')).toMatchObject({
      link: '/app/approvals',
      severity: 'warning',
    });

    await deliver(app, 'quoting.quote.client_decided', a.tenantId, {
      quoteId: crypto.randomUUID(),
      projectId: crypto.randomUUID(),
      decision: 'approved',
      decidedBy: 'GM',
      comment: null,
    });
    expect((await notificationsFor(pm.id)).find((n) => n.type === 'quote_client_decided')?.severity).toBe(
      'success',
    );

    await deliver(app, 'orders.claim.opened', a.tenantId, {
      claimId: crypto.randomUUID(),
      projectId: crypto.randomUUID(),
      poId: null,
      number: 'CL-26-0001',
      type: 'concealed_damage',
    });
    expect((await notificationsFor(om.id)).find((n) => n.type === 'claim_opened')?.title).toBe(
      'Claim CL-26-0001 opened (concealed damage)',
    );

    await deliver(app, 'orders.risk.escalated', a.tenantId, {
      poId: crypto.randomUUID(),
      projectId: crypto.randomUUID(),
      escalation: 'critical',
      reasons: ['Ship date after install date'],
    });
    expect((await notificationsFor(om.id)).find((n) => n.type === 'risk_escalated')?.severity).toBe(
      'critical',
    );

    const sd = {
      shipmentId: crypto.randomUUID(),
      poId: crypto.randomUUID(),
      projectId: crypto.randomUUID(),
      source: 'vendor_portal',
    };
    await deliver(app, 'orders.shipment.ship_date_changed', a.tenantId, {
      ...sd,
      previous: '2026-11-10',
      current: '2026-11-03',
    });
    expect((await notificationsFor(om.id)).filter((n) => n.type === 'ship_date_slipped')).toHaveLength(0);
    await deliver(app, 'orders.shipment.ship_date_changed', a.tenantId, {
      ...sd,
      previous: '2026-11-10',
      current: '2026-11-24',
    });
    expect((await notificationsFor(om.id)).find((n) => n.type === 'ship_date_slipped')?.title).toBe(
      'Ship date moved from 2026-11-10 to 2026-11-24',
    );

    await deliver(app, 'projects.task.assigned', a.tenantId, {
      taskId: crypto.randomUUID(),
      projectId: crypto.randomUUID(),
      assigneeUserId: pm.id,
      name: 'Send finish samples',
    });
    expect((await notificationsFor(pm.id)).find((n) => n.type === 'task_assigned')?.title).toBe(
      'Task assigned to you: Send finish samples',
    );

    await deliver(
      app,
      'ai.job.completed',
      a.tenantId,
      { jobId: crypto.randomUUID(), kind: 'vendor_quote_extract', status: 'needs_review' },
      { userId: om.id, orgId: a.tenantId, name: 'Olivia' },
    );
    expect((await notificationsFor(om.id)).find((n) => n.type === 'ai_job_completed')?.title).toBe(
      'AI vendor quote extract is ready for review',
    );
    // Unknown creator → skipped.
    expect(
      (
        await deliver(app, 'ai.job.completed', a.tenantId, {
          jobId: crypto.randomUUID(),
          kind: 'risk_score',
          status: 'completed',
        })
      ).result,
    ).toBe('processed');
  });

  it('identity.user.invited emails the invite link', async () => {
    await deliver(app, 'identity.user.invited', a.tenantId, {
      userId: crypto.randomUUID(),
      orgId: a.vendorOrgId,
      email: 'new.rep@vendor.example',
      inviteUrl: '/invite/abc123',
    });
    const e = one((await emails(a.tenantId)).filter((x) => x.to.includes('new.rep@vendor.example')));
    expect(e.subject).toBe("You're invited to Events Procurement on Pro-Cure");
    expect(e.htmlBody).toContain('http://localhost:5173/invite/abc123');
  });
});

describe('daily digest', () => {
  it('emails unread notifications once per local day to daily-digest users', async () => {
    const token = await a.tokenAs(['order_manager'], om.id);
    await app.inject({
      method: 'PUT',
      url: '/notification-preferences',
      headers: auth(token),
      payload: { emailDigest: 'daily', mutedTypes: [] },
    });
    const now = new Date('2026-10-26T12:30:00Z'); // 08:30 New York
    const log = app.log as never;
    const r1 = await withOwner((tx) => sendDailyDigests(tx as never, log, now));
    expect(r1.sent).toBeGreaterThanOrEqual(1);
    const digest = (await emails(a.tenantId)).filter(
      (x) => x.to.includes(om.email) && x.subject.startsWith('Your Pro-Cure digest'),
    );
    expect(digest).toHaveLength(1);
    expect(one(digest).textBody).toContain('[Critical]');
    const r2 = await withOwner((tx) => sendDailyDigests(tx as never, log, now));
    expect(r2.users).toBe(0);
    const early = await withOwner((tx) =>
      sendDailyDigests(tx as never, log, new Date('2026-10-27T10:00:00Z')),
    );
    expect(early).toMatchObject({ skipped: 'before digest hour' });
  });
});
