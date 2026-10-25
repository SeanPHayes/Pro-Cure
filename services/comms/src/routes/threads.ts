import { page } from '@procure/domain';
import { type App, forbidden, must, notFound, type Principal, type Tx, z } from '@procure/platform';
import { clients } from '../clients.js';
import { asService } from '../context.js';
import { queueEmail } from '../email/outbound.js';
import {
  AnyMessage,
  AnyThread,
  AnyThreadDetail,
  IdParams,
  Ok,
  PortalThreadListItem,
  PortalThreadListQuery,
  PostMessageBody,
  ThreadDetailQuery,
  ThreadForQuery,
  ThreadListItem,
  ThreadListQuery,
} from '../schemas.js';
import {
  appendMessage,
  type Emitter,
  findThread,
  getOrCreateThread,
  type MessageRow,
  type ThreadRow,
} from '../threads.js';
import {
  isPortal,
  listPortalThreads,
  listStaffThreads,
  portalMessageView,
  portalThreadView,
  staffMessageView,
  staffThreadView,
  threadView,
  unreadCount,
} from '../views.js';

const actorOf = (p: Principal): MessageRow['authorActor'] =>
  p.isVendor ? 'vendor' : p.isClient ? 'client' : 'internal';

const requestEmitter =
  (req: { emit: Emitter }): Emitter =>
  (tx, type, data) =>
    req.emit(tx, type, data);

async function loadThread(tx: Tx, id: string): Promise<ThreadRow> {
  const [t] = await tx<ThreadRow[]>`select * from comms.threads where id = ${id}`;
  return must(t, 'Thread');
}

async function threadDetail(tx: Tx, p: Principal, t: ThreadRow, limit: number, offset: number) {
  const msgs = await tx<(MessageRow & { total: number })[]>`
    select m.*, count(*) over ()::int as total from comms.messages m
    where m.thread_id = ${t.id}
    order by m.created_at desc, m.id desc
    limit ${limit} offset ${offset}`;
  const participants = await tx<
    {
      name: string;
      actor: MessageRow['authorActor'];
      orgId: string | null;
      messageCount: number;
      lastAt: string;
    }[]
  >`
    select author_name as name, author_actor as actor, author_org_id as org_id,
           count(*)::int as message_count, max(created_at) as last_at
    from comms.messages where thread_id = ${t.id}
    group by author_name, author_actor, author_org_id
    order by max(created_at) desc limit 50`;
  const total = msgs[0]?.total ?? t.messageCount;
  const ordered = msgs.reverse();
  const unread = await unreadCount(tx, t.id, p.userId);
  if (isPortal(p))
    return {
      ...portalThreadView(t),
      unreadCount: unread,
      participants: participants.map(({ orgId: _o, ...rest }) => rest),
      messages: { items: ordered.map((m) => portalMessageView(m, p.userId)), total, limit, offset },
    };
  return {
    ...staffThreadView(t),
    unreadCount: unread,
    participants,
    messages: { items: ordered.map(staffMessageView), total, limit, offset },
  };
}

/**
 * Get-or-create the thread for an entity, as the caller.
 * - Staff: any visibility (vendor/client threads need the org id).
 * - Vendor/client: only their own org's thread of that visibility. Existing threads are returned
 *   under RLS; a client may open a new thread on a project shared with their org (verified with
 *   the projects service). Vendor threads are opened by staff/events (cost requests, POs).
 */
async function threadFor(tx: Tx, p: Principal, q: z.infer<typeof ThreadForQuery>) {
  if (p.isVendor || p.isClient) {
    const visibility = p.isVendor ? 'vendor' : 'client';
    if (q.visibility !== visibility) throw forbidden(`Portal users can only open ${visibility} threads`);
    const key = {
      tenantId: p.tenantId,
      entityType: q.entityType,
      entityId: q.entityId,
      visibility,
      vendorOrgId: p.isVendor ? p.orgId : null,
      clientOrgId: p.isClient ? p.orgId : null,
    } as const;
    const existing = await findThread(tx, key);
    if (existing) return existing;
    if (p.isClient && q.entityType === 'project') {
      const project = await clients.getProject(p.tenantId, q.entityId).catch(() => null);
      if (project?.clientOrgId === p.orgId) {
        const { thread } = await asService(tx, p.tenantId, () =>
          getOrCreateThread(tx, { ...key, subject: q.subject, createdByUserId: p.userId }),
        );
        return thread;
      }
    }
    throw notFound('Thread');
  }
  p.requireInternal();
  const { thread } = await getOrCreateThread(tx, {
    tenantId: p.tenantId,
    entityType: q.entityType,
    entityId: q.entityId,
    visibility: q.visibility,
    vendorOrgId: q.vendorOrgId ?? null,
    clientOrgId: q.clientOrgId ?? null,
    subject: q.subject,
    createdByUserId: p.userId,
  });
  return thread;
}

export async function threadRoutes(app: App) {
  app.get(
    '/threads',
    {
      schema: {
        tags: ['threads'],
        summary: 'Threads visible to the caller, newest activity first, with preview and unread count',
        querystring: ThreadListQuery,
        response: { 200: z.union([page(ThreadListItem), page(PortalThreadListItem)]) },
      },
    },
    async (req) => {
      req.principal.require('messages:read');
      const p = req.principal;
      return req.tx((tx) =>
        isPortal(p) ? listPortalThreads(tx, p, req.query) : listStaffThreads(tx, p, req.query),
      );
    },
  );

  for (const kind of ['vendor', 'client'] as const) {
    app.get(
      `/${kind}/threads`,
      {
        schema: {
          tags: ['portal'],
          summary: `${kind === 'vendor' ? 'Vendor' : 'Owner'} portal: conversations shared with my organization`,
          querystring: PortalThreadListQuery,
          response: { 200: page(PortalThreadListItem) },
        },
      },
      async (req) => {
        const p = req.principal;
        if (kind === 'vendor' ? !p.isVendor : !p.isClient) throw forbidden(`${kind} portal only`);
        p.require('messages:read');
        return req.tx((tx) => listPortalThreads(tx, p, { ...req.query, visibility: kind }));
      },
    );
  }

  app.get(
    '/threads/for',
    {
      schema: {
        tags: ['threads'],
        summary: 'Get (or create) the thread attached to an entity for a given audience',
        querystring: ThreadForQuery,
        response: { 200: AnyThread },
      },
    },
    async (req) => {
      req.principal.require('messages:read');
      return req.tx(async (tx) => threadView(await threadFor(tx, req.principal, req.query), req.principal));
    },
  );

  app.get(
    '/threads/:id',
    {
      schema: {
        tags: ['threads'],
        summary: 'A thread with its participants and messages (paginated, newest last)',
        params: IdParams,
        querystring: ThreadDetailQuery,
        response: { 200: AnyThreadDetail },
      },
    },
    async (req) => {
      req.principal.require('messages:read');
      return req.tx(async (tx) =>
        threadDetail(
          tx,
          req.principal,
          await loadThread(tx, req.params.id),
          req.query.limit,
          req.query.offset,
        ),
      );
    },
  );

  app.post(
    '/threads/:id/messages',
    {
      schema: {
        tags: ['threads'],
        summary: 'Post a message; staff can also email it out with the thread as reply-to',
        params: IdParams,
        body: PostMessageBody,
        response: { 201: AnyMessage },
      },
    },
    async (req, reply) => {
      const p = req.principal;
      p.require('messages:write');
      const b = req.body;
      const external = p.isVendor || p.isClient;
      if (external && (b.emailTo?.length || b.emailCc?.length))
        throw forbidden('Only staff can send thread messages by email');
      const emitter = requestEmitter(req);
      const msg = await req.tx(async (tx) => {
        const thread = await loadThread(tx, req.params.id);
        const sendEmail = !external && !!b.emailTo?.length;
        const m = await appendMessage(
          tx,
          emitter,
          {
            thread,
            authorUserId: p.userId,
            authorName: p.name,
            authorEmail: p.claims.email,
            authorOrgId: p.orgId,
            authorActor: actorOf(p),
            direction: external ? 'inbound' : sendEmail ? 'outbound' : 'internal',
            channel: sendEmail ? 'email' : 'app',
            bodyText: b.bodyText,
            // Portal users post plain text only; staff HTML is rendered sanitized by the web app.
            bodyHtml: external ? null : (b.bodyHtml ?? null),
            attachmentDocumentIds: b.attachmentDocumentIds,
            mentions: external ? [] : b.mentions,
          },
          req.log,
        );
        if (!sendEmail) return m;
        const email = await queueEmail(
          tx,
          emitter,
          {
            tenantId: p.tenantId,
            to: b.emailTo!,
            cc: b.emailCc ?? [],
            subject: thread.subject,
            text: b.bodyText,
            // Empty filename: delivery uses the stored document's filename.
            attachments: b.attachmentDocumentIds.map((documentId) => ({ documentId, filename: '' })),
            threadId: thread.id,
            recordOnThread: false,
          },
          req.log,
        );
        const [u] = await tx<MessageRow[]>`
          update comms.messages set email_message_id = ${email.messageId} where id = ${m.id} returning *`;
        return u!;
      });
      return reply.status(201).send(isPortal(p) ? portalMessageView(msg, p.userId) : staffMessageView(msg));
    },
  );

  app.post(
    '/threads/:id/read',
    {
      schema: {
        tags: ['threads'],
        summary: 'Mark the thread read up to now for the caller',
        params: IdParams,
        response: { 200: Ok },
      },
    },
    async (req) => {
      const p = req.principal;
      p.require('messages:read');
      await req.tx(async (tx) => {
        const t = await loadThread(tx, req.params.id);
        await tx`
          insert into comms.thread_reads (tenant_id, thread_id, user_id, last_read_at)
          values (${t.tenantId}, ${t.id}, ${p.userId}, now())
          on conflict (thread_id, user_id) do update set last_read_at = excluded.last_read_at`;
      });
      return { ok: true as const };
    },
  );
}
