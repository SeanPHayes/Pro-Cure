import {
  type App,
  badRequest,
  emit,
  must,
  storage,
  type Tx,
  withSystem,
  withTenant,
  z,
} from '@procure/platform';
import { resolveSharing } from '../access.js';
import { Document, EntityTypeName, InternalCreateBody, InternalRenderBody } from '../schemas.js';
import {
  createDocument,
  findDocument,
  listDocuments,
  MAX_UPLOAD_BYTES,
  present,
  presentOne,
  resolveContentType,
} from '../store.js';
import { renderAndStore } from './reports.js';

const SERVICE_ACTOR = { userId: null, orgId: null, name: 'Pro-Cure' };

/**
 * Service-to-service routes (x-procure-internal). `tenantId` comes from the caller and every query runs
 * under withTenant(tenantId), so RLS still scopes reads and writes to that tenant. A null tenant on
 * POST /internal/documents creates a global document (system context).
 */
export async function internalRoutes(app: App) {
  app.post(
    '/internal/documents',
    {
      config: { internal: true },
      bodyLimit: 60 * 1024 * 1024,
      schema: { hide: true, body: InternalCreateBody, response: { 201: Document } },
    },
    async (req, reply) => {
      const b = req.body;
      const bytes = Buffer.from(b.base64, 'base64');
      if (!bytes.length) throw badRequest('base64 decodes to an empty file');
      if (bytes.length > MAX_UPLOAD_BYTES) throw badRequest('File exceeds the 200 MB limit');
      const contentType = resolveContentType(b.filename, b.contentType);
      if (!contentType) throw badRequest(`File type not allowed: ${b.contentType}`);
      if (!!b.entityType !== !!b.entityId) throw badRequest('entityType and entityId go together');
      const sharing = resolveSharing(null, b);
      const tenantId = b.tenantId;
      const run = <T>(fn: (tx: Tx) => Promise<T>) => (tenantId ? withTenant(tenantId, fn) : withSystem(fn));
      const doc = await run(async (tx) => {
        const id = await createDocument(tx, {
          tenantId: b.tenantId,
          ownerOrgId: b.tenantId,
          filename: b.filename,
          contentType,
          bytes,
          kind: b.kind,
          entityType: b.entityType ?? null,
          entityId: b.entityId ?? null,
          ...sharing,
          includeInSpecBook: b.includeInSpecBook ?? false,
          uploadedByName: b.uploadedByName ?? 'Pro-Cure',
        });
        await emit(
          tx,
          'documents',
          'documents.document.uploaded',
          {
            documentId: id,
            entityType: b.entityType ?? null,
            entityId: b.entityId ?? null,
            kind: b.kind,
            filename: b.filename,
          },
          { tenantId: b.tenantId, actor: null },
        );
        return presentOne(tx, must(await findDocument(tx, id), 'Document'));
      });
      return reply.status(201).send(doc);
    },
  );

  app.get(
    '/internal/documents/:id/content',
    {
      config: { internal: true },
      schema: {
        hide: true,
        params: z.object({ id: z.uuid() }),
        querystring: z.object({ tenantId: z.uuid() }),
        response: { 200: z.object({ filename: z.string(), contentType: z.string(), base64: z.string() }) },
      },
    },
    async (req) => {
      const doc = must(
        await withTenant(req.query.tenantId, (tx) => findDocument(tx, req.params.id)),
        'Document',
      );
      const bytes = await storage().get(doc.storageKey);
      return { filename: doc.filename, contentType: doc.contentType, base64: bytes.toString('base64') };
    },
  );

  app.get(
    '/internal/documents',
    {
      config: { internal: true },
      schema: {
        hide: true,
        querystring: z.object({
          tenantId: z.uuid(),
          entityType: EntityTypeName.optional(),
          entityId: z.uuid().optional(),
          kind: z.string().optional(),
          ids: z.string().optional(),
          includeInSpecBook: z
            .enum(['true', 'false'])
            .transform((v) => v === 'true')
            .optional(),
          limit: z.coerce.number().int().min(1).max(1000).default(500),
        }),
        response: { 200: z.array(Document) },
      },
    },
    async (req) => {
      const q = req.query;
      const ids = q.ids?.split(',').filter(Boolean) ?? [];
      if (ids.some((i) => !z.uuid().safeParse(i).success)) throw badRequest('ids must be uuids');
      if (!ids.length && !(q.entityType && q.entityId) && !q.kind)
        throw badRequest('Provide entityType+entityId, kind or ids');
      return withTenant(q.tenantId, async (tx) => {
        if (ids.length) {
          const rows = [];
          for (const id of ids) {
            const d = await findDocument(tx, id);
            if (d) rows.push(d);
          }
          return present(tx, rows);
        }
        const { rows } = await listDocuments(tx, { ...q, offset: 0 });
        return present(tx, rows);
      });
    },
  );

  app.post(
    '/internal/reports/render',
    {
      config: { internal: true },
      schema: { hide: true, body: InternalRenderBody, response: { 201: Document } },
    },
    async (req, reply) => {
      const { tenantId, ...body } = req.body;
      const doc = await withTenant(tenantId, (tx) =>
        renderAndStore(tx, tenantId, body, SERVICE_ACTOR, (t, data) =>
          emit(t, 'documents', 'documents.report.rendered', data, { tenantId, actor: null }),
        ),
      );
      return reply.status(201).send(doc);
    },
  );
}
