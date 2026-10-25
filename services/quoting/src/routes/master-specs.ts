import { PageQuery } from '@procure/domain';
import { type App, badRequest, must, type Tx, z } from '@procure/platform';
import { pageResult } from '../repo.js';
import {
  IdParams,
  MasterSpec,
  MasterSpecDetail,
  MasterSpecInput,
  MasterSpecPatch,
  Ok,
  pageOf,
  type Spec,
} from '../schemas.js';
import { specSelect } from './specs.js';

const masterSelect = (tx: Tx) => tx`
  m.id, m.name, m.category, m.description, m.notes, m.archived, m.created_at, m.updated_at,
  (select count(*)::int from quoting.specs s where s.master_spec_id = m.id) as spec_count`;

async function getMaster(tx: Tx, id: string) {
  const [m] = await tx<
    MasterSpec[]
  >`select ${masterSelect(tx)} from quoting.master_specs m where m.id = ${id}`;
  return must(m, 'Master spec');
}

export async function masterSpecRoutes(app: App) {
  app.get(
    '/master-specs',
    {
      schema: {
        tags: ['master-specs'],
        summary: 'List master specs (slots with competing vendor specs)',
        querystring: PageQuery.extend({ category: z.string().optional() }),
        response: { 200: pageOf(MasterSpec) },
      },
    },
    async (req) => {
      req.principal.require('specs:read');
      const { q, category, limit, offset } = req.query;
      return req.tx(async (tx) => {
        const where = tx`where not m.archived
          ${q ? tx`and m.name ilike ${`%${q}%`}` : tx``}
          ${category ? tx`and m.category = ${category}` : tx``}`;
        const [{ count }] =
          (await tx`select count(*)::int as count from quoting.master_specs m ${where}`) as unknown as [
            { count: number },
          ];
        const items = await tx<MasterSpec[]>`
          select ${masterSelect(tx)} from quoting.master_specs m ${where} order by m.name limit ${limit} offset ${offset}`;
        return pageResult(items, count, limit, offset);
      });
    },
  );

  app.post(
    '/master-specs',
    {
      schema: {
        tags: ['master-specs'],
        summary: 'Create a master spec',
        body: MasterSpecInput,
        response: { 201: MasterSpec },
      },
    },
    async (req, reply) => {
      req.principal.require('specs:write');
      const b = req.body;
      const m = await req.tx(async (tx) => {
        const [r] = await tx<{ id: string }[]>`
          insert into quoting.master_specs (tenant_id, name, category, description, notes)
          values (${req.principal.tenantId}, ${b.name}, ${b.category ?? null}, ${b.description ?? null}, ${b.notes ?? null})
          returning id`;
        return getMaster(tx, r!.id);
      });
      return reply.status(201).send(m);
    },
  );

  app.get(
    '/master-specs/:id',
    {
      schema: {
        tags: ['master-specs'],
        summary: 'Master spec with its competing specs',
        params: IdParams,
        response: { 200: MasterSpecDetail },
      },
    },
    async (req) => {
      req.principal.require('specs:read');
      return req.tx(async (tx) => {
        const m = await getMaster(tx, req.params.id);
        const specs = await tx<Spec[]>`
          select ${specSelect(tx)} from quoting.specs s where s.master_spec_id = ${m.id} order by s.cost nulls last, s.code`;
        return { ...m, specs };
      });
    },
  );

  app.patch(
    '/master-specs/:id',
    {
      schema: {
        tags: ['master-specs'],
        summary: 'Update a master spec',
        params: IdParams,
        body: MasterSpecPatch,
        response: { 200: MasterSpec },
      },
    },
    async (req) => {
      req.principal.require('specs:write');
      return req.tx(async (tx) => {
        await getMaster(tx, req.params.id);
        const sets = Object.fromEntries(Object.entries(req.body).filter(([, v]) => v !== undefined));
        if (Object.keys(sets).length)
          await tx`update quoting.master_specs set ${tx(sets as never)} where id = ${req.params.id}`;
        return getMaster(tx, req.params.id);
      });
    },
  );

  app.delete(
    '/master-specs/:id',
    {
      schema: {
        tags: ['master-specs'],
        summary: 'Delete a master spec (specs and quote lines are detached, not deleted)',
        params: IdParams,
      },
    },
    async (req, reply) => {
      req.principal.require('specs:write');
      await req.tx(async (tx) => {
        await getMaster(tx, req.params.id);
        await tx`delete from quoting.master_specs where id = ${req.params.id}`;
      });
      return reply.status(204).send();
    },
  );

  app.post(
    '/master-specs/:id/specs',
    {
      schema: {
        tags: ['master-specs'],
        summary: 'Assign specs to a master spec (existing quote lines of those specs join the slot)',
        params: IdParams,
        body: z.object({ specIds: z.array(z.uuid()).min(1).max(100) }),
        response: { 200: MasterSpecDetail },
      },
    },
    async (req) => {
      req.principal.require('specs:write');
      return req.tx(async (tx) => {
        const m = await getMaster(tx, req.params.id);
        const found = await tx<
          { id: string }[]
        >`select id from quoting.specs where id in ${tx(req.body.specIds)}`;
        if (found.length !== req.body.specIds.length) throw badRequest('Some specs were not found');
        await tx`update quoting.specs set master_spec_id = ${m.id} where id in ${tx(req.body.specIds)}`;
        await tx`update quoting.quote_lines set master_spec_id = ${m.id}
                 where spec_id in ${tx(req.body.specIds)} and master_spec_id is null and po_id is null`;
        const specs = await tx<Spec[]>`
          select ${specSelect(tx)} from quoting.specs s where s.master_spec_id = ${m.id} order by s.code`;
        return { ...(await getMaster(tx, m.id)), specs };
      });
    },
  );

  app.delete(
    '/master-specs/:id/specs/:specId',
    {
      schema: {
        tags: ['master-specs'],
        summary: 'Remove a spec from a master spec',
        params: z.object({ id: z.uuid(), specId: z.uuid() }),
        response: { 200: Ok },
      },
    },
    async (req) => {
      req.principal.require('specs:write');
      await req.tx(
        (tx) =>
          tx`update quoting.specs set master_spec_id = null where id = ${req.params.specId} and master_spec_id = ${req.params.id}`,
      );
      return { ok: true as const };
    },
  );
}
