import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  type App,
  type DbContext,
  must,
  Principal,
  unauthorized,
  verifyAccessToken,
  withContext,
  z,
} from '@procure/platform';
import { IdParams, Notification, NotificationList, NotificationQuery, Preferences } from '../schemas.js';

/** The parts of a Fastify request/reply the SSE handler uses (comms has no direct fastify dep). */
interface StreamRequest {
  headers: IncomingMessage['headers'];
  query: unknown;
  raw: IncomingMessage;
  log: { warn: (obj: object, msg: string) => void };
}
interface StreamReply {
  hijack(): void;
  raw: ServerResponse;
}

const ctxOf = (p: Principal): DbContext => ({
  tenantId: p.tenantId,
  userId: p.userId,
  orgId: p.orgId,
  actor: p.actor,
  userName: p.name,
});

const COLS = 'id, type, title, body, link, severity, entity_type, entity_id, read_at, created_at';

/**
 * Notifications for `p` created since `sinceIso` (inclusive), oldest first. The SSE poller passes a
 * lookback window and de-duplicates by id, which tolerates sub-millisecond timestamps and
 * transactions that commit out of order.
 */
export async function pollNotifications(
  p: Principal,
  sinceIso: string | null,
  limit = 100,
): Promise<Notification[]> {
  return withContext(ctxOf(p), (tx) =>
    sinceIso
      ? tx<Notification[]>`
          select ${tx.unsafe(COLS)} from comms.notifications
          where user_id = ${p.userId} and created_at >= ${sinceIso}::timestamptz
          order by created_at, id limit ${limit}`
      : tx<Notification[]>`
          select ${tx.unsafe(COLS)} from comms.notifications
          where user_id = ${p.userId} order by created_at desc, id desc limit 1`,
  );
}

/** Lookback for the poller; covers commit lag between insert time and visibility. */
const SSE_LOOKBACK_MS = 30_000;

export const SSE_POLL_MS = 3_000;
export const SSE_HEARTBEAT_MS = 20_000;

/** `exp` (seconds) from a verified JWT; AccessClaims parsing drops registered claims. */
const tokenExpiry = (token: string): number | undefined => {
  try {
    const json = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'));
    return typeof json.exp === 'number' ? json.exp : undefined;
  } catch {
    return undefined;
  }
};

async function principalFrom(req: StreamRequest): Promise<Principal> {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ')
    ? header.slice(7)
    : ((req.query as { token?: string }).token ?? undefined);
  if (!token) throw unauthorized();
  return new Principal(await verifyAccessToken(token), token);
}

/** Server-Sent Events: pushes each new notification as `event: notification`. */
/** Close functions of live streams, so app.close() / shutdown does not wait on open connections. */
const openStreams = new Set<() => void>();

export const sseTiming = { pollMs: SSE_POLL_MS, heartbeatMs: SSE_HEARTBEAT_MS };

async function stream(req: StreamRequest, reply: StreamReply) {
  const opts = sseTiming;
  const p = await principalFrom(req);
  p.require('messages:read');
  // Only notifications created after connect are pushed (or after Last-Event-ID on reconnect).
  let since = new Date().toISOString();
  const lastEventId = req.headers['last-event-id'];
  if (typeof lastEventId === 'string') {
    const ts = lastEventId.split('|')[0] ?? '';
    if (!Number.isNaN(Date.parse(ts)) && Date.parse(ts) > Date.now() - 24 * 3_600_000) since = ts;
  }
  const sinceMs = Date.parse(since);
  /** id → createdAt (ms) of rows already sent; pruned once they fall out of the lookback window. */
  const sent = new Map<string, number>();
  if (typeof lastEventId === 'string') {
    const id = lastEventId.split('|')[1];
    if (id) sent.set(id, sinceMs);
  } else {
    // Timestamps are microsecond precision; rows from the connect millisecond are already "seen".
    for (const n of await pollNotifications(p, new Date(sinceMs - 1_000).toISOString()))
      sent.set(n.id, Date.parse(n.createdAt));
  }

  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    'access-control-allow-origin': (req.headers.origin as string) ?? '*',
    'access-control-allow-credentials': 'true',
  });
  res.write(`retry: 5000\n: connected\n\n`);

  let closed = false;
  let polling = false;
  const tick = async () => {
    if (closed || polling) return;
    polling = true;
    try {
      const from = new Date(Math.max(sinceMs, Date.now() - SSE_LOOKBACK_MS)).toISOString();
      const rows = await pollNotifications(p, from);
      for (const n of rows) {
        if (sent.has(n.id) || closed) continue;
        sent.set(n.id, Date.parse(n.createdAt));
        res.write(`id: ${n.createdAt}|${n.id}\nevent: notification\ndata: ${JSON.stringify(n)}\n\n`);
      }
      const horizon = Date.now() - SSE_LOOKBACK_MS - 5_000;
      for (const [id, at] of sent) if (at < horizon) sent.delete(id);
    } catch (err) {
      req.log.warn({ err: (err as Error).message }, 'notification stream poll failed');
    } finally {
      polling = false;
    }
  };
  const poll = setInterval(tick, opts.pollMs);
  const beat = setInterval(() => !closed && res.write(`: heartbeat ${Date.now()}\n\n`), opts.heartbeatMs);
  // Token expiry ends the stream; EventSource reconnects and the client supplies a fresh token.
  const exp = tokenExpiry(p.token);
  const expiry = exp ? setTimeout(() => close(), Math.max(1_000, exp * 1000 - Date.now())) : undefined;
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(poll);
    clearInterval(beat);
    if (expiry) clearTimeout(expiry);
    openStreams.delete(close);
    res.end();
  };
  openStreams.add(close);
  req.raw.on('close', close);
  res.on('close', close);
  void tick();
}

export async function notificationRoutes(app: App) {
  app.addHook('onClose', async () => {
    for (const close of [...openStreams]) close();
  });
  app.get(
    '/notifications',
    {
      schema: {
        tags: ['notifications'],
        summary: 'My notifications, newest first, with unread count',
        querystring: NotificationQuery,
        response: { 200: NotificationList },
      },
    },
    async (req) => {
      const p = req.principal;
      p.require('messages:read');
      const { unreadOnly, limit, before } = req.query;
      return req.tx(async (tx) => {
        const items = await tx<Notification[]>`
          select ${tx.unsafe(COLS)} from comms.notifications
          where user_id = ${p.userId}
            ${unreadOnly ? tx`and read_at is null` : tx``}
            ${before ? tx`and created_at < ${before}` : tx``}
          order by created_at desc, id desc limit ${limit}`;
        const [c] = await tx<{ n: number }[]>`
          select count(*)::int as n from comms.notifications where user_id = ${p.userId} and read_at is null`;
        return { items, unreadCount: c?.n ?? 0 };
      });
    },
  );

  app.post(
    '/notifications/:id/read',
    {
      schema: {
        tags: ['notifications'],
        summary: 'Mark one notification read',
        params: IdParams,
        response: { 200: Notification },
      },
    },
    async (req) => {
      const p = req.principal;
      p.require('messages:read');
      return req.tx(async (tx) => {
        const [n] = await tx<Notification[]>`
          update comms.notifications set read_at = coalesce(read_at, now())
          where id = ${req.params.id} and user_id = ${p.userId}
          returning ${tx.unsafe(COLS)}`;
        return must(n, 'Notification');
      });
    },
  );

  app.post(
    '/notifications/read-all',
    {
      schema: {
        tags: ['notifications'],
        summary: 'Mark all my notifications read',
        response: { 200: z.object({ ok: z.literal(true), updated: z.number().int() }) },
      },
    },
    async (req) => {
      const p = req.principal;
      p.require('messages:read');
      const updated = await req.tx(
        async (tx) =>
          (
            await tx`update comms.notifications set read_at = now() where user_id = ${p.userId} and read_at is null`
          ).count,
      );
      return { ok: true as const, updated };
    },
  );

  app.get(
    '/notifications/stream',
    {
      // Authenticated in the handler: EventSource cannot send headers, so ?token= is accepted.
      config: { public: true },
      schema: {
        tags: ['notifications'],
        summary: 'Server-Sent Events stream of new notifications (auth: Bearer header or ?token=)',
        querystring: z.object({ token: z.string().optional() }),
      },
    },
    async (req, reply) => stream(req, reply),
  );

  app.get(
    '/notification-preferences',
    {
      schema: {
        tags: ['notifications'],
        summary: 'My notification preferences',
        response: { 200: Preferences },
      },
    },
    async (req) => {
      const p = req.principal;
      p.require('messages:read');
      return req.tx(async (tx) => {
        const [r] = await tx<z.infer<typeof Preferences>[]>`
          select email_digest, muted_types from comms.notification_preferences
          where tenant_id = ${p.tenantId} and user_id = ${p.userId}`;
        return r ?? { emailDigest: 'none' as const, mutedTypes: [] };
      });
    },
  );

  app.put(
    '/notification-preferences',
    {
      schema: {
        tags: ['notifications'],
        summary: 'Update my notification preferences',
        body: Preferences.extend({ mutedTypes: z.array(z.string().min(1).max(64)).max(50) }),
        response: { 200: Preferences },
      },
    },
    async (req) => {
      const p = req.principal;
      p.require('messages:read');
      const b = req.body;
      return req.tx(async (tx) => {
        const [r] = await tx<z.infer<typeof Preferences>[]>`
          insert into comms.notification_preferences (tenant_id, user_id, email_digest, muted_types)
          values (${p.tenantId}, ${p.userId}, ${b.emailDigest}, ${[...new Set(b.mutedTypes)]})
          on conflict (tenant_id, user_id) do update
            set email_digest = excluded.email_digest, muted_types = excluded.muted_types
          returning email_digest, muted_types`;
        return r!;
      });
    },
  );
}
