import { page } from '@procure/domain';
import {
  type App,
  badRequest,
  config,
  conflict,
  must,
  storage,
  type Tx,
  unprocessable,
  upstream,
  withTenant,
  z,
} from '@procure/platform';
import { clients } from '../clients.js';
import { buildMime } from '../email/mime.js';
import { type InboundRow, type IngestResult, ingestRawEmail, routeToThread } from '../inbound/pipeline.js';
import { stripQuotedReply } from '../inbound/quotes.js';
import {
  IdParams,
  InboundConfig,
  InboundCounts,
  InboundEmail,
  InboundListItem,
  InboundListQuery,
  IngestResponse,
  InternalInbound,
  InternalRouteBody,
  ManualRouteBody,
  RawInboundBody,
  SesInboundBody,
  SimulateInboundBody,
  TenantQuery,
} from '../schemas.js';
import { getOrCreateThread, previewOf, serviceEmitter, type ThreadRow } from '../threads.js';

const MAX_RAW_BYTES = 40 * 1024 * 1024;

/** Suggestion types that file the email on a thread (ai emits route_to_po for ranked PO candidates). */
const ROUTE_TYPES = new Set(['route_to_thread', 'route_to_po', 'route']);

/** Known suggestion payload fields (produced by the ai service; validated per type below). */
interface SuggestionPayload {
  shipmentId?: string;
  carrier?: string;
  trackingNumber?: string;
  shipDate?: string;
  newShipDate?: string;
  poId?: string;
  kind?: string;
  status?: string;
  note?: string;
  documentId?: string;
  attachmentIndex?: number;
  threadId?: string;
  entityType?: string;
  entityId?: string;
  visibility?: 'internal' | 'vendor' | 'client';
  vendorOrgId?: string;
  clientOrgId?: string;
  subject?: string;
}

const ingestResponse = (r: IngestResult) => ({
  id: r.inbound.id,
  status: r.inbound.status,
  tenantResolved: !!r.inbound.tenantId,
  routedThreadId: r.inbound.routedThreadId,
  duplicate: r.duplicate,
});

const decode = (b64: string) => {
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) throw badRequest('rawBase64 is empty or not base64');
  if (buf.length > MAX_RAW_BYTES) throw unprocessable('Message too large');
  return buf;
};

const inboundView = (r: InboundRow) => ({
  id: r.id,
  messageId: r.messageId,
  fromAddress: r.fromAddress,
  fromName: r.fromName,
  toAddresses: r.toAddresses,
  cc: r.cc,
  subject: r.subject,
  textBody: r.textBody,
  strippedText: stripQuotedReply(r.textBody ?? ''),
  htmlBody: r.htmlBody,
  receivedAt: r.receivedAt,
  rawDocumentId: r.rawDocumentId,
  attachments: r.attachments,
  status: r.status,
  routedThreadId: r.routedThreadId,
  routedEntityType: r.routedEntityType,
  routedEntityId: r.routedEntityId,
  routing: r.routing,
  suggestions: r.suggestions,
  triagedByName: r.triagedByName,
  triagedAt: r.triagedAt,
  source: r.source,
});

async function loadInbound(tx: Tx, id: string, lock = false): Promise<InboundRow> {
  const [r] = lock
    ? await tx<InboundRow[]>`select * from comms.inbound_emails where id = ${id} for update`
    : await tx<InboundRow[]>`select * from comms.inbound_emails where id = ${id}`;
  return must(r, 'Inbound email');
}

/** Resolve the routing target to a thread (creating it). Vendor threads when vendorOrgId given. */
async function targetThread(
  tx: Tx,
  tenantId: string,
  t: {
    threadId?: string;
    entityType?: string;
    entityId?: string;
    visibility?: 'internal' | 'vendor' | 'client';
    vendorOrgId?: string;
    clientOrgId?: string;
    subject?: string;
  },
  fallbackSubject: string,
): Promise<ThreadRow> {
  if (t.threadId) {
    const [th] = await tx<ThreadRow[]>`select * from comms.threads where id = ${t.threadId}`;
    return must(th, 'Thread');
  }
  if (!t.entityType || !t.entityId) throw unprocessable('threadId or entityType + entityId is required');
  const visibility = t.visibility ?? (t.vendorOrgId ? 'vendor' : t.clientOrgId ? 'client' : 'internal');
  const { thread } = await getOrCreateThread(tx, {
    tenantId,
    entityType: t.entityType,
    entityId: t.entityId,
    visibility,
    vendorOrgId: t.vendorOrgId ?? null,
    clientOrgId: t.clientOrgId ?? null,
    subject: t.subject ?? fallbackSubject,
  });
  return thread;
}

/** Build a MIME message for /inbound/simulate so it goes through the exact same parser. */
function simulatedMime(b: z.infer<typeof SimulateInboundBody>) {
  const to = Array.isArray(b.to) ? b.to : [b.to];
  return buildMime({
    from: b.fromName ? `${b.fromName} <${b.from}>` : b.from,
    to,
    cc: b.cc ?? [],
    replyTo: null,
    subject: b.subject,
    text: b.text,
    html: b.html ?? null,
    messageId: `<sim-${crypto.randomUUID()}@${config().INBOUND_EMAIL_DOMAIN}>`,
    inReplyTo: b.inReplyTo ?? null,
    attachments: b.attachments.map((a) => ({
      filename: a.filename,
      contentType: a.contentType,
      content: Buffer.from(a.base64, 'base64'),
    })),
  });
}

export async function inboundRoutes(app: App) {
  // ------------------------------------------------------------------ ingestion
  app.post(
    '/inbound/ses',
    {
      config: { internal: true },
      schema: {
        tags: ['inbound'],
        summary: 'SES receipt hook (S3 → Lambda): ingest a received message by S3 key or raw bytes',
        body: SesInboundBody,
        response: { 200: IngestResponse },
      },
    },
    async (req) => {
      let raw: Buffer;
      if (req.body.rawBase64) raw = decode(req.body.rawBase64);
      else {
        try {
          raw = await storage().get(req.body.s3Key!);
        } catch (err) {
          throw upstream(`Could not read ${req.body.s3Key}`, (err as Error).message);
        }
      }
      return ingestResponse(await ingestRawEmail(raw, { source: 'ses', log: req.log }));
    },
  );

  app.post(
    '/inbound/raw',
    {
      config: { internal: true },
      schema: {
        tags: ['inbound'],
        summary: 'Ingest a raw RFC 5322 message (base64)',
        body: RawInboundBody,
        response: { 200: IngestResponse },
      },
    },
    async (req) =>
      ingestResponse(await ingestRawEmail(decode(req.body.rawBase64), { source: 'raw', log: req.log })),
  );

  app.post(
    '/inbound/simulate',
    {
      schema: {
        tags: ['inbound'],
        summary: 'Demo/local: deliver a simulated inbound email to this tenant through the real pipeline',
        body: SimulateInboundBody,
        response: { 200: IngestResponse },
      },
    },
    async (req) => {
      const p = req.principal;
      p.requireInternal();
      p.require('inbox:triage');
      if (config().APP_ENV === 'production') throw badRequest('Simulation is disabled in production');
      const result = await ingestRawEmail(simulatedMime(req.body), {
        source: 'simulate',
        tenantId: p.tenantId,
        actor: { userId: p.userId, orgId: p.orgId, name: p.name },
        log: req.log,
      });
      return ingestResponse(result);
    },
  );

  // ------------------------------------------------------------------ triage
  app.get(
    '/inbound',
    {
      schema: {
        tags: ['inbox'],
        summary: 'Inbound emails for triage',
        querystring: InboundListQuery,
        response: { 200: page(InboundListItem) },
      },
    },
    async (req) => {
      req.principal.requireInternal();
      req.principal.require('inbox:triage');
      const { status, q, limit, offset } = req.query;
      return req.tx(async (tx) => {
        const rows = await tx<(InboundRow & { total: number })[]>`
          select *, count(*) over ()::int as total from comms.inbound_emails
          where true
            ${status?.length ? tx`and status in ${tx(status)}` : tx``}
            ${
              q
                ? tx`and (subject ilike ${`%${q}%`} or from_address ilike ${`%${q}%`}
                       or coalesce(from_name, '') ilike ${`%${q}%`} or coalesce(text_body, '') ilike ${`%${q}%`})`
                : tx``
            }
          order by received_at desc, id
          limit ${limit} offset ${offset}`;
        return {
          items: rows.map((r) => ({
            id: r.id,
            fromAddress: r.fromAddress,
            fromName: r.fromName,
            toAddresses: r.toAddresses,
            subject: r.subject,
            preview: previewOf(stripQuotedReply(r.textBody ?? '')),
            receivedAt: r.receivedAt,
            status: r.status,
            attachmentCount: r.attachments.length,
            routedThreadId: r.routedThreadId,
            routedEntityType: r.routedEntityType,
            routedEntityId: r.routedEntityId,
            routing: r.routing,
            suggestionCount: r.suggestions.length,
          })),
          total: rows[0]?.total ?? 0,
          limit,
          offset,
        };
      });
    },
  );

  app.get(
    '/inbound/config',
    {
      schema: {
        tags: ['inbox'],
        summary: 'Inbound email setup: receiving domain, forwarding address, simulator availability',
        response: { 200: InboundConfig },
      },
    },
    async (req) => {
      req.principal.requireInternal();
      const domain = config().INBOUND_EMAIL_DOMAIN;
      return {
        inboundDomain: domain,
        forwardingAddress: `inbox@${domain}`,
        simulatorEnabled: config().APP_ENV !== 'production',
      };
    },
  );

  app.get(
    '/inbound/counts',
    {
      schema: {
        tags: ['inbox'],
        summary: 'Inbound email counts per status (inbox filter badges)',
        response: { 200: InboundCounts },
      },
    },
    async (req) => {
      req.principal.requireInternal();
      req.principal.require('inbox:triage');
      return req.tx(async (tx) => {
        const rows = await tx<{ status: string; n: number }[]>`
          select status, count(*)::int as n from comms.inbound_emails group by status`;
        const by = Object.fromEntries(rows.map((r) => [r.status, r.n]));
        return {
          pending: by.pending ?? 0,
          needs_review: by.needs_review ?? 0,
          routed: by.routed ?? 0,
          ignored: by.ignored ?? 0,
          total: rows.reduce((a, r) => a + r.n, 0),
        };
      });
    },
  );

  app.get(
    '/inbound/:id',
    {
      schema: {
        tags: ['inbox'],
        summary: 'One inbound email with routing, suggestions and attachments',
        params: IdParams,
        response: { 200: InboundEmail },
      },
    },
    async (req) => {
      req.principal.requireInternal();
      req.principal.require('inbox:triage');
      return req.tx(async (tx) => inboundView(await loadInbound(tx, req.params.id)));
    },
  );

  app.post(
    '/inbound/:id/route',
    {
      schema: {
        tags: ['inbox'],
        summary: 'Manually file an inbound email onto an entity thread',
        params: IdParams,
        body: ManualRouteBody,
        response: { 200: InboundEmail },
      },
    },
    async (req) => {
      const p = req.principal;
      p.requireInternal();
      p.require('inbox:triage');
      return req.tx(async (tx) => {
        const inbound = await loadInbound(tx, req.params.id, true);
        const thread = await targetThread(tx, p.tenantId, req.body, inbound.subject || 'Email');
        if (inbound.status === 'routed' && inbound.routedThreadId === thread.id) return inboundView(inbound);
        const routed = await routeToThread(
          tx,
          (t, type, data) => req.emit(t, type, data),
          inbound,
          thread,
          { method: 'manual', confidence: 1, reasons: [`Filed manually by ${p.name}`] },
          p.name,
          req.log,
        );
        return inboundView(routed);
      });
    },
  );

  app.post(
    '/inbound/:id/ignore',
    {
      schema: {
        tags: ['inbox'],
        summary: 'Dismiss an inbound email (spam, newsletters, no action needed)',
        params: IdParams,
        response: { 200: InboundEmail },
      },
    },
    async (req) => {
      const p = req.principal;
      p.requireInternal();
      p.require('inbox:triage');
      return req.tx(async (tx) => {
        const inbound = await loadInbound(tx, req.params.id, true);
        if (inbound.status === 'routed') throw conflict('Email is already filed on a thread');
        const [r] = await tx<InboundRow[]>`
          update comms.inbound_emails set status = 'ignored', triaged_by_name = ${p.name}, triaged_at = now()
          where id = ${inbound.id} returning *`;
        return inboundView(r!);
      });
    },
  );

  app.post(
    '/inbound/:id/suggestions/:index/apply',
    {
      schema: {
        tags: ['inbox'],
        summary: 'Apply an AI suggestion (route to thread, set tracking, complete a PO requirement)',
        params: z.object({ id: z.uuid(), index: z.coerce.number().int().min(0) }),
        response: { 200: InboundEmail },
      },
    },
    async (req) => {
      const p = req.principal;
      p.requireInternal();
      p.require('inbox:triage');
      const { id, index } = req.params;
      const inbound = await req.tx((tx) => loadInbound(tx, id));
      const s = inbound.suggestions[index];
      if (!s) throw unprocessable(`No suggestion at index ${index}`);
      if ((s as { appliedAt?: string }).appliedAt) throw conflict('Suggestion was already applied');
      const payload = s.payload as SuggestionPayload;

      // Cross-service side effects happen before recording the result (they are idempotent upserts
      // in orders); route_to_thread stays inside our own transaction.
      let result: unknown = null;
      let error: string | null = null;
      try {
        switch (s.type) {
          case 'set_tracking': {
            if ((!payload.shipmentId && !payload.poId) || !payload.carrier || !payload.trackingNumber)
              throw unprocessable('set_tracking needs shipmentId (or poId), carrier and trackingNumber');
            // The ai router knows the PO, not the shipment: use the PO's next open shipment without tracking.
            let shipmentId = payload.shipmentId;
            if (!shipmentId) {
              const open = (await clients.listOpenShipments(p.tenantId)).filter(
                (x) => x.poId === payload.poId,
              );
              shipmentId = (open.find((x) => !x.hasTracking) ?? open[0])?.id;
              if (!shipmentId) throw new Error('This purchase order has no open shipment to add tracking to');
            }
            result = await clients.setShipmentTracking(p.tenantId, shipmentId, {
              carrier: String(payload.carrier),
              trackingNumber: String(payload.trackingNumber),
              ...(payload.shipDate ? { shipDate: String(payload.shipDate) } : {}),
            });
            break;
          }
          case 'complete_requirement':
          case 'attach_to_requirement': {
            if (!payload.poId || !payload.kind)
              throw unprocessable('complete_requirement needs poId and kind');
            const documentId =
              payload.documentId ??
              (typeof payload.attachmentIndex === 'number'
                ? inbound.attachments[payload.attachmentIndex]?.documentId
                : inbound.attachments[0]?.documentId);
            result = await clients.setPoRequirement(p.tenantId, payload.poId, {
              kind: String(payload.kind),
              status: String(payload.status ?? 'submitted'),
              ...(documentId ? { documentId } : {}),
              note: String(payload.note ?? `From email "${inbound.subject}" (${inbound.fromAddress})`),
            });
            break;
          }
          case 'route_to_thread':
          case 'route_to_po':
          case 'route':
            break;
          case 'update_ship_date': {
            if ((!payload.shipmentId && !payload.poId) || !payload.newShipDate)
              throw unprocessable('update_ship_date needs shipmentId (or poId) and newShipDate');
            result = await clients.setShipDate(p.tenantId, {
              ...(payload.shipmentId ? { shipmentId: String(payload.shipmentId) } : {}),
              ...(payload.poId ? { poId: String(payload.poId) } : {}),
              newShipDate: String(payload.newShipDate),
              note: `From vendor email: ${inbound.subject ?? ''}`.slice(0, 2000),
            });
            break;
          }
          default:
            throw unprocessable(`Unknown suggestion type: ${s.type}`);
        }
      } catch (err) {
        if ((err as { status?: number }).status === 422) throw err;
        error = (err as Error).message;
      }

      return req.tx(async (tx) => {
        const fresh = await loadInbound(tx, id, true);
        let current = fresh;
        if (!error && ROUTE_TYPES.has(s.type)) {
          const thread = await targetThread(tx, p.tenantId, payload, fresh.subject || 'Email');
          current = await routeToThread(
            tx,
            (t, type, data) => req.emit(t, type, data),
            fresh,
            thread,
            {
              method: 'ai',
              confidence: fresh.routing?.confidence ?? 0.5,
              reasons: [...(fresh.routing?.reasons ?? []), `Suggestion applied by ${p.name}`],
            },
            p.name,
            req.log,
          );
          result = { threadId: thread.id };
        }
        const suggestions = [...current.suggestions] as Record<string, unknown>[];
        suggestions[index] = {
          ...suggestions[index],
          ...(error ? { error } : { appliedAt: new Date().toISOString(), result: result ?? { ok: true } }),
        };
        const [r] = await tx<InboundRow[]>`
          update comms.inbound_emails set suggestions = ${tx.json(suggestions as never)},
            triaged_by_name = ${p.name}, triaged_at = now()
          where id = ${id} returning *`;
        return inboundView(r!);
      });
    },
  );

  // ------------------------------------------------------------------ internal (ai service)
  app.get(
    '/internal/inbound/:id',
    {
      config: { internal: true },
      schema: {
        tags: ['internal'],
        summary: 'Inbound email for the AI router',
        params: IdParams,
        querystring: TenantQuery,
        response: { 200: InternalInbound },
      },
    },
    async (req) =>
      withTenant(req.query.tenantId, async (tx) => {
        const r = await loadInbound(tx, req.params.id);
        return {
          id: r.id,
          from: r.fromAddress,
          fromName: r.fromName,
          to: r.toAddresses,
          cc: r.cc,
          subject: r.subject,
          text: stripQuotedReply(r.textBody ?? ''),
          html: r.htmlBody,
          receivedAt: r.receivedAt,
          status: r.status,
          attachments: r.attachments.map((a) => ({
            documentId: a.documentId,
            filename: a.filename,
            contentType: a.contentType,
          })),
        };
      }),
  );

  app.post(
    '/internal/inbound/:id/route',
    {
      config: { internal: true },
      schema: {
        tags: ['internal'],
        summary: 'AI router result: file the email on a thread, or park it for review with suggestions',
        params: IdParams,
        querystring: TenantQuery,
        body: InternalRouteBody,
        response: { 200: InboundEmail },
      },
    },
    async (req) => {
      const tenantId = req.query.tenantId;
      const b = req.body;
      const emitter = serviceEmitter(tenantId, { userId: null, orgId: null, name: 'Pro-Cure AI' });
      return withTenant(tenantId, async (tx) => {
        const inbound = await loadInbound(tx, req.params.id, true);
        // A human decision wins over a late AI result.
        if (inbound.status === 'ignored' || inbound.routing?.method === 'manual') return inboundView(inbound);
        const routing = { method: 'ai' as const, confidence: b.confidence, reasons: b.reasons };
        if (b.status === 'routed') {
          const thread = await targetThread(tx, tenantId, b, inbound.subject || 'Email');
          const [withSuggestions] = await tx<InboundRow[]>`
            update comms.inbound_emails set suggestions = ${tx.json(b.suggestions as never)}
            where id = ${inbound.id} returning *`;
          return inboundView(
            await routeToThread(tx, emitter, withSuggestions!, thread, routing, null, req.log),
          );
        }
        const [r] = await tx<InboundRow[]>`
          update comms.inbound_emails set status = 'needs_review', routing = ${tx.json(routing as never)},
            suggestions = ${tx.json(
              (b.entityType && b.entityId && !b.suggestions.some((s) => ROUTE_TYPES.has(s.type))
                ? [
                    {
                      type: 'route_to_thread',
                      label: `File on ${b.entityType.replace(/_/g, ' ')}`,
                      payload: {
                        entityType: b.entityType,
                        entityId: b.entityId,
                        ...(b.vendorOrgId ? { vendorOrgId: b.vendorOrgId } : {}),
                        ...(b.clientOrgId ? { clientOrgId: b.clientOrgId } : {}),
                      },
                    },
                    ...b.suggestions,
                  ]
                : b.suggestions) as never,
            )}
          where id = ${inbound.id} returning *`;
        return inboundView(r!);
      });
    },
  );
}
