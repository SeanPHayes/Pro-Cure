import { page } from '@procure/domain';
import { type App, conflict, must, z } from '@procure/platform';
import type { EmailRow } from '../email/outbound.js';
import {
  EmailDetail,
  EmailListItem,
  EmailListQuery,
  IdParams,
  Mailbox,
  MailboxBody,
  Ok,
} from '../schemas.js';

const listItem = (e: EmailRow) => ({
  id: e.id,
  to: e.to,
  cc: e.cc,
  subject: e.subject,
  status: e.status,
  threadId: e.threadId,
  attachmentCount: e.attachments.length,
  attempts: e.attempts,
  createdAt: e.createdAt,
  sentAt: e.sentAt,
});

/** Outbound email log (dev mailbox viewer / delivery audit) and tenant inbound mailboxes. */
export async function emailRoutes(app: App) {
  app.get(
    '/emails',
    {
      schema: {
        tags: ['emails'],
        summary: 'Outbound email log for this tenant (admin / local mailbox viewer)',
        querystring: EmailListQuery,
        response: { 200: page(EmailListItem) },
      },
    },
    async (req) => {
      const p = req.principal;
      p.requireInternal();
      p.require('org:admin');
      const { status, q, threadId, limit, offset } = req.query;
      return req.tx(async (tx) => {
        const rows = await tx<(EmailRow & { total: number })[]>`
          select *, count(*) over ()::int as total from comms.emails
          where true
            ${status ? tx`and status = ${status}` : tx``}
            ${threadId ? tx`and thread_id = ${threadId}` : tx``}
            ${q ? tx`and (subject ilike ${`%${q}%`} or array_to_string("to", ',') ilike ${`%${q}%`})` : tx``}
          order by created_at desc, id limit ${limit} offset ${offset}`;
        return { items: rows.map(listItem), total: rows[0]?.total ?? 0, limit, offset };
      });
    },
  );

  app.get(
    '/emails/:id',
    {
      schema: {
        tags: ['emails'],
        summary: 'One outbound email with full bodies',
        params: IdParams,
        response: { 200: EmailDetail },
      },
    },
    async (req) => {
      const p = req.principal;
      p.requireInternal();
      p.require('org:admin');
      return req.tx(async (tx) => {
        const [e] = await tx<EmailRow[]>`select * from comms.emails where id = ${req.params.id}`;
        const row = must(e, 'Email');
        return {
          ...listItem(row),
          fromAddress: row.fromAddress,
          replyTo: row.replyTo,
          textBody: row.textBody,
          htmlBody: row.htmlBody,
          attachments: row.attachments,
          messageId: row.messageId,
          providerMessageId: row.providerMessageId,
          error: row.error,
        };
      });
    },
  );

  app.get(
    '/mailboxes',
    {
      schema: {
        tags: ['mailboxes'],
        summary: 'Addresses whose mail is delivered to this tenant (forwarded mailboxes, @domain catch-alls)',
        response: { 200: z.array(Mailbox) },
      },
    },
    async (req) => {
      req.principal.requireInternal();
      req.principal.require('org:admin');
      return req.tx(
        (tx) => tx<z.infer<typeof Mailbox>[]>`
          select id, address, created_at from comms.tenant_mailboxes order by address`,
      );
    },
  );

  app.post(
    '/mailboxes',
    {
      schema: {
        tags: ['mailboxes'],
        summary: 'Map an inbound address (or @domain) to this tenant',
        body: MailboxBody,
        response: { 201: Mailbox },
      },
    },
    async (req, reply) => {
      const p = req.principal;
      p.requireInternal();
      p.require('org:admin');
      // Uniqueness is global: check across tenants without revealing who owns the address.
      const row = await req.tx(async (tx) => {
        const [m] = await tx<z.infer<typeof Mailbox>[]>`
          insert into comms.tenant_mailboxes (tenant_id, address) values (${p.tenantId}, ${req.body.address})
          on conflict (address) do nothing
          returning id, address, created_at`;
        return m;
      });
      if (!row) throw conflict('That address is already in use');
      return reply.status(201).send(row);
    },
  );

  app.delete(
    '/mailboxes/:id',
    {
      schema: {
        tags: ['mailboxes'],
        summary: 'Remove an inbound address mapping',
        params: IdParams,
        response: { 200: Ok },
      },
    },
    async (req) => {
      req.principal.requireInternal();
      req.principal.require('org:admin');
      const n = await req.tx(
        async (tx) => (await tx`delete from comms.tenant_mailboxes where id = ${req.params.id}`).count,
      );
      if (!n) must(undefined, 'Mailbox');
      return { ok: true as const };
    },
  );
}
