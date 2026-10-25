import { page } from '@procure/domain';
import { type App, notFound, orderBy } from '@procure/platform';
import { getPo, requestEmitter } from '../core.js';
import { DEFAULT_PARTY, REQUIREMENT_LABELS } from '../domain/requirements.js';
import { afterRequirementsChanged, setRequirementStatus } from '../ops.js';
import {
  IdParams,
  PoReqParams,
  Requirement,
  RequirementBulkBody,
  RequirementCreateBody,
  RequirementPatchBody,
  RequirementRow,
  RequirementsQuery,
  z,
} from './_shared.js';

const TAGS = ['requirements'];

export async function requirementRoutes(app: App) {
  app.get(
    '/requirements',
    {
      schema: {
        tags: TAGS,
        summary: 'Cross-portfolio pre-order requirements (what must be done before production can start)',
        querystring: RequirementsQuery,
        response: { 200: page(RequirementRow) },
      },
    },
    async (req) => {
      req.principal.require('orders:read');
      const q = req.query;
      return req.tx(async (tx) => {
        const conds = [tx`p.status not in ('cancelled', 'closed')`];
        if (q.status?.length) conds.push(tx`r.status in ${tx(q.status)}`);
        if (q.kind?.length) conds.push(tx`r.kind in ${tx(q.kind)}`);
        if (q.party) conds.push(tx`r.party = ${q.party}`);
        if (q.projectId) conds.push(tx`p.project_id = ${q.projectId}`);
        if (q.poId) conds.push(tx`r.po_id = ${q.poId}`);
        if (q.dueBefore) conds.push(tx`coalesce(r.due_date, p.release_by_date) <= ${q.dueBefore}`);
        if (q.overdue)
          conds.push(
            tx`r.status in ('pending', 'submitted', 'rejected') and coalesce(r.due_date, p.release_by_date) < current_date`,
          );
        if (q.q) {
          const like = `%${q.q}%`;
          conds.push(tx`(p.number ilike ${like} or p.vendor_name ilike ${like} or p.project_name ilike ${like}
                         or r.label ilike ${like})`);
        }
        const where = conds.reduce((a, c) => tx`${a} and ${c}`);
        const rows = await tx<any[]>`
          select r.*, p.number as po_number, p.project_id, p.project_name, p.vendor_id, p.vendor_name, p.release_by_date,
                 coalesce(r.status in ('pending', 'submitted', 'rejected')
                  and coalesce(r.due_date, p.release_by_date) < current_date, false) as overdue,
                 count(*) over ()::int as total_count
          from orders.pre_order_requirements r join orders.purchase_orders p on p.id = r.po_id
          where ${where}
          order by ${orderBy(tx, q.sort, { due: 'coalesce(r.due_date, p.release_by_date)', po: 'p.number' }, 'due')},
                   p.number, r.sort
          limit ${q.limit} offset ${q.offset}`;
        return { items: rows, total: rows[0]?.totalCount ?? 0, limit: q.limit, offset: q.offset };
      });
    },
  );

  app.post(
    '/purchase-orders/:id/requirements',
    {
      schema: {
        tags: TAGS,
        summary: 'Add a pre-order requirement to a PO',
        params: IdParams,
        body: RequirementCreateBody,
        response: { 201: Requirement },
      },
    },
    async (req, reply) => {
      req.principal.require('orders:write');
      const em = requestEmitter(req);
      const r = await req.tx(async (tx) => {
        const po = await getPo(tx, req.params.id);
        const b = req.body;
        const [row] = await tx<any[]>`
          insert into orders.pre_order_requirements (tenant_id, po_id, kind, label, party, due_date, note, document_id, sort)
          values (${po.tenantId}, ${po.id}, ${b.kind}, ${b.label ?? REQUIREMENT_LABELS[b.kind]},
                  ${b.party ?? DEFAULT_PARTY[b.kind]}, ${b.dueDate ?? null}, ${b.note ?? null}, ${b.documentId ?? null},
                  (select coalesce(max(sort) + 1, 0) from orders.pre_order_requirements where po_id = ${po.id}))
          returning *`;
        await afterRequirementsChanged(tx, em, po.id);
        return row;
      });
      return reply.status(201).send(r);
    },
  );

  app.patch(
    '/purchase-orders/:id/requirements/:reqId',
    {
      schema: {
        tags: TAGS,
        summary: 'Update a requirement (status, document, due date, note)',
        params: PoReqParams,
        body: RequirementPatchBody,
        response: { 200: Requirement },
      },
    },
    async (req) => {
      const p = req.principal;
      p.require('orders:write');
      const em = requestEmitter(req);
      return req.tx(async (tx) => {
        const [cur] = await tx<any[]>`select * from orders.pre_order_requirements
                                      where id = ${req.params.reqId} and po_id = ${req.params.id}`;
        if (!cur) throw notFound('Requirement');
        const b = req.body;
        const sets = Object.fromEntries(
          Object.entries({
            label: b.label,
            dueDate: b.dueDate,
            note: b.note,
            documentId: b.documentId,
          }).filter(([, v]) => v !== undefined),
        );
        if (Object.keys(sets).length)
          await tx`update orders.pre_order_requirements set ${tx(sets as never)} where id = ${cur.id}`;
        if (b.status && b.status !== cur.status)
          await setRequirementStatus(tx, em, cur.id, b.status, { actorName: p.name });
        await afterRequirementsChanged(tx, em, cur.poId);
        const [row] = await tx<any[]>`select * from orders.pre_order_requirements where id = ${cur.id}`;
        return row;
      });
    },
  );

  app.delete(
    '/purchase-orders/:id/requirements/:reqId',
    {
      schema: {
        tags: TAGS,
        summary: 'Remove a requirement',
        params: PoReqParams,
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      req.principal.require('orders:write');
      const em = requestEmitter(req);
      await req.tx(async (tx) => {
        const del = await tx`delete from orders.pre_order_requirements
                             where id = ${req.params.reqId} and po_id = ${req.params.id} returning id`;
        if (!del.length) throw notFound('Requirement');
        await afterRequirementsChanged(tx, em, req.params.id);
      });
      return reply.status(204).send(null);
    },
  );

  app.post(
    '/requirements/bulk',
    {
      schema: {
        tags: TAGS,
        summary: 'Set the status of many requirements at once (e.g. waive or approve across POs)',
        body: RequirementBulkBody,
        response: { 200: z.object({ updated: z.number(), items: z.array(Requirement) }) },
      },
    },
    async (req) => {
      const p = req.principal;
      p.require('orders:write');
      const em = requestEmitter(req);
      return req.tx(async (tx) => {
        const found = await tx<{ id: string; poId: string; status: string }[]>`
          select id, po_id, status from orders.pre_order_requirements where id in ${tx(req.body.ids)} for update`;
        const missing = req.body.ids.filter((id) => !found.some((f) => f.id === id));
        if (missing.length) throw notFound(`Requirement(s) ${missing.join(', ')}`);
        const items = [];
        for (const r of found) {
          const row =
            r.status === req.body.status
              ? (await tx<any[]>`select * from orders.pre_order_requirements where id = ${r.id}`)[0]
              : await setRequirementStatus(tx, em, r.id, req.body.status, {
                  actorName: p.name,
                  note: req.body.note,
                });
          items.push(row);
        }
        for (const poId of new Set(found.map((f) => f.poId))) await afterRequirementsChanged(tx, em, poId);
        return { updated: found.filter((f) => f.status !== req.body.status).length, items };
      });
    },
  );
}
