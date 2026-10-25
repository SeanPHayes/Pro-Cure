/** Carrier tracking adapter. Selected by env TRACKING_PROVIDER (simulated | aftership). */
export type TrackingStatus =
  | 'label_created'
  | 'in_transit'
  | 'out_for_delivery'
  | 'delivered'
  | 'exception'
  | 'unknown';

export interface TrackingEvent {
  at: string;
  status: TrackingStatus;
  description: string;
  location: string | null;
}

export interface TrackingResult {
  status: TrackingStatus;
  estimatedDeliveryDate: string | null;
  deliveredAt: string | null;
  events: TrackingEvent[];
  trackingUrl: string | null;
}

export interface TrackingQuery {
  carrier: string;
  trackingNumber: string;
  /** Shipment's actual ship date (simulated provider progresses from it). */
  shipDate?: string | null;
  transitDays?: number | null;
}

export interface TrackingProvider {
  readonly name: string;
  get(q: TrackingQuery, now?: Date): Promise<TrackingResult>;
}

/** Public tracking page for common carriers (used when a provider gives none). */
export function carrierTrackingUrl(carrier: string, number: string): string | null {
  const c = carrier.toLowerCase();
  const n = encodeURIComponent(number);
  if (c.includes('ups')) return `https://www.ups.com/track?tracknum=${n}`;
  if (c.includes('fedex')) return `https://www.fedex.com/fedextrack/?trknbr=${n}`;
  if (c.includes('usps')) return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${n}`;
  if (c.includes('dhl')) return `https://www.dhl.com/us-en/home/tracking.html?tracking-id=${n}`;
  if (c.includes('xpo')) return `https://www.xpo.com/track/?trackingNumber=${n}`;
  if (c.includes('estes')) return `https://www.estes-express.com/myestes/shipment-tracking/?query=${n}`;
  if (c.includes('old dominion') || c === 'odfl')
    return `https://www.odfl.com/us/en/tools/trace-track-ltl-freight.html?pro=${n}`;
  return null;
}
