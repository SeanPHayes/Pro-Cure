import { round2 } from '@procure/domain';
import {
  ActivityEntry,
  type App,
  badRequest,
  config,
  listActivity,
  type Principal,
  type Tx,
  unprocessable,
  withTenant,
  z,
} from '@procure/platform';
import { clients, type ProjectInfo } from '../clients.js';
import {
  addDays,
  daysBetween,
  daysForTerms,
  InvoicingRuleError,
  invoiceTotals,
  priceLines,
  quoteInvoiceLine,
  termsForDays,
} from '../domain/invoicing.js';
import {
  applyInvoicePayment,
  createInvoice,
  getInvoice,
  type InvoiceRow,
  insertLines,
  invoiceDetail,
  invoicedForQuote,
  today,
  withAging,
} from '../repo.js';
import {
  CreateInvoiceBody,
  FromQuoteBody,
  IdParams,
  Invoice,
  InvoiceDetail,
  InvoiceListQuery,
  Payment,
  page,
  RecordPaymentBody,
  SendInvoiceBody,
  SendInvoiceResponse,
  UpdateInvoiceBody,
  VoidBody,
} from '../schemas.js';

const TAGS = ['invoices'];
const ACTIVITY_NOISE = new Set(['qboId', 'qboSyncStatus', 'qboSyncedAt', 'qboError', 'documentId', 'sentAt']);

/** SQL predicate: days past due (current_date − due_date) falls in one of the aging buckets. */
const AGING_RANGES: Record<string, [number, number]> = {
  current: [-100000, 0],
  '1-30': [1, 30],
  '31-60': [31, 60],
  '61-90': [61, 90],
  '90+': [91, 100000],
};
function agingSql(tx: Tx, buckets: string[]) {
  return buckets
    .map((b) => AGING_RANGES[b]!)
    .map(([lo, hi]) => tx`(current_date - due_date) between ${lo} and ${hi}`)
    .reduce((acc, frag) => tx`${acc} or ${frag}`);
}
const OWNER_CONTACT_ROLES = ['owner_rep', 'gm'];

/** Project header fields for an invoice; tolerate projects being down when the caller supplied them. */
async function projectFor(tenantId: string, projectId: string): Promise<ProjectInfo | null> {
  try {
    return await clients.project(tenantId, projectId);
  } catch (err) {
    if ((err as { status?: number }).status === 404) throw badRequest('Project not found');
    return null;
  }
}

/** Display name for the client org: identity (with the caller's token), else a previous invoice, else the project. */
async function clientNameFor(
  tx: Tx,
  principal: Principal | null,
  clientOrgId: string,
  project: ProjectInfo | null,
): Promise<string> {
  const org = await clients.org(principal, clientOrgId).catch(() => null);
  if (org?.name) return org.name;
  const [prev] = await tx<{ clientName: string }[]>`
    select client_name from finance.invoices where client_org_id = ${clientOrgId} order by created_at desc limit 1`;
  return prev?.clientName ?? project?.propertyName ?? project?.name ?? 'Client';
}

/** Resolve the dates/terms trio from whatever the caller gave. */
export function resolveDates(b: {
  issueDate?: string;
  dueDate?: string;
  dueInDays?: number;
  terms?: string;
}) {
  const issueDate = b.issueDate ?? today();
  const termDays = b.dueInDays ?? daysForTerms(b.terms);
  const dueDate = b.dueDate ?? addDays(issueDate, termDays ?? 30);
  const terms = b.terms ?? termsForDays(b.dueInDays ?? daysBetween(issueDate, dueDate));
  return { issueDate, dueDate, terms };
}

/** Find a quote (and its project) — via the existing invoices, the given project, or the quote header. */
async function findQuote(tenantId: string, quoteId: string, projectId: string | undefined) {
  let pid = projectId;
  if (!pid) {
    const header = await clients.quoteHeader(tenantId, quoteId).catch(() => null);
    pid = header?.projectId;
  }
  if (!pid) throw badRequest('Quote not found (pass projectId if quoting cannot be reached)');
  const quotes = await clients.quoteSummary(tenantId, pid);
  const quote = quotes.find((q) => q.id === quoteId);
  if (!quote) throw badRequest('Quote not found on that project');
  return { quote, projectId: pid };
}

export async function invoiceRoutes(app: App) {
  // ------------------------------------------------------------------ list
  app.get(
    '/invoices',
    {
      schema: {
        tags: TAGS,
        summary: 'List client invoices with AR aging',
        querystring: InvoiceListQuery,
        response: { 200: page(Invoice) },
      },
    },
    async (req) => {
      req.principal.require('finance:read');
      const q = req.query;
      return req.tx(async (tx) => {
        const where = tx`
          where true
          ${q.projectId ? tx`and project_id = ${q.projectId}` : tx``}
          ${q.clientOrgId ? tx`and client_org_id = ${q.clientOrgId}` : tx``}
          ${q.quoteId ? tx`and quote_id = ${q.quoteId}` : tx``}
          ${q.status?.length ? tx`and status in ${tx(q.status)}` : tx``}
          ${q.kind?.length ? tx`and kind in ${tx(q.kind)}` : tx``}
          ${
            q.overdue === true
              ? tx`and status in ('sent', 'partially_paid', 'overdue') and balance > 0 and due_date < current_date`
              : q.overdue === false
                ? tx`and not (status in ('sent', 'partially_paid', 'overdue') and balance > 0 and due_date < current_date)`
                : tx``
          }
          ${
            q.aging?.length
              ? tx`and status in ('sent', 'partially_paid', 'overdue') and balance > 0 and (${agingSql(tx, q.aging)})`
              : tx``
          }
          ${
            q.q
              ? tx`and (number || ' ' || client_name || ' ' || project_name || ' ' || project_number || ' ' || coalesce(po_reference, '')) ilike ${`%${q.q}%`}`
              : tx``
          }`;
        const sort = q.sort ?? '-issueDate';
        const cols: Record<string, string> = {
          issueDate: 'issue_date',
          dueDate: 'due_date',
          number: 'number',
          total: 'total',
          balance: 'balance',
          status: 'status',
          clientName: 'client_name',
          createdAt: 'created_at',
        };
        const desc = sort.startsWith('-');
        const col = cols[sort.replace(/^-/, '')] ?? 'issue_date';
        const [items, [count]] = await Promise.all([
          tx<InvoiceRow[]>`select * from finance.invoices ${where}
            order by ${tx.unsafe(`${col} ${desc ? 'desc' : 'asc'}`)}, number desc
            limit ${q.limit} offset ${q.offset}`,
          tx<{ n: number }[]>`select count(*)::int as n from finance.invoices ${where}`,
        ]);
        const asOf = today();
        return {
          items: items.map((i) => withAging(i, asOf)),
          total: count!.n,
          limit: q.limit,
          offset: q.offset,
        };
      });
    },
  );

  // ------------------------------------------------------------------ create (manual)
  app.post(
    '/invoices',
    {
      schema: {
        tags: TAGS,
        summary: 'Create a draft invoice with manual lines',
        body: CreateInvoiceBody,
        response: { 201: InvoiceDetail },
      },
    },
    async (req, reply) => {
      req.principal.require('finance:write');
      const p = req.principal;
      const b = req.body;
      const project = await projectFor(p.tenantId, b.projectId);
      const clientOrgId = b.clientOrgId ?? project?.clientOrgId;
      if (!clientOrgId) throw badRequest('clientOrgId is required (the project has no client organization)');
      if (b.kind === 'credit_memo' && b.lines.some((l) => l.unitPrice * l.quantity < 0))
        throw badRequest('Credit memo lines are entered as positive amounts');
      const result = await req.tx(async (tx) => {
        let quoteNumber: string | null = null;
        if (b.quoteId) {
          const [prev] = await tx<{ quoteNumber: string | null }[]>`
            select quote_number from finance.invoices where quote_id = ${b.quoteId} and quote_number is not null limit 1`;
          quoteNumber = prev?.quoteNumber ?? null;
        }
        const id = await createInvoice(tx, {
          tenantId: p.tenantId,
          projectId: b.projectId,
          projectNumber: project?.number ?? '',
          projectName: project?.name ?? '',
          clientOrgId,
          clientName: b.clientName ?? (await clientNameFor(tx, p, clientOrgId, project)),
          quoteId: b.quoteId ?? null,
          quoteNumber,
          kind: b.kind,
          ...resolveDates(b),
          poReference: b.poReference ?? null,
          notes: b.notes ?? null,
          taxRate: b.taxRate ?? 0,
          createdByName: p.name,
          lines: b.lines,
        });
        return invoiceDetail(tx, id);
      });
      return reply.status(201).send(result);
    },
  );

  // ------------------------------------------------------------------ create from quote
  app.post(
    '/invoices/from-quote',
    {
      schema: {
        tags: TAGS,
        summary: 'Create a draft deposit, progress or final invoice from a quote',
        description:
          'deposit = percent (default 50%) of the quote sell total (quote must be client approved); ' +
          'progress = percent or amount; final = sell total − Σ earlier non-void invoices for the quote.',
        body: FromQuoteBody.extend({ projectId: z.uuid().optional() }),
        response: { 201: InvoiceDetail },
      },
    },
    async (req, reply) => {
      req.principal.require('finance:write');
      const p = req.principal;
      const b = req.body;
      if (b.kind !== 'final' && b.percent !== undefined && b.amount !== undefined)
        throw badRequest('Give either percent or amount, not both');
      const { quote, projectId } = await findQuote(p.tenantId, b.quoteId, b.projectId);
      const project = await projectFor(p.tenantId, projectId);
      if (!project?.clientOrgId) throw unprocessable('The project has no client organization to invoice');
      const result = await req.tx(async (tx) => {
        // Serialize invoice creation per quote so two "final" invoices cannot race.
        await tx`select pg_advisory_xact_lock(hashtext(${`finance:quote:${quote.id}`}))`;
        const previously = await invoicedForQuote(tx, quote.id);
        let line: ReturnType<typeof quoteInvoiceLine>;
        try {
          line = quoteInvoiceLine(quote, { kind: b.kind, percent: b.percent, amount: b.amount }, previously);
        } catch (err) {
          if (err instanceof InvoicingRuleError) throw unprocessable(err.message);
          throw err;
        }
        const id = await createInvoice(tx, {
          tenantId: p.tenantId,
          projectId,
          projectNumber: project.number,
          projectName: project.name,
          clientOrgId: project.clientOrgId!,
          clientName: await clientNameFor(tx, p, project.clientOrgId!, project),
          quoteId: quote.id,
          quoteNumber: quote.number,
          kind: b.kind,
          ...resolveDates({ dueInDays: b.dueInDays ?? (b.kind === 'deposit' ? 0 : 30) }),
          poReference: b.poReference ?? null,
          notes: b.notes ?? null,
          taxRate: b.taxRate ?? 0,
          createdByName: p.name,
          lines: [line],
        });
        return invoiceDetail(tx, id);
      });
      return reply.status(201).send(result);
    },
  );

  // ------------------------------------------------------------------ read
  app.get(
    '/invoices/:id',
    {
      schema: {
        tags: TAGS,
        summary: 'Get an invoice with its lines and payments',
        params: IdParams,
        response: { 200: InvoiceDetail },
      },
    },
    async (req) => {
      req.principal.require('finance:read');
      return req.tx((tx) => invoiceDetail(tx, req.params.id));
    },
  );

  // ------------------------------------------------------------------ activity
  app.get(
    '/invoices/:id/activity',
    {
      schema: {
        tags: TAGS,
        summary: 'Field-level activity for the invoice, its lines and payments',
        params: IdParams,
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(1000).default(200) }),
        response: { 200: z.array(ActivityEntry) },
      },
    },
    async (req) => {
      req.principal.require('finance:read');
      return req.tx(async (tx) => {
        await getInvoice(tx, req.params.id);
        const rows = await listActivity(tx, 'invoice', req.params.id, {
          includeChildren: true,
          limit: req.query.limit,
        });
        // Sync bookkeeping (QuickBooks ids/status, rendered PDF ids) is shown elsewhere; keep the feed to business changes.
        return rows.flatMap((r) => {
          if (r.action !== 'update') return [r];
          const changes = Object.fromEntries(
            Object.entries(r.changes).filter(([k]) => !ACTIVITY_NOISE.has(k)),
          );
          return Object.keys(changes).length ? [{ ...r, changes }] : [];
        });
      });
    },
  );

  // ------------------------------------------------------------------ update (draft only)
  app.patch(
    '/invoices/:id',
    {
      schema: {
        tags: TAGS,
        summary: 'Edit a draft invoice (header and/or replace lines)',
        params: IdParams,
        body: UpdateInvoiceBody,
        response: { 200: InvoiceDetail },
      },
    },
    async (req) => {
      req.principal.require('finance:write');
      const b = req.body;
      return req.tx(async (tx) => {
        const inv = await getInvoice(tx, req.params.id, { forUpdate: true });
        if (inv.status !== 'draft')
          throw unprocessable('Only draft invoices can be edited; void and reissue instead');
        const issueDate = b.issueDate ?? inv.issueDate;
        let dueDate = b.dueDate ?? inv.dueDate;
        if (!b.dueDate && b.dueInDays !== undefined) dueDate = addDays(issueDate, b.dueInDays);
        if (dueDate < issueDate) throw unprocessable('Due date cannot be before the issue date');
        const terms = b.terms ?? (b.dueInDays !== undefined ? termsForDays(b.dueInDays) : inv.terms);
        const taxRate = b.taxRate ?? inv.taxRate;
        let lineAmounts: { amount: number }[];
        if (b.lines) {
          const priced = priceLines(b.lines);
          await tx`delete from finance.invoice_lines where invoice_id = ${inv.id}`;
          await insertLines(tx, inv.tenantId, inv.id, priced);
          lineAmounts = priced;
        } else {
          lineAmounts = await tx<
            { amount: number }[]
          >`select amount from finance.invoice_lines where invoice_id = ${inv.id}`;
        }
        const totals = invoiceTotals(lineAmounts, taxRate);
        await tx`update finance.invoices set ${tx({
          issueDate,
          dueDate,
          terms,
          taxRate,
          ...totals,
          balance: round2(totals.total - inv.amountPaid),
          kind: b.kind ?? inv.kind,
          clientName: b.clientName ?? inv.clientName,
          poReference: b.poReference === undefined ? inv.poReference : b.poReference,
          notes: b.notes === undefined ? inv.notes : b.notes,
          qboSyncStatus: 'pending',
        })} where id = ${inv.id}`;
        return invoiceDetail(tx, inv.id);
      });
    },
  );

  // ------------------------------------------------------------------ render PDF
  app.post(
    '/invoices/:id/pdf',
    {
      schema: {
        tags: TAGS,
        summary: 'Render (or re-render) the invoice PDF',
        params: IdParams,
        response: { 200: z.object({ documentId: z.string() }) },
      },
    },
    async (req) => {
      req.principal.require('finance:write');
      const documentId = await renderInvoicePdf(req.principal, req.params.id);
      return { documentId };
    },
  );

  // ------------------------------------------------------------------ send
  app.post(
    '/invoices/:id/send',
    {
      schema: {
        tags: TAGS,
        summary: 'Render the PDF, mark sent, and email it to the owner contacts',
        params: IdParams,
        body: SendInvoiceBody,
        response: { 200: SendInvoiceResponse },
      },
    },
    async (req) => {
      req.principal.require('finance:write');
      const p = req.principal;
      const inv = await req.tx((tx) => getInvoice(tx, req.params.id));
      if (inv.status === 'void') throw unprocessable('A void invoice cannot be sent');
      if (inv.total <= 0) throw unprocessable('Invoice total must be greater than zero');
      let to = req.body.to ?? [];
      if (!to.length) {
        const project = await clients.project(p.tenantId, inv.projectId).catch(() => null);
        to = [
          ...new Set(
            (project?.contacts ?? [])
              .filter((c) => OWNER_CONTACT_ROLES.includes(c.role) && c.email)
              .map((c) => c.email!),
          ),
        ];
      }
      if (!to.length)
        throw unprocessable('No owner contacts with an email on the project; pass recipients in "to"');

      const documentId = await renderInvoicePdf(p, inv.id);
      const invoice = await req.tx(async (tx) => {
        const cur = await getInvoice(tx, inv.id, { forUpdate: true });
        const firstSend = cur.status === 'draft';
        await tx`update finance.invoices set
          status = case when status = 'draft' then 'sent' else status end,
          sent_at = now(), document_id = ${documentId},
          qbo_sync_status = case when status = 'draft' or qbo_sync_status = 'error' then 'pending' else qbo_sync_status end
          where id = ${cur.id}`;
        if (firstSend)
          await req.emit(tx, 'finance.invoice.issued', {
            invoiceId: cur.id,
            projectId: cur.projectId,
            number: cur.number,
            total: cur.total,
          });
        const link = `${config().PUBLIC_WEB_URL}/portal/invoices/${cur.id}`;
        const due = cur.terms === 'Due on receipt' ? 'due on receipt' : `due ${cur.dueDate}`;
        const intro = req.body.message?.trim();
        await req.emit(tx, 'cmd.email.send', {
          to,
          cc: req.body.cc ?? [],
          subject: `Invoice ${cur.number} — ${cur.projectName || cur.projectNumber}`.trim(),
          text: [
            intro ? `${intro}\n` : '',
            `Please find attached invoice ${cur.number} for ${cur.projectName || 'your project'}.`,
            `Amount: $${cur.total.toFixed(2)} (${due}).`,
            cur.poReference ? `Your PO: ${cur.poReference}` : '',
            '',
            `View it online: ${link}`,
          ]
            .filter((l) => l !== '')
            .join('\n'),
          html: null,
          replyTo: null,
          attachments: [{ documentId, filename: `${cur.number}.pdf` }],
          threadId: null,
        });
        return withAging(await getInvoice(tx, cur.id));
      });
      return { invoice, documentId, recipients: to };
    },
  );

  // ------------------------------------------------------------------ payments
  app.post(
    '/invoices/:id/payments',
    {
      schema: {
        tags: TAGS,
        summary: 'Record a payment received from the client',
        params: IdParams,
        body: RecordPaymentBody,
        response: { 201: z.object({ payment: Payment, invoice: Invoice }) },
      },
    },
    async (req, reply) => {
      req.principal.require('finance:write');
      const p = req.principal;
      const result = await req.tx(async (tx) => {
        const { payment } = await applyInvoicePayment(
          tx,
          req.params.id,
          {
            amount: req.body.amount,
            receivedAt: req.body.receivedAt ?? today(),
            method: req.body.method,
            reference: req.body.reference ?? null,
            notes: req.body.notes ?? null,
            source: 'manual',
            createdByName: p.name,
          },
          { tenantId: p.tenantId, actor: { userId: p.userId, orgId: p.orgId, name: p.name } },
        );
        return { payment, invoice: withAging(await getInvoice(tx, req.params.id)) };
      });
      return reply.status(201).send(result);
    },
  );

  // ------------------------------------------------------------------ void
  app.post(
    '/invoices/:id/void',
    {
      schema: {
        tags: TAGS,
        summary: 'Void an invoice (no payments may be recorded against it)',
        params: IdParams,
        body: VoidBody,
        response: { 200: Invoice },
      },
    },
    async (req) => {
      req.principal.require('finance:write');
      return req.tx(async (tx) => {
        const inv = await getInvoice(tx, req.params.id, { forUpdate: true });
        if (inv.status === 'void') return withAging(inv);
        if (inv.amountPaid > 0) throw unprocessable('Invoice has payments; issue a credit memo instead');
        const reason = req.body.reason?.trim();
        await tx`update finance.invoices set status = 'void', voided_at = now(), balance = 0,
          notes = ${reason ? [inv.notes, `Voided: ${reason}`].filter(Boolean).join('\n') : inv.notes},
          qbo_sync_status = ${inv.qboId ? 'pending' : 'not_synced'}
          where id = ${inv.id}`;
        return withAging(await getInvoice(tx, inv.id));
      });
    },
  );
}

/** Render the 'invoice' template through documents and store the document id on the invoice. */
export async function renderInvoicePdf(principal: Principal, invoiceId: string): Promise<string> {
  const tenantId = principal.tenantId;
  const detail = await withTenant(tenantId, (tx) => invoiceDetail(tx, invoiceId));
  const [tenantOrg, clientOrg, project] = await Promise.all([
    clients.org(principal, tenantId).catch(() => null),
    clients.org(principal, detail.clientOrgId).catch(() => null),
    clients.project(tenantId, detail.projectId).catch(() => null),
  ]);
  const tenant = {
    name: tenantOrg?.name ?? principal.claims.orgName,
    address: tenantOrg?.address ?? {},
    phone: tenantOrg?.phone ?? null,
    email: tenantOrg?.email ?? null,
  };
  const doc = await clients.renderReport({
    tenantId,
    template: 'invoice',
    filename: `${detail.number}.pdf`,
    entityType: 'invoice',
    entityId: detail.id,
    visibility: 'client',
    clientOrgId: detail.clientOrgId,
    data: {
      tenant,
      client: { name: clientOrg?.name ?? detail.clientName, address: clientOrg?.address ?? {} },
      invoice: {
        number: detail.number,
        kind: detail.kind,
        issueDate: detail.issueDate,
        dueDate: detail.dueDate,
        terms: detail.terms,
        notes: detail.notes,
        poReference: detail.poReference,
      },
      project: {
        number: detail.projectNumber,
        name: detail.projectName,
        propertyName: project?.propertyName ?? null,
        address: project?.address ?? null,
      },
      lines: detail.lines.map((l) => ({
        description: l.description,
        qty: l.quantity,
        unitPrice: l.unitPrice,
        amount: l.amount,
      })),
      totals: {
        subtotal: detail.subtotal,
        tax: detail.tax,
        total: detail.total,
        paid: detail.amountPaid,
        balance: detail.balance,
      },
      remitTo: { name: tenant.name, address: tenant.address, email: tenant.email, phone: tenant.phone },
    },
  });
  await withTenant(
    tenantId,
    (tx) => tx`update finance.invoices set document_id = ${doc.id} where id = ${invoiceId}`,
  );
  return doc.id;
}
