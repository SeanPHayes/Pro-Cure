import {
  type App,
  badRequest,
  conflict,
  notFound,
  type Principal,
  type Tx,
  unprocessable,
  z,
} from '@procure/platform';
import { matchRule } from '../domain/merchandising.js';
import { computeQuantity, handingError } from '../domain/quantity.js';
import {
  assertEditable,
  descendantsOf,
  getQuote,
  invalidateApproval,
  type LineRow,
  locationTree,
  pageResult,
  parentMap,
  type QuoteRow,
  recomputeLines,
  redactLine,
} from '../repo.js';
import {
  AddAlternatesBody,
  BulkLinePatch,
  IdParams,
  Line,
  LineDeleteBody,
  LineListQuery,
  LineParams,
  LinePatch,
  LinesCreate,
  pageOf,
} from '../schemas.js';

type LinePatchT = z.infer<typeof LinePatch> & { clearPriceOverride?: boolean };

/** Fields that only annotate a line; allowed on quotes past the editable stage. */
const ANNOTATION_KEYS = new Set(['notes', 'readyToOrder']);
/** Fields that change price/quantity (invalidate internal approval). */
const PRICING_KEYS = new Set([
  'qtyMode',
  'qtyFixed',
  'qtyPerRoom',
  'atticStockPct',
  'unitCost',
  'freightUnit',
  'markupPct',
  'unitPrice',
  'isSelected',
  'clearPriceOverride',
  'costExpiresAt',
]);

export async function getLine(tx: Tx, quoteId: string, lineId: string) {
  const [l] = await tx<
    LineRow[]
  >`select * from quoting.quote_lines where id = ${lineId} and quote_id = ${quoteId}`;
  if (!l) throw notFound('Quote line');
  return l;
}

const linesByIds = (tx: Tx, ids: string[]) =>
  ids.length
    ? tx<Line[]>`select * from quoting.quote_lines where id in ${tx(ids)} order by sort, code`
    : Promise.resolve([] as Line[]);

/** Default markup for a line: saved quote markup rules (most specific), else the quote default. */
export async function defaultMarkupResolver(tx: Tx, q: QuoteRow) {
  const rules = await tx<{ category: string | null; locationId: string | null; markupPct: number }[]>`
    select category, location_id, markup_pct from quoting.quote_markup_rules where quote_id = ${q.id}`;
  const parents = parentMap(await locationTree(tx, q.id));
  return (category: string, locationId: string | null) =>
    matchRule({ category, locationId }, rules, parents)?.markupPct ?? q.defaultMarkupPct;
}

/**
 * Validate and write a patch to one line. Returns true when pricing-relevant fields changed.
 * Caller recomputes derived fields afterwards.
 */
export async function applyLinePatch(tx: Tx, q: QuoteRow, l: LineRow, b: LinePatchT): Promise<boolean> {
  const keys = Object.entries(b)
    .filter(([, v]) => v !== undefined)
    .map(([k]) => k);
  if (!keys.length) return false;
  if (keys.some((k) => !ANNOTATION_KEYS.has(k))) {
    assertEditable(q);
    if (l.poId) throw conflict(`Line ${l.code} is on PO ${l.poNumber ?? l.poId} and cannot be changed`);
  }

  const sets: Record<string, unknown> = {};
  const copy = [
    'locationId',
    'qtyMode',
    'qtyFixed',
    'atticStockPct',
    'unit',
    'unitCost',
    'costExpiresAt',
    'leadTimeWeeks',
    'freightUnit',
    'markupPct',
    'name',
    'description',
    'finish',
    'dimensions',
    'materials',
    'notes',
    'clientNotes',
    'isSelected',
    'sort',
  ] as const;
  for (const k of copy) if (b[k] !== undefined) sets[k] = b[k];
  if (b.qtyPerRoom !== undefined) {
    const rts = await tx<{ id: string }[]>`select id from quoting.quote_room_types where quote_id = ${q.id}`;
    const known = new Set(rts.map((r) => r.id));
    const unknown = Object.keys(b.qtyPerRoom).filter((k) => !known.has(k));
    if (unknown.length) throw badRequest('qtyPerRoom references room types not on this quote', { unknown });
    sets.qtyPerRoom = tx.json(b.qtyPerRoom as never);
    if (b.qtyMode === undefined) sets.qtyMode = 'per_room';
  }
  if (b.locationId) {
    const [loc] =
      await tx`select 1 from quoting.quote_locations where id = ${b.locationId} and quote_id = ${q.id}`;
    if (!loc) throw badRequest('locationId is not a location of this quote');
  }
  if (b.unitPrice !== undefined) {
    sets.unitPrice = b.unitPrice;
    sets.priceOverride = b.unitPrice !== null;
  }
  if (b.clearPriceOverride) sets.priceOverride = false;
  if (b.markupPct !== undefined && b.unitPrice === undefined) sets.priceOverride = false;

  // Quantity + handing validation against the would-be quantity.
  const next = { ...l, ...sets, qtyPerRoom: b.qtyPerRoom ?? l.qtyPerRoom } as LineRow;
  const rooms = await tx<
    { id: string; count: number }[]
  >`select id, count from quoting.quote_room_types where quote_id = ${q.id}`;
  const { quantity } = computeQuantity(next, rooms);
  const handing = b.handing !== undefined ? b.handing : null;
  if (b.handing !== undefined) {
    const err = handingError(handing, quantity);
    if (err) throw unprocessable(err, { quantity, handing });
    sets.handing = handing ? tx.json(handing as never) : null;
  } else if (
    l.handing &&
    quantity !== l.quantity &&
    (b.qtyFixed !== undefined || b.qtyPerRoom !== undefined)
  ) {
    // Direct quantity edits must restate the split (room-count cascades rescale automatically).
    const err = handingError(l.handing, quantity);
    if (err)
      throw unprocessable(`${err}. Send handing with the new quantity.`, { quantity, handing: l.handing });
  }

  if (b.readyToOrder !== undefined && b.readyToOrder !== l.readyToOrder) {
    if (b.readyToOrder) {
      if (q.status !== 'client_approved' && q.status !== 'ordered')
        throw conflict('Lines can be released for ordering only after the client approves the quote');
      const selected = (next.isSelected as boolean) ?? l.isSelected;
      if (!selected) throw unprocessable(`Line ${l.code} is not the selected option`);
      if (l.unitCost === null || l.unitPrice === null)
        throw unprocessable(`Line ${l.code} needs a cost and a price before ordering`);
      if (!(quantity > 0)) throw unprocessable(`Line ${l.code} has no quantity to order`);
    } else if (l.poId) throw conflict(`Line ${l.code} is already ordered`);
    sets.readyToOrder = b.readyToOrder;
  }

  if (Object.keys(sets).length)
    await tx`update quoting.quote_lines set ${tx(sets as never)} where id = ${l.id}`;
  return keys.some((k) => PRICING_KEYS.has(k));
}

async function snapshotSpecs(
  tx: Tx,
  q: QuoteRow,
  specIds: string[],
  opts: {
    locationId: string | null;
    qtyMode?: 'fixed' | 'per_room';
    qtyFixed?: number;
    qtyPerRoom?: Record<string, number>;
    atticStockPct?: number;
    markupPct?: number;
    masterSpecId?: string | null;
    isSelected?: boolean;
  },
) {
  const specs = await tx<Record<string, any>[]>`select * from quoting.specs where id in ${tx(specIds)}`;
  if (specs.length !== new Set(specIds).size) throw badRequest('Some specs were not found');
  const byId = new Map(specs.map((s) => [s.id as string, s]));
  const markup = await defaultMarkupResolver(tx, q);
  const [{ s: start }] =
    (await tx`select coalesce(max(sort), -1) + 1 as s from quoting.quote_lines where quote_id = ${q.id}`) as unknown as [
      { s: number },
    ];
  const perRoom = opts.qtyPerRoom ?? {};
  const mode = opts.qtyMode ?? (Object.keys(perRoom).length ? 'per_room' : 'fixed');
  const ids: string[] = [];
  for (const [i, sid] of specIds.entries()) {
    const s = byId.get(sid)!;
    const [r] = await tx<{ id: string }[]>`
      insert into quoting.quote_lines ${tx({
        tenantId: q.tenantId,
        quoteId: q.id,
        locationId: opts.locationId,
        specId: s.id,
        masterSpecId: opts.masterSpecId !== undefined ? opts.masterSpecId : (s.masterSpecId ?? null),
        isSelected: opts.isSelected ?? true,
        code: s.code,
        name: s.name,
        description: s.description,
        category: s.category,
        vendorId: s.vendorId,
        vendorName: s.vendorName,
        vendorSku: s.vendorSku,
        finish: s.finish,
        dimensions: s.dimensions,
        materials: s.materials,
        imageDocumentId: s.imageDocumentId,
        qtyMode: mode,
        qtyFixed: opts.qtyFixed ?? (mode === 'fixed' ? 1 : 0),
        qtyPerRoom: tx.json(perRoom as never),
        atticStockPct: opts.atticStockPct ?? 0,
        unit: s.unit,
        unitCost: s.cost,
        costExpiresAt: s.costExpiresAt,
        leadTimeWeeks: s.leadTimeWeeks,
        freightUnit: s.freightUnit,
        markupPct: opts.markupPct ?? markup(s.category, opts.locationId),
        sort: start + i,
      } as never)}
      returning id`;
    ids.push(r!.id);
  }
  return ids;
}

export async function lineRoutes(app: App) {
  const out = (p: Principal, rows: Line[]) => rows.map((l) => redactLine(p, l));

  app.get(
    '/quotes/:id/lines',
    {
      schema: {
        tags: ['quote-lines'],
        summary: 'Quote lines with filters (location subtree, category, vendor, flag, text)',
        params: IdParams,
        querystring: LineListQuery,
        response: { 200: pageOf(Line) },
      },
    },
    async (req) => {
      const p = req.principal;
      p.require('quotes:read');
      const {
        locationId,
        category,
        vendorId,
        masterSpecId,
        flag,
        q,
        selectedOnly,
        includeChildren,
        limit,
        offset,
      } = req.query;
      return req.tx(async (tx) => {
        await getQuote(tx, req.params.id);
        let locIds: string[] | null = null;
        if (locationId) {
          locIds = includeChildren
            ? [...descendantsOf(locationId, await locationTree(tx, req.params.id))]
            : [locationId];
        }
        const where = tx`where l.quote_id = ${req.params.id}
          ${locIds ? tx`and l.location_id in ${tx(locIds)}` : tx``}
          ${category ? tx`and l.category = ${category}` : tx``}
          ${vendorId ? tx`and l.vendor_id = ${vendorId}` : tx``}
          ${masterSpecId ? tx`and l.master_spec_id = ${masterSpecId}` : tx``}
          ${flag ? tx`and ${flag} = any(l.flags)` : tx``}
          ${selectedOnly ? tx`and l.is_selected` : tx``}
          ${q ? tx`and (l.code ilike ${`%${q}%`} or l.name ilike ${`%${q}%`} or l.vendor_name ilike ${`%${q}%`})` : tx``}`;
        const [{ count }] =
          (await tx`select count(*)::int as count from quoting.quote_lines l ${where}`) as unknown as [
            { count: number },
          ];
        const items = await tx<Line[]>`
          select l.* from quoting.quote_lines l ${where} order by l.sort, l.code limit ${limit} offset ${offset}`;
        return pageResult(out(p, items), count, limit, offset);
      });
    },
  );

  app.post(
    '/quotes/:id/lines',
    {
      schema: {
        tags: ['quote-lines'],
        summary:
          'Add specs to a location (each line is a snapshot of the spec, priced at the applicable markup)',
        params: IdParams,
        body: LinesCreate,
        response: { 201: z.array(Line) },
      },
    },
    async (req, reply) => {
      const p = req.principal;
      p.require('quotes:write');
      const b = req.body;
      const rows = await req.tx(async (tx) => {
        const q = await getQuote(tx, req.params.id, { lock: true });
        assertEditable(q);
        if (b.locationId) {
          const [loc] =
            await tx`select 1 from quoting.quote_locations where id = ${b.locationId} and quote_id = ${q.id}`;
          if (!loc) throw badRequest('locationId is not a location of this quote');
        }
        if (b.qtyPerRoom) {
          const rts = await tx<
            { id: string }[]
          >`select id from quoting.quote_room_types where quote_id = ${q.id}`;
          const known = new Set(rts.map((r) => r.id));
          if (Object.keys(b.qtyPerRoom).some((k) => !known.has(k)))
            throw badRequest('qtyPerRoom references room types not on this quote');
        }
        const ids = await snapshotSpecs(tx, q, b.specIds, { ...b, locationId: b.locationId ?? null });
        await recomputeLines(tx, q, { lineIds: ids });
        await invalidateApproval(tx, q);
        return linesByIds(tx, ids);
      });
      return reply.status(201).send(out(p, rows));
    },
  );

  app.patch(
    '/quotes/:id/lines/:lineId',
    {
      schema: {
        tags: ['quote-lines'],
        summary:
          'Edit a line: quantities, handing, attic stock, cost, markup, price override, location, notes, ready-to-order',
        params: LineParams,
        body: LinePatch,
        response: { 200: Line },
      },
    },
    async (req) => {
      const p = req.principal;
      const b = req.body;
      const onlyReady = Object.entries(b).every(([k, v]) => v === undefined || k === 'readyToOrder');
      if (onlyReady) {
        if (!p.can('quotes:write') && !p.can('orders:write')) p.require('quotes:write');
      } else p.require('quotes:write');
      const touchesCost = ['unitCost', 'freightUnit', 'markupPct', 'unitPrice', 'costExpiresAt'].some(
        (k) => (b as Record<string, unknown>)[k] !== undefined,
      );
      if (touchesCost) p.require('quotes:costs:read');
      return req.tx(async (tx) => {
        const q = await getQuote(tx, req.params.id, { lock: true });
        const l = await getLine(tx, q.id, req.params.lineId);
        const pricing = await applyLinePatch(tx, q, l, b);
        await recomputeLines(tx, q, { lineIds: [l.id] });
        if (pricing) await invalidateApproval(tx, q);
        return redactLine(p, (await linesByIds(tx, [l.id]))[0]!);
      });
    },
  );

  app.post(
    '/quotes/:id/lines/bulk',
    {
      schema: {
        tags: ['quote-lines'],
        summary: 'Apply one patch to many lines (markup, attic stock, move location, ready-to-order, select)',
        params: IdParams,
        body: BulkLinePatch,
        response: { 200: z.object({ updated: z.number().int(), lines: z.array(Line) }) },
      },
    },
    async (req) => {
      const p = req.principal;
      const keys = Object.entries(req.body.patch)
        .filter(([, v]) => v !== undefined)
        .map(([k]) => k);
      if (keys.length === 1 && keys[0] === 'readyToOrder') {
        if (!p.can('quotes:write') && !p.can('orders:write')) p.require('quotes:write');
      } else p.require('quotes:write');
      if (keys.some((k) => ['markupPct', 'freightUnit', 'clearPriceOverride'].includes(k)))
        p.require('quotes:costs:read');
      return req.tx(async (tx) => {
        const q = await getQuote(tx, req.params.id, { lock: true });
        const lines = await tx<LineRow[]>`
          select * from quoting.quote_lines where quote_id = ${q.id} and id in ${tx(req.body.lineIds)}`;
        if (lines.length !== new Set(req.body.lineIds).size)
          throw badRequest('Some lines are not on this quote');
        let pricing = false;
        for (const l of lines) pricing = (await applyLinePatch(tx, q, l, req.body.patch)) || pricing;
        await recomputeLines(tx, q, { lineIds: lines.map((l) => l.id) });
        if (pricing) await invalidateApproval(tx, q);
        return {
          updated: lines.length,
          lines: out(
            p,
            await linesByIds(
              tx,
              lines.map((l) => l.id),
            ),
          ),
        };
      });
    },
  );

  const deleteLines = async (tx: Tx, q: QuoteRow, ids: string[]) => {
    assertEditable(q);
    const rows = await tx<{ id: string; code: string; poId: string | null }[]>`
      select id, code, po_id from quoting.quote_lines where quote_id = ${q.id} and id in ${tx(ids)}`;
    if (rows.length !== new Set(ids).size) throw notFound('Quote line');
    const ordered = rows.filter((r) => r.poId);
    if (ordered.length)
      throw conflict('Ordered lines cannot be deleted', { codes: ordered.map((r) => r.code) });
    await tx`delete from quoting.quote_lines where id in ${tx(ids)}`;
    await invalidateApproval(tx, q);
  };

  app.delete(
    '/quotes/:id/lines/:lineId',
    { schema: { tags: ['quote-lines'], summary: 'Delete a line (not once ordered)', params: LineParams } },
    async (req, reply) => {
      req.principal.require('quotes:write');
      await req.tx(async (tx) =>
        deleteLines(tx, await getQuote(tx, req.params.id, { lock: true }), [req.params.lineId]),
      );
      return reply.status(204).send();
    },
  );

  app.post(
    '/quotes/:id/lines/delete',
    {
      schema: {
        tags: ['quote-lines'],
        summary: 'Delete several lines (none may be ordered)',
        params: IdParams,
        body: LineDeleteBody,
        response: { 200: z.object({ deleted: z.number().int() }) },
      },
    },
    async (req) => {
      req.principal.require('quotes:write');
      await req.tx(async (tx) =>
        deleteLines(tx, await getQuote(tx, req.params.id, { lock: true }), req.body.lineIds),
      );
      return { deleted: new Set(req.body.lineIds).size };
    },
  );

  app.post(
    '/quotes/:id/lines/:lineId/sync-from-spec',
    {
      schema: {
        tags: ['quote-lines'],
        summary: 'Re-copy description, finish, dimensions, vendor and cost from the library spec',
        params: LineParams,
        response: { 200: Line },
      },
    },
    async (req) => {
      const p = req.principal;
      p.require('quotes:write');
      return req.tx(async (tx) => {
        const q = await getQuote(tx, req.params.id, { lock: true });
        assertEditable(q);
        const l = await getLine(tx, q.id, req.params.lineId);
        if (l.poId) throw conflict('Ordered lines cannot be re-synced');
        if (!l.specId) throw unprocessable('Line is not linked to a library spec');
        const [s] = await tx<Record<string, any>[]>`select * from quoting.specs where id = ${l.specId}`;
        if (!s) throw unprocessable('The library spec no longer exists');
        await tx`update quoting.quote_lines set ${tx({
          code: s.code,
          name: s.name,
          description: s.description,
          category: s.category,
          vendorId: s.vendorId,
          vendorName: s.vendorName,
          vendorSku: s.vendorSku,
          finish: s.finish,
          dimensions: s.dimensions,
          materials: s.materials,
          imageDocumentId: s.imageDocumentId,
          unit: s.unit,
          unitCost: s.cost,
          costExpiresAt: s.costExpiresAt,
          leadTimeWeeks: s.leadTimeWeeks,
          freightUnit: s.freightUnit,
        } as never)} where id = ${l.id}`;
        await recomputeLines(tx, q, { lineIds: [l.id] });
        await invalidateApproval(tx, q);
        return redactLine(p, (await linesByIds(tx, [l.id]))[0]!);
      });
    },
  );

  app.post(
    '/quotes/:id/lines/:lineId/alternates',
    {
      schema: {
        tags: ['price-matrix'],
        summary:
          'Add competing specs (other vendors) for a line. Creates the master spec slot if needed; alternates are unselected.',
        params: LineParams,
        body: AddAlternatesBody.omit({ lineId: true }),
        response: { 201: z.array(Line) },
      },
    },
    async (req, reply) => {
      const p = req.principal;
      p.require('quotes:write');
      const rows = await req.tx(async (tx) => {
        const q = await getQuote(tx, req.params.id, { lock: true });
        assertEditable(q);
        const l = await getLine(tx, q.id, req.params.lineId);
        let masterId = l.masterSpecId;
        if (!masterId) {
          const [m] = await tx<{ id: string }[]>`
            insert into quoting.master_specs (tenant_id, name, category) values (${q.tenantId}, ${l.name}, ${l.category}) returning id`;
          masterId = m!.id;
          await tx`update quoting.quote_lines set master_spec_id = ${masterId} where id = ${l.id}`;
          if (l.specId)
            await tx`update quoting.specs set master_spec_id = ${masterId} where id = ${l.specId} and master_spec_id is null`;
        }
        await tx`update quoting.specs set master_spec_id = ${masterId} where id in ${tx(req.body.specIds)} and master_spec_id is null`;
        const ids = await snapshotSpecs(tx, q, req.body.specIds, {
          locationId: l.locationId,
          qtyMode: l.qtyMode,
          qtyFixed: l.qtyFixed,
          qtyPerRoom: l.qtyPerRoom,
          atticStockPct: l.atticStockPct,
          markupPct: l.markupPct,
          masterSpecId: masterId,
          isSelected: false,
        });
        await recomputeLines(tx, q, { lineIds: ids });
        return linesByIds(tx, ids);
      });
      return reply.status(201).send(out(p, rows));
    },
  );
}
