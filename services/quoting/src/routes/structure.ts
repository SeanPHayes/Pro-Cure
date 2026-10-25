import { type App, badRequest, conflict, must, notFound, type Tx, z } from '@procure/platform';
import {
  assertEditable,
  descendantsOf,
  getQuote,
  invalidateApproval,
  locationTree,
  type QuoteRow,
  recomputeLines,
} from '../repo.js';
import {
  ChildParams,
  IdParams,
  Location,
  LocationDeleteQuery,
  LocationInput,
  LocationPatch,
  LocationTemplate,
  LocationTemplateFromQuote,
  LocationTemplateInput,
  RoomType,
  RoomTypeInput,
  RoomTypePatch,
  type TemplateNode,
} from '../schemas.js';

/** Recompute every per-room line on the quote (after a room count/type change). */
async function recomputePerRoom(tx: Tx, q: QuoteRow) {
  const ids = await tx<{ id: string }[]>`
    select id from quoting.quote_lines where quote_id = ${q.id} and qty_mode = 'per_room' and po_id is null`;
  return recomputeLines(tx, q, { lineIds: ids.map((r) => r.id) });
}

async function insertTree(
  tx: Tx,
  q: QuoteRow,
  nodes: TemplateNode[],
  parentId: string | null,
  startSort: number,
): Promise<number> {
  let created = 0;
  for (const [i, n] of nodes.entries()) {
    const [r] = await tx<{ id: string }[]>`
      insert into quoting.quote_locations (tenant_id, quote_id, parent_id, name, kind, sort)
      values (${q.tenantId}, ${q.id}, ${parentId}, ${n.name}, ${n.kind ?? (parentId ? 'room' : 'area')}, ${startSort + i})
      returning id`;
    created++;
    if (n.children?.length) created += await insertTree(tx, q, n.children, r!.id, 0);
  }
  return created;
}

const listLocations = async (tx: Tx, quoteId: string) => locationTree(tx, quoteId);

async function toTemplateTree(tx: Tx, quoteId: string): Promise<TemplateNode[]> {
  const locs = await locationTree(tx, quoteId);
  const build = (parent: string | null): TemplateNode[] =>
    locs
      .filter((l) => (l.parentId ?? null) === parent)
      .map((l) => {
        const children = build(l.id);
        return {
          name: l.name,
          kind: l.kind as TemplateNode['kind'],
          ...(children.length ? { children } : {}),
        };
      });
  return build(null);
}

export async function structureRoutes(app: App) {
  // ---------------------------------------------------------------- room types
  app.get(
    '/quotes/:id/room-types',
    {
      schema: {
        tags: ['quote-structure'],
        summary: 'Room types and counts',
        params: IdParams,
        response: { 200: z.array(RoomType) },
      },
    },
    async (req) => {
      req.principal.require('quotes:read');
      return req.tx(async (tx) => {
        await getQuote(tx, req.params.id);
        return tx<RoomType[]>`select id, code, name, count, sort from quoting.quote_room_types
                              where quote_id = ${req.params.id} order by sort, code` as never;
      });
    },
  );

  app.post(
    '/quotes/:id/room-types',
    {
      schema: {
        tags: ['quote-structure'],
        summary: 'Add a room type (e.g. "King" × 62)',
        params: IdParams,
        body: RoomTypeInput,
        response: { 201: RoomType },
      },
    },
    async (req, reply) => {
      req.principal.require('quotes:write');
      const rt = await req.tx(async (tx) => {
        const q = await getQuote(tx, req.params.id, { lock: true });
        assertEditable(q);
        const b = req.body;
        const [r] = await tx<RoomType[]>`
          insert into quoting.quote_room_types (tenant_id, quote_id, code, name, count, sort)
          values (${q.tenantId}, ${q.id}, ${b.code}, ${b.name}, ${b.count},
                  ${b.sort ?? tx`(select coalesce(max(sort), -1) + 1 from quoting.quote_room_types where quote_id = ${q.id})`})
          returning id, code, name, count, sort`;
        return r!;
      });
      return reply.status(201).send(rt);
    },
  );

  app.patch(
    '/quotes/:id/room-types/:childId',
    {
      schema: {
        tags: ['quote-structure'],
        summary: 'Update a room type; count changes recompute every per-room quantity on the quote',
        params: ChildParams,
        body: RoomTypePatch,
        response: { 200: RoomType.extend({ linesRecomputed: z.number().int() }) },
      },
    },
    async (req) => {
      req.principal.require('quotes:write');
      return req.tx(async (tx) => {
        const q = await getQuote(tx, req.params.id, { lock: true });
        assertEditable(q);
        const sets = Object.fromEntries(Object.entries(req.body).filter(([, v]) => v !== undefined));
        const [r] = Object.keys(sets).length
          ? await tx<RoomType[]>`update quoting.quote_room_types set ${tx(sets as never)}
                                 where id = ${req.params.childId} and quote_id = ${q.id} returning id, code, name, count, sort`
          : await tx<RoomType[]>`select id, code, name, count, sort from quoting.quote_room_types
                                 where id = ${req.params.childId} and quote_id = ${q.id}`;
        must(r, 'Room type');
        const { updated } = req.body.count !== undefined ? await recomputePerRoom(tx, q) : { updated: 0 };
        // Per-room quantity changes alter pricing → approvals no longer reflect the quote.
        if (updated) await invalidateApproval(tx, q);
        return { ...r!, linesRecomputed: updated };
      });
    },
  );

  app.delete(
    '/quotes/:id/room-types/:childId',
    {
      schema: {
        tags: ['quote-structure'],
        summary: 'Remove a room type (its per-room quantities are dropped from lines)',
        params: ChildParams,
      },
    },
    async (req, reply) => {
      req.principal.require('quotes:write');
      await req.tx(async (tx) => {
        const q = await getQuote(tx, req.params.id, { lock: true });
        assertEditable(q);
        const [del] =
          await tx`delete from quoting.quote_room_types where id = ${req.params.childId} and quote_id = ${q.id} returning id`;
        if (!del) throw notFound('Room type');
        await tx`update quoting.quote_lines set qty_per_room = qty_per_room - ${req.params.childId}::text
                 where quote_id = ${q.id} and qty_per_room ? ${req.params.childId}`;
        await recomputePerRoom(tx, q);
      });
      return reply.status(204).send();
    },
  );

  // ---------------------------------------------------------------- locations
  app.get(
    '/quotes/:id/locations',
    {
      schema: {
        tags: ['quote-structure'],
        summary: 'Location tree (depth-first, with depth and "Area > Room" path)',
        params: IdParams,
        response: { 200: z.array(Location) },
      },
    },
    async (req) => {
      req.principal.require('quotes:read');
      return req.tx(async (tx) => {
        await getQuote(tx, req.params.id);
        return listLocations(tx, req.params.id) as never;
      });
    },
  );

  app.post(
    '/quotes/:id/locations',
    {
      schema: {
        tags: ['quote-structure'],
        summary: 'Add a location (area, or sub-area under parentId)',
        params: IdParams,
        body: LocationInput,
        response: { 201: Location },
      },
    },
    async (req, reply) => {
      req.principal.require('quotes:write');
      const loc = await req.tx(async (tx) => {
        const q = await getQuote(tx, req.params.id, { lock: true });
        assertEditable(q);
        const b = req.body;
        if (b.parentId) {
          const [par] =
            await tx`select 1 from quoting.quote_locations where id = ${b.parentId} and quote_id = ${q.id}`;
          if (!par) throw badRequest('parentId is not a location of this quote');
        }
        const [r] = await tx<{ id: string }[]>`
          insert into quoting.quote_locations (tenant_id, quote_id, parent_id, name, kind, sort)
          values (${q.tenantId}, ${q.id}, ${b.parentId ?? null}, ${b.name}, ${b.kind},
                  ${
                    b.sort ??
                    tx`(select coalesce(max(sort), -1) + 1 from quoting.quote_locations
                                  where quote_id = ${q.id} and parent_id is not distinct from ${b.parentId ?? null}::uuid)`
                  })
          returning id`;
        return (await listLocations(tx, q.id)).find((l) => l.id === r!.id)!;
      });
      return reply.status(201).send(loc as never);
    },
  );

  app.patch(
    '/quotes/:id/locations/:childId',
    {
      schema: {
        tags: ['quote-structure'],
        summary: 'Rename, move (parentId) or re-sort a location',
        params: ChildParams,
        body: LocationPatch,
        response: { 200: Location },
      },
    },
    async (req) => {
      req.principal.require('quotes:write');
      return req.tx(async (tx) => {
        const q = await getQuote(tx, req.params.id, { lock: true });
        assertEditable(q);
        const locs = await listLocations(tx, q.id);
        const me = locs.find((l) => l.id === req.params.childId);
        if (!me) throw notFound('Location');
        const b = req.body;
        if (b.parentId) {
          if (!locs.some((l) => l.id === b.parentId))
            throw badRequest('parentId is not a location of this quote');
          if (descendantsOf(me.id, locs).has(b.parentId))
            throw conflict('A location cannot be moved under itself');
        }
        const sets = Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined));
        if (Object.keys(sets).length)
          await tx`update quoting.quote_locations set ${tx(sets as never)} where id = ${me.id}`;
        return (await listLocations(tx, q.id)).find((l) => l.id === me.id)! as never;
      });
    },
  );

  app.delete(
    '/quotes/:id/locations/:childId',
    {
      schema: {
        tags: ['quote-structure'],
        summary: 'Delete a location and its sub-locations; lines are moved to moveLinesTo or unassigned',
        params: ChildParams,
        querystring: LocationDeleteQuery,
      },
    },
    async (req, reply) => {
      req.principal.require('quotes:write');
      await req.tx(async (tx) => {
        const q = await getQuote(tx, req.params.id, { lock: true });
        assertEditable(q);
        const locs = await listLocations(tx, q.id);
        if (!locs.some((l) => l.id === req.params.childId)) throw notFound('Location');
        const subtree = [...descendantsOf(req.params.childId, locs)];
        const target = req.query.moveLinesTo ?? null;
        if (target && (subtree.includes(target) || !locs.some((l) => l.id === target)))
          throw badRequest('moveLinesTo must be another location of this quote');
        await tx`update quoting.quote_lines set location_id = ${target} where quote_id = ${q.id} and location_id in ${tx(subtree)}`;
        await tx`delete from quoting.quote_locations where id = ${req.params.childId}`;
      });
      return reply.status(204).send();
    },
  );

  app.post(
    '/quotes/:id/locations/reorder',
    {
      schema: {
        tags: ['quote-structure'],
        summary: 'Set sibling order: ids in the desired order under the same parent',
        params: IdParams,
        body: z.object({ ids: z.array(z.uuid()).min(1).max(500) }),
        response: { 200: z.array(Location) },
      },
    },
    async (req) => {
      req.principal.require('quotes:write');
      return req.tx(async (tx) => {
        const q = await getQuote(tx, req.params.id, { lock: true });
        assertEditable(q);
        for (const [i, id] of req.body.ids.entries())
          await tx`update quoting.quote_locations set sort = ${i} where id = ${id} and quote_id = ${q.id}`;
        return listLocations(tx, q.id) as never;
      });
    },
  );

  app.post(
    '/quotes/:id/locations/apply-template',
    {
      schema: {
        tags: ['quote-structure'],
        summary: 'Append a saved location tree (e.g. "Select-service prototype") to the quote',
        params: IdParams,
        body: z.object({ locationTemplateId: z.uuid(), parentId: z.uuid().nullable().optional() }),
        response: { 200: z.object({ created: z.number().int(), locations: z.array(Location) }) },
      },
    },
    async (req) => {
      req.principal.require('quotes:write');
      return req.tx(async (tx) => {
        const q = await getQuote(tx, req.params.id, { lock: true });
        assertEditable(q);
        const [t] = await tx<{ tree: TemplateNode[] }[]>`
          select tree from quoting.location_templates where id = ${req.body.locationTemplateId}`;
        if (!t) throw notFound('Location template');
        const parentId = req.body.parentId ?? null;
        const [{ s }] = (await tx`select coalesce(max(sort), -1) + 1 as s from quoting.quote_locations
                                  where quote_id = ${q.id} and parent_id is not distinct from ${parentId}::uuid`) as unknown as [
          { s: number },
        ];
        const created = await insertTree(tx, q, t.tree ?? [], parentId, s);
        return { created, locations: (await listLocations(tx, q.id)) as never };
      });
    },
  );

  // ---------------------------------------------------------------- location templates
  app.get(
    '/location-templates',
    {
      schema: {
        tags: ['location-templates'],
        summary: 'Saved location trees',
        response: { 200: z.array(LocationTemplate) },
      },
    },
    async (req) => {
      req.principal.require('quotes:read');
      return req.tx((tx) => tx`select * from quoting.location_templates order by name` as never);
    },
  );

  app.post(
    '/location-templates',
    {
      schema: {
        tags: ['location-templates'],
        summary: 'Save a location tree, given explicitly or captured from an existing quote',
        body: z.union([LocationTemplateInput, LocationTemplateFromQuote]),
        response: { 201: LocationTemplate },
      },
    },
    async (req, reply) => {
      req.principal.require('templates:write');
      const t = await req.tx(async (tx) => {
        const b = req.body;
        let tree = 'tree' in b ? b.tree : null;
        if ('quoteId' in b) {
          await getQuote(tx, b.quoteId);
          tree = await toTemplateTree(tx, b.quoteId);
        }
        const [r] = await tx`
          insert into quoting.location_templates (tenant_id, name, description, tree)
          values (${req.principal.tenantId}, ${b.name}, ${b.description ?? null}, ${tx.json(tree as never)}) returning *`;
        return r!;
      });
      return reply.status(201).send(t as never);
    },
  );

  app.get(
    '/location-templates/:id',
    {
      schema: {
        tags: ['location-templates'],
        summary: 'A saved location tree',
        params: IdParams,
        response: { 200: LocationTemplate },
      },
    },
    async (req) => {
      req.principal.require('quotes:read');
      return req.tx(async (tx) => {
        const [r] = await tx`select * from quoting.location_templates where id = ${req.params.id}`;
        return must(r, 'Location template') as never;
      });
    },
  );

  app.patch(
    '/location-templates/:id',
    {
      schema: {
        tags: ['location-templates'],
        summary: 'Update a saved location tree',
        params: IdParams,
        body: LocationTemplateInput.partial(),
        response: { 200: LocationTemplate },
      },
    },
    async (req) => {
      req.principal.require('templates:write');
      return req.tx(async (tx) => {
        const b = req.body;
        const sets: Record<string, unknown> = {};
        if (b.name !== undefined) sets.name = b.name;
        if (b.description !== undefined) sets.description = b.description;
        if (b.tree !== undefined) sets.tree = tx.json(b.tree as never);
        const [r] = Object.keys(sets).length
          ? await tx`update quoting.location_templates set ${tx(sets as never)} where id = ${req.params.id} returning *`
          : await tx`select * from quoting.location_templates where id = ${req.params.id}`;
        return must(r, 'Location template') as never;
      });
    },
  );

  app.delete(
    '/location-templates/:id',
    { schema: { tags: ['location-templates'], summary: 'Delete a saved location tree', params: IdParams } },
    async (req, reply) => {
      req.principal.require('templates:write');
      await req.tx(async (tx) => {
        const [r] = await tx`delete from quoting.location_templates where id = ${req.params.id} returning id`;
        must(r, 'Location template');
      });
      return reply.status(204).send();
    },
  );
}
