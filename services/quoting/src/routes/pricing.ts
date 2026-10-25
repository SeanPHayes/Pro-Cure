import { round2, round4 } from '@procure/domain';
import { type App, badRequest, type Tx, z } from '@procure/platform';
import { merchandise } from '../domain/merchandising.js';
import { landedUnitCost } from '../domain/pricing.js';
import { groupTotals, quoteTotals, type TotalsLine } from '../domain/totals.js';
import {
  assertEditable,
  getQuote,
  invalidateApproval,
  type LineRow,
  locationTree,
  parentMap,
  type QuoteRow,
  recomputeLines,
  totalsFor,
} from '../repo.js';
import {
  IdParams,
  MerchandiseBody,
  MerchandiseResult,
  PriceMatrix,
  PriceMatrixSelect,
  RefreshCostsResult,
  Summary,
} from '../schemas.js';

/** Pull the latest library costs into not-ordered lines. Returns changed lines. */
export async function refreshCosts(tx: Tx, q: QuoteRow, lineIds?: string[]) {
  const rows = await tx<
    {
      lineId: string;
      code: string;
      unitCost: number | null;
      costExpiresAt: string | null;
      leadTimeWeeks: number | null;
      freightUnit: number | null;
      sCost: number | null;
      sExpires: string | null;
      sLead: number | null;
      sFreight: number | null;
    }[]
  >`
    select l.id as line_id, l.code, l.unit_cost, l.cost_expires_at, l.lead_time_weeks, l.freight_unit,
           s.cost as s_cost, s.cost_expires_at as s_expires, s.lead_time_weeks as s_lead, s.freight_unit as s_freight
    from quoting.quote_lines l join quoting.specs s on s.id = l.spec_id
    where l.quote_id = ${q.id} and l.po_id is null
      ${lineIds ? tx`and l.id in ${tx(lineIds.length ? lineIds : ['00000000-0000-0000-0000-000000000000'])}` : tx``}`;
  const changed: z.infer<typeof RefreshCostsResult>['changed'] = [];
  for (const r of rows) {
    if (r.sCost === null) continue; // never wipe a quoted cost because the library lacks one
    if (
      r.sCost === r.unitCost &&
      r.sExpires === r.costExpiresAt &&
      r.sLead === r.leadTimeWeeks &&
      r.sFreight === r.freightUnit
    )
      continue;
    await tx`update quoting.quote_lines set unit_cost = ${r.sCost}, cost_expires_at = ${r.sExpires},
               lead_time_weeks = coalesce(${r.sLead}, lead_time_weeks), freight_unit = coalesce(${r.sFreight}, freight_unit)
             where id = ${r.lineId}`;
    if (r.sCost !== r.unitCost || r.sExpires !== r.costExpiresAt)
      changed.push({
        lineId: r.lineId,
        code: r.code,
        from: { unitCost: r.unitCost, costExpiresAt: r.costExpiresAt },
        to: { unitCost: r.sCost, costExpiresAt: r.sExpires },
      });
  }
  if (rows.length) await recomputeLines(tx, q, { lineIds: rows.map((r) => r.lineId) });
  return changed;
}

export async function pricingRoutes(app: App) {
  app.post(
    '/quotes/:id/refresh-costs',
    {
      schema: {
        tags: ['pricing'],
        summary: 'Pull the latest library spec costs into every not-ordered line',
        params: IdParams,
        body: z.object({ lineIds: z.array(z.uuid()).optional() }).optional(),
        response: { 200: RefreshCostsResult },
      },
    },
    async (req) => {
      req.principal.require('quotes:write', 'quotes:costs:read');
      return req.tx(async (tx) => {
        const q = await getQuote(tx, req.params.id, { lock: true });
        assertEditable(q);
        const changed = await refreshCosts(tx, q, req.body?.lineIds);
        if (changed.length) await invalidateApproval(tx, q);
        return { changed, totals: await totalsFor(tx, q) };
      });
    },
  );

  app.post(
    '/quotes/:id/merchandise',
    {
      schema: {
        tags: ['pricing'],
        summary:
          'Apply markups by category and/or location (most specific rule wins) and optionally solve the rest for a target margin',
        params: IdParams,
        body: MerchandiseBody,
        response: { 200: MerchandiseResult },
      },
    },
    async (req) => {
      req.principal.require('quotes:write', 'quotes:costs:read');
      const b = req.body;
      return req.tx(async (tx) => {
        const q = await getQuote(tx, req.params.id, { lock: true });
        assertEditable(q);
        const locs = await locationTree(tx, q.id);
        const known = new Set(locs.map((l) => l.id));
        for (const r of b.rules)
          if (r.locationId && !known.has(r.locationId))
            throw badRequest('A rule references a location not on this quote');
        const lines = await tx<
          LineRow[]
        >`select * from quoting.quote_lines where quote_id = ${q.id} and po_id is null`;
        const res = merchandise(
          lines.map((l) => ({
            id: l.id,
            category: l.category,
            locationId: l.locationId,
            isSelected: l.isSelected,
            quantity: l.quantity,
            landedCost: landedUnitCost(l, q),
            priceOverride: l.priceOverride,
            unitPrice: l.unitPrice,
          })),
          b.rules,
          parentMap(locs),
          { targetMarginPct: b.targetMarginPct ?? null, respectOverrides: b.respectOverrides },
        );
        const cleared = new Set(res.clearedOverrides);
        let updated = 0;
        for (const l of lines) {
          const m = res.markups.get(l.id);
          if (m === undefined && !cleared.has(l.id)) continue;
          await tx`update quoting.quote_lines set markup_pct = ${m ?? l.markupPct}, price_override = false where id = ${l.id}`;
          updated++;
        }
        if (b.saveRules) {
          await tx`delete from quoting.quote_markup_rules where quote_id = ${q.id}`;
          for (const r of b.rules)
            await tx`insert into quoting.quote_markup_rules (tenant_id, quote_id, category, location_id, markup_pct)
                     values (${q.tenantId}, ${q.id}, ${r.category ?? null}, ${r.locationId ?? null}, ${r.markupPct})`;
        }
        await recomputeLines(tx, q);
        if (q.status === 'draft' || q.status === 'costing')
          await tx`update quoting.quotes set status = 'merchandising' where id = ${q.id}`;
        await invalidateApproval(tx, q);
        return {
          updatedLines: updated,
          solvedMarkupPct: res.solvedMarkupPct,
          totals: await totalsFor(tx, q),
        };
      });
    },
  );

  app.get(
    '/quotes/:id/summary',
    {
      schema: {
        tags: ['pricing'],
        summary:
          'Totals by location (top-level area), category and vendor; freight, tax, grand total, flag counts',
        params: IdParams,
        response: { 200: Summary },
      },
    },
    async (req) => {
      req.principal.require('quotes:read', 'quotes:costs:read');
      return req.tx(async (tx) => {
        const q = await getQuote(tx, req.params.id);
        const lines = await tx<TotalsLine[]>`
          select id, is_selected, location_id, category, vendor_id, vendor_name, quantity, freight_unit,
                 extended_cost, extended_price, flags
          from quoting.quote_lines where quote_id = ${q.id}`;
        const locs = await locationTree(tx, q.id);
        const parents = parentMap(locs);
        const byId = new Map(locs.map((l) => [l.id, l]));
        const root = (id: string | null) => {
          let cur = id;
          while (cur && parents.get(cur)) cur = parents.get(cur)!;
          return cur;
        };
        return {
          totals: quoteTotals(q, lines),
          byLocation: groupTotals(
            lines,
            (l) => root(l.locationId),
            (k) => (k ? (byId.get(k)?.name ?? 'Unknown') : 'Unassigned'),
          ),
          byCategory: groupTotals(
            lines,
            (l) => l.category,
            (k) => k ?? 'other',
          ),
          byVendor: groupTotals(
            lines,
            (l) => l.vendorId,
            (_k, l) => l.vendorName ?? 'No vendor',
          ),
        };
      });
    },
  );

  app.get(
    '/quotes/:id/price-matrix',
    {
      schema: {
        tags: ['price-matrix'],
        summary:
          'Competing vendor options per master-spec slot with cost, lead time, expiry and delta vs. lowest',
        params: IdParams,
        response: { 200: PriceMatrix },
      },
    },
    async (req) => {
      req.principal.require('quotes:read', 'quotes:costs:read');
      return req.tx(async (tx) => {
        const q = await getQuote(tx, req.params.id);
        const rows = await tx<
          (LineRow & { masterName: string; masterCategory: string | null; leadTimeWeeks: number | null })[]
        >`
          select l.*, m.name as master_name, m.category as master_category
          from quoting.quote_lines l join quoting.master_specs m on m.id = l.master_spec_id
          where l.quote_id = ${q.id} order by m.name, l.unit_cost nulls last, l.code`;
        const locs = new Map((await locationTree(tx, q.id)).map((l) => [l.id, l.path]));
        const groups = new Map<string, (typeof rows)[number][]>();
        for (const r of rows) {
          const k = `${r.masterSpecId}|${r.locationId ?? ''}`;
          if (!groups.has(k)) groups.set(k, []);
          groups.get(k)!.push(r);
        }
        const slots = [...groups.values()].map((g) => {
          const first = g[0]!;
          const costs = g.map((l) => l.unitCost).filter((c): c is number => c !== null);
          const lowest = costs.length ? Math.min(...costs) : null;
          const selected = g.find((l) => l.isSelected) ?? null;
          return {
            masterSpecId: first.masterSpecId!,
            name: first.masterName,
            category: first.masterCategory,
            locationId: first.locationId,
            locationName: first.locationId ? (locs.get(first.locationId) ?? null) : null,
            selectedLineId: selected?.id ?? null,
            lowestUnitCost: lowest,
            options: g.map((l) => {
              const delta = l.unitCost !== null && lowest !== null ? round4(l.unitCost - lowest) : null;
              return {
                lineId: l.id,
                specId: l.specId,
                code: l.code,
                name: l.name,
                vendorId: l.vendorId,
                vendorName: l.vendorName,
                unitCost: l.unitCost,
                leadTimeWeeks: l.leadTimeWeeks,
                costExpiresAt: l.costExpiresAt,
                quantity: l.quantity,
                extendedCost: l.extendedCost,
                deltaVsLowest: delta,
                deltaPct: delta !== null && lowest ? round2((delta / lowest) * 100) : null,
                isLowest: l.unitCost !== null && l.unitCost === lowest,
                isSelected: l.isSelected,
                flags: l.flags,
              };
            }),
          };
        });
        return { slots };
      });
    },
  );

  app.post(
    '/quotes/:id/price-matrix/select',
    {
      schema: {
        tags: ['price-matrix'],
        summary: 'Choose the winning line per master-spec slot; optionally delete the losing alternates',
        params: IdParams,
        body: PriceMatrixSelect,
        response: {
          200: z.object({
            selected: z.number().int(),
            deselected: z.number().int(),
            deleted: z.number().int(),
          }),
        },
      },
    },
    async (req) => {
      req.principal.require('quotes:write', 'quotes:costs:read');
      return req.tx(async (tx) => {
        const q = await getQuote(tx, req.params.id, { lock: true });
        assertEditable(q);
        let selected = 0;
        let deselected = 0;
        let deleted = 0;
        for (const [masterSpecId, lineId] of Object.entries(req.body.selections)) {
          const [win] = await tx<LineRow[]>`
            select * from quoting.quote_lines where id = ${lineId} and quote_id = ${q.id} and master_spec_id = ${masterSpecId}`;
          if (!win)
            throw badRequest(`Line ${lineId} is not an option of master spec ${masterSpecId} on this quote`);
          const losers = await tx<{ id: string; poId: string | null }[]>`
            select id, po_id from quoting.quote_lines
            where quote_id = ${q.id} and master_spec_id = ${masterSpecId} and id <> ${lineId}
              and location_id is not distinct from ${win.locationId}::uuid`;
          if (losers.some((l) => l.poId)) throw badRequest('An alternate in this slot is already ordered');
          await tx`update quoting.quote_lines set is_selected = true where id = ${lineId}`;
          selected++;
          if (losers.length) {
            const ids = losers.map((l) => l.id);
            if (req.body.deleteOthers) {
              await tx`delete from quoting.quote_lines where id in ${tx(ids)}`;
              deleted += ids.length;
            } else {
              await tx`update quoting.quote_lines set is_selected = false, ready_to_order = false where id in ${tx(ids)}`;
              deselected += ids.length;
            }
          }
        }
        await invalidateApproval(tx, q);
        return { selected, deselected, deleted };
      });
    },
  );
}
