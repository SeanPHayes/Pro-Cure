import {
  carrierTrackingUrl,
  type TrackingProvider,
  type TrackingQuery,
  type TrackingResult,
  type TrackingStatus,
} from './provider.js';

/**
 * AfterShip-style HTTP provider (stub). Expects AFTERSHIP_API_KEY and optionally AFTERSHIP_BASE_URL. Maps the
 * provider's tag vocabulary onto ours. Not exercised locally; the simulated provider is the default.
 */
const TAGS: Record<string, TrackingStatus> = {
  InfoReceived: 'label_created',
  Pending: 'label_created',
  InTransit: 'in_transit',
  OutForDelivery: 'out_for_delivery',
  AttemptFail: 'exception',
  Exception: 'exception',
  Delivered: 'delivered',
  AvailableForPickup: 'out_for_delivery',
};

export class AfterShipTrackingProvider implements TrackingProvider {
  readonly name = 'aftership';
  constructor(
    private apiKey = process.env.AFTERSHIP_API_KEY ?? '',
    private baseUrl = process.env.AFTERSHIP_BASE_URL ?? 'https://api.aftership.com/tracking/2024-10',
  ) {}

  async get(q: TrackingQuery): Promise<TrackingResult> {
    if (!this.apiKey) throw new Error('AFTERSHIP_API_KEY is not configured');
    const slug = q.carrier.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const res = await fetch(
      `${this.baseUrl}/trackings/${encodeURIComponent(slug)}/${encodeURIComponent(q.trackingNumber)}`,
      {
        headers: { 'as-api-key': this.apiKey, 'content-type': 'application/json' },
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!res.ok) throw new Error(`AfterShip HTTP ${res.status}`);
    const body = (await res.json()) as {
      data?: {
        tracking?: {
          tag?: string;
          expected_delivery?: string | null;
          shipment_delivery_date?: string | null;
          courier_tracking_link?: string | null;
          checkpoints?: { checkpoint_time: string; tag: string; message: string; location?: string | null }[];
        };
      };
    };
    const t = body.data?.tracking ?? {};
    return {
      status: TAGS[t.tag ?? ''] ?? 'unknown',
      estimatedDeliveryDate: t.expected_delivery?.slice(0, 10) ?? null,
      deliveredAt: t.shipment_delivery_date ?? null,
      events: (t.checkpoints ?? [])
        .map((c) => ({
          at: c.checkpoint_time,
          status: TAGS[c.tag] ?? 'unknown',
          description: c.message,
          location: c.location ?? null,
        }))
        .reverse(),
      trackingUrl: t.courier_tracking_link ?? carrierTrackingUrl(q.carrier, q.trackingNumber),
    };
  }
}
