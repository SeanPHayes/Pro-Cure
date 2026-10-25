import { round4 } from '@procure/domain';

export interface OrderedLine {
  id: string;
  code: string;
  quantity: number;
}
export interface Allocation {
  poLineId: string;
  quantity: number;
  shipmentId?: string;
}
export interface AllocationError {
  poLineId: string;
  code: string | null;
  ordered: number;
  allocated: number;
  message: string;
}

/** Σ allocated quantity per PO line across all shipments must not exceed the ordered quantity. */
export function allocationErrors(lines: OrderedLine[], allocations: Allocation[]): AllocationError[] {
  const byId = new Map(lines.map((l) => [l.id, l]));
  const totals = new Map<string, number>();
  const errors: AllocationError[] = [];
  for (const a of allocations) {
    if (a.quantity <= 0) {
      errors.push({
        poLineId: a.poLineId,
        code: byId.get(a.poLineId)?.code ?? null,
        ordered: byId.get(a.poLineId)?.quantity ?? 0,
        allocated: a.quantity,
        message: 'Allocated quantity must be positive',
      });
      continue;
    }
    if (!byId.has(a.poLineId)) {
      errors.push({
        poLineId: a.poLineId,
        code: null,
        ordered: 0,
        allocated: a.quantity,
        message: 'Line is not on this purchase order',
      });
      continue;
    }
    totals.set(a.poLineId, round4((totals.get(a.poLineId) ?? 0) + a.quantity));
  }
  for (const [id, allocated] of totals) {
    const l = byId.get(id)!;
    if (allocated > l.quantity + 1e-9)
      errors.push({
        poLineId: id,
        code: l.code,
        ordered: l.quantity,
        allocated,
        message: `${l.code}: ${allocated} allocated across shipments but only ${l.quantity} ordered`,
      });
  }
  return errors;
}

/** Quantity of each line not yet on any shipment. */
export function unallocated(lines: OrderedLine[], allocations: Allocation[]) {
  const used = new Map<string, number>();
  for (const a of allocations) used.set(a.poLineId, round4((used.get(a.poLineId) ?? 0) + a.quantity));
  return lines
    .map((l) => ({ poLineId: l.id, code: l.code, quantity: round4(l.quantity - (used.get(l.id) ?? 0)) }))
    .filter((x) => x.quantity > 0);
}

/** Next shipment label after the given ones: A, B, … Z, AA, AB … */
export function nextLabel(existing: string[]): string {
  const toNum = (s: string) => [...s].reduce((n, c) => n * 26 + (c.charCodeAt(0) - 64), 0);
  const toLabel = (n: number): string => {
    let s = '';
    while (n > 0) {
      const r = (n - 1) % 26;
      s = String.fromCharCode(65 + r) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  };
  const max = existing.filter((x) => /^[A-Z]+$/.test(x)).reduce((m, x) => Math.max(m, toNum(x)), 0);
  return toLabel(max + 1);
}
