import { config, type EmitActor, type Tx, withSystem, withTenant } from '@procure/platform';
import { clients } from '../clients.js';
import type { Logger } from '../log.js';
import { aliasFromAddress, appendMessage, type Emitter, serviceEmitter, type ThreadRow } from '../threads.js';
import { type ParsedEmail, parseRawEmail } from './parse.js';
import { stripQuotedReply } from './quotes.js';

export interface InboundRow {
  id: string;
  tenantId: string | null;
  messageId: string | null;
  inReplyTo: string | null;
  fromAddress: string;
  fromName: string | null;
  toAddresses: string[];
  cc: string[];
  subject: string;
  textBody: string | null;
  htmlBody: string | null;
  receivedAt: string;
  rawDocumentId: string | null;
  attachmentDocumentIds: string[];
  attachments: { documentId: string; filename: string; contentType: string; size: number }[];
  status: 'pending' | 'routed' | 'needs_review' | 'ignored';
  routedThreadId: string | null;
  routedEntityType: string | null;
  routedEntityId: string | null;
  routing: { confidence: number; reasons: string[]; method: 'alias' | 'ai' | 'manual' } | null;
  suggestions: { type: string; label: string; payload: Record<string, unknown> }[];
  triagedByName: string | null;
  triagedAt: string | null;
  source: 'ses' | 'raw' | 'simulate';
  createdAt: string;
}

export interface IngestOptions {
  source: InboundRow['source'];
  /** Simulated mail from a signed-in user: the tenant is known and alias matches must be in it. */
  tenantId?: string;
  actor?: EmitActor | null;
  log?: Logger;
}

export interface IngestResult {
  inbound: InboundRow;
  duplicate: boolean;
}

const MAX_ATTACHMENT_BYTES = 40 * 1024 * 1024;

/** Find the thread a message is addressed to via a `t-<alias>@INBOUND_EMAIL_DOMAIN` recipient. */
async function threadForRecipients(recipients: string[], tenantId?: string): Promise<ThreadRow | undefined> {
  const aliases = [...new Set(recipients.map(aliasFromAddress).filter((a): a is string => !!a))];
  if (!aliases.length) return undefined;
  // Aliases are globally unique; the lookup must span tenants because the tenant is not known yet.
  const rows = await withSystem(
    (tx) => tx<ThreadRow[]>`
    select * from comms.threads where email_alias in ${tx(aliases)}`,
  );
  return rows.find((t) => !tenantId || t.tenantId === tenantId);
}

/** Tenant from a configured mailbox (exact address, then `@domain` catch-all). */
async function tenantForRecipients(
  recipients: string[],
): Promise<{ tenantId: string; address: string } | undefined> {
  if (!recipients.length) return undefined;
  const domains = [...new Set(recipients.map((r) => `@${r.split('@')[1] ?? ''}`))];
  const rows = await withSystem(
    (tx) => tx<{ tenantId: string; address: string }[]>`
    select tenant_id, address from comms.tenant_mailboxes where address in ${tx([...recipients, ...domains])}`,
  );
  // Prefer an exact address over a domain catch-all, in recipient order.
  for (const r of recipients) {
    const exact = rows.find((x) => x.address === r);
    if (exact) return exact;
  }
  for (const r of recipients) {
    const dom = rows.find((x) => x.address === `@${r.split('@')[1]}`);
    if (dom) return dom;
  }
  return undefined;
}

/** Store the raw message and its attachments in documents, visible to the thread's audience. */
async function storeFiles(
  tenantId: string,
  raw: Buffer,
  parsed: ParsedEmail,
  thread: ThreadRow | undefined,
  inboundId: string,
  log?: Logger,
) {
  const visibility = thread?.visibility ?? 'internal';
  const share = {
    visibility,
    ...(thread?.vendorOrgId ? { vendorOrgId: thread.vendorOrgId } : {}),
    ...(thread?.clientOrgId ? { clientOrgId: thread.clientOrgId } : {}),
  } as const;
  const uploadedByName = parsed.from.name ?? parsed.from.address;
  const safeSubject = (parsed.subject || 'email').replace(/[^\w.-]+/g, '_').slice(0, 60);
  const rawDoc = await clients.createDocument({
    tenantId,
    filename: `${safeSubject}.eml`,
    contentType: 'message/rfc822',
    base64: raw.toString('base64'),
    entityType: 'inbound_email',
    entityId: inboundId,
    kind: 'email',
    visibility: 'internal',
    uploadedByName,
  });
  const attachments: InboundRow['attachments'] = [];
  for (const a of parsed.attachments) {
    if (a.inline && a.contentType.startsWith('image/') && a.size < 20_000) continue; // signature logos
    if (a.size > MAX_ATTACHMENT_BYTES) {
      log?.warn({ filename: a.filename, size: a.size }, 'inbound attachment too large; skipped');
      continue;
    }
    const doc = await clients.createDocument({
      tenantId,
      filename: a.filename,
      contentType: a.contentType,
      base64: a.content.toString('base64'),
      entityType: 'inbound_email',
      entityId: inboundId,
      kind: 'email_attachment',
      ...share,
      uploadedByName,
    });
    attachments.push({ documentId: doc.id, filename: a.filename, contentType: a.contentType, size: a.size });
  }
  return { rawDocumentId: rawDoc.id, attachments };
}

/** Resolve the sender against the thread's external org so their message is attributed to them. */
async function senderIdentity(thread: ThreadRow, fromAddress: string, log?: Logger) {
  const orgId = thread.vendorOrgId ?? thread.clientOrgId;
  try {
    const users = await clients.listUsers(thread.tenantId, orgId ? { orgId } : { ids: [] });
    const u = users.find((x) => x.email.toLowerCase() === fromAddress);
    if (u)
      return {
        userId: u.id,
        orgId: u.orgId,
        actor: (u.orgType === 'vendor' ? 'vendor' : u.orgType === 'client' ? 'client' : 'internal') as
          | 'vendor'
          | 'client'
          | 'internal',
      };
  } catch (err) {
    log?.debug({ err: (err as Error).message }, 'sender lookup failed');
  }
  return null;
}

/**
 * Append an inbound email to a thread (idempotent per email + thread) and mark it routed.
 */
export async function routeToThread(
  tx: Tx,
  emitter: Emitter,
  inbound: InboundRow,
  thread: ThreadRow,
  routing: { method: 'alias' | 'ai' | 'manual'; confidence: number; reasons: string[] },
  triagedByName: string | null,
  log?: Logger,
): Promise<InboundRow> {
  const [already] = await tx<{ id: string }[]>`
    select id from comms.messages where inbound_email_id = ${inbound.id} and thread_id = ${thread.id}`;
  if (!already) {
    const who = await senderIdentity(thread, inbound.fromAddress, log);
    await appendMessage(
      tx,
      emitter,
      {
        thread,
        authorUserId: who?.userId ?? null,
        authorName: inbound.fromName || inbound.fromAddress,
        authorEmail: inbound.fromAddress,
        authorOrgId: who?.orgId ?? thread.vendorOrgId ?? thread.clientOrgId ?? null,
        authorActor: who?.actor ?? 'email',
        direction: 'inbound',
        channel: 'email',
        bodyText: stripQuotedReply(inbound.textBody ?? ''),
        bodyHtml: inbound.htmlBody,
        attachmentDocumentIds: inbound.attachmentDocumentIds,
        emailMessageId: inbound.messageId,
        inReplyTo: inbound.inReplyTo,
        inboundEmailId: inbound.id,
      },
      log,
    );
  }
  const [row] = await tx<InboundRow[]>`
    update comms.inbound_emails set status = 'routed', routed_thread_id = ${thread.id},
      routed_entity_type = ${thread.entityType}, routed_entity_id = ${thread.entityId},
      routing = ${tx.json(routing as never)},
      triaged_by_name = ${triagedByName}, triaged_at = ${triagedByName || routing.method !== 'alias' ? tx`now()` : null}
    where id = ${inbound.id} returning *`;
  return row!;
}

/**
 * The one inbound pipeline (SES, raw, simulate): parse → store files → resolve tenant and thread →
 * route by alias, or park as pending for the AI router (comms.inbound_email.received).
 */
export async function ingestRawEmail(raw: Buffer, opts: IngestOptions): Promise<IngestResult> {
  const log = opts.log;
  const parsed = await parseRawEmail(raw);
  const recipients = [
    ...new Set([...parsed.to, ...parsed.cc].map((a) => a.address).concat(parsed.deliveredTo)),
  ];

  const thread = await threadForRecipients(recipients, opts.tenantId);
  const tenantId =
    thread?.tenantId ?? opts.tenantId ?? (await tenantForRecipients(recipients))?.tenantId ?? null;

  if (tenantId && parsed.messageId) {
    const [dup] = await withTenant(
      tenantId,
      (tx) => tx<InboundRow[]>`
      select * from comms.inbound_emails where tenant_id = ${tenantId} and message_id = ${parsed.messageId}`,
    );
    if (dup) return { inbound: dup, duplicate: true };
  }

  const base = {
    messageId: parsed.messageId,
    inReplyTo: parsed.inReplyTo,
    fromAddress: parsed.from.address,
    fromName: parsed.from.name,
    toAddresses: parsed.to.map((a) => a.address),
    cc: parsed.cc.map((a) => a.address),
    subject: parsed.subject.slice(0, 998),
    textBody: parsed.text,
    htmlBody: parsed.html,
    receivedAt:
      parsed.date && Date.parse(parsed.date) <= Date.now() + 60_000 ? parsed.date : new Date().toISOString(),
    source: opts.source,
  };

  if (!tenantId) {
    // Nobody to deliver to: keep the metadata for operators, but do not store files for no tenant.
    log?.warn({ recipients, from: parsed.from.address }, 'inbound email matched no tenant');
    const [row] = await withSystem(
      (tx) => tx<InboundRow[]>`
      insert into comms.inbound_emails ${tx({
        ...base,
        tenantId: null,
        status: 'ignored',
        routing: tx.json({
          confidence: 0,
          reasons: ['No thread alias or tenant mailbox matched the recipients'],
          method: 'alias',
        } as never),
        attachments: tx.json(
          parsed.attachments.map((a) => ({
            filename: a.filename,
            contentType: a.contentType,
            size: a.size,
          })) as never,
        ),
      } as never)}
      on conflict do nothing returning *`,
    );
    return { inbound: row!, duplicate: !row };
  }

  // Files are linked to the inbound email (documents requires entityType + entityId together), so
  // the row id is chosen before the files are stored.
  const inboundId = crypto.randomUUID();
  const files = await storeFiles(tenantId, raw, parsed, thread, inboundId, log);
  const emitter = serviceEmitter(tenantId, opts.actor ?? null);

  return withTenant(tenantId, async (tx) => {
    const [row] = await tx<InboundRow[]>`
      insert into comms.inbound_emails ${tx({
        ...base,
        id: inboundId,
        tenantId,
        rawDocumentId: files.rawDocumentId,
        attachmentDocumentIds: files.attachments.map((a) => a.documentId),
        attachments: tx.json(files.attachments as never),
        status: 'pending',
      } as never)}
      on conflict do nothing returning *`;
    if (!row) {
      const [dup] = await tx<InboundRow[]>`
        select * from comms.inbound_emails where tenant_id = ${tenantId} and message_id = ${parsed.messageId}`;
      return { inbound: dup!, duplicate: true };
    }
    if (thread) {
      const routed = await routeToThread(
        tx,
        emitter,
        row,
        thread,
        {
          method: 'alias',
          confidence: 1,
          reasons: [
            `Addressed to the thread reply address t-${thread.emailAlias}@${config().INBOUND_EMAIL_DOMAIN}`,
          ],
        },
        null,
        log,
      );
      return { inbound: routed, duplicate: false };
    }
    await emitter(tx, 'comms.inbound_email.received', { inboundEmailId: row.id });
    return { inbound: row, duplicate: false };
  });
}
