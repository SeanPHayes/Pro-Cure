import { EntityType, InboundEmailStatus, MessageDirection, page, ThreadVisibility } from '@procure/domain';
import { z } from '@procure/platform';

export const IdParams = z.object({ id: z.uuid() });
export const TenantQuery = z.object({ tenantId: z.uuid() });
const ts = z.string();
const nts = z.string().nullable();

const Paging = {
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
};
const boolish = z
  .enum(['true', 'false', '1', '0'])
  .optional()
  .transform((v) => v === 'true' || v === '1');

// ------------------------------------------------------------------------------------ threads
export const AuthorActor = z.enum(['internal', 'vendor', 'client', 'system', 'email']);
export const Channel = z.enum(['app', 'email']);

/** Message as staff see it. */
export const Message = z.object({
  id: z.string(),
  threadId: z.string(),
  authorUserId: nts,
  authorName: z.string(),
  authorEmail: nts,
  authorOrgId: nts,
  authorActor: AuthorActor,
  direction: MessageDirection,
  channel: Channel,
  bodyText: z.string(),
  bodyHtml: nts,
  attachmentDocumentIds: z.array(z.string()),
  mentions: z.array(z.string()),
  emailMessageId: nts,
  inboundEmailId: nts,
  aiSummary: nts,
  createdAt: ts,
  editedAt: nts,
});
export type Message = z.infer<typeof Message>;

/** Message as vendor/client actors see it: no internal email plumbing, mentions or AI notes. */
export const PortalMessage = Message.pick({
  id: true,
  threadId: true,
  authorName: true,
  authorActor: true,
  direction: true,
  channel: true,
  bodyText: true,
  attachmentDocumentIds: true,
  createdAt: true,
  editedAt: true,
}).extend({ mine: z.boolean() });

export const Thread = z.object({
  id: z.string(),
  entityType: z.string(),
  entityId: z.string(),
  subject: z.string(),
  visibility: ThreadVisibility,
  vendorOrgId: nts,
  clientOrgId: nts,
  emailAlias: z.string(),
  replyToAddress: z.string(),
  lastMessageAt: nts,
  messageCount: z.number().int(),
  createdAt: ts,
});

export const ThreadListItem = Thread.extend({
  unreadCount: z.number().int(),
  lastMessage: z
    .object({ authorName: z.string(), preview: z.string(), createdAt: ts, direction: MessageDirection })
    .nullable(),
});

export const PortalThread = z.object({
  id: z.string(),
  entityType: z.string(),
  entityId: z.string(),
  subject: z.string(),
  visibility: ThreadVisibility,
  replyToAddress: z.string(),
  lastMessageAt: nts,
  messageCount: z.number().int(),
  createdAt: ts,
});
export const PortalThreadListItem = PortalThread.extend({
  unreadCount: z.number().int(),
  lastMessage: z.object({ authorName: z.string(), preview: z.string(), createdAt: ts }).nullable(),
});

export const Participant = z.object({
  name: z.string(),
  actor: AuthorActor,
  orgId: nts,
  messageCount: z.number().int(),
  lastAt: ts,
});

export const ThreadDetail = Thread.extend({
  unreadCount: z.number().int(),
  participants: z.array(Participant),
  messages: page(Message),
});
export const PortalThreadDetail = PortalThread.extend({
  unreadCount: z.number().int(),
  participants: z.array(Participant.omit({ orgId: true })),
  messages: page(PortalMessage),
});

/** Union response for routes shared by staff and portal actors; the handler picks the shape. */
export const AnyThreadDetail = z.union([ThreadDetail, PortalThreadDetail]);
export const AnyThread = z.union([Thread, PortalThread]);
export const AnyMessage = z.union([Message, PortalMessage]);

export const ThreadListQuery = z.object({
  ...Paging,
  entityType: EntityType.optional(),
  entityId: z.uuid().optional(),
  visibility: ThreadVisibility.optional(),
  mine: boolish,
  unread: boolish,
});
export const PortalThreadListQuery = z.object({ ...Paging, unread: boolish });

export const ThreadForQuery = z.object({
  entityType: EntityType,
  entityId: z.uuid(),
  visibility: ThreadVisibility.default('internal'),
  vendorOrgId: z.uuid().optional(),
  clientOrgId: z.uuid().optional(),
  subject: z.string().trim().min(1).max(300).optional(),
});

export const ThreadDetailQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** Messages are newest-last; offset counts back from the newest (0 = the latest page). */
  offset: z.coerce.number().int().min(0).default(0),
});

export const PostMessageBody = z.object({
  bodyText: z.string().trim().min(1).max(50_000),
  bodyHtml: z.string().max(200_000).optional(),
  attachmentDocumentIds: z.array(z.uuid()).max(30).default([]),
  mentions: z.array(z.uuid()).max(50).default([]),
  /** Internal users only: also email the message to these addresses (reply-to = thread alias). */
  emailTo: z.array(z.email()).max(30).optional(),
  emailCc: z.array(z.email()).max(30).optional(),
});

// ------------------------------------------------------------------------------------ inbound
export const Suggestion = z.object({
  type: z.string().min(1),
  label: z.string(),
  payload: z.record(z.string(), z.unknown()).default({}),
  appliedAt: z.string().optional(),
  result: z.unknown().optional(),
  error: z.string().optional(),
});
export const Routing = z.object({
  confidence: z.number(),
  reasons: z.array(z.string()),
  method: z.enum(['alias', 'ai', 'manual']),
});
export const InboundAttachment = z.object({
  documentId: z.string(),
  filename: z.string(),
  contentType: z.string(),
  size: z.number(),
});

export const InboundListItem = z.object({
  id: z.string(),
  fromAddress: z.string(),
  fromName: nts,
  toAddresses: z.array(z.string()),
  subject: z.string(),
  preview: z.string(),
  receivedAt: ts,
  status: InboundEmailStatus,
  attachmentCount: z.number().int(),
  routedThreadId: nts,
  routedEntityType: nts,
  routedEntityId: nts,
  routing: Routing.nullable(),
  suggestionCount: z.number().int(),
});

export const InboundEmail = z.object({
  id: z.string(),
  messageId: nts,
  fromAddress: z.string(),
  fromName: nts,
  toAddresses: z.array(z.string()),
  cc: z.array(z.string()),
  subject: z.string(),
  textBody: nts,
  strippedText: z.string(),
  htmlBody: nts,
  receivedAt: ts,
  rawDocumentId: nts,
  attachments: z.array(InboundAttachment),
  status: InboundEmailStatus,
  routedThreadId: nts,
  routedEntityType: nts,
  routedEntityId: nts,
  routing: Routing.nullable(),
  suggestions: z.array(Suggestion),
  triagedByName: nts,
  triagedAt: nts,
  source: z.string(),
});

export const InboundListQuery = z.object({
  ...Paging,
  /** One status or a comma-separated list (e.g. "pending,needs_review"). */
  status: z
    .string()
    .optional()
    .refine(
      (s) => !s || s.split(',').every((x) => InboundEmailStatus.safeParse(x.trim()).success),
      'status must be pending, routed, needs_review or ignored (comma-separated)',
    )
    .transform((s) => (s ? s.split(',').map((x) => x.trim()) : undefined)),
  q: z.string().trim().min(1).optional(),
});

export const InboundCounts = z.object({
  pending: z.number().int(),
  needs_review: z.number().int(),
  routed: z.number().int(),
  ignored: z.number().int(),
  total: z.number().int(),
});

export const InboundConfig = z.object({
  /** Domain whose mail Pro-Cure receives (thread reply addresses are t-<alias>@this domain). */
  inboundDomain: z.string(),
  /** Where a tenant forwards a shared mailbox (purchasing@…); the original To: header picks the tenant. */
  forwardingAddress: z.string(),
  /** Whether POST /inbound/simulate is available (never in production). */
  simulatorEnabled: z.boolean(),
});

export const SesInboundBody = z
  .object({
    s3Key: z.string().min(1).optional(),
    s3Bucket: z.string().min(1).optional(),
    rawBase64: z.string().min(1).optional(),
  })
  .refine((b) => b.s3Key || b.rawBase64, 'Provide s3Key or rawBase64');
export const RawInboundBody = z.object({ rawBase64: z.string().min(1) });
export const SimulateInboundBody = z.object({
  from: z.email(),
  fromName: z.string().optional(),
  to: z.union([z.email(), z.array(z.email()).min(1)]),
  cc: z.array(z.email()).optional(),
  subject: z.string().default(''),
  text: z.string().default(''),
  html: z.string().optional(),
  inReplyTo: z.string().optional(),
  attachments: z
    .array(z.object({ filename: z.string().min(1), contentType: z.string().min(1), base64: z.string() }))
    .max(20)
    .default([]),
});
export const IngestResponse = z.object({
  id: z.string(),
  status: InboundEmailStatus,
  tenantResolved: z.boolean(),
  routedThreadId: nts,
  duplicate: z.boolean(),
});

export const ManualRouteBody = z.object({
  entityType: EntityType,
  entityId: z.uuid(),
  visibility: ThreadVisibility.default('internal'),
  vendorOrgId: z.uuid().optional(),
  clientOrgId: z.uuid().optional(),
  subject: z.string().trim().min(1).max(300).optional(),
});

export const InternalRouteBody = z.object({
  status: z.enum(['routed', 'needs_review']),
  threadId: z.uuid().optional(),
  entityType: EntityType.optional(),
  entityId: z.uuid().optional(),
  visibility: ThreadVisibility.optional(),
  vendorOrgId: z.uuid().optional(),
  clientOrgId: z.uuid().optional(),
  confidence: z.number().min(0).max(1),
  reasons: z.array(z.string()).default([]),
  suggestions: z
    .array(
      z.object({
        type: z.string().min(1),
        label: z.string(),
        payload: z.record(z.string(), z.unknown()).default({}),
      }),
    )
    .default([]),
});

export const InternalInbound = z.object({
  id: z.string(),
  from: z.string(),
  fromName: nts,
  to: z.array(z.string()),
  cc: z.array(z.string()),
  subject: z.string(),
  text: z.string(),
  html: nts,
  receivedAt: ts,
  status: InboundEmailStatus,
  attachments: z.array(z.object({ documentId: z.string(), filename: z.string(), contentType: z.string() })),
});

export const InternalThreadBody = z.object({
  tenantId: z.uuid(),
  entityType: EntityType,
  entityId: z.uuid(),
  subject: z.string().trim().min(1).max(300),
  visibility: ThreadVisibility,
  vendorOrgId: z.uuid().optional(),
  clientOrgId: z.uuid().optional(),
});
export const InternalMessageBody = z.object({
  tenantId: z.uuid(),
  threadId: z.uuid(),
  authorName: z.string().min(1),
  authorEmail: z.string().optional(),
  authorUserId: z.uuid().optional(),
  direction: MessageDirection,
  channel: Channel.default('app'),
  bodyText: z.string().min(1),
  bodyHtml: z.string().optional(),
  attachments: z.array(z.uuid()).default([]),
});

// ------------------------------------------------------------------------------------ notifications
export const Severity = z.enum(['info', 'success', 'warning', 'critical']);
export const Notification = z.object({
  id: z.string(),
  type: z.string(),
  title: z.string(),
  body: z.string(),
  link: nts,
  severity: Severity,
  entityType: nts,
  entityId: nts,
  readAt: nts,
  createdAt: ts,
});
export type Notification = z.infer<typeof Notification>;
export const NotificationList = z.object({ items: z.array(Notification), unreadCount: z.number().int() });
export const NotificationQuery = z.object({
  unreadOnly: boolish,
  limit: z.coerce.number().int().min(1).max(200).default(30),
  before: z.iso.datetime({ offset: true }).optional(),
});
export const Preferences = z.object({
  emailDigest: z.enum(['none', 'daily', 'immediate_critical']),
  mutedTypes: z.array(z.string()),
});

// ------------------------------------------------------------------------------------ emails & mailboxes
export const EmailStatus = z.enum(['queued', 'sent', 'delivered-local', 'failed']);
export const EmailListItem = z.object({
  id: z.string(),
  to: z.array(z.string()),
  cc: z.array(z.string()),
  subject: z.string(),
  status: EmailStatus,
  threadId: nts,
  attachmentCount: z.number().int(),
  attempts: z.number().int(),
  createdAt: ts,
  sentAt: nts,
});
export const EmailDetail = EmailListItem.extend({
  fromAddress: z.string(),
  replyTo: nts,
  textBody: z.string(),
  htmlBody: nts,
  attachments: z.array(z.object({ documentId: z.string(), filename: z.string() })),
  messageId: z.string(),
  providerMessageId: nts,
  error: nts,
});
export const EmailListQuery = z.object({
  ...Paging,
  status: EmailStatus.optional(),
  q: z.string().trim().min(1).optional(),
  threadId: z.uuid().optional(),
});

export const Mailbox = z.object({ id: z.string(), address: z.string(), createdAt: ts });
export const MailboxBody = z.object({
  address: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[^@\s]*@[^@\s]+\.[^@\s]+$/, 'An email address, or @domain for a catch-all'),
});

export const Ok = z.object({ ok: z.literal(true) });
