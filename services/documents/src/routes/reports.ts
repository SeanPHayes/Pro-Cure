import { type App, forbidden, must, type Tx } from '@procure/platform';
import { isInternalActor, resolveSharing } from '../access.js';
import { renderTemplate, tenantLoader } from '../reports/index.js';
import { Document, RenderBody, type RenderRequest } from '../schemas.js';
import { createDocument, findDocument, presentOne } from '../store.js';

const pdfName = (f: string) => (/\.pdf$/i.test(f) ? f : `${f}.pdf`);

/**
 * Render a template and store the PDF as a new `report` document in `tx`. Shared by the public and
 * internal render routes; `emit` writes the outbox event in the same transaction.
 */
export async function renderAndStore(
  tx: Tx,
  tenantId: string,
  body: RenderRequest,
  actor: { userId: string | null; orgId: string | null; name: string | null },
  emit: (
    tx: Tx,
    data: {
      documentId: string;
      template: string;
      entityType: string | null;
      entityId: string | null;
      pageCount: number;
    },
  ) => Promise<unknown>,
) {
  const rendered = await renderTemplate(body.template, body.data, tenantLoader(tx));
  const sharing = resolveSharing(null, body);
  const id = await createDocument(tx, {
    tenantId,
    ownerOrgId: actor.orgId ?? tenantId,
    filename: pdfName(body.filename),
    contentType: 'application/pdf',
    bytes: rendered.buffer,
    kind: 'report',
    template: body.template,
    entityType: body.entityType ?? null,
    entityId: body.entityId ?? null,
    ...sharing,
    includeInSpecBook: body.includeInSpecBook ?? false,
    pageCount: rendered.pageCount,
    uploadedBy: actor.userId,
    uploadedByName: actor.name ?? 'Pro-Cure',
  });
  const doc = must(await findDocument(tx, id), 'Document');
  await emit(tx, {
    documentId: id,
    template: body.template,
    entityType: body.entityType ?? null,
    entityId: body.entityId ?? null,
    pageCount: doc.pageCount ?? 0,
  });
  return presentOne(tx, doc);
}

export async function reportRoutes(app: App) {
  app.post(
    '/reports/render',
    {
      schema: {
        tags: ['reports'],
        summary:
          'Render a PDF report (quote, purchase_order, po_revision, spec_book, schedule, cost_request, invoice, claim) and store it',
        body: RenderBody,
        response: { 201: Document },
      },
    },
    async (req, reply) => {
      const p = req.principal;
      if (!isInternalActor(p)) throw forbidden('Internal users only');
      const perm = {
        quote: 'quotes:read',
        spec_book: 'specs:read',
        purchase_order: 'orders:read',
        po_revision: 'orders:read',
        cost_request: 'quotes:read',
        schedule: 'projects:read',
        invoice: 'finance:read',
        claim: 'orders:read',
      } as const;
      p.require(perm[req.body.template]);
      const doc = await req.tx((tx) =>
        renderAndStore(
          tx,
          p.tenantId,
          req.body,
          { userId: p.userId, orgId: p.orgId, name: p.name },
          (t, data) => req.emit(t, 'documents.report.rendered', data),
        ),
      );
      return reply.status(201).send(doc);
    },
  );
}
