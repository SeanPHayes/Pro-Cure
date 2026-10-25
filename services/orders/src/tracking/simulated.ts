import { addDays, daysBetween, today as todayIso } from '../domain/dates.js';
import {
  carrierTrackingUrl,
  type TrackingEvent,
  type TrackingProvider,
  type TrackingQuery,
  type TrackingResult,
} from './provider.js';

/**
 * Deterministic local provider so demos show movement: status progresses by days since the ship date.
 *   day 0          label created
 *   day 1 .. T-1   in transit (one scan per day)
 *   day T-1        out for delivery (T = transit days, min 2)
 *   day >= T       delivered
 * A tracking number containing "EXC" reports an exception after day 1.
 */
export class SimulatedTrackingProvider implements TrackingProvider {
  readonly name = 'simulated';
  async get(q: TrackingQuery, now: Date = new Date()): Promise<TrackingResult> {
    const today = todayIso(now);
    const shipDate = q.shipDate ?? today;
    const transit = Math.max(2, q.transitDays ?? 5);
    const day = Math.max(0, daysBetween(shipDate, today));
    const eta = addDays(shipDate, transit);
    const ts = (d: number, hour: number) =>
      `${addDays(shipDate, d)}T${String(hour).padStart(2, '0')}:00:00.000Z`;
    const hubs = ['Origin facility', 'Regional hub', 'Linehaul', 'Destination hub', 'Local terminal'];
    const events: TrackingEvent[] = [
      {
        at: ts(0, 14),
        status: 'label_created',
        description: `${q.carrier}: shipment information received`,
        location: hubs[0]!,
      },
    ];
    const exception = q.trackingNumber.toUpperCase().includes('EXC');
    for (let d = 1; d <= Math.min(day, transit - 2); d++)
      events.push({
        at: ts(d, 9),
        status: 'in_transit',
        description: 'In transit',
        location: hubs[Math.min(d, hubs.length - 1)]!,
      });
    if (exception && day >= 1) {
      events.push({
        at: ts(1, 16),
        status: 'exception',
        description: 'Delivery exception: carrier delay',
        location: hubs[1]!,
      });
      return {
        status: 'exception',
        estimatedDeliveryDate: addDays(eta, 2),
        deliveredAt: null,
        events: events.reverse(),
        trackingUrl: carrierTrackingUrl(q.carrier, q.trackingNumber),
      };
    }
    if (day >= transit - 1)
      events.push({
        at: ts(transit - 1, 7),
        status: 'out_for_delivery',
        description: 'Out for delivery',
        location: hubs[4]!,
      });
    let deliveredAt: string | null = null;
    if (day >= transit) {
      deliveredAt = ts(transit, 11);
      events.push({
        at: deliveredAt,
        status: 'delivered',
        description: 'Delivered',
        location: 'Destination',
      });
    }
    const status = events[events.length - 1]!.status;
    return {
      status,
      estimatedDeliveryDate: eta,
      deliveredAt,
      events: events.reverse(),
      trackingUrl: carrierTrackingUrl(q.carrier, q.trackingNumber),
    };
  }
}
