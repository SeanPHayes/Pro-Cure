export type PoStatus =
  | 'draft'
  | 'issued'
  | 'acknowledged'
  | 'in_production'
  | 'partially_shipped'
  | 'shipped'
  | 'partially_delivered'
  | 'delivered'
  | 'closed'
  | 'cancelled';

const SHIPPED = new Set(['shipped', 'in_transit', 'delivered']);
export const isShipped = (s: string) => SHIPPED.has(s);
export const OPEN_PO_STATUSES: PoStatus[] = [
  'draft',
  'issued',
  'acknowledged',
  'in_production',
  'partially_shipped',
  'shipped',
  'partially_delivered',
];

/**
 * Derive a PO's status from its shipments and requirements. Draft, closed and cancelled are only changed by
 * explicit actions. Shipment progress wins; otherwise an acknowledged PO whose pre-order requirements are all
 * complete moves into production.
 */
export function derivePoStatus(input: {
  current: PoStatus;
  shipmentStatuses: string[];
  requirementsComplete: boolean;
}): PoStatus {
  const { current, shipmentStatuses: ss } = input;
  if (current === 'draft' || current === 'closed' || current === 'cancelled') return current;
  if (ss.length) {
    const delivered = ss.filter((s) => s === 'delivered').length;
    const shipped = ss.filter(isShipped).length;
    if (delivered === ss.length) return 'delivered';
    if (delivered > 0) return 'partially_delivered';
    if (shipped === ss.length) return 'shipped';
    if (shipped > 0) return 'partially_shipped';
  }
  const preShip: PoStatus[] = ['issued', 'acknowledged', 'in_production'];
  if (!preShip.includes(current)) {
    // shipments were rolled back (e.g. tracking removed): fall back to the pre-ship state
    return input.requirementsComplete ? 'in_production' : 'acknowledged';
  }
  if (current === 'acknowledged' && input.requirementsComplete) return 'in_production';
  return current;
}
