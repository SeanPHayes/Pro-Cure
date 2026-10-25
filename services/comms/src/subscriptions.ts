import type { EventEnvelope } from '@procure/domain';
import { on, type Subscription, type Tx } from '@procure/platform';
import { clients } from './clients.js';
import { queueEmail } from './email/outbound.js';
import { absoluteUrl, entityPath } from './links.js';
import type { Logger } from './log.js';
import { type NotifyInput, notifyUsers, type Severity } from './notify.js';
import { getOrCreateThread, serviceEmitter } from './threads.js';

/**
 * Event handlers. Each runs exactly once per event (platform.inbox) inside a system transaction
 * scoped to the event's tenant; all writes are additionally idempotent by construction
 * (get-or-create threads).
 */
type Ctx = { tx: Tx; log: Logger };

const tenantOf = (e: EventEnvelope<unknown>, log: Logger): string | null => {
  if (!e.tenantId) log.warn({ event: e.type, id: e.id }, 'event has no tenantId; skipped');
  return e.tenantId;
};

const notify = (e: EventEnvelope<unknown>, { tx, log }: Ctx, n: NotifyInput) => {
  const tenantId = tenantOf(e, log);
  if (!tenantId) return Promise.resolve([]);
  return notifyUsers(tx, tenantId, { internalOnly: !n.userIds?.length, ...n }, log, serviceEmitter(tenantId));
};

const human = (s: string) => s.replace(/_/g, ' ');

export const subscriptions: Subscription[] = [
  // ------------------------------------------------------------------------------- commands
  on('cmd.email.send', async (e, { tx, log }) => {
    const tenantId = tenantOf(e, log);
    if (!tenantId) return;
    const d = e.data;
    if (!d.to.length) return;
    await queueEmail(
      tx,
      serviceEmitter(tenantId, e.actor),
      {
        tenantId,
        to: d.to,
        cc: d.cc,
        subject: d.subject,
        text: d.text,
        html: d.html,
        replyTo: d.replyTo,
        attachments: d.attachments,
        threadId: d.threadId,
        author: e.actor?.userId
          ? { userId: e.actor.userId, name: e.actor.name ?? 'Pro-Cure', orgId: e.actor.orgId }
          : undefined,
      },
      log,
    );
  }),

  on('cmd.notify', async (e, ctx) => {
    const d = e.data;
    await notify(e, ctx, {
      userIds: d.userIds,
      roles: d.roles,
      internalOnly: false,
      type: 'notify',
      title: d.title,
      body: d.body,
      link: d.link,
      severity: d.severity,
    });
  }),

  // ------------------------------------------------------------------------------- quoting
  on('quoting.cost_request.sent', async (e, { tx, log }) => {
    const tenantId = tenantOf(e, log);
    if (!tenantId) return;
    const d = e.data;
    const tenantName = await clients.tenantName(tenantId);
    const { thread } = await getOrCreateThread(tx, {
      tenantId,
      entityType: 'cost_request',
      entityId: d.costRequestId,
      visibility: d.vendorOrgId ? 'vendor' : 'internal',
      vendorOrgId: d.vendorOrgId,
      subject: `Pricing request ${d.number}`,
    });
    if (!d.vendorEmail) {
      log.info({ costRequestId: d.costRequestId }, 'cost request has no vendor email; thread only');
      return;
    }
    const url = absoluteUrl(entityPath('vendor', 'cost_request', d.costRequestId)!);
    const due = d.dueDate ? ` Please respond by ${d.dueDate}.` : '';
    await queueEmail(
      tx,
      serviceEmitter(tenantId, e.actor),
      {
        tenantId,
        to: [d.vendorEmail],
        subject: `Pricing request ${d.number} from ${tenantName}`,
        heading: `Pricing request ${d.number}`,
        text: `Hello,\n\n${tenantName} has requested pricing on ${d.lineCount} item${d.lineCount === 1 ? '' : 's'}.${due}\n\nYou can enter your pricing, lead times and notes in the vendor portal, or reply to this email with your quote attached.`,
        cta: { label: 'Open the pricing request', url },
        threadId: thread.id,
      },
      log,
    );
  }),

  on('quoting.approval.requested', (e, ctx) =>
    notify(e, ctx, {
      roles: [e.data.approverRole],
      type: 'approval_requested',
      title: `Approval needed: ${human(e.data.entityType)} — ${e.data.reason}`,
      body: e.data.reason,
      link: '/app/approvals',
      severity: 'warning',
      entityType: e.data.entityType,
      entityId: e.data.entityId,
    }).then(() => {}),
  ),

  on('quoting.quote.client_decided', (e, ctx) => {
    const d = e.data;
    const approved = d.decision === 'approved';
    return notify(e, ctx, {
      roles: ['project_manager', 'sales'],
      type: 'quote_client_decided',
      title: `Client ${approved ? 'approved' : 'rejected'} the quote (${d.decidedBy})`,
      body: d.comment ?? '',
      link: entityPath('internal', 'quote', d.quoteId),
      severity: approved ? 'success' : 'warning',
      entityType: 'quote',
      entityId: d.quoteId,
    }).then(() => {});
  }),

  // ------------------------------------------------------------------------------- orders
  on('orders.po.issued', async (e, { tx, log }) => {
    const tenantId = tenantOf(e, log);
    if (!tenantId) return;
    // The vendor org is not on the event; orders opens the vendor thread via POST /internal/threads.
    // Ensure the internal PO thread exists so staff can discuss and file emails on it.
    await getOrCreateThread(tx, {
      tenantId,
      entityType: 'purchase_order',
      entityId: e.data.poId,
      visibility: 'internal',
      subject: `PO ${e.data.number}`,
    });
  }),

  on('orders.claim.opened', (e, ctx) =>
    notify(e, ctx, {
      roles: ['order_manager'],
      type: 'claim_opened',
      title: `Claim ${e.data.number} opened (${human(e.data.type)})`,
      link: entityPath('internal', 'claim', e.data.claimId),
      severity: 'warning',
      entityType: 'claim',
      entityId: e.data.claimId,
    }).then(() => {}),
  ),

  on('orders.risk.escalated', (e, ctx) => {
    const level = e.data.escalation;
    const severity: Severity = level === 'critical' ? 'critical' : level === 'at_risk' ? 'warning' : 'info';
    return notify(e, ctx, {
      roles: ['order_manager'],
      type: 'risk_escalated',
      title: `Order ${human(level)}: ${e.data.reasons[0] ?? 'ship date risk'}`,
      body: e.data.reasons.join('\n'),
      link: entityPath('internal', 'purchase_order', e.data.poId),
      severity,
      entityType: 'purchase_order',
      entityId: e.data.poId,
    }).then(() => {});
  }),

  on('orders.shipment.ship_date_changed', async (e, ctx) => {
    const { previous, current } = e.data;
    // Only slips matter: a new date later than the old one (or a date removed).
    if (!previous || (current && current <= previous)) return;
    await notify(e, ctx, {
      roles: ['order_manager'],
      type: 'ship_date_slipped',
      title: current ? `Ship date moved from ${previous} to ${current}` : `Ship date ${previous} withdrawn`,
      body: `Source: ${human(e.data.source)}`,
      link: entityPath('internal', 'purchase_order', e.data.poId),
      severity: 'warning',
      entityType: 'shipment',
      entityId: e.data.shipmentId,
    });
  }),

  on('orders.shipment.tracking_added', (e, ctx) =>
    notify(e, ctx, {
      roles: ['logistics'],
      type: 'tracking_added',
      title: `Tracking added: ${e.data.carrier} ${e.data.trackingNumber}`,
      link: entityPath('internal', 'purchase_order', e.data.poId),
      severity: 'info',
      entityType: 'shipment',
      entityId: e.data.shipmentId,
    }).then(() => {}),
  ),

  // ------------------------------------------------------------------------------- projects / identity / ai
  on('projects.task.assigned', async (e, ctx) => {
    if (!e.data.assigneeUserId || e.data.assigneeUserId === e.actor?.userId) return;
    await notify(e, ctx, {
      userIds: [e.data.assigneeUserId],
      type: 'task_assigned',
      title: `Task assigned to you: ${e.data.name}`,
      body: e.actor?.name ? `Assigned by ${e.actor.name}` : '',
      link: entityPath('internal', 'project', e.data.projectId),
      entityType: 'task',
      entityId: e.data.taskId,
    });
  }),

  on('identity.user.invited', async (e, { tx, log }) => {
    // Invites into the tenant itself or a connected vendor/client org; the email is sent under the
    // inviting tenant's name.
    const tenantId = e.tenantId ?? e.data.orgId;
    const tenantName = await clients.tenantName(tenantId);
    await queueEmail(
      tx,
      serviceEmitter(tenantId, e.actor),
      {
        tenantId,
        to: [e.data.email],
        subject: `You're invited to ${tenantName} on Pro-Cure`,
        heading: "You've been invited",
        text: `${e.actor?.name ? `${e.actor.name} has` : `${tenantName} has`} invited you to collaborate on Pro-Cure.\n\nAccept the invitation to set up your account. The link is personal — please don't forward it.`,
        cta: { label: 'Accept invitation', url: absoluteUrl(e.data.inviteUrl) },
      },
      log,
    );
  }),

  on('ai.job.completed', async (e, ctx) => {
    const userId = e.actor?.userId;
    if (!userId) return; // creator unknown (system-initiated job)
    const ok = e.data.status === 'completed' || e.data.status === 'needs_review';
    await notify(e, ctx, {
      userIds: [userId],
      type: 'ai_job_completed',
      title: ok
        ? `AI ${human(e.data.kind)} is ready for review`
        : `AI ${human(e.data.kind)} ${human(e.data.status)}`,
      link: `/app/ai/jobs/${e.data.jobId}`,
      severity: ok ? 'success' : 'warning',
    });
  }),
];
