import { z } from 'zod';

/**
 * Integration events. Producers write these to their schema's transactional outbox in the same DB
 * transaction as the state change; a relay publishes them (EventBridge in AWS, HTTP fan-out locally).
 * Consumers must be idempotent on `id`.
 *
 * This file is the contract between services. Adding a field is backwards compatible; renaming or
 * removing one requires a new `version`.
 */
export const EventEnvelope = z.object({
  id: z.uuid(),
  type: z.string(),
  version: z.number().int().default(1),
  occurredAt: z.string(),
  source: z.string(),
  tenantId: z.uuid().nullable(),
  actor: z
    .object({ userId: z.uuid().nullable(), orgId: z.uuid().nullable(), name: z.string().nullable() })
    .nullable(),
  data: z.record(z.string(), z.unknown()),
});
export type EventEnvelope<T = Record<string, unknown>> = Omit<z.infer<typeof EventEnvelope>, 'data'> & {
  data: T;
};

const id = z.uuid();
const nid = z.uuid().nullable();

export const EVENTS = {
  // identity
  'identity.org.created': z.object({ orgId: id, type: z.string(), name: z.string() }),
  'identity.user.invited': z.object({ userId: id, orgId: id, email: z.string(), inviteUrl: z.string() }),

  // projects
  'projects.project.created': z.object({
    projectId: id,
    number: z.string(),
    name: z.string(),
    clientOrgId: nid,
  }),
  'projects.project.updated': z.object({ projectId: id, changes: z.record(z.string(), z.unknown()) }),
  'projects.task.assigned': z.object({ taskId: id, projectId: id, assigneeUserId: nid, name: z.string() }),
  'projects.task.completed': z.object({
    taskId: id,
    projectId: id,
    name: z.string(),
    isMilestone: z.boolean(),
  }),

  // quoting
  'quoting.quote.sent_to_client': z.object({
    quoteId: id,
    projectId: id,
    number: z.string(),
    total: z.number(),
  }),
  'quoting.quote.client_decided': z.object({
    quoteId: id,
    projectId: id,
    decision: z.enum(['approved', 'rejected']),
    decidedBy: z.string(),
    comment: z.string().nullable(),
  }),
  'quoting.cost_request.sent': z.object({
    costRequestId: id,
    number: z.string(),
    quoteId: id,
    vendorId: id,
    vendorOrgId: nid,
    vendorEmail: z.string().nullable(),
    lineCount: z.number().int(),
    dueDate: z.string().nullable(),
  }),
  'quoting.cost_request.responded': z.object({
    costRequestId: id,
    quoteId: id,
    vendorId: id,
    source: z.string(),
  }),
  'quoting.approval.requested': z.object({
    approvalId: id,
    entityType: z.string(),
    entityId: id,
    reason: z.string(),
    approverRole: z.string(),
  }),
  'quoting.approval.decided': z.object({
    approvalId: id,
    entityType: z.string(),
    entityId: id,
    status: z.string(),
  }),

  // orders
  'orders.po.created': z.object({
    poId: id,
    projectId: id,
    vendorId: id,
    number: z.string(),
    total: z.number(),
    quoteId: nid,
    quoteLineIds: z.array(z.uuid()).default([]),
  }),
  'orders.po.issued': z.object({
    poId: id,
    projectId: id,
    vendorId: id,
    number: z.string(),
    revision: z.number().int(),
    total: z.number(),
  }),
  'orders.shipment.ship_date_changed': z.object({
    shipmentId: id,
    poId: id,
    projectId: id,
    previous: z.string().nullable(),
    current: z.string().nullable(),
    source: z.string(),
  }),
  'orders.shipment.tracking_added': z.object({
    shipmentId: id,
    poId: id,
    projectId: id,
    carrier: z.string(),
    trackingNumber: z.string(),
  }),
  'orders.shipment.delivered': z.object({ shipmentId: id, poId: id, projectId: id }),
  'orders.claim.opened': z.object({
    claimId: id,
    projectId: id,
    poId: nid,
    number: z.string(),
    type: z.string(),
  }),
  'orders.requirement.updated': z.object({
    requirementId: id,
    poId: id,
    kind: z.string(),
    status: z.string(),
  }),
  'orders.risk.escalated': z.object({
    poId: id,
    projectId: id,
    escalation: z.string(),
    reasons: z.array(z.string()),
  }),

  // finance
  'finance.invoice.issued': z.object({ invoiceId: id, projectId: id, number: z.string(), total: z.number() }),
  'finance.vendor_bill.paid': z.object({
    billId: id,
    poId: nid,
    vendorId: id,
    kind: z.string(),
    amount: z.number(),
  }),
  'finance.payment.received': z.object({ invoiceId: id, projectId: id, amount: z.number() }),

  // catalog
  'catalog.brand_standard.submitted': z.object({
    standardId: id,
    brandId: id,
    name: z.string(),
    version: z.string(),
    itemCount: z.number().int(),
  }),
  'catalog.brand_standard.published': z.object({
    standardId: id,
    brandId: id,
    name: z.string(),
    version: z.string(),
    itemCount: z.number().int(),
    contributedByTenantId: nid,
    supersededIds: z.array(z.uuid()).default([]),
  }),
  'catalog.vendor.created': z.object({ vendorId: id, name: z.string(), orgId: nid }),

  // documents
  'documents.report.rendered': z.object({
    documentId: id,
    template: z.string(),
    entityType: z.string().nullable(),
    entityId: nid,
    pageCount: z.number().int(),
  }),
  'documents.document.uploaded': z.object({
    documentId: id,
    entityType: z.string().nullable(),
    entityId: nid,
    kind: z.string(),
    filename: z.string(),
  }),

  // comms
  'comms.message.posted': z.object({
    messageId: id,
    threadId: id,
    entityType: z.string(),
    entityId: id,
    direction: z.string(),
    authorOrgId: nid,
  }),
  'comms.inbound_email.received': z.object({ inboundEmailId: id }),

  // ai
  'ai.job.completed': z.object({ jobId: id, kind: z.string(), status: z.string() }),
  'ai.job.applied': z.object({
    jobId: id,
    kind: z.string(),
    entityType: z.string().nullable(),
    entityId: nid,
    appliedBy: z.string().nullable(),
  }),

  // commands carried on the bus (fire-and-forget)
  'cmd.notify': z.object({
    userIds: z.array(z.uuid()).default([]),
    roles: z.array(z.string()).default([]),
    title: z.string(),
    body: z.string(),
    link: z.string().nullable(),
    severity: z.enum(['info', 'success', 'warning', 'critical']).default('info'),
  }),
  'cmd.email.send': z.object({
    to: z.array(z.string()),
    cc: z.array(z.string()).default([]),
    subject: z.string(),
    text: z.string(),
    html: z.string().nullable(),
    replyTo: z.string().nullable(),
    attachments: z.array(z.object({ documentId: z.uuid(), filename: z.string() })).default([]),
    threadId: nid,
  }),
} as const;

export type EventType = keyof typeof EVENTS;
export type EventData<T extends EventType> = z.infer<(typeof EVENTS)[T]>;
