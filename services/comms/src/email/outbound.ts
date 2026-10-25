import { config, type Tx } from '@procure/platform';
import { clients } from '../clients.js';
import type { Logger } from '../log.js';
import { aliasAddress, appendMessage, type Emitter, type ThreadRow } from '../threads.js';
import { emailSender } from './sender.js';
import { extractCta, renderEmail } from './template.js';

export const MAX_EMAIL_ATTEMPTS = 5;

export interface EmailRow {
  id: string;
  tenantId: string;
  fromAddress: string;
  to: string[];
  cc: string[];
  subject: string;
  textBody: string;
  htmlBody: string | null;
  replyTo: string | null;
  attachmentDocumentIds: string[];
  attachments: { documentId: string; filename: string }[];
  threadId: string | null;
  messageId: string;
  status: 'queued' | 'sent' | 'delivered-local' | 'failed';
  providerMessageId: string | null;
  error: string | null;
  attempts: number;
  nextAttemptAt: string | null;
  createdAt: string;
  sentAt: string | null;
}

export interface QueueEmailInput {
  tenantId: string;
  to: string[];
  cc?: string[];
  subject: string;
  /** Plain text. Rendered into the tenant HTML layout unless `html` is provided. */
  text: string;
  html?: string | null;
  heading?: string | null;
  cta?: { label: string; url: string } | null;
  replyTo?: string | null;
  attachments?: { documentId: string; filename: string }[];
  threadId?: string | null;
  /** Author recorded on the outbound thread message. */
  author?: { userId: string | null; name: string; email?: string | null; orgId?: string | null };
  /** Append the email to the thread as an outbound message (default true when threadId is given). */
  recordOnThread?: boolean;
}

const newMessageId = () => `<${crypto.randomUUID()}@${config().INBOUND_EMAIL_DOMAIN}>`;
const clean = (list: string[]) => [...new Set(list.map((a) => a.trim()).filter(Boolean))];

/**
 * Render, store and send an email. The row is written first (status queued) so a failed send is
 * retried by the `email-retry` job; send errors never throw out of here.
 */
export async function queueEmail(
  tx: Tx,
  emitter: Emitter,
  input: QueueEmailInput,
  log?: Logger,
): Promise<EmailRow> {
  const to = clean(input.to);
  if (!to.length) throw new Error('email has no recipients');
  let thread: ThreadRow | undefined;
  if (input.threadId) {
    [thread] = await tx<ThreadRow[]>`select * from comms.threads where id = ${input.threadId}`;
  }
  const replyTo = thread ? aliasAddress(thread.emailAlias) : (input.replyTo ?? null);
  const tenantName = await clients.tenantName(input.tenantId);
  const { text: bodyText, cta: detected } = input.html
    ? { text: input.text, cta: null }
    : extractCta(input.text);
  const rendered = renderEmail({
    tenantName,
    text: bodyText,
    html: input.html ?? null,
    heading: input.heading ?? null,
    cta: input.cta ?? detected,
    footerNote: thread ? 'Reply to this email to respond on the conversation.' : null,
  });

  const [row] = await tx<EmailRow[]>`
    insert into comms.emails ${tx({
      tenantId: input.tenantId,
      fromAddress: config().EMAIL_FROM,
      to,
      cc: clean(input.cc ?? []),
      subject: input.subject,
      textBody: rendered.text,
      htmlBody: rendered.html,
      replyTo,
      attachmentDocumentIds: (input.attachments ?? []).map((a) => a.documentId),
      attachments: tx.json((input.attachments ?? []) as never) as never,
      threadId: thread?.id ?? null,
      messageId: newMessageId(),
      status: 'queued',
    })}
    returning *`;

  if (thread && input.recordOnThread !== false) {
    const a = input.author ?? { userId: null, name: tenantName };
    await appendMessage(
      tx,
      emitter,
      {
        thread,
        authorUserId: a.userId,
        authorName: a.name,
        authorEmail: a.email ?? null,
        authorOrgId: a.orgId ?? null,
        authorActor: a.userId ? 'internal' : 'system',
        direction: 'outbound',
        channel: 'email',
        bodyText: input.text,
        bodyHtml: input.html ?? null,
        attachmentDocumentIds: row!.attachmentDocumentIds,
        emailMessageId: row!.messageId,
        silent: true,
      },
      log,
    );
  }
  return deliver(tx, row!, log);
}

/** Attempt delivery of a stored email and record the outcome. */
export async function deliver(tx: Tx, row: EmailRow, log?: Logger): Promise<EmailRow> {
  try {
    const attachments = [];
    for (const a of row.attachments) {
      const c = await clients.getDocumentContent(row.tenantId, a.documentId);
      attachments.push({
        filename: a.filename || c.filename,
        contentType: c.contentType || 'application/octet-stream',
        content: Buffer.from(c.base64, 'base64'),
      });
    }
    let inReplyTo: string | null = null;
    let references: string[] = [];
    if (row.threadId) {
      const refs = await tx<{ emailMessageId: string }[]>`
        select email_message_id from comms.messages
        where thread_id = ${row.threadId} and email_message_id is not null and email_message_id <> ${row.messageId}
        order by created_at desc limit 10`;
      references = refs.map((r) => r.emailMessageId).reverse();
      inReplyTo = references.at(-1) ?? null;
    }
    const res = await emailSender().send({
      from: row.fromAddress,
      to: row.to,
      cc: row.cc,
      replyTo: row.replyTo,
      subject: row.subject,
      text: row.textBody,
      html: row.htmlBody,
      messageId: row.messageId,
      inReplyTo,
      references,
      attachments,
    });
    const [u] = await tx<EmailRow[]>`
      update comms.emails set status = ${res.status}, provider_message_id = ${res.providerMessageId},
        error = null, attempts = attempts + 1, next_attempt_at = null, sent_at = now()
      where id = ${row.id} returning *`;
    return u!;
  } catch (err) {
    const attempts = row.attempts + 1;
    const backoffMin = 5 * 2 ** (attempts - 1); // 5, 10, 20, 40 min
    const message = (err as Error).message?.slice(0, 1000) ?? 'send failed';
    log?.warn({ emailId: row.id, attempts, err: message }, 'email send failed');
    const [u] = await tx<EmailRow[]>`
      update comms.emails set status = 'failed', error = ${message}, attempts = ${attempts},
        next_attempt_at = ${attempts >= MAX_EMAIL_ATTEMPTS ? null : tx`now() + make_interval(mins => ${backoffMin})`}
      where id = ${row.id} returning *`;
    return u!;
  }
}
