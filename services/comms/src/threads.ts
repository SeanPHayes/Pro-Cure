import { randomBytes } from 'node:crypto';
import type { EventData, EventType } from '@procure/domain';
import { config, type EmitActor, emit, type Tx, unprocessable } from '@procure/platform';
import { threadPath } from './links.js';
import type { Logger } from './log.js';
import { notifyUsers, responsibleRoles } from './notify.js';

export type Emitter = <T extends EventType>(tx: Tx, type: T, data: EventData<T>) => Promise<string>;

/** Emitter for event handlers / internal endpoints (no request principal). */
export const serviceEmitter =
  (tenantId: string, actor: EmitActor | null = null): Emitter =>
  (tx, type, data) =>
    emit(tx, 'comms', type, data, { tenantId, actor });

export interface ThreadRow {
  id: string;
  tenantId: string;
  entityType: string;
  entityId: string;
  subject: string;
  visibility: 'internal' | 'vendor' | 'client';
  vendorOrgId: string | null;
  clientOrgId: string | null;
  emailAlias: string;
  lastMessageAt: string | null;
  messageCount: number;
  createdByUserId: string | null;
  createdAt: string;
}

export interface MessageRow {
  id: string;
  tenantId: string;
  threadId: string;
  authorUserId: string | null;
  authorName: string;
  authorEmail: string | null;
  authorOrgId: string | null;
  authorActor: 'internal' | 'vendor' | 'client' | 'system' | 'email';
  direction: 'internal' | 'outbound' | 'inbound';
  channel: 'app' | 'email';
  bodyText: string;
  bodyHtml: string | null;
  attachmentDocumentIds: string[];
  mentions: string[];
  emailMessageId: string | null;
  inReplyTo: string | null;
  inboundEmailId: string | null;
  aiSummary: string | null;
  createdAt: string;
  editedAt: string | null;
}

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
/** 8-char lowercase base32 token (40 bits). */
export const newAlias = () => {
  const bytes = randomBytes(8);
  let s = '';
  for (let i = 0; i < 8; i++) s += B32[bytes[i]! & 31];
  return s;
};

export const aliasAddress = (alias: string) => `t-${alias}@${config().INBOUND_EMAIL_DOMAIN}`;

const ALIAS_RE = /^t-([a-z2-7]{8})@(.+)$/i;
/** Extract a thread alias from an address on our inbound domain (`t-abcd2345@inbound…`). */
export const aliasFromAddress = (address: string): string | null => {
  const m = ALIAS_RE.exec(address.trim().toLowerCase());
  if (!m) return null;
  return m[2] === config().INBOUND_EMAIL_DOMAIN.toLowerCase() ? m[1]! : null;
};

export interface ThreadKey {
  tenantId: string;
  entityType: string;
  entityId: string;
  visibility: 'internal' | 'vendor' | 'client';
  vendorOrgId?: string | null;
  clientOrgId?: string | null;
}

export function validateThreadKey(k: ThreadKey) {
  if (k.visibility === 'vendor' && !k.vendorOrgId)
    throw unprocessable('vendorOrgId is required for vendor threads');
  if (k.visibility === 'client' && !k.clientOrgId)
    throw unprocessable('clientOrgId is required for client threads');
}

const NIL = '00000000-0000-0000-0000-000000000000';

export async function findThread(tx: Tx, k: ThreadKey): Promise<ThreadRow | undefined> {
  const org = k.visibility === 'vendor' ? k.vendorOrgId : k.visibility === 'client' ? k.clientOrgId : null;
  const [t] = await tx<ThreadRow[]>`
    select * from comms.threads
    where tenant_id = ${k.tenantId} and entity_type = ${k.entityType} and entity_id = ${k.entityId}
      and visibility = ${k.visibility}
      and coalesce(vendor_org_id, client_org_id, ${NIL}::uuid) = ${org ?? NIL}::uuid`;
  return t;
}

/** Idempotent on (tenant, entity, visibility, org). Safe under concurrency. */
export async function getOrCreateThread(
  tx: Tx,
  k: ThreadKey & { subject?: string | null; createdByUserId?: string | null },
): Promise<{ thread: ThreadRow; created: boolean }> {
  validateThreadKey(k);
  const existing = await findThread(tx, k);
  if (existing) return { thread: existing, created: false };
  const subject = k.subject?.trim() || defaultSubject(k.entityType);
  for (let attempt = 0; attempt < 5; attempt++) {
    const [t] = await tx<ThreadRow[]>`
      insert into comms.threads ${tx({
        tenantId: k.tenantId,
        entityType: k.entityType,
        entityId: k.entityId,
        subject,
        visibility: k.visibility,
        vendorOrgId: k.visibility === 'vendor' ? k.vendorOrgId : null,
        clientOrgId: k.visibility === 'client' ? k.clientOrgId : null,
        emailAlias: newAlias(),
        createdByUserId: k.createdByUserId ?? null,
      })}
      on conflict do nothing
      returning *`;
    if (t) return { thread: t, created: true };
    const raced = await findThread(tx, k);
    if (raced) return { thread: raced, created: false };
    // otherwise the alias collided — retry with a new one
  }
  throw new Error('could not allocate a thread alias');
}

const ENTITY_LABEL: Record<string, string> = {
  purchase_order: 'Purchase order',
  cost_request: 'Pricing request',
  quote: 'Quote',
  project: 'Project',
  shipment: 'Shipment',
  claim: 'Claim',
  invoice: 'Invoice',
};
export const defaultSubject = (entityType: string) =>
  `${ENTITY_LABEL[entityType] ?? entityType.replace(/_/g, ' ')} discussion`;

export interface AppendMessageInput {
  thread: ThreadRow;
  authorUserId?: string | null;
  authorName: string;
  authorEmail?: string | null;
  authorOrgId?: string | null;
  authorActor: MessageRow['authorActor'];
  direction: MessageRow['direction'];
  channel: MessageRow['channel'];
  bodyText: string;
  bodyHtml?: string | null;
  attachmentDocumentIds?: string[];
  mentions?: string[];
  emailMessageId?: string | null;
  inReplyTo?: string | null;
  inboundEmailId?: string | null;
  /** Skip notifying responsible roles (e.g. our own system messages). */
  silent?: boolean;
}

/**
 * Append a message to a thread: stores it, bumps the thread counters, emits comms.message.posted,
 * notifies mentioned users and — for messages from outside the firm — the entity's responsible
 * internal roles.
 */
export async function appendMessage(
  tx: Tx,
  emitter: Emitter,
  m: AppendMessageInput,
  log?: Logger,
): Promise<MessageRow> {
  const t = m.thread;
  const mentions = [...new Set(m.mentions ?? [])];
  const [msg] = await tx<MessageRow[]>`
    insert into comms.messages ${tx({
      tenantId: t.tenantId,
      threadId: t.id,
      authorUserId: m.authorUserId ?? null,
      authorName: m.authorName,
      authorEmail: m.authorEmail ?? null,
      authorOrgId: m.authorOrgId ?? null,
      authorActor: m.authorActor,
      direction: m.direction,
      channel: m.channel,
      bodyText: m.bodyText,
      bodyHtml: m.bodyHtml ?? null,
      attachmentDocumentIds: m.attachmentDocumentIds ?? [],
      mentions,
      emailMessageId: m.emailMessageId ?? null,
      inReplyTo: m.inReplyTo ?? null,
      inboundEmailId: m.inboundEmailId ?? null,
    })}
    returning *`;
  await tx`
    update comms.threads set message_count = message_count + 1,
      last_message_at = greatest(coalesce(last_message_at, ${msg!.createdAt}), ${msg!.createdAt})
    where id = ${t.id}`;
  if (m.authorUserId) {
    // The author has obviously read their own thread.
    await tx`
      insert into comms.thread_reads (tenant_id, thread_id, user_id, last_read_at)
      values (${t.tenantId}, ${t.id}, ${m.authorUserId}, ${msg!.createdAt})
      on conflict (thread_id, user_id) do update set last_read_at = excluded.last_read_at`;
  }
  await emitter(tx, 'comms.message.posted', {
    messageId: msg!.id,
    threadId: t.id,
    entityType: t.entityType,
    entityId: t.entityId,
    direction: m.direction,
    authorOrgId: m.authorOrgId ?? null,
  });

  const preview = previewOf(m.bodyText, 200);
  const link = threadPath('internal', t);
  const exclude = m.authorUserId ? [m.authorUserId] : [];
  if (mentions.length) {
    await notifyUsers(
      tx,
      t.tenantId,
      {
        userIds: mentions.filter((u) => !exclude.includes(u)),
        type: 'mention',
        title: `${m.authorName} mentioned you: ${t.subject}`,
        body: preview,
        link,
        severity: 'info',
        entityType: t.entityType,
        entityId: t.entityId,
      },
      log,
    );
  }
  const external = m.authorActor === 'vendor' || m.authorActor === 'client' || m.authorActor === 'email';
  if (external && !m.silent) {
    await notifyUsers(
      tx,
      t.tenantId,
      {
        roles: responsibleRoles(t.entityType),
        internalOnly: true,
        excludeUserIds: [...exclude, ...mentions],
        type: 'message',
        title: `New message from ${m.authorName}: ${t.subject}`,
        body: preview,
        link,
        severity: 'info',
        entityType: t.entityType,
        entityId: t.entityId,
      },
      log,
      emitter,
    );
  }
  return msg!;
}

export const previewOf = (text: string, n = 160) => {
  const s = text.replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};
