import { type App, must, withTenant } from '@procure/platform';
import { InternalMessageBody, InternalThreadBody, Message, Thread } from '../schemas.js';
import {
  aliasAddress,
  appendMessage,
  getOrCreateThread,
  serviceEmitter,
  type ThreadRow,
} from '../threads.js';

const staffThread = (t: ThreadRow) => ({
  id: t.id,
  entityType: t.entityType,
  entityId: t.entityId,
  subject: t.subject,
  visibility: t.visibility,
  vendorOrgId: t.vendorOrgId,
  clientOrgId: t.clientOrgId,
  emailAlias: t.emailAlias,
  replyToAddress: aliasAddress(t.emailAlias),
  lastMessageAt: t.lastMessageAt,
  messageCount: t.messageCount,
  createdAt: t.createdAt,
});

/** Service-to-service endpoints (docs/service-contracts.md → comms). */
export async function internalRoutes(app: App) {
  app.post(
    '/internal/threads',
    {
      config: { internal: true },
      schema: {
        tags: ['internal'],
        summary: 'Get or create the thread for an entity + audience (idempotent)',
        body: InternalThreadBody,
        response: { 200: Thread },
      },
    },
    async (req) => {
      const b = req.body;
      return withTenant(b.tenantId, async (tx) => {
        const { thread } = await getOrCreateThread(tx, {
          tenantId: b.tenantId,
          entityType: b.entityType,
          entityId: b.entityId,
          visibility: b.visibility,
          vendorOrgId: b.vendorOrgId ?? null,
          clientOrgId: b.clientOrgId ?? null,
          subject: b.subject,
        });
        return staffThread(thread);
      });
    },
  );

  app.post(
    '/internal/messages',
    {
      config: { internal: true },
      schema: {
        tags: ['internal'],
        summary: 'Append a system/service message to a thread',
        body: InternalMessageBody,
        response: { 200: Message },
      },
    },
    async (req) => {
      const b = req.body;
      return withTenant(b.tenantId, async (tx) => {
        const [t] = await tx<ThreadRow[]>`select * from comms.threads where id = ${b.threadId}`;
        const thread = must(t, 'Thread');
        const m = await appendMessage(
          tx,
          serviceEmitter(b.tenantId),
          {
            thread,
            authorUserId: b.authorUserId ?? null,
            authorName: b.authorName,
            authorEmail: b.authorEmail ?? null,
            authorActor: b.direction === 'inbound' ? 'email' : 'system',
            direction: b.direction,
            channel: b.channel,
            bodyText: b.bodyText,
            bodyHtml: b.bodyHtml ?? null,
            attachmentDocumentIds: b.attachments,
            silent: b.direction !== 'inbound',
          },
          req.log,
        );
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
      });
    },
  );
}
