import { sum } from '@procure/domain';
import {
  type App,
  conflict,
  forbidden,
  notFound,
  type Principal,
  type Tx,
  unprocessable,
  z,
} from '@procure/platform';
import { documents, identity, type ProjectInfo, projects, tolerate } from '../clients.js';
import { getQuote, locationTree, pageResult, type QuoteRow, type ReqCtx, totalsFor } from '../repo.js';
import {
  ClientDecision,
  ClientQuote,
  ClientQuoteDetail,
  DocumentRef,
  IdParams,
  pageOf,
  ReportBody,
  SendToClient,
  SendToClientResult,
  SpecBookBody,
  SpecBookResult,
} from '../schemas.js';
import { submitForApproval } from './approvals.js';

type ReportLine = {
  id: string;
  category: string;
  materials: string | null;
  imageDocumentId: string | null;
  clientNotes: string | null;
  locationId: string | null;
  code: string;
  name: string;
  description: string | null;
  finish: string | null;
  dimensions: string | null;
  quantity: number;
  unit: string;
  unitPrice: number | null;
  extendedPrice: number | null;
  unitCost: number | null;
  extendedCost: number | null;
  marginPct: number | null;
  vendorName: string | null;
  sort: number;
};

/** Sections in location tree order (unassigned last). Selected lines only. */
async function sections(tx: Tx, q: QuoteRow, locationIds?: string[]) {
  const locs = await locationTree(tx, q.id);
  const lines = await tx<ReportLine[]>`
    select id, location_id, code, name, description, category, materials, image_document_id, client_notes,
           finish, dimensions, quantity, unit, unit_price, extended_price,
           unit_cost, extended_cost, margin_pct, vendor_name, sort
    from quoting.quote_lines where quote_id = ${q.id} and is_selected order by sort, code`;
  const wanted = locationIds ? new Set(locationIds) : null;
  const out: { locationId: string | null; location: string; lines: ReportLine[] }[] = [];
  for (const l of locs) {
    if (wanted && !wanted.has(l.id)) continue;
    const ls = lines.filter((x) => x.locationId === l.id);
    if (ls.length) out.push({ locationId: l.id, location: l.path, lines: ls });
  }
  const known = new Set(locs.map((l) => l.id));
  const orphan = lines.filter((x) => !x.locationId || !known.has(x.locationId));
  if (orphan.length && !wanted) out.push({ locationId: null, location: 'General', lines: orphan });
  return out;
}

async function tenantLetterhead(p: Principal | null) {
  const org = p ? await tolerate(() => identity.org(p, p.tenantId)) : null;
  return {
    name: org?.name ?? '',
    address: org?.address ?? {},
    phone: org?.phone ?? null,
    email: org?.email ?? null,
  };
}

const projectHeader = (pr: ProjectInfo | null) => ({
  number: pr?.number ?? null,
  name: pr?.name ?? null,
  propertyName: pr?.propertyName ?? null,
  address: pr?.address ?? null,
});

async function renderQuotePdf(
  req: ReqCtx,
  q: QuoteRow,
  variant: 'client' | 'internal',
  project: ProjectInfo | null,
  locationIds?: string[],
) {
  const p = req.principal;
  const { secs, totals } = await req.tx(async (tx) => ({
    secs: await sections(tx, q, locationIds),
    totals: await totalsFor(tx, q),
  }));
  const internal = variant === 'internal';
  return documents.render({
    tenantId: p.tenantId,
    template: 'quote',
    filename: `${q.number}${internal ? '-internal' : ''}.pdf`,
    entityType: 'quote',
    entityId: q.id,
    visibility: internal ? 'internal' : 'client',
    clientOrgId: internal ? null : q.clientOrgId,
    data: {
      variant,
      tenant: await tenantLetterhead(p),
      project: projectHeader(project),
      quote: {
        number: q.number,
        name: q.name,
        phase: q.phase,
        date: new Date().toISOString().slice(0, 10),
        validUntil: q.validUntil ?? null,
        notes: internal ? (q.notes ?? null) : (q.clientNotes ?? null),
      },
      contacts: (project?.contacts ?? []).map((c) => ({
        role: c.role,
        name: c.name,
        email: c.email,
        phone: c.phone,
      })),
      sections: secs.map((s) => ({
        location: s.location,
        lines: s.lines.map((l) => ({
          code: l.code,
          name: l.name,
          description: l.description,
          finish: l.finish,
          dimensions: l.dimensions,
          qty: l.quantity,
          unit: l.unit,
          unitPrice: l.unitPrice,
          extended: l.extendedPrice,
          ...(internal
            ? {
                vendor: l.vendorName,
                unitCost: l.unitCost,
                extendedCost: l.extendedCost,
                marginPct: l.marginPct,
              }
            : {}),
        })),
      })),
      totals: {
        subtotal: totals.sellSubtotal,
        freight: totals.freight,
        tax: totals.tax,
        total: totals.grandTotal,
        ...(internal ? { cost: totals.costTotal, marginPct: totals.marginPct } : {}),
      },
    },
  });
}

const CLIENT_VISIBLE = ['sent', 'client_approved', 'client_rejected', 'ordered'];

const clientHeader = (q: QuoteRow, total: number) => ({
  ...q,
  documentId: (q.clientDocumentId as string) ?? null,
  total,
});

async function clientQuoteDetail(tx: Tx, id: string) {
  const [q] = await tx<QuoteRow[]>`select * from quoting.quotes where id = ${id}`;
  if (!q || !CLIENT_VISIBLE.includes(q.status)) throw notFound('Quote');
  const secs = await sections(tx, q);
  const t = await totalsFor(tx, q);
  return {
    ...clientHeader(q, t.grandTotal),
    sections: secs.map((s) => ({
      locationId: s.locationId,
      location: s.location,
      lines: s.lines,
      subtotal: sum(s.lines.map((l) => l.extendedPrice ?? 0)),
    })),
    totals: { subtotal: t.sellSubtotal, freight: t.freight, tax: t.tax, total: t.grandTotal },
  } as unknown as z.infer<typeof ClientQuoteDetail>;
}

export async function clientFlowRoutes(app: App) {
  app.post(
    '/quotes/:id/send-to-client',
    {
      schema: {
        tags: ['client-approval'],
        summary:
          'Send the quote to the client portal: requires internal approval (policies evaluated now if needed), no below-cost lines; renders the quote PDF and emails contacts',
        params: IdParams,
        body: SendToClient,
        response: { 200: SendToClientResult },
      },
    },
    async (req) => {
      const p = req.principal;
      p.require('quotes:send');
      const warnings: string[] = [];
      let q = await req.tx(async (tx) => {
        const q = await getQuote(tx, req.params.id);
        if (q.isTemplate) throw conflict('Templates cannot be sent to clients');
        if (
          ![
            'merchandising',
            'pending_internal_approval',
            'client_rejected',
            'draft',
            'costing',
            'sent',
          ].includes(q.status)
        )
          throw conflict(`A ${q.status} quote cannot be sent`);
        const [rej] = await tx`select 1 from quoting.approval_requests
                                where entity_type = 'quote' and entity_id = ${q.id} and status = 'rejected'
                                  and decided_at > coalesce(${q.submittedForApprovalAt as string | null}::timestamptz, '-infinity')
                                  and ${q.internalApprovedAt as string | null}::timestamptz is null limit 1`;
        if (rej) throw conflict('An internal approval was rejected; revise and resubmit the quote');
        const [{ n }] = (await tx`select count(*)::int as n from quoting.quote_lines
                                  where quote_id = ${q.id} and is_selected and 'below_cost' = any(flags)`) as unknown as [
          { n: number },
        ];
        if (n) throw conflict(`${n} line(s) are priced below cost`, { belowCostLines: n });
        const [{ m }] = (await tx`select count(*)::int as m from quoting.quote_lines
                                  where quote_id = ${q.id} and is_selected and unit_price is null`) as unknown as [
          { m: number },
        ];
        if (m) throw unprocessable(`${m} line(s) have no price`);
        return q;
      });
      if (!q.internalApprovedAt) {
        if (q.status === 'pending_internal_approval')
          throw conflict('The quote is waiting for internal approval', { status: q.status });
        const r = await submitForApproval(req, q.id);
        warnings.push(...r.warnings);
        if (!r.approved)
          throw conflict('The quote needs internal approval before it can be sent', {
            approvals: r.requests.map((a) => ({
              id: a.id,
              policyName: a.policyName,
              reason: a.reason,
              approverRole: a.approverRole,
            })),
          });
        q = await req.tx((tx) => getQuote(tx, q.id));
      }

      const project = q.projectId ? await tolerate(() => projects.get(p.tenantId, q.projectId!)) : null;
      if (!project) warnings.push('Project details unavailable; client organization taken from the quote');
      const clientOrgId = project?.clientOrgId ?? q.clientOrgId;
      if (!clientOrgId) throw unprocessable('The project has no client organization to send the quote to');
      if (clientOrgId !== q.clientOrgId)
        await req.tx((tx) => tx`update quoting.quotes set client_org_id = ${clientOrgId} where id = ${q.id}`);
      q.clientOrgId = clientOrgId;

      const doc = await tolerate(
        () => renderQuotePdf(req, q, 'client', project),
        () => warnings.push('Quote PDF could not be rendered (documents service unavailable)'),
      );
      const to = [
        ...new Set(
          (req.body.contacts?.length
            ? req.body.contacts.map((c) => c.email)
            : (project?.contacts ?? []).map((c) => c.email).filter((e): e is string => !!e)
          ).map((e) => e.toLowerCase()),
        ),
      ];
      if (!to.length)
        warnings.push('No client contacts with email; the quote is visible in the owner portal only');

      return req.tx(async (tx) => {
        const locked = await getQuote(tx, q.id, { lock: true });
        // Any pricing/content change since approval clears the stamp (invalidateApproval).
        if (!locked.internalApprovedAt)
          throw conflict('The quote changed while sending; review and try again');
        const t = await totalsFor(tx, locked);
        await tx`update quoting.quotes set status = 'sent', sent_at = now(), sent_by_name = ${p.name},
                   client_document_id = ${doc?.id ?? null}, client_decision = null, client_decided_at = null,
                   client_decided_by_name = null, client_signature_name = null, client_comment = null
                 where id = ${q.id}`;
        await req.emit(tx, 'quoting.quote.sent_to_client', {
          quoteId: q.id,
          projectId: q.projectId!,
          number: q.number,
          total: t.grandTotal,
        });
        if (to.length)
          await req.emit(tx, 'cmd.email.send', {
            to,
            cc: [],
            subject: `Quote ${q.number}: ${q.name}${project?.name ? ` — ${project.name}` : ''}`,
            text: `${req.body.message ? `${req.body.message}\n\n` : ''}Your quote is ready for review and approval: ${
              process.env.PUBLIC_WEB_URL ?? 'http://localhost:5173'
            }/portal/quotes/${q.id}`,
            html: null,
            replyTo: null,
            attachments: doc ? [{ documentId: doc.id, filename: doc.filename }] : [],
            threadId: null,
          });
        return { status: 'sent' as const, documentId: doc?.id ?? null, sentTo: to, warnings };
      });
    },
  );

  app.post(
    '/quotes/:id/report',
    {
      schema: {
        tags: ['client-approval'],
        summary:
          'Render the quote as PDF (client variant: sell prices only; internal variant: cost and margin)',
        params: IdParams,
        body: ReportBody,
        response: { 200: DocumentRef },
      },
    },
    async (req) => {
      const p = req.principal;
      p.require('quotes:read');
      if (req.body.variant === 'internal') p.require('quotes:costs:read');
      const q = await req.tx((tx) => getQuote(tx, req.params.id));
      const project = q.projectId ? await tolerate(() => projects.get(p.tenantId, q.projectId!)) : null;
      const doc = await renderQuotePdf(req, q, req.body.variant, project, req.body.locationIds);
      return { documentId: doc.id, filename: doc.filename };
    },
  );

  app.post(
    '/quotes/:id/spec-book',
    {
      schema: {
        tags: ['client-approval'],
        summary:
          'Render a spec book for the specs used on the quote (selected lines), merging their spec-book documents',
        params: IdParams,
        body: SpecBookBody,
        response: { 200: SpecBookResult },
      },
    },
    async (req) => {
      const p = req.principal;
      p.require('quotes:read');
      const warnings: string[] = [];
      const { q, specs } = await req.tx(async (tx) => {
        const q = await getQuote(tx, req.params.id);
        const secs = await sections(tx, q, req.body.locationIds);
        const lineIds = secs.flatMap((s) => s.lines.map((l) => l.id));
        const locOf = new Map(secs.flatMap((s) => s.lines.map((l) => [l.id, s.location] as const)));
        const rows = lineIds.length
          ? await tx<
              {
                id: string;
                specId: string | null;
                code: string;
                name: string;
                category: string;
                vendorName: string | null;
                description: string | null;
                dimensions: string | null;
                finish: string | null;
                materials: string | null;
              }[]
            >`
              select id, spec_id, code, name, category, vendor_name, description, dimensions, finish, materials
              from quoting.quote_lines where id in ${tx(lineIds)} order by code`
          : [];
        const bySpec = new Map<string, (typeof rows)[number] & { locations: Set<string> }>();
        for (const r of rows) {
          const k = r.specId ?? `line:${r.id}`;
          if (!bySpec.has(k)) bySpec.set(k, { ...r, locations: new Set() });
          bySpec.get(k)!.locations.add(locOf.get(r.id) ?? '');
        }
        return { q, specs: [...bySpec.values()] };
      });
      if (!specs.length) throw unprocessable('No selected lines to include');
      const project = q.projectId ? await tolerate(() => projects.get(p.tenantId, q.projectId!)) : null;
      const docsBySpec = new Map<string, string[]>();
      if (req.body.includeDocuments)
        for (const s of specs) {
          if (!s.specId) continue;
          const docs = await tolerate(
            () => documents.list(p.tenantId, 'spec', s.specId!),
            () => warnings.push(`${s.code}: attachments unavailable`),
          );
          docsBySpec.set(
            s.specId,
            (docs ?? []).filter((d) => d.includeInSpecBook).map((d) => d.id),
          );
        }
      const doc = await documents.render({
        tenantId: p.tenantId,
        template: 'spec_book',
        filename: `${q.number}-spec-book.pdf`,
        entityType: 'quote',
        entityId: q.id,
        visibility: 'internal',
        data: {
          tenant: await tenantLetterhead(p),
          project: projectHeader(project),
          quote: { number: q.number, name: q.name },
          specs: specs.map((s) => ({
            code: s.code,
            name: s.name,
            category: s.category,
            vendor: s.vendorName,
            description: s.description,
            dimensions: s.dimensions,
            finish: s.finish,
            materials: s.materials,
            location: [...s.locations].filter(Boolean).join(', '),
            documentIds: s.specId ? (docsBySpec.get(s.specId) ?? []) : [],
          })),
        },
      });
      return { documentId: doc.id, filename: doc.filename, specCount: specs.length, warnings };
    },
  );

  // ================================================================ client (owner) portal
  const requireClient = (p: Principal, perm: 'client:view' | 'client:approve') => {
    if (!p.isClient) throw forbidden('Owner portal only');
    p.require(perm);
  };

  app.get(
    '/client/quotes',
    {
      schema: {
        tags: ['client-portal'],
        summary: 'Quotes sent to my organization',
        querystring: z.object({
          projectId: z.uuid().optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
          offset: z.coerce.number().int().min(0).default(0),
        }),
        response: { 200: pageOf(ClientQuote) },
      },
    },
    async (req) => {
      requireClient(req.principal, 'client:view');
      const { projectId, limit, offset } = req.query;
      return req.tx(async (tx) => {
        const where = tx`where q.status in ${tx(CLIENT_VISIBLE)} ${projectId ? tx`and q.project_id = ${projectId}` : tx``}`;
        const [{ count }] =
          (await tx`select count(*)::int as count from quoting.quotes q ${where}`) as unknown as [
            { count: number },
          ];
        const rows = await tx<
          QuoteRow[]
        >`select q.* from quoting.quotes q ${where} order by q.sent_at desc nulls last limit ${limit} offset ${offset}`;
        const items = [];
        for (const q of rows) items.push(clientHeader(q, (await totalsFor(tx, q)).grandTotal));
        return pageResult(items as never[], count, limit, offset);
      });
    },
  );

  app.get(
    '/client/quotes/:id',
    {
      schema: {
        tags: ['client-portal'],
        summary: 'A quote for review: sections by location with sell prices and totals',
        params: IdParams,
        response: { 200: ClientQuoteDetail },
      },
    },
    async (req) => {
      requireClient(req.principal, 'client:view');
      return req.tx((tx) => clientQuoteDetail(tx, req.params.id));
    },
  );

  app.post(
    '/client/quotes/:id/decision',
    {
      schema: {
        tags: ['client-portal'],
        summary: 'Approve or reject the quote with a typed signature',
        params: IdParams,
        body: ClientDecision,
        response: { 200: ClientQuoteDetail },
      },
    },
    async (req) => {
      const p = req.principal;
      requireClient(p, 'client:approve');
      const b = req.body;
      return req.tx(async (tx) => {
        // No FOR UPDATE: it would also apply the UPDATE policy (sent-only); the guarded update below handles races.
        const [q] = await tx<QuoteRow[]>`select * from quoting.quotes where id = ${req.params.id}`;
        if (!q || !CLIENT_VISIBLE.includes(q.status)) throw notFound('Quote');
        if (q.status !== 'sent') throw conflict(`This quote was already ${q.status.replace('client_', '')}`);
        const [u] = await tx`
          update quoting.quotes set status = ${b.decision === 'approved' ? 'client_approved' : 'client_rejected'},
            client_decision = ${b.decision}, client_decided_at = now(), client_decided_by_name = ${p.name},
            client_signature_name = ${b.signatureName}, client_comment = ${b.comment ?? null}
          where id = ${q.id} and status = 'sent' returning id`;
        if (!u) throw conflict('This quote can no longer be decided');
        await req.emit(tx, 'quoting.quote.client_decided', {
          quoteId: q.id,
          projectId: q.projectId!,
          decision: b.decision,
          decidedBy: `${b.signatureName} (${p.name})`,
          comment: b.comment ?? null,
        });
        await req.emit(tx, 'cmd.notify', {
          userIds: q.createdBy ? [q.createdBy as string] : [],
          roles: ['project_manager', 'procurement'],
          title: `${q.number} ${b.decision === 'approved' ? 'approved' : 'rejected'} by the client`,
          body: b.comment ?? `Signed: ${b.signatureName}`,
          link: `/app/quotes/${q.id}`,
          severity: b.decision === 'approved' ? 'success' : 'warning',
        });
        return clientQuoteDetail(tx, q.id);
      });
    },
  );
}
