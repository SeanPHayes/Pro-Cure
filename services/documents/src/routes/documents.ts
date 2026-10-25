import type { Readable } from 'node:stream';
import {
  type App,
  badRequest,
  forbidden,
  must,
  notFound,
  Principal,
  storage,
  unauthorized,
  verifyAccessToken,
  withContext,
  z,
} from '@procure/platform';
import { requireInternalWrite, requireRead, requireUpload, resolveSharing } from '../access.js';
import {
  Document,
  DocumentListQuery,
  DocumentPatch,
  IdParams,
  LinkBody,
  page,
  UploadFields,
} from '../schemas.js';
import {
  createDocument,
  findDocument,
  listDocuments,
  MAX_UPLOAD_BYTES,
  present,
  presentOne,
  resolveContentType,
} from '../store.js';

const contentDisposition = (disposition: 'inline' | 'attachment', filename: string) => {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
};

const DownloadQuery = z.object({
  /** Access token for <a href>/<img src> links that cannot send an Authorization header. */
  token: z.string().min(20).optional(),
  download: z
    .enum(['true', 'false', '1', '0'])
    .transform((v) => v === 'true' || v === '1')
    .optional(),
});

export async function documentRoutes(app: App) {
  app.post(
    '/documents',
    {
      schema: {
        tags: ['documents'],
        summary: 'Upload a file (multipart: `file` plus entityType, entityId, kind, visibility, …)',
        consumes: ['multipart/form-data'],
        response: { 201: Document },
      },
    },
    async (req, reply) => {
      const p = req.principal;
      requireUpload(p);
      if (!req.isMultipart()) throw badRequest('Expected multipart/form-data with a `file` part');

      const fields: Record<string, string> = {};
      let file: { filename: string; mimetype: string; bytes: Buffer } | undefined;
      for await (const part of req.parts({ limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } })) {
        if (part.type === 'file') {
          if (file) throw badRequest('Upload one file per request');
          const bytes = await part.toBuffer();
          if (part.file.truncated) throw badRequest('File exceeds the 200 MB limit');
          file = { filename: part.filename, mimetype: part.mimetype, bytes };
        } else {
          fields[part.fieldname] = String(part.value ?? '');
        }
      }
      if (!file) throw badRequest('Missing `file` part');
      if (!file.bytes.length) throw badRequest('File is empty');
      const parsed = UploadFields.safeParse(
        Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== '')),
      );
      if (!parsed.success)
        throw badRequest(
          'Invalid upload fields',
          parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        );
      const f = parsed.data;
      if (!!f.entityType !== !!f.entityId) throw badRequest('entityType and entityId go together');
      const contentType = resolveContentType(file.filename, file.mimetype);
      if (!contentType) throw badRequest(`File type not allowed: ${file.mimetype || 'unknown'}`);
      const sharing = resolveSharing(p, f);

      const doc = await req.tx(async (tx) => {
        const id = await createDocument(tx, {
          tenantId: p.tenantId,
          ownerOrgId: p.orgId,
          filename: file!.filename,
          contentType,
          bytes: file!.bytes,
          kind: f.kind,
          entityType: f.entityType ?? null,
          entityId: f.entityId ?? null,
          ...sharing,
          includeInSpecBook: p.isInternal ? (f.includeInSpecBook ?? false) : false,
          uploadedBy: p.userId,
          uploadedByName: p.name,
        });
        await req.emit(tx, 'documents.document.uploaded', {
          documentId: id,
          entityType: f.entityType ?? null,
          entityId: f.entityId ?? null,
          kind: f.kind,
          filename: file!.filename,
        });
        return presentOne(tx, must(await findDocument(tx, id), 'Document'));
      });
      return reply.status(201).send(doc);
    },
  );

  app.get(
    '/documents',
    {
      schema: {
        tags: ['documents'],
        summary: 'List documents for an entity (including linked ones), or by kind / filename search',
        querystring: DocumentListQuery,
        response: { 200: page(Document) },
      },
    },
    async (req) => {
      requireRead(req.principal);
      const q = req.query;
      if (!!q.entityType !== !!q.entityId && !q.kind && !q.q)
        throw badRequest('Provide entityType and entityId together');
      if (!q.entityType && !q.kind && !q.q && q.includeInSpecBook === undefined)
        throw badRequest('Filter by entityType+entityId, kind or q');
      return req.tx(async (tx) => {
        const { rows, total } = await listDocuments(tx, q);
        return { items: await present(tx, rows), total, limit: q.limit, offset: q.offset };
      });
    },
  );

  app.get(
    '/documents/:id',
    {
      schema: {
        tags: ['documents'],
        summary: 'Get document metadata',
        params: IdParams,
        response: { 200: Document },
      },
    },
    async (req) => {
      requireRead(req.principal);
      return req.tx(async (tx) => presentOne(tx, must(await findDocument(tx, req.params.id), 'Document')));
    },
  );

  app.patch(
    '/documents/:id',
    {
      schema: {
        tags: ['documents'],
        summary: 'Rename, re-classify, change sharing, toggle spec-book inclusion or re-attach a document',
        params: IdParams,
        body: DocumentPatch,
        response: { 200: Document },
      },
    },
    async (req) => {
      const p = req.principal;
      requireInternalWrite(p);
      const b = req.body;
      return req.tx(async (tx) => {
        const doc = must(await findDocument(tx, req.params.id), 'Document');
        if (doc.tenantId === null && p.actor !== 'platform')
          throw forbidden('Global documents are read-only');
        const sharingTouched =
          b.visibility !== undefined || b.vendorOrgId !== undefined || b.clientOrgId !== undefined;
        const sharing = sharingTouched
          ? resolveSharing(p, {
              visibility: b.visibility ?? doc.visibility,
              vendorOrgId: b.vendorOrgId !== undefined ? b.vendorOrgId : doc.vendorOrgId,
              clientOrgId: b.clientOrgId !== undefined ? b.clientOrgId : doc.clientOrgId,
            })
          : undefined;
        const entityType = b.entityType !== undefined ? b.entityType : doc.entityType;
        const entityId = b.entityId !== undefined ? b.entityId : doc.entityId;
        if (!!entityType !== !!entityId) throw badRequest('entityType and entityId go together');
        const sets = Object.fromEntries(
          Object.entries({
            filename: b.filename,
            kind: b.kind,
            include_in_spec_book: b.includeInSpecBook,
            entity_type: b.entityType !== undefined || b.entityId !== undefined ? entityType : undefined,
            entity_id: b.entityType !== undefined || b.entityId !== undefined ? entityId : undefined,
            visibility: sharing?.visibility,
            vendor_org_id: sharing ? sharing.vendorOrgId : undefined,
            client_org_id: sharing ? sharing.clientOrgId : undefined,
          }).filter(([, v]) => v !== undefined),
        );
        if (Object.keys(sets).length)
          await tx`update documents.documents set ${tx(sets as never)} where id = ${doc.id}`;
        return presentOne(tx, must(await findDocument(tx, doc.id), 'Document'));
      });
    },
  );

  app.delete(
    '/documents/:id',
    {
      schema: {
        tags: ['documents'],
        summary: 'Delete a document (soft delete; bytes are retained for the audit trail)',
        params: IdParams,
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      const p = req.principal;
      requireInternalWrite(p);
      await req.tx(async (tx) => {
        const doc = must(await findDocument(tx, req.params.id), 'Document');
        if (doc.tenantId === null && p.actor !== 'platform')
          throw forbidden('Global documents are read-only');
        await tx`update documents.documents set deleted_at = now() where id = ${doc.id}`;
      });
      return reply.status(204).send(null);
    },
  );

  app.post(
    '/documents/:id/links',
    {
      schema: {
        tags: ['documents'],
        summary: 'Attach an existing document to another entity',
        params: IdParams,
        body: LinkBody,
        response: { 200: Document },
      },
    },
    async (req) => {
      const p = req.principal;
      requireInternalWrite(p);
      return req.tx(async (tx) => {
        const doc = must(await findDocument(tx, req.params.id), 'Document');
        if (doc.entityType === req.body.entityType && doc.entityId === req.body.entityId)
          return presentOne(tx, doc);
        await tx`
          insert into documents.document_links (document_id, tenant_id, entity_type, entity_id, created_by)
          values (${doc.id}, ${p.tenantId}, ${req.body.entityType}, ${req.body.entityId}, ${p.userId})
          on conflict (document_id, entity_type, entity_id) do nothing`;
        return presentOne(tx, doc);
      });
    },
  );

  app.delete(
    '/documents/:id/links',
    {
      schema: {
        tags: ['documents'],
        summary: 'Detach a document from an additional entity',
        params: IdParams,
        querystring: LinkBody,
        response: { 200: Document },
      },
    },
    async (req) => {
      requireInternalWrite(req.principal);
      return req.tx(async (tx) => {
        const doc = must(await findDocument(tx, req.params.id), 'Document');
        const rows = await tx`
          delete from documents.document_links
          where document_id = ${doc.id} and entity_type = ${req.query.entityType} and entity_id = ${req.query.entityId}
          returning id`;
        if (!rows.length) throw notFound('Link');
        return presentOne(tx, doc);
      });
    },
  );

  // ---------------------------------------------------------------- bytes
  /**
   * Download / thumbnail routes accept the access token either as a bearer header or as `?token=` so
   * plain <a href> and <img src> work. They are declared public so the global auth hook does not reject
   * a header-less request; the token is verified here exactly as the hook would.
   */
  const principalFor = async (req: { principal: Principal | null; query: { token?: string } }) => {
    if (req.principal) return req.principal;
    if (!req.query.token) throw unauthorized();
    return new Principal(await verifyAccessToken(req.query.token), req.query.token);
  };

  const loadForBytes = async (p: Principal, id: string) => {
    requireRead(p);
    return withContext(
      { tenantId: p.tenantId, userId: p.userId, orgId: p.orgId, actor: p.actor, userName: p.name },
      async (tx) => findDocument(tx, id),
    );
  };

  app.get(
    '/documents/:id/download',
    {
      config: { public: true },
      schema: {
        tags: ['documents'],
        summary: 'Download the file (inline). Redirects to a signed URL when storage provides one',
        params: IdParams,
        querystring: DownloadQuery,
      },
    },
    async (req, reply) => {
      const p = await principalFor(req as never);
      const doc = must(await loadForBytes(p, req.params.id), 'Document');
      const disposition = req.query.download ? 'attachment' : 'inline';
      const url = await storage().downloadUrl(doc.storageKey, doc.filename);
      if (url) return reply.redirect(url, 302);
      const stream: Readable = await storage().stream(doc.storageKey);
      return (
        reply
          .header('content-type', doc.contentType)
          .header('content-length', String(doc.size))
          .header('content-disposition', contentDisposition(disposition, doc.filename))
          .header('cache-control', 'private, max-age=300')
          .header('x-content-type-options', 'nosniff')
          // User-supplied files (SVG, HTML-ish text) must never execute script in our origin.
          .header(
            'content-security-policy',
            "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
          )
          .send(stream)
      );
    },
  );

  app.get(
    '/documents/:id/thumbnail',
    {
      config: { public: true },
      schema: {
        tags: ['documents'],
        summary:
          'Thumbnail for previews. Images return the image itself; PDFs and other types return 404 (not yet generated)',
        params: IdParams,
        querystring: DownloadQuery,
      },
    },
    async (req, reply) => {
      const p = await principalFor(req as never);
      const doc = must(await loadForBytes(p, req.params.id), 'Document');
      if (!doc.contentType.startsWith('image/') || doc.contentType === 'image/vnd.dwg')
        throw notFound('Thumbnail');
      const url = await storage().downloadUrl(doc.storageKey, doc.filename);
      if (url) return reply.redirect(url, 302);
      const bytes = await storage().get(doc.storageKey);
      return reply
        .header('content-type', doc.contentType)
        .header('content-disposition', contentDisposition('inline', doc.filename))
        .header('cache-control', 'private, max-age=3600')
        .header('x-content-type-options', 'nosniff')
        .header('content-security-policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'")
        .send(bytes);
    },
  );
}
