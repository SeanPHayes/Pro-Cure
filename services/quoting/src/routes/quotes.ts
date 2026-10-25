import {
  ActivityEntry,
  type App,
  badRequest,
  conflict,
  listActivity,
  type Principal,
  type Tx,
  z,
} from '@procure/platform';
import { projects, tolerate } from '../clients.js';
import {
  assertEditable,
  getQuote,
  headerTotals,
  invalidateApproval,
  locationTree,
  pageResult,
  type QuoteRow,
  recomputeLines,
  redactTotals,
  totalsFor,
} from '../repo.js';
import {
  ActivityQuery,
  IdParams,
  IfMatchHeaders,
  pageOf,
  QuoteCopy,
  QuoteCreate,
  QuoteDetail,
  QuoteListItem,
  QuoteListQuery,
  QuotePatch,
} from '../schemas.js';

export const nextQuoteNumber = async (tx: Tx, tenantId: string) => {
  const [r] = await tx<{ n: string }[]>`select platform.next_number(${tenantId}, 'Q', 'Q-{yy}-{seq:4}') as n`;
  return r!.n;
};

/**
 * Deep-copy a quote's structure into `targetId`: room types, location tree, lines (spec snapshots
 * with quantities and pricing) and markup rules. Ordering state (PO links, ready flags) is reset.
 */
export async function deepCopyQuote(tx: Tx, sourceId: string, targetId: string, tenantId: string) {
  const rtMap = new Map<string, string>();
  const rts = await tx<{ id: string; code: string; name: string; count: number; sort: number }[]>`
    select id, code, name, count, sort from quoting.quote_room_types where quote_id = ${sourceId}`;
  for (const r of rts) {
    const [n] = await tx<{ id: string }[]>`
      insert into quoting.quote_room_types (tenant_id, quote_id, code, name, count, sort)
      values (${tenantId}, ${targetId}, ${r.code}, ${r.name}, ${r.count}, ${r.sort}) returning id`;
    rtMap.set(r.id, n!.id);
  }
  const locs = await locationTree(tx, sourceId); // parents before children
  const locMap = new Map<string, string>();
  for (const l of locs) {
    const [n] = await tx<{ id: string }[]>`
      insert into quoting.quote_locations (tenant_id, quote_id, parent_id, name, kind, sort)
      values (${tenantId}, ${targetId}, ${l.parentId ? (locMap.get(l.parentId) ?? null) : null}, ${l.name}, ${l.kind}, ${l.sort})
      returning id`;
    locMap.set(l.id, n!.id);
  }
  const lines = await tx<
    Record<string, unknown>[]
  >`select * from quoting.quote_lines where quote_id = ${sourceId} order by sort`;
  for (const l of lines) {
    const perRoom = Object.fromEntries(
      Object.entries((l.qtyPerRoom as Record<string, number>) ?? {})
        .filter(([k]) => rtMap.has(k))
        .map(([k, v]) => [rtMap.get(k)!, v]),
    );
    const { id, createdAt, updatedAt, ...rest } = l;
    void id;
    void createdAt;
    void updatedAt;
    await tx`insert into quoting.quote_lines ${tx({
      ...rest,
      tenantId,
      quoteId: targetId,
      locationId: l.locationId ? (locMap.get(l.locationId as string) ?? null) : null,
      qtyPerRoom: tx.json(perRoom as never),
      handing: l.handing ? tx.json(l.handing as never) : null,
      readyToOrder: false,
      poId: null,
      poNumber: null,
    } as never)}`;
  }
  const rules = await tx<{ category: string | null; locationId: string | null; markupPct: number }[]>`
    select category, location_id, markup_pct from quoting.quote_markup_rules where quote_id = ${sourceId}`;
  for (const r of rules)
    await tx`insert into quoting.quote_markup_rules (tenant_id, quote_id, category, location_id, markup_pct)
             values (${tenantId}, ${targetId}, ${r.category}, ${r.locationId ? (locMap.get(r.locationId) ?? null) : null}, ${r.markupPct})`;
  return { roomTypes: rtMap.size, locations: locMap.size, lines: lines.length };
}

export async function quoteDetail(tx: Tx, p: Principal, id: string) {
  const q = await getQuote(tx, id);
  const roomTypes =
    await tx`select id, code, name, count, sort from quoting.quote_room_types where quote_id = ${id} order by sort, code`;
  const locations = await locationTree(tx, id);
  const markupRules =
    await tx`select id, category, location_id, markup_pct from quoting.quote_markup_rules where quote_id = ${id} order by created_at`;
  const [{ n }] = (await tx`select count(*)::int as n from quoting.approval_requests
                            where entity_type = 'quote' and entity_id = ${id} and status = 'pending'`) as unknown as [
    { n: number },
  ];
  const totals = redactTotals(p, await totalsFor(tx, q));
  return {
    ...q,
    roomTypes,
    locations,
    totals,
    pendingApprovals: n,
    markupRules: p.can('quotes:costs:read') ? markupRules : [],
  } as unknown as z.infer<typeof QuoteDetail>;
}

/** Optimistic concurrency: If-Match carries the quote version (W/"3", "3" or 3). */
export function checkVersion(q: QuoteRow, ifMatch: string | undefined) {
  if (ifMatch === undefined) return;
  const v = Number(ifMatch.replace(/^W\//, '').replace(/"/g, '').trim());
  if (!Number.isInteger(v)) throw badRequest('If-Match must carry the quote version');
  if (v !== q.version)
    throw conflict('The quote was changed by someone else. Reload and try again.', {
      currentVersion: q.version,
    });
}

async function projectClientOrg(tenantId: string, projectId: string | null | undefined) {
  if (!projectId) return null;
  const pr = await tolerate(() => projects.get(tenantId, projectId));
  return pr?.clientOrgId ?? null;
}

export async function quoteRoutes(app: App) {
  app.get(
    '/quotes',
    {
      schema: {
        tags: ['quotes'],
        summary: 'List quotes (and templates) with totals',
        querystring: QuoteListQuery,
        response: { 200: pageOf(QuoteListItem) },
      },
    },
    async (req) => {
      const p = req.principal;
      p.require('quotes:read');
      const { projectId, status, isTemplate, q, limit, offset } = req.query;
      return req.tx(async (tx) => {
        const where = tx`where true
          ${projectId ? tx`and q.project_id = ${projectId}` : tx``}
          ${status ? tx`and q.status = ${status}` : tx``}
          ${isTemplate !== undefined ? tx`and q.is_template = ${isTemplate}` : tx``}
          ${q ? tx`and (q.number ilike ${`%${q}%`} or q.name ilike ${`%${q}%`} or q.template_name ilike ${`%${q}%`} or q.phase ilike ${`%${q}%`})` : tx``}`;
        const [{ count }] =
          (await tx`select count(*)::int as count from quoting.quotes q ${where}`) as unknown as [
            { count: number },
          ];
        const rows = await tx<(QuoteRow & { lineCount: number; cost: number; sell: number })[]>`
          select q.*,
            (select count(*)::int from quoting.quote_lines l where l.quote_id = q.id) as line_count,
            coalesce((select sum(extended_cost) from quoting.quote_lines l where l.quote_id = q.id and l.is_selected), 0) as cost,
            coalesce((select sum(extended_price) from quoting.quote_lines l where l.quote_id = q.id and l.is_selected), 0) as sell
          from quoting.quotes q ${where}
          order by q.created_at desc limit ${limit} offset ${offset}`;
        const items = rows.map((r) => ({
          ...r,
          totals: redactTotals(p, headerTotals(r, r)),
        })) as unknown as z.infer<typeof QuoteListItem>[];
        return pageResult(items, count, limit, offset);
      });
    },
  );

  app.post(
    '/quotes',
    {
      schema: {
        tags: ['quotes'],
        summary:
          'Create a quote for a project, optionally from a template (deep copy of rooms, locations and lines)',
        body: QuoteCreate,
        response: { 201: QuoteDetail },
      },
    },
    async (req, reply) => {
      const p = req.principal;
      p.require('quotes:write');
      const b = req.body;
      if (!b.isTemplate && !b.projectId)
        throw badRequest('projectId is required (unless creating a template)');
      const clientOrgId = b.isTemplate ? null : await projectClientOrg(p.tenantId, b.projectId);
      const detail = await req.tx(async (tx) => {
        const tpl = b.templateId ? await getQuote(tx, b.templateId) : null;
        const number = await nextQuoteNumber(tx, p.tenantId);
        const [q] = await tx<{ id: string }[]>`
          insert into quoting.quotes ${tx({
            tenantId: p.tenantId,
            projectId: b.projectId ?? null,
            clientOrgId,
            number,
            name: b.name,
            phase: b.phase ?? null,
            isTemplate: b.isTemplate,
            templateName: b.isTemplate ? (b.templateName ?? b.name) : null,
            sourceQuoteId: tpl?.id ?? null,
            taxRate: b.taxRate ?? tpl?.taxRate ?? 0,
            freightMode: b.freightMode ?? tpl?.freightMode ?? 'per_line',
            freightPct: b.freightPct ?? tpl?.freightPct ?? 0,
            defaultMarkupPct: b.defaultMarkupPct ?? tpl?.defaultMarkupPct ?? 0,
            minMarginPct: b.minMarginPct !== undefined ? b.minMarginPct : (tpl?.minMarginPct ?? null),
            validUntil: b.validUntil ?? null,
            notes: b.notes ?? (tpl?.notes as string | null) ?? null,
            clientNotes: b.clientNotes ?? (tpl?.clientNotes as string | null) ?? null,
            createdBy: p.userId,
          } as never)}
          returning id`;
        if (tpl) {
          await deepCopyQuote(tx, tpl.id, q!.id, p.tenantId);
          await recomputeLines(tx, await getQuote(tx, q!.id));
        }
        return quoteDetail(tx, p, q!.id);
      });
      return reply.status(201).send(detail);
    },
  );

  app.get(
    '/quotes/:id',
    {
      schema: {
        tags: ['quotes'],
        summary: 'Quote header, room types, location tree, totals and flag counts',
        params: IdParams,
        response: { 200: QuoteDetail },
      },
    },
    async (req, reply) => {
      req.principal.require('quotes:read');
      const d = await req.tx((tx) => quoteDetail(tx, req.principal, req.params.id));
      reply.header('etag', `"${d.version}"`);
      return d;
    },
  );

  app.patch(
    '/quotes/:id',
    {
      schema: {
        tags: ['quotes'],
        summary:
          'Update quote header. Send If-Match with the version to avoid overwriting concurrent edits (409).',
        params: IdParams,
        headers: IfMatchHeaders,
        body: QuotePatch,
        response: { 200: QuoteDetail },
      },
    },
    async (req, reply) => {
      const p = req.principal;
      p.require('quotes:write');
      const d = await req.tx(async (tx) => {
        const q = await getQuote(tx, req.params.id, { lock: true });
        checkVersion(q, req.headers['if-match']);
        const b = req.body;
        const contentKeys = [
          'taxRate',
          'freightMode',
          'freightPct',
          'minMarginPct',
          'defaultMarkupPct',
        ] as const;
        if (contentKeys.some((k) => b[k] !== undefined) || (b.status && b.status !== 'archived'))
          assertEditable(q);
        if (b.status === 'archived' && q.status === 'ordered')
          throw conflict('Ordered quotes cannot be archived');
        const sets = Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined));
        if (Object.keys(sets).length)
          await tx`update quoting.quotes set ${tx(sets as never)} where id = ${q.id}`;
        if (contentKeys.some((k) => b[k] !== undefined && b[k] !== q[k])) {
          const fresh = await getQuote(tx, q.id);
          await recomputeLines(tx, fresh);
          if (
            ['taxRate', 'freightMode', 'freightPct', 'minMarginPct'].some(
              (k) => (b as never)[k] !== undefined,
            )
          )
            await invalidateApproval(tx, fresh);
        }
        return quoteDetail(tx, p, q.id);
      });
      reply.header('etag', `"${d.version}"`);
      return d;
    },
  );

  app.post(
    '/quotes/:id/copy',
    {
      schema: {
        tags: ['quotes'],
        summary: 'Copy a quote to a (possibly different) project, or save it as a template',
        params: IdParams,
        body: QuoteCopy,
        response: { 201: QuoteDetail },
      },
    },
    async (req, reply) => {
      const p = req.principal;
      p.require('quotes:write');
      const b = req.body;
      const detail = await req.tx(async (tx) => {
        const src = await getQuote(tx, req.params.id);
        const projectId = b.asTemplate ? (b.projectId ?? null) : (b.projectId ?? src.projectId);
        if (!b.asTemplate && !projectId)
          throw badRequest('projectId is required to copy a template into a quote');
        const clientOrgId = b.asTemplate
          ? null
          : projectId === src.projectId
            ? src.clientOrgId
            : await projectClientOrg(p.tenantId, projectId);
        const number = await nextQuoteNumber(tx, p.tenantId);
        const [q] = await tx<{ id: string }[]>`
          insert into quoting.quotes ${tx({
            tenantId: p.tenantId,
            projectId,
            clientOrgId,
            number,
            name: b.name,
            phase: b.phase !== undefined ? b.phase : src.phase,
            isTemplate: b.asTemplate,
            templateName: b.asTemplate ? (b.templateName ?? b.name) : null,
            sourceQuoteId: src.id,
            currency: src.currency,
            taxRate: src.taxRate,
            freightMode: src.freightMode,
            freightPct: src.freightPct,
            defaultMarkupPct: src.defaultMarkupPct,
            minMarginPct: src.minMarginPct,
            notes: src.notes ?? null,
            clientNotes: src.clientNotes ?? null,
            createdBy: p.userId,
          } as never)}
          returning id`;
        await deepCopyQuote(tx, src.id, q!.id, p.tenantId);
        await recomputeLines(tx, await getQuote(tx, q!.id));
        return quoteDetail(tx, p, q!.id);
      });
      return reply.status(201).send(detail);
    },
  );

  app.delete(
    '/quotes/:id',
    { schema: { tags: ['quotes'], summary: 'Delete a draft quote or template', params: IdParams } },
    async (req, reply) => {
      req.principal.require('quotes:write');
      await req.tx(async (tx) => {
        const q = await getQuote(tx, req.params.id, { lock: true });
        if (!q.isTemplate && q.status !== 'draft')
          throw conflict(`Only draft quotes can be deleted (this one is ${q.status})`);
        const [ordered] =
          await tx`select 1 from quoting.quote_lines where quote_id = ${q.id} and po_id is not null limit 1`;
        if (ordered) throw conflict('Quote has ordered lines');
        await tx`delete from quoting.quotes where id = ${q.id}`;
      });
      return reply.status(204).send();
    },
  );

  app.get(
    '/quotes/:id/activity',
    {
      schema: {
        tags: ['quotes'],
        summary: 'Field-level activity for the quote and its lines, cost requests and approvals',
        params: IdParams,
        querystring: ActivityQuery,
        response: { 200: z.array(ActivityEntry) },
      },
    },
    async (req) => {
      req.principal.require('quotes:read');
      const canCosts = req.principal.can('quotes:costs:read');
      return req.tx(async (tx) => {
        await getQuote(tx, req.params.id);
        const rows = await listActivity(tx, 'quote', req.params.id, {
          includeChildren: true,
          limit: req.query.limit,
        });
        if (canCosts) return rows;
        const hidden = new Set(['unitCost', 'freightUnit', 'extendedCost', 'marginPct', 'markupPct', 'cost']);
        return rows.map((r) => ({
          ...r,
          changes: Object.fromEntries(Object.entries(r.changes).filter(([k]) => !hidden.has(k))),
        }));
      });
    },
  );
}
