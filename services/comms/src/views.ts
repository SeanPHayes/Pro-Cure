import type { Principal, Tx } from '@procure/platform';
import { aliasAddress, type MessageRow, previewOf, type ThreadRow } from './threads.js';

/**
 * Serializers. Staff get full rows; vendor/client actors get the stripped portal shapes (no org ids,
 * alias token, author emails, mentions, email plumbing or AI notes). Each portal shape is also
 * enforced by the route's response schema.
 */
export const isPortal = (p: Principal) => p.isVendor || p.isClient;

export function portalThreadView(t: ThreadRow) {
  return {
    id: t.id,
    entityType: t.entityType,
    entityId: t.entityId,
    subject: t.subject,
    visibility: t.visibility,
    replyToAddress: aliasAddress(t.emailAlias),
    lastMessageAt: t.lastMessageAt,
    messageCount: t.messageCount,
    createdAt: t.createdAt,
  };
}

export function staffThreadView(t: ThreadRow) {
  return {
    ...portalThreadView(t),
    vendorOrgId: t.vendorOrgId,
    clientOrgId: t.clientOrgId,
    emailAlias: t.emailAlias,
  };
}

export const threadView = (t: ThreadRow, p: Principal) =>
  isPortal(p) ? portalThreadView(t) : staffThreadView(t);

export function portalMessageView(m: MessageRow, viewerUserId: string) {
  return {
    id: m.id,
    threadId: m.threadId,
    authorName: m.authorName,
    authorActor: m.authorActor,
    direction: m.direction,
    channel: m.channel,
    bodyText: m.bodyText,
    attachmentDocumentIds: m.attachmentDocumentIds,
    createdAt: m.createdAt,
    editedAt: m.editedAt,
    mine: m.authorUserId === viewerUserId,
  };
}

export function staffMessageView(m: MessageRow) {
  return {
    id: m.id,
    threadId: m.threadId,
    authorUserId: m.authorUserId,
    authorName: m.authorName,
    authorEmail: m.authorEmail,
    authorOrgId: m.authorOrgId,
    authorActor: m.authorActor,
    direction: m.direction,
    channel: m.channel,
    bodyText: m.bodyText,
    bodyHtml: m.bodyHtml,
    attachmentDocumentIds: m.attachmentDocumentIds,
    mentions: m.mentions,
    emailMessageId: m.emailMessageId,
    inboundEmailId: m.inboundEmailId,
    aiSummary: m.aiSummary,
    createdAt: m.createdAt,
    editedAt: m.editedAt,
  };
}

export const messageView = (m: MessageRow, p: Principal) =>
  isPortal(p) ? portalMessageView(m, p.userId) : staffMessageView(m);

type ListRow = ThreadRow & {
  unreadCount: number;
  lastAuthorName: string | null;
  lastBody: string | null;
  lastCreatedAt: string | null;
  lastDirection: MessageRow['direction'] | null;
  total: number;
};

export interface ThreadFilter {
  entityType?: string;
  entityId?: string;
  visibility?: string;
  mine?: boolean;
  unread?: boolean;
  limit: number;
  offset: number;
}

/**
 * Thread list with last-message preview and the caller's unread count. RLS limits rows to what the
 * caller may see; the filter adds API criteria.
 */
export async function queryThreads(tx: Tx, userId: string, f: ThreadFilter) {
  const rows = await tx<ListRow[]>`
    with visible as (
      select t.*,
        (select count(*)::int from comms.messages m
          where m.thread_id = t.id
            and m.author_user_id is distinct from ${userId}::uuid
            and m.created_at > coalesce(r.last_read_at, '-infinity'::timestamptz)) as unread_count
      from comms.threads t
      left join comms.thread_reads r on r.thread_id = t.id and r.user_id = ${userId}
      where true
        ${f.entityType ? tx`and t.entity_type = ${f.entityType}` : tx``}
        ${f.entityId ? tx`and t.entity_id = ${f.entityId}` : tx``}
        ${f.visibility ? tx`and t.visibility = ${f.visibility}` : tx``}
        ${
          f.mine
            ? tx`and (t.created_by_user_id = ${userId}
                  or exists (select 1 from comms.messages m where m.thread_id = t.id
                             and (m.author_user_id = ${userId} or ${userId}::uuid = any(m.mentions))))`
            : tx``
        }
    )
    select v.*, lm.author_name as last_author_name, lm.body_text as last_body,
           lm.created_at as last_created_at, lm.direction as last_direction,
           count(*) over ()::int as total
    from visible v
    left join lateral (
      select author_name, body_text, created_at, direction from comms.messages m
      where m.thread_id = v.id order by created_at desc limit 1
    ) lm on true
    where ${f.unread ? tx`v.unread_count > 0` : tx`true`}
    order by coalesce(v.last_message_at, v.created_at) desc, v.id
    limit ${f.limit} offset ${f.offset}`;
  let total = rows[0]?.total ?? 0;
  if (!rows.length && f.offset > 0)
    total = (await queryThreads(tx, userId, { ...f, limit: 1, offset: 0 })).total;
  return { rows, total };
}

export async function listPortalThreads(tx: Tx, p: Principal, f: ThreadFilter) {
  const { rows, total } = await queryThreads(tx, p.userId, f);
  return {
    items: rows.map((r) => ({
      ...portalThreadView(r),
      unreadCount: r.unreadCount,
      lastMessage: r.lastCreatedAt
        ? {
            authorName: r.lastAuthorName ?? '',
            preview: previewOf(r.lastBody ?? ''),
            createdAt: r.lastCreatedAt,
          }
        : null,
    })),
    total,
    limit: f.limit,
    offset: f.offset,
  };
}

export async function listStaffThreads(tx: Tx, p: Principal, f: ThreadFilter) {
  const { rows, total } = await queryThreads(tx, p.userId, f);
  return {
    items: rows.map((r) => ({
      ...staffThreadView(r),
      unreadCount: r.unreadCount,
      lastMessage: r.lastCreatedAt
        ? {
            authorName: r.lastAuthorName ?? '',
            preview: previewOf(r.lastBody ?? ''),
            createdAt: r.lastCreatedAt,
            direction: r.lastDirection ?? 'internal',
          }
        : null,
    })),
    total,
    limit: f.limit,
    offset: f.offset,
  };
}

export async function unreadCount(tx: Tx, threadId: string, userId: string) {
  const [r] = await tx<{ n: number }[]>`
    select count(*)::int as n from comms.messages m
    left join comms.thread_reads r on r.thread_id = m.thread_id and r.user_id = ${userId}
    where m.thread_id = ${threadId} and m.author_user_id is distinct from ${userId}::uuid
      and m.created_at > coalesce(r.last_read_at, '-infinity'::timestamptz)`;
  return r?.n ?? 0;
}
