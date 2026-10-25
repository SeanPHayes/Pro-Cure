import type { EventData, EventType } from '@procure/domain';
import { type LineFlag, round2, sum } from '@procure/domain';
import { conflict, forbidden, notFound, type Principal, type Tx } from '@procure/platform';
import type { ApprovalCondition } from './domain/approvals.js';
import { priceLine, todayIso } from './domain/pricing.js';
import { computeQuantity, type Handing, rescaleHanding } from './domain/quantity.js';
import { emptyFlagCounts, type QuoteTotals, quoteTotals, type TotalsLine } from './domain/totals.js';

/** Shared data access + derived-field maintenance for quotes and lines. */

export type QuoteRow = {
  id: string;
  tenantId: string;
  projectId: string | null;
  clientOrgId: string | null;
  number: string;
  name: string;
  phase: string | null;
  status: string;
  isTemplate: boolean;
  freightMode: 'per_line' | 'percent';
  freightPct: number;
  taxRate: number;
  defaultMarkupPct: number;
  minMarginPct: number | null;
  internalApprovedAt: string | null;
  version: number;
  [k: string]: unknown;
};

export type LineRow = {
  id: string;
  quoteId: string;
  locationId: string | null;
  specId: string | null;
  masterSpecId: string | null;
  isSelected: boolean;
  code: string;
  name: string;
  category: string;
  vendorId: string | null;
  vendorName: string | null;
  qtyMode: 'fixed' | 'per_room';
  qtyFixed: number;
  qtyPerRoom: Record<string, number>;
  handing: Handing | null;
  atticStockPct: number;
  quantity: number;
  unitCost: number | null;
  costExpiresAt: string | null;
  freightUnit: number | null;
  markupPct: number;
  unitPrice: number | null;
  priceOverride: boolean;
  extendedCost: number | null;
  extendedPrice: number | null;
  marginPct: number | null;
  flags: string[];
  readyToOrder: boolean;
  poId: string | null;
  [k: string]: unknown;
};

/** Statuses in which a quote's content (lines, pricing, structure) may change. */
export const EDITABLE_STATUSES = [
  'draft',
  'costing',
  'merchandising',
  'pending_internal_approval',
  'client_rejected',
];
export const OPEN_STATUSES = [...EDITABLE_STATUSES, 'sent'];

export async function getQuote(tx: Tx, id: string, opts: { lock?: boolean } = {}): Promise<QuoteRow> {
  const [q] = opts.lock
    ? await tx<QuoteRow[]>`select * from quoting.quotes where id = ${id} for update`
    : await tx<QuoteRow[]>`select * from quoting.quotes where id = ${id}`;
  if (!q) throw notFound('Quote');
  return q;
}

export function assertEditable(q: QuoteRow) {
  if (q.isTemplate) return;
  if (!EDITABLE_STATUSES.includes(q.status))
    throw conflict(`Quote ${q.number} is ${q.status} and can no longer be edited`, { status: q.status });
}

export const requireAny = (p: Principal, ...perms: Parameters<Principal['can']>[0][]) => {
  if (!perms.some((x) => p.can(x))) throw forbidden(`Missing permission: one of ${perms.join(', ')}`);
};

/**
 * Pricing/content changed after an internal approval round: approvals no longer reflect the quote.
 * Cancel pending requests, clear the approval stamp, and drop back to merchandising.
 */
export async function invalidateApproval(tx: Tx, q: QuoteRow) {
  if (q.isTemplate) return;
  const wasPending = q.status === 'pending_internal_approval';
  if (!wasPending && !q.internalApprovedAt && q.status !== 'client_rejected') return;
  await tx`update quoting.approval_requests set status = 'cancelled', comment = coalesce(comment, 'Quote changed')
           where entity_type = 'quote' and entity_id = ${q.id} and status = 'pending'`;
  await tx`update quoting.quotes set internal_approved_at = null,
             status = case when status in ('pending_internal_approval', 'client_rejected') then 'merchandising' else status end
           where id = ${q.id}`;
  q.internalApprovedAt = null;
  if (wasPending || q.status === 'client_rejected') q.status = 'merchandising';
}

/** Highest applicable minimum margin for a line: quote min margin and active line-margin policies. */
export async function minMarginResolver(tx: Tx, q: QuoteRow) {
  const policies = await tx<{ condition: ApprovalCondition }[]>`
    select condition from quoting.approval_policies
    where tenant_id = ${q.tenantId} -- explicit: jobs run as system and see every tenant
      and active and applies_to = 'quote' and condition->>'type' = 'line_margin_below'`;
  return (category: string): number | null => {
    let m: number | null = q.minMarginPct ?? null;
    for (const p of policies) {
      const c = p.condition;
      if (c.type !== 'line_margin_below') continue;
      if (c.category && c.category !== category) continue;
      m = m === null ? c.pct : Math.max(m, c.pct);
    }
    return m;
  };
}

const arrEq = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Recompute quantity, handing, price, extended amounts, margin and flags for a quote's lines and
 * persist those that changed. Called after any change to lines, room counts, markups or costs.
 */
export async function recomputeLines(
  tx: Tx,
  q: QuoteRow,
  opts: { lineIds?: string[]; today?: string } = {},
): Promise<{ updated: number; newlyFlagged: { lineId: string; code: string; flag: LineFlag }[] }> {
  const rooms = await tx<{ id: string; count: number }[]>`
    select id, count from quoting.quote_room_types where quote_id = ${q.id}`;
  const lines = opts.lineIds
    ? opts.lineIds.length
      ? await tx<
          LineRow[]
        >`select * from quoting.quote_lines where quote_id = ${q.id} and id in ${tx(opts.lineIds)}`
      : []
    : await tx<LineRow[]>`select * from quoting.quote_lines where quote_id = ${q.id}`;
  const minMargin = await minMarginResolver(tx, q);
  const today = opts.today ?? todayIso();
  let updated = 0;
  const newlyFlagged: { lineId: string; code: string; flag: LineFlag }[] = [];
  for (const l of lines) {
    const { quantity } = computeQuantity(
      {
        qtyMode: l.qtyMode,
        qtyFixed: l.qtyFixed,
        qtyPerRoom: l.qtyPerRoom ?? {},
        atticStockPct: l.atticStockPct,
      },
      rooms,
    );
    const handing = rescaleHanding(l.handing, quantity);
    const p = priceLine(
      {
        quantity,
        unitCost: l.unitCost,
        freightUnit: l.freightUnit,
        markupPct: l.markupPct,
        unitPrice: l.unitPrice,
        priceOverride: l.priceOverride,
        costExpiresAt: l.costExpiresAt,
      },
      { freightMode: q.freightMode, minMarginPct: minMargin(l.category), today },
    );
    const flags = [...p.flags].sort();
    const changed =
      quantity !== l.quantity ||
      JSON.stringify(handing) !== JSON.stringify(l.handing) ||
      p.unitPrice !== l.unitPrice ||
      p.extendedCost !== l.extendedCost ||
      p.extendedPrice !== l.extendedPrice ||
      p.marginPct !== l.marginPct ||
      !arrEq(flags, [...(l.flags ?? [])].sort());
    for (const f of flags)
      if ((f === 'cost_expired' || f === 'cost_expiring') && !(l.flags ?? []).includes(f))
        newlyFlagged.push({ lineId: l.id, code: l.code, flag: f });
    if (!changed) continue;
    await tx`update quoting.quote_lines set
        quantity = ${quantity},
        handing = ${handing ? tx.json(handing as never) : null},
        unit_price = ${p.unitPrice},
        extended_cost = ${p.extendedCost},
        extended_price = ${p.extendedPrice},
        margin_pct = ${p.marginPct},
        flags = ${flags}::text[]
      where id = ${l.id}`;
    updated++;
  }
  return { updated, newlyFlagged };
}

export async function totalsFor(tx: Tx, q: QuoteRow): Promise<QuoteTotals> {
  const lines = await tx<TotalsLine[]>`
    select id, is_selected, location_id, category, vendor_id, vendor_name, quantity, freight_unit,
           extended_cost, extended_price, flags
    from quoting.quote_lines where quote_id = ${q.id}`;
  return quoteTotals(q, lines);
}

/** Header-level totals from aggregates (lists), same formula as quoteTotals. */
export function headerTotals(
  q: Pick<QuoteRow, 'freightMode' | 'freightPct' | 'taxRate'>,
  agg: { lineCount: number; cost: number; sell: number },
) {
  const sell = round2(agg.sell ?? 0);
  const cost = round2(agg.cost ?? 0);
  const freight = q.freightMode === 'percent' ? round2((sell * (Number(q.freightPct) || 0)) / 100) : 0;
  const tax = round2(((sell + freight) * (Number(q.taxRate) || 0)) / 100);
  return {
    lineCount: agg.lineCount,
    costSubtotal: cost,
    sellSubtotal: sell,
    grandTotal: sum([sell, freight, tax]),
    marginPct: sell === 0 ? 0 : round2(((sell - cost) / sell) * 100),
  };
}

/** Strip cost-side numbers for internal users without quotes:costs:read (e.g. designers). */
export function redactLine<T extends object>(p: Principal, l: T): T {
  if (p.can('quotes:costs:read')) return l;
  return { ...l, unitCost: null, freightUnit: null, extendedCost: null, marginPct: null, markupPct: null };
}
export function redactTotals<T extends object>(p: Principal, t: T): T {
  if (p.can('quotes:costs:read')) return t;
  return { ...t, costSubtotal: null, marginPct: null, costTotal: null, freightIncluded: null };
}

export const zeroTotals = (): QuoteTotals => ({
  lineCount: 0,
  selectedLineCount: 0,
  costSubtotal: 0,
  sellSubtotal: 0,
  marginPct: 0,
  freightIncluded: 0,
  freight: 0,
  tax: 0,
  grandTotal: 0,
  costTotal: 0,
  flagCounts: emptyFlagCounts(),
});

/** Location rows with depth + "A > B" path, ordered depth-first by sort. */
export async function locationTree(tx: Tx, quoteId: string) {
  const rows = await tx<{ id: string; parentId: string | null; name: string; kind: string; sort: number }[]>`
    select id, parent_id, name, kind, sort from quoting.quote_locations where quote_id = ${quoteId}
    order by sort, name`;
  const children = new Map<string | null, (typeof rows)[number][]>();
  for (const r of rows) {
    const k = r.parentId ?? null;
    if (!children.has(k)) children.set(k, []);
    children.get(k)!.push(r);
  }
  const out: ((typeof rows)[number] & { depth: number; path: string })[] = [];
  const walk = (parent: string | null, depth: number, prefix: string) => {
    for (const r of children.get(parent) ?? []) {
      const path = prefix ? `${prefix} > ${r.name}` : r.name;
      out.push({ ...r, depth, path });
      walk(r.id, depth + 1, path);
    }
  };
  walk(null, 0, '');
  return out;
}

export const parentMap = (locs: { id: string; parentId: string | null }[]) =>
  new Map(locs.map((l) => [l.id, l.parentId ?? null]));

export const descendantsOf = (id: string, locs: { id: string; parentId: string | null }[]) => {
  const out = new Set<string>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const l of locs)
      if (l.parentId && out.has(l.parentId) && !out.has(l.id)) {
        out.add(l.id);
        grew = true;
      }
  }
  return out;
};

/** SQL fragment: cost status of a spec row aliased `s`. */
export const specCostStatus = (tx: Tx) => tx`
  case when s.cost is null then 'missing'
       when s.cost_expires_at is not null and s.cost_expires_at < current_date then 'expired'
       when s.cost_expires_at is not null and s.cost_expires_at <= current_date + 14 then 'expiring'
       else 'ok' end`;

/** Append a row to a spec's cost history. */
export async function recordSpecCost(
  tx: Tx,
  e: {
    tenantId: string;
    specId: string;
    cost: number | null;
    expiresAt: string | null;
    source: 'manual' | 'cost_request' | 'ai_pdf' | 'import';
    costRequestId?: string | null;
    by?: string | null;
  },
) {
  await tx`insert into quoting.spec_cost_history (tenant_id, spec_id, cost, expires_at, source, cost_request_id, recorded_by_name)
           values (${e.tenantId}, ${e.specId}, ${e.cost}, ${e.expiresAt}, ${e.source}, ${e.costRequestId ?? null}, ${e.by ?? null})`;
}

/** Count + rows helper for paginated lists. */
export const pageResult = <T>(items: T[], total: number, limit: number, offset: number) => ({
  items,
  total,
  limit,
  offset,
});

/** The parts of a Fastify request that shared helpers need (quoting does not depend on fastify directly). */
export interface ReqCtx {
  principal: Principal;
  tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  emit<T extends EventType>(tx: Tx, type: T, data: EventData<T>): Promise<string>;
}
