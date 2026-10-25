import { type EventData, marginPct, priceFromMarkup } from '@procure/domain';
import {
  type App,
  badRequest,
  config,
  conflict,
  emit,
  forbidden,
  must,
  notFound,
  type Principal,
  type Tx,
  unprocessable,
  withTenant,
  z,
} from '@procure/platform';
import { catalog, documents, identity, projects, tolerate, type VendorInfo } from '../clients.js';
import { diffCompare, SPEC_CHANGE_FIELDS, type SpecChanges } from '../domain/compare.js';
import {
  getQuote,
  invalidateApproval,
  type LineRow,
  pageResult,
  type ReqCtx,
  recomputeLines,
  recordSpecCost,
} from '../repo.js';
import {
  CompareResult,
  CostRequest,
  CostRequestApply,
  CostRequestApplyResult,
  CostRequestCreate,
  CostRequestCreateResult,
  CostRequestDetail,
  CostRequestLine,
  CostRequestListQuery,
  CostResponseInput,
  IdParams,
  LineParams,
  pageOf,
  TenantQuery,
  VendorCostRequest,
  VendorCostRequestDetail,
} from '../schemas.js';

type CR = z.infer<typeof CostRequest> & { tenantId: string };
type CRL = z.infer<typeof CostRequestLine>;

const crSelect = (tx: Tx) => tx`
  r.*, q.number as quote_number, q.name as quote_name,
  (select count(*)::int from quoting.cost_request_lines x where x.cost_request_id = r.id) as line_count,
  (select count(*)::int from quoting.cost_request_lines x where x.cost_request_id = r.id and x.responded_at is not null) as responded_line_count,
  (select count(*)::int from quoting.cost_request_lines x where x.cost_request_id = r.id and x.applied_at is not null) as applied_line_count`;

/** Vendors cannot read quotes (RLS), so their list query must not join quotes. */
const vendorSelect = (tx: Tx) => tx`
  r.id, r.number, r.status, r.project_name, r.due_date, r.message, r.sent_at, r.viewed_at, r.responded_at, r.document_id,
  (select count(*)::int from quoting.cost_request_lines x where x.cost_request_id = r.id) as line_count,
  (select count(*)::int from quoting.cost_request_lines x where x.cost_request_id = r.id and x.responded_at is not null) as responded_line_count`;

export async function getCostRequest(tx: Tx, id: string): Promise<CR> {
  const [r] = await tx<CR[]>`
    select ${crSelect(tx)} from quoting.cost_requests r left join quoting.quotes q on q.id = r.quote_id where r.id = ${id}`;
  return must(r, 'Cost request');
}
const crLines = (tx: Tx, id: string) =>
  tx<CRL[]>`select * from quoting.cost_request_lines where cost_request_id = ${id} order by code, id`;

const ACCEPTING = ['sent', 'viewed', 'responded'];

/** Write a vendor (or staff / AI) response onto cost request lines. */
export async function recordResponses(
  tx: Tx,
  cr: { id: string; status: string },
  lines: {
    costRequestLineId: string;
    cost: number | null;
    expiresAt?: string | null;
    leadTimeWeeks?: number | null;
    notes?: string | null;
    specChanges?: SpecChanges;
  }[],
  source: 'portal' | 'ai_pdf' | 'manual',
) {
  if (!ACCEPTING.includes(cr.status) && source === 'portal')
    throw conflict(`This cost request is ${cr.status} and no longer accepts responses`);
  if (['closed'].includes(cr.status)) throw conflict('This cost request is closed');
  const existing = await tx<
    {
      id: string;
      code: string;
      name: string;
      description: string | null;
      vendorSku: string | null;
      finish: string | null;
      dimensions: string | null;
      materials: string | null;
    }[]
  >`
    select l.id, l.code, l.name, l.description, l.vendor_sku, l.finish, l.dimensions, s.materials
    from quoting.cost_request_lines l left join quoting.specs s on s.id = l.spec_id
    where l.cost_request_id = ${cr.id}`;
  const byId = new Map(existing.map((e) => [e.id, e]));
  for (const l of lines) {
    if (!byId.has(l.costRequestLineId))
      throw badRequest(`Line ${l.costRequestLineId} is not part of this cost request`);
    const prev = byId.get(l.costRequestLineId)! as Record<string, unknown>;
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const [f, ch] of Object.entries(l.specChanges ?? {})) {
      if (!(SPEC_CHANGE_FIELDS as readonly string[]).includes(f) || !ch) continue;
      changes[f] = { from: ch.from ?? (prev[f] as string | null) ?? null, to: ch.to };
    }
    await tx`update quoting.cost_request_lines set
        response_cost = ${l.cost},
        response_expires_at = ${l.expiresAt ?? null},
        response_lead_time_weeks = ${l.leadTimeWeeks ?? null},
        response_notes = ${l.notes ?? null},
        response_spec_changes = ${tx.json(changes as never)},
        response_source = ${source},
        responded_at = now(),
        applied_at = null
      where id = ${l.costRequestLineId}`;
  }
}

/** Vendor-side line ids may not be readable via joins on specs; this variant uses only the line table. */
async function vendorRecordResponse(
  tx: Tx,
  crId: string,
  lineId: string,
  b: z.infer<typeof CostResponseInput>,
) {
  const [l] = await tx<Record<string, string | null>[]>`
    select id, name, description, vendor_sku, finish, dimensions from quoting.cost_request_lines
    where id = ${lineId} and cost_request_id = ${crId}`;
  if (!l) throw notFound('Cost request line');
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const [f, ch] of Object.entries(b.specChanges ?? {})) {
    if (!ch) continue;
    changes[f] = { from: ch.from ?? l[f] ?? null, to: ch.to };
  }
  const [u] = await tx`update quoting.cost_request_lines set
      response_cost = ${b.cost},
      response_expires_at = ${b.expiresAt ?? null},
      response_lead_time_weeks = ${b.leadTimeWeeks ?? null},
      response_notes = ${b.notes ?? null},
      response_spec_changes = ${tx.json(changes as never)},
      response_source = 'portal',
      responded_at = now(),
      applied_at = null
    where id = ${lineId} returning id`;
  if (!u) throw forbidden('This line can no longer be changed');
}

const portalLink = (path: string) => `${config().PUBLIC_WEB_URL}${path}`;

async function notifyResponded(
  req: Pick<ReqCtx, 'emit'>,
  tx: Tx,
  cr: { id: string; number: string; quoteId: string; vendorId: string; vendorName: string | null },
  source: string,
) {
  await req.emit(tx, 'quoting.cost_request.responded', {
    costRequestId: cr.id,
    quoteId: cr.quoteId,
    vendorId: cr.vendorId,
    source,
  });
  await req.emit(tx, 'cmd.notify', {
    userIds: [],
    roles: ['procurement'],
    title: `${cr.vendorName ?? 'Vendor'} responded to ${cr.number}`,
    body: `Costs are ready to compare and apply.`,
    link: `/app/cost-requests/${cr.id}`,
    severity: 'info',
  });
}

export async function costRequestRoutes(app: App) {
  // ================================================================ internal staff
  app.post(
    '/quotes/:id/cost-requests',
    {
      schema: {
        tags: ['cost-requests'],
        summary: 'Package quote lines by vendor and send one cost request per vendor to the vendor portal',
        params: IdParams,
        body: CostRequestCreate,
        response: { 201: CostRequestCreateResult },
      },
    },
    async (req, reply) => {
      const p = req.principal;
      p.require('cost_requests:write');
      const b = req.body;
      // 1) Read candidate lines (validates the quote under the caller's RLS).
      const { q, lines } = await req.tx(async (tx) => {
        const q = await getQuote(tx, req.params.id);
        if (q.isTemplate) throw conflict('Templates cannot be sent for costing');
        const lines = await tx<LineRow[]>`
          select * from quoting.quote_lines where quote_id = ${q.id} and po_id is null
          ${b.lineIds ? tx`and id in ${tx(b.lineIds.length ? b.lineIds : ['00000000-0000-0000-0000-000000000000'])}` : tx``}
          ${b.onlyExpiredOrMissing ? tx`and (unit_cost is null or 'cost_expired' = any(flags) or 'cost_expiring' = any(flags))` : tx``}
          order by sort, code`;
        if (b.lineIds && lines.length !== new Set(b.lineIds).size)
          throw badRequest('Some lines are not on this quote or are already ordered');
        return { q, lines };
      });
      const skipped = lines
        .filter((l) => !l.vendorId)
        .map((l) => ({ lineId: l.id, code: l.code, reason: 'No vendor assigned' }));
      const byVendor = new Map<string, LineRow[]>();
      for (const l of lines.filter((x) => x.vendorId)) {
        if (!byVendor.has(l.vendorId!)) byVendor.set(l.vendorId!, []);
        byVendor.get(l.vendorId!)!.push(l);
      }
      if (!byVendor.size) throw unprocessable('No lines with a vendor to request costs for', { skipped });

      // 2) Enrich from other services outside the transaction (tolerating outages).
      const warnings: string[] = [];
      const vendors = new Map<string, VendorInfo | null>();
      for (const vid of byVendor.keys())
        vendors.set(
          vid,
          await tolerate(
            () => catalog.vendor(p.tenantId, vid),
            () =>
              warnings.push(
                `Vendor ${byVendor.get(vid)![0]!.vendorName ?? vid}: catalog unavailable — no portal access or email until the vendor is linked`,
              ),
          ),
        );
      const project = q.projectId ? await tolerate(() => projects.get(p.tenantId, q.projectId!)) : null;
      const tenantOrg = await tolerate(() => identity.org(p, p.tenantId));

      // 3) Create requests + lines + events in one transaction.
      const created = await req.tx(async (tx) => {
        const ids: string[] = [];
        for (const [vid, ls] of byVendor) {
          const v = vendors.get(vid) ?? null;
          const email = v?.profile?.primaryContact?.email ?? null;
          const [{ n }] = (await tx`select platform.next_number(${p.tenantId}, 'CR') as n`) as unknown as [
            { n: string },
          ];
          const [r] = await tx<{ id: string }[]>`
            insert into quoting.cost_requests ${tx({
              tenantId: p.tenantId,
              quoteId: q.id,
              projectId: q.projectId,
              projectName: project?.name ?? null,
              vendorId: vid,
              vendorName: v?.name ?? ls[0]!.vendorName,
              vendorOrgId: v?.orgId ?? null,
              vendorEmail: email,
              number: n,
              status: 'sent',
              dueDate: b.dueDate ?? null,
              message: b.message ?? null,
              sentAt: new Date().toISOString(),
              createdByName: p.name,
            } as never)} returning id`;
          for (const l of ls)
            await tx`insert into quoting.cost_request_lines ${tx({
              tenantId: p.tenantId,
              costRequestId: r!.id,
              quoteLineId: l.id,
              specId: l.specId,
              code: l.code,
              name: l.name,
              description: (l.description as string) ?? null,
              vendorSku: (l.vendorSku as string) ?? null,
              finish: (l.finish as string) ?? null,
              dimensions: (l.dimensions as string) ?? null,
              quantity: l.quantity,
              currentCost: l.unitCost,
            } as never)}`;
          if (!v?.orgId)
            warnings.push(
              `${v?.name ?? ls[0]!.vendorName ?? vid}: vendor has no portal organization; request it by email`,
            );
          await req.emit(tx, 'quoting.cost_request.sent', {
            costRequestId: r!.id,
            number: n,
            quoteId: q.id,
            vendorId: vid,
            vendorOrgId: v?.orgId ?? null,
            vendorEmail: email,
            lineCount: ls.length,
            dueDate: b.dueDate ?? null,
          });
          ids.push(r!.id);
        }
        if (q.status === 'draft') await tx`update quoting.quotes set status = 'costing' where id = ${q.id}`;
        return ids;
      });

      // 4) Render PDFs (best effort) and attach.
      for (const id of created) {
        const vr = await req.tx((tx) => getCostRequest(tx, id));
        const ls = await req.tx((tx) => crLines(tx, id));
        const v = vendors.get(vr.vendorId) ?? null;
        const doc = await tolerate(
          () =>
            documents.render({
              tenantId: p.tenantId,
              template: 'cost_request',
              filename: `${vr.number}.pdf`,
              entityType: 'cost_request',
              entityId: id,
              visibility: 'vendor',
              vendorOrgId: vr.vendorOrgId,
              data: {
                tenant: {
                  name: tenantOrg?.name ?? '',
                  address: tenantOrg?.address ?? {},
                  phone: tenantOrg?.phone ?? null,
                  email: tenantOrg?.email ?? null,
                },
                vendor: { name: vr.vendorName, contact: v?.profile?.primaryContact ?? null },
                request: { number: vr.number, dueDate: vr.dueDate, message: vr.message },
                lines: ls.map((l) => ({
                  code: l.code,
                  name: l.name,
                  description: l.description,
                  qty: l.quantity,
                })),
              },
            }),
          () => warnings.push(`${vr.number}: PDF could not be rendered (documents service unavailable)`),
        );
        if (doc)
          await req.tx((tx) => tx`update quoting.cost_requests set document_id = ${doc.id} where id = ${id}`);
      }
      const requests = await req.tx(async (tx) => Promise.all(created.map((id) => getCostRequest(tx, id))));
      return reply.status(201).send({ requests, skipped, warnings });
    },
  );

  app.get(
    '/cost-requests',
    {
      schema: {
        tags: ['cost-requests'],
        summary: 'List cost requests',
        querystring: CostRequestListQuery,
        response: { 200: pageOf(CostRequest) },
      },
    },
    async (req) => {
      req.principal.require('quotes:costs:read');
      const { quoteId, vendorId, status, q, limit, offset } = req.query;
      return req.tx(async (tx) => {
        const where = tx`where true
          ${quoteId ? tx`and r.quote_id = ${quoteId}` : tx``}
          ${vendorId ? tx`and r.vendor_id = ${vendorId}` : tx``}
          ${status ? tx`and r.status = ${status}` : tx``}
          ${q ? tx`and (r.number ilike ${`%${q}%`} or r.vendor_name ilike ${`%${q}%`})` : tx``}`;
        const [{ count }] =
          (await tx`select count(*)::int as count from quoting.cost_requests r ${where}`) as unknown as [
            { count: number },
          ];
        const items = await tx<CR[]>`
          select ${crSelect(tx)} from quoting.cost_requests r left join quoting.quotes q on q.id = r.quote_id
          ${where} order by r.created_at desc limit ${limit} offset ${offset}`;
        return pageResult(items, count, limit, offset);
      });
    },
  );

  app.get(
    '/cost-requests/:id',
    {
      schema: {
        tags: ['cost-requests'],
        summary: 'Cost request with lines and responses',
        params: IdParams,
        response: { 200: CostRequestDetail },
      },
    },
    async (req) => {
      req.principal.require('quotes:costs:read');
      return req.tx(async (tx) => ({
        ...(await getCostRequest(tx, req.params.id)),
        lines: await crLines(tx, req.params.id),
      }));
    },
  );

  app.get(
    '/cost-requests/:id/compare',
    {
      schema: {
        tags: ['cost-requests'],
        summary: 'Side-by-side: vendor response vs. library spec vs. quote line, with field differences',
        params: IdParams,
        response: { 200: CompareResult },
      },
    },
    async (req) => {
      req.principal.require('quotes:costs:read');
      return req.tx(async (tx) => {
        const cr = await getCostRequest(tx, req.params.id);
        const q = await getQuote(tx, cr.quoteId);
        const lines = await crLines(tx, cr.id);
        const specIds = lines.map((l) => l.specId).filter(Boolean) as string[];
        const qlIds = lines.map((l) => l.quoteLineId).filter(Boolean) as string[];
        const specs = new Map(
          (specIds.length
            ? await tx<
                Record<string, any>[]
              >`select id, code, name, description, vendor_sku, finish, dimensions, materials, cost,
                 cost_expires_at, lead_time_weeks from quoting.specs where id in ${tx(specIds)}`
            : []
          ).map((s) => [s.id as string, s]),
        );
        const qls = new Map(
          (qlIds.length
            ? await tx<Record<string, any>[]>`select * from quoting.quote_lines where id in ${tx(qlIds)}`
            : []
          ).map((l) => [l.id as string, l]),
        );
        const fields = ['cost', 'leadTimeWeeks', ...SPEC_CHANGE_FIELDS];
        return {
          rows: lines.map((l) => {
            const spec = l.specId ? (specs.get(l.specId) ?? null) : null;
            const ql = l.quoteLineId ? (qls.get(l.quoteLineId) ?? null) : null;
            const sc = (l.responseSpecChanges ?? {}) as Record<string, { to: unknown }>;
            const vendorView: Record<string, unknown> = {
              cost: l.responseCost,
              leadTimeWeeks: l.responseLeadTimeWeeks,
              ...Object.fromEntries(Object.entries(sc).map(([k, v]) => [k, v?.to])),
            };
            const differences = l.respondedAt
              ? diffCompare(vendorView, spec, ql ? { ...ql, cost: ql.unitCost } : null, fields)
              : [];
            let projected: number | null = null;
            if (ql && l.responseCost !== null) {
              const landed = l.responseCost + (q.freightMode === 'per_line' ? (ql.freightUnit ?? 0) : 0);
              const price = ql.priceOverride ? ql.unitPrice : priceFromMarkup(landed, ql.markupPct ?? 0);
              projected = price === null ? null : marginPct(landed, price);
            }
            return {
              costRequestLineId: l.id,
              line: l,
              vendorResponse: {
                cost: l.responseCost,
                expiresAt: l.responseExpiresAt,
                leadTimeWeeks: l.responseLeadTimeWeeks,
                notes: l.responseNotes,
                specChanges: l.responseSpecChanges ?? {},
                source: l.responseSource,
                respondedAt: l.respondedAt,
              },
              librarySpec: spec as never,
              quoteLine: ql as never,
              differences,
              projectedMarginPct: projected,
            };
          }),
        };
      });
    },
  );

  app.post(
    '/cost-requests/:id/apply',
    {
      schema: {
        tags: ['cost-requests'],
        summary:
          'Apply vendor responses to the quote lines, and optionally to the library spec (cost history) and spec corrections',
        params: IdParams,
        body: CostRequestApply,
        response: { 200: CostRequestApplyResult },
      },
    },
    async (req) => {
      const p = req.principal;
      p.require('cost_requests:write', 'quotes:write');
      if (req.body.applyToSpec) p.require('specs:write');
      return req.tx(async (tx) => {
        const cr = await getCostRequest(tx, req.params.id);
        if (cr.status === 'closed') throw conflict('This cost request is closed');
        const q = await getQuote(tx, cr.quoteId, { lock: true });
        const all = await crLines(tx, cr.id);
        const wanted = req.body.lineIds ? new Set(req.body.lineIds) : null;
        if (wanted && [...wanted].some((id) => !all.some((l) => l.id === id)))
          throw badRequest('Some lines are not part of this cost request');
        const targets = all.filter((l) => (wanted ? wanted.has(l.id) : l.respondedAt && !l.appliedAt));
        const skipped: { lineId: string; reason: string }[] = [];
        let applied = 0;
        const specsTouched = new Set<string>();
        const qlTouched: string[] = [];
        for (const l of targets) {
          if (!l.respondedAt) {
            skipped.push({ lineId: l.id, reason: 'No vendor response yet' });
            continue;
          }
          const changes = (l.responseSpecChanges ?? {}) as SpecChanges;
          const specFieldSets: Record<string, unknown> = {};
          if (req.body.applySpecChanges)
            for (const [f, ch] of Object.entries(changes)) if (ch) specFieldSets[f] = ch.to;
          if (l.quoteLineId) {
            const [ql] = await tx<LineRow[]>`select * from quoting.quote_lines where id = ${l.quoteLineId}`;
            if (!ql) skipped.push({ lineId: l.id, reason: 'Quote line was deleted' });
            else if (ql.poId) skipped.push({ lineId: l.id, reason: 'Quote line is already ordered' });
            else {
              await tx`update quoting.quote_lines set ${tx({
                ...(l.responseCost !== null
                  ? { unitCost: l.responseCost, costExpiresAt: l.responseExpiresAt }
                  : {}),
                ...(l.responseLeadTimeWeeks !== null ? { leadTimeWeeks: l.responseLeadTimeWeeks } : {}),
                ...specFieldSets,
              } as never)} where id = ${ql.id}`;
              qlTouched.push(ql.id);
            }
          }
          if (req.body.applyToSpec && l.specId) {
            const [s] = await tx<{ id: string; cost: number | null; costExpiresAt: string | null }[]>`
              select id, cost, cost_expires_at from quoting.specs where id = ${l.specId} for update`;
            if (s) {
              await tx`update quoting.specs set ${tx({
                ...(l.responseCost !== null
                  ? { cost: l.responseCost, costExpiresAt: l.responseExpiresAt }
                  : {}),
                ...(l.responseLeadTimeWeeks !== null ? { leadTimeWeeks: l.responseLeadTimeWeeks } : {}),
                ...specFieldSets,
              } as never)} where id = ${s.id}`;
              if (l.responseCost !== null)
                await recordSpecCost(tx, {
                  tenantId: p.tenantId,
                  specId: s.id,
                  cost: l.responseCost,
                  expiresAt: l.responseExpiresAt,
                  source: l.responseSource === 'ai_pdf' ? 'ai_pdf' : 'cost_request',
                  costRequestId: cr.id,
                  by: p.name,
                });
              specsTouched.add(s.id);
            }
          }
          await tx`update quoting.cost_request_lines set applied_at = now(),
                     applied_to_spec = ${req.body.applyToSpec && !!l.specId} where id = ${l.id}`;
          applied++;
        }
        if (qlTouched.length) {
          await recomputeLines(tx, q, { lineIds: qlTouched });
          await invalidateApproval(tx, q);
        }
        const [{ remaining }] = (await tx`select count(*)::int as remaining from quoting.cost_request_lines
                                          where cost_request_id = ${cr.id} and applied_at is null`) as unknown as [
          { remaining: number },
        ];
        const status =
          remaining === 0 ? 'applied' : applied || cr.appliedLineCount ? 'partially_applied' : cr.status;
        await tx`update quoting.cost_requests set status = ${status} where id = ${cr.id}`;
        return { applied, skipped, specsUpdated: specsTouched.size, status: status as never };
      });
    },
  );

  app.put(
    '/cost-requests/:id/lines/:lineId/response',
    {
      schema: {
        tags: ['cost-requests'],
        summary: 'Enter a vendor response received by phone or email (source: manual)',
        params: LineParams,
        body: CostResponseInput,
        response: { 200: CostRequestLine },
      },
    },
    async (req) => {
      req.principal.require('cost_requests:write');
      return req.tx(async (tx) => {
        const cr = await getCostRequest(tx, req.params.id);
        await recordResponses(tx, cr, [{ costRequestLineId: req.params.lineId, ...req.body }], 'manual');
        const [{ open }] = (await tx`select count(*)::int as open from quoting.cost_request_lines
                                     where cost_request_id = ${cr.id} and responded_at is null`) as unknown as [
          { open: number },
        ];
        if (open === 0 && ['sent', 'viewed'].includes(cr.status))
          await tx`update quoting.cost_requests set status = 'responded', responded_at = now() where id = ${cr.id}`;
        const [l] = await tx<CRL[]>`select * from quoting.cost_request_lines where id = ${req.params.lineId}`;
        return l!;
      });
    },
  );

  app.post(
    '/cost-requests/:id/close',
    {
      schema: {
        tags: ['cost-requests'],
        summary: 'Close a cost request (no further responses)',
        params: IdParams,
        response: { 200: CostRequest },
      },
    },
    async (req) => {
      req.principal.require('cost_requests:write');
      return req.tx(async (tx) => {
        await getCostRequest(tx, req.params.id);
        await tx`update quoting.cost_requests set status = 'closed' where id = ${req.params.id}`;
        return getCostRequest(tx, req.params.id);
      });
    },
  );

  app.post(
    '/cost-requests/:id/remind',
    {
      schema: {
        tags: ['cost-requests'],
        summary: 'Email the vendor a reminder with the portal link',
        params: IdParams,
        body: z.object({ message: z.string().max(4000).optional() }).optional(),
        response: { 200: CostRequest },
      },
    },
    async (req) => {
      req.principal.require('cost_requests:write');
      return req.tx(async (tx) => {
        const cr = await getCostRequest(tx, req.params.id);
        if (!['sent', 'viewed'].includes(cr.status))
          throw conflict(`Cannot remind on a ${cr.status} request`);
        if (!cr.vendorEmail) throw unprocessable('The vendor has no contact email on file');
        await emitReminder(tx, (t, d) => req.emit(tx, t, d), cr, req.body?.message);
        return getCostRequest(tx, cr.id);
      });
    },
  );

  // ================================================================ vendor portal
  const requireVendor = (p: Principal) => {
    if (!p.isVendor) throw forbidden('Vendor portal only');
    p.require('vendor:respond');
  };

  app.get(
    '/vendor/cost-requests',
    {
      schema: {
        tags: ['vendor-portal'],
        summary: 'Cost requests sent to my organization',
        querystring: z.object({
          status: z
            .enum(['sent', 'viewed', 'responded', 'partially_applied', 'applied', 'closed'])
            .optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
          offset: z.coerce.number().int().min(0).default(0),
        }),
        response: { 200: pageOf(VendorCostRequest) },
      },
    },
    async (req) => {
      requireVendor(req.principal);
      const { status, limit, offset } = req.query;
      return req.tx(async (tx) => {
        const where = tx`where r.status <> 'draft' ${status ? tx`and r.status = ${status}` : tx``}`;
        const [{ count }] =
          (await tx`select count(*)::int as count from quoting.cost_requests r ${where}`) as unknown as [
            { count: number },
          ];
        const items = await tx`select ${vendorSelect(tx)} from quoting.cost_requests r ${where}
                               order by r.sent_at desc nulls last limit ${limit} offset ${offset}`;
        return pageResult(items as unknown as never[], count, limit, offset);
      });
    },
  );

  const vendorDetail = async (tx: Tx, id: string) => {
    const [r] =
      await tx`select ${vendorSelect(tx)} from quoting.cost_requests r where r.id = ${id} and r.status <> 'draft'`;
    if (!r) throw notFound('Cost request');
    const lines =
      await tx`select * from quoting.cost_request_lines where cost_request_id = ${id} order by code, id`;
    return { ...r, lines } as never as z.infer<typeof VendorCostRequestDetail>;
  };

  app.get(
    '/vendor/cost-requests/:id',
    {
      schema: {
        tags: ['vendor-portal'],
        summary: 'A cost request to respond to (marks it viewed)',
        params: IdParams,
        response: { 200: VendorCostRequestDetail },
      },
    },
    async (req) => {
      requireVendor(req.principal);
      return req.tx(async (tx) => {
        const d = await vendorDetail(tx, req.params.id);
        if (d.status === 'sent') {
          await tx`update quoting.cost_requests set status = 'viewed', viewed_at = now() where id = ${d.id}`;
          return vendorDetail(tx, d.id);
        }
        return d;
      });
    },
  );

  app.put(
    '/vendor/cost-requests/:id/lines/:lineId',
    {
      schema: {
        tags: ['vendor-portal'],
        summary: 'Enter cost, expiry, lead time, notes and spec corrections for a line',
        params: LineParams,
        body: CostResponseInput,
        response: { 200: VendorCostRequestDetail },
      },
    },
    async (req) => {
      requireVendor(req.principal);
      return req.tx(async (tx) => {
        const d = await vendorDetail(tx, req.params.id);
        if (!ACCEPTING.includes(d.status))
          throw conflict(`This cost request is ${d.status} and no longer accepts responses`);
        await vendorRecordResponse(tx, d.id, req.params.lineId, req.body);
        return vendorDetail(tx, d.id);
      });
    },
  );

  app.post(
    '/vendor/cost-requests/:id/submit',
    {
      schema: {
        tags: ['vendor-portal'],
        summary: 'Submit my response (notifies the procurement team)',
        params: IdParams,
        response: { 200: VendorCostRequestDetail },
      },
    },
    async (req) => {
      requireVendor(req.principal);
      return req.tx(async (tx) => {
        const d = await vendorDetail(tx, req.params.id);
        if (!ACCEPTING.includes(d.status)) throw conflict(`This cost request is ${d.status}`);
        if (!d.lines.some((l) => l.respondedAt))
          throw unprocessable('Enter a response for at least one line before submitting');
        const [cr] = await tx<
          { id: string; number: string; quoteId: string; vendorId: string; vendorName: string | null }[]
        >`
          update quoting.cost_requests set status = 'responded', responded_at = now() where id = ${d.id}
          returning id, number, quote_id, vendor_id, vendor_name`;
        await notifyResponded(req, tx, cr!, 'portal');
        return vendorDetail(tx, d.id);
      });
    },
  );

  // ================================================================ service-to-service
  app.get(
    '/internal/cost-requests/:id',
    {
      config: { internal: true },
      schema: { hide: true, params: IdParams, querystring: TenantQuery },
    },
    async (req) =>
      withTenant(req.query.tenantId, async (tx) => {
        const cr = await getCostRequest(tx, req.params.id);
        const lines = await crLines(tx, cr.id);
        return {
          id: cr.id,
          number: cr.number,
          quoteId: cr.quoteId,
          vendorId: cr.vendorId,
          status: cr.status,
          lines: lines.map((l) => ({
            id: l.id,
            quoteLineId: l.quoteLineId,
            specId: l.specId,
            code: l.code,
            name: l.name,
            description: l.description,
            vendorSku: l.vendorSku,
            quantity: l.quantity,
            currentCost: l.currentCost,
          })),
        };
      }),
  );

  app.post(
    '/internal/cost-requests/:id/responses',
    {
      config: { internal: true },
      schema: {
        hide: true,
        params: IdParams,
        querystring: TenantQuery,
        body: z.object({
          source: z.enum(['ai_pdf', 'manual']),
          lines: z
            .array(
              z.object({
                costRequestLineId: z.uuid(),
                cost: z.number().min(0).nullable(),
                expiresAt: z.string().nullable().optional(),
                leadTimeWeeks: z.number().min(0).nullable().optional(),
                notes: z.string().nullable().optional(),
              }),
            )
            .min(1),
        }),
      },
    },
    async (req) => {
      const tenantId = req.query.tenantId;
      return withTenant(tenantId, async (tx) => {
        const cr = await getCostRequest(tx, req.params.id);
        await recordResponses(tx, cr, req.body.lines, req.body.source);
        const [{ open }] = (await tx`select count(*)::int as open from quoting.cost_request_lines
                                     where cost_request_id = ${cr.id} and responded_at is null`) as unknown as [
          { open: number },
        ];
        if (open === 0 && ['sent', 'viewed'].includes(cr.status)) {
          await tx`update quoting.cost_requests set status = 'responded', responded_at = now() where id = ${cr.id}`;
        }
        await notifyResponded(
          { emit: (etx, t, d) => emit(etx, 'quoting', t, d, { tenantId, actor: null }) },
          tx,
          cr,
          req.body.source,
        );
        return { ok: true, recorded: req.body.lines.length, status: open === 0 ? 'responded' : cr.status };
      });
    },
  );
}

export async function emitReminder(
  tx: Tx,
  emit: (type: 'cmd.email.send', data: EventData<'cmd.email.send'>) => Promise<string>,
  cr: {
    id: string;
    number: string;
    vendorEmail: string | null;
    dueDate: string | null;
    documentId: string | null;
    projectName?: string | null;
  },
  message?: string,
) {
  if (!cr.vendorEmail) return false;
  await emit('cmd.email.send', {
    to: [cr.vendorEmail],
    cc: [],
    subject: `Reminder: cost request ${cr.number}${cr.dueDate ? ` was due ${cr.dueDate}` : ''}`,
    text: `${message ? `${message}\n\n` : ''}Please submit pricing for cost request ${cr.number}${
      cr.projectName ? ` (${cr.projectName})` : ''
    }: ${portalLink(`/vendor/cost-requests/${cr.id}`)}`,
    html: null,
    replyTo: null,
    attachments: cr.documentId ? [{ documentId: cr.documentId, filename: `${cr.number}.pdf` }] : [],
    threadId: null,
  });
  await tx`update quoting.cost_requests set last_reminded_at = now(), reminder_count = reminder_count + 1 where id = ${cr.id}`;
  return true;
}
