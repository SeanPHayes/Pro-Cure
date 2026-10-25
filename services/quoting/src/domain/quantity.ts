import { round4 } from '@procure/domain';

/** Pure quantity math for quote lines. */
export interface QtyInput {
  qtyMode: 'fixed' | 'per_room';
  qtyFixed: number;
  /** { roomTypeId: qty per room } */
  qtyPerRoom: Record<string, number>;
  atticStockPct: number;
}

export interface RoomTypeCount {
  id: string;
  count: number;
}

export interface QtyResult {
  base: number;
  atticStock: number;
  quantity: number;
}

/**
 * per_room: Σ(qty per room × room count); fixed: qty_fixed. Attic stock (spare units the owner keeps)
 * is ceil(base × pct / 100) — you can't order a fraction of a headboard.
 */
export function computeQuantity(line: QtyInput, roomTypes: RoomTypeCount[]): QtyResult {
  let base: number;
  if (line.qtyMode === 'per_room') {
    const counts = new Map(roomTypes.map((r) => [r.id, r.count]));
    base = 0;
    for (const [rt, perRoom] of Object.entries(line.qtyPerRoom ?? {})) {
      base += (Number(perRoom) || 0) * (counts.get(rt) ?? 0);
    }
  } else {
    base = Number(line.qtyFixed) || 0;
  }
  base = round4(base);
  const pct = Number(line.atticStockPct) || 0;
  // Guard against float noise (e.g. 120 × 5% = 6.000000001 → 7).
  const atticStock = pct > 0 && base > 0 ? Math.ceil(round4((base * pct) / 100)) : 0;
  return { base, atticStock, quantity: round4(base + atticStock) };
}

export interface Handing {
  left: number;
  right: number;
}

/**
 * Keep an existing handing split consistent when the quantity changes indirectly (e.g. a room count
 * change cascades): scale proportionally, rounding left, remainder right.
 */
export function rescaleHanding(handing: Handing | null | undefined, quantity: number): Handing | null {
  if (!handing) return null;
  const total = handing.left + handing.right;
  if (round4(total) === round4(quantity)) return handing;
  if (total <= 0)
    return { left: Math.floor(quantity / 2), right: round4(quantity - Math.floor(quantity / 2)) };
  const left = Math.round((quantity * handing.left) / total);
  return { left, right: round4(quantity - left) };
}

/** Left/right handing split must account for every unit. Returns an error message or null. */
export function handingError(handing: Handing | null | undefined, quantity: number): string | null {
  if (!handing) return null;
  if (handing.left < 0 || handing.right < 0) return 'Handing quantities cannot be negative';
  if (round4(handing.left + handing.right) !== round4(quantity))
    return `Handing split (L ${handing.left} + R ${handing.right}) must equal the line quantity ${quantity}`;
  return null;
}
