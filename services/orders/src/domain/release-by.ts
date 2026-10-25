import { addDays } from './dates.js';

export type Origin = 'domestic' | 'international';

export const DEFAULT_TRANSIT_DAYS: Record<Origin, number> = { domestic: 5, international: 35 };

/** Transit days: the vendor profile's value when known, else the default for the origin. */
export const transitDaysFor = (origin: Origin, vendorTransitDays?: number | null): number =>
  vendorTransitDays ?? DEFAULT_TRANSIT_DAYS[origin];

/**
 * Release-by ("order-by") date: the latest date every pre-order requirement (acknowledgement, deposit,
 * shop drawings, finish samples …) must be complete so that production — lead time — plus transit still
 * meets the requested delivery date.
 *
 *   release_by = requested_delivery − lead_time_weeks × 7 − transit_days
 *
 * Unknown when either the requested delivery date or the vendor lead time is unknown.
 */
export function releaseByDate(input: {
  requestedDeliveryDate: string | null | undefined;
  leadTimeWeeks: number | null | undefined;
  transitDays?: number | null;
  origin?: Origin | null;
}): string | null {
  if (!input.requestedDeliveryDate || input.leadTimeWeeks === null || input.leadTimeWeeks === undefined)
    return null;
  const transit = input.transitDays ?? DEFAULT_TRANSIT_DAYS[input.origin ?? 'domestic'];
  return addDays(input.requestedDeliveryDate, -(input.leadTimeWeeks * 7) - transit);
}

/** Planned ship date that meets the requested delivery: requested delivery − transit. */
export function plannedShipDate(requestedDeliveryDate: string | null | undefined, transitDays: number) {
  return requestedDeliveryDate ? addDays(requestedDeliveryDate, -transitDays) : null;
}
