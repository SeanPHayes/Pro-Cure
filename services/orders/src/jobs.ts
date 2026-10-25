import { hours, type Job, minutes, type Tx } from '@procure/platform';
import { emailVendor, getPo, recomputeEscalation, systemEmitter, vendorPortalLink } from './core.js';
import { addDays, today as todayIso } from './domain/dates.js';
import { applyTrackingResult } from './ops.js';
import { requestConfirmation } from './routes/shipments.js';
import { trackingProvider } from './tracking/index.js';

/**
 * Scheduled jobs. They run as `system` (every tenant visible), so each one emits with the row's tenant and
 * keeps per-tenant work inside the same transaction. Jobs are idempotent: re-running in the same window is a no-op.
 */
const OPEN_PO = `p.status not in ('draft', 'cancelled', 'closed', 'delivered')`;
const NOT_SHIPPED = `s.status not in ('shipped', 'in_transit', 'delivered')`;

/** Ask vendors to confirm upcoming ship dates (every 14 days; every 7 once the date is within 14 days). */
export const shipDateConfirmations: Job = {
  name: 'ship-date-confirmations',
  everyMs: hours(1),
  run: async ({ tx, now }) => {
    const today = todayIso(now);
    const rows = await tx<any[]>`
      select s.* from orders.shipments s join orders.purchase_orders p on p.id = s.po_id
      where ${tx.unsafe(OPEN_PO)} and ${tx.unsafe(NOT_SHIPPED)}
        and s.estimated_ship_date is not null
        and s.estimated_ship_date <= ${addDays(today, 45)}::date
        and s.estimated_ship_date >= ${addDays(today, -3)}::date
        and coalesce(greatest(s.last_confirmed_at, s.last_confirmation_requested_at), '-infinity'::timestamptz)
            < ${now.toISOString()}::timestamptz
              - (case when s.estimated_ship_date <= ${addDays(today, 14)}::date then interval '7 days'
                      else interval '14 days' end)
      order by s.estimated_ship_date
      limit 500`;
    let requested = 0;
    for (const s of rows) {
      const po = await getPo(tx, s.poId);
      await requestConfirmation(tx, systemEmitter(po.tenantId), po, s, 'email');
      requested++;
    }
    return { requested };
  },
};

/** Ship date passed ≥ 2 days ago without tracking: ask the vendor for it (at most every 3 days). */
export const trackingMissing: Job = {
  name: 'tracking-missing',
  everyMs: hours(1),
  run: async ({ tx, now }) => {
    const rows = await tx<any[]>`
      select s.* from orders.shipments s join orders.purchase_orders p on p.id = s.po_id
      where ${tx.unsafe(OPEN_PO)} and s.status not in ('delivered') and s.tracking_number is null
        and s.estimated_ship_date <= ${addDays(todayIso(now), -2)}::date
        and coalesce(s.last_tracking_requested_at, '-infinity'::timestamptz) < ${now.toISOString()}::timestamptz - interval '3 days'
      limit 500`;
    let requested = 0;
    for (const s of rows) {
      const po = await getPo(tx, s.poId);
      const em = systemEmitter(po.tenantId);
      await emailVendor(tx, em, po, {
        subject: `Tracking needed: ${po.number}${s.label !== 'A' ? ` shipment ${s.label}` : ''}`,
        text: [
          `Our records show ${po.number}${s.label !== 'A' ? ` shipment ${s.label}` : ''} (${po.projectName ?? ''}) was due to ship on ${s.estimatedShipDate}, but we have no tracking yet.`,
          '',
          `If it has shipped, please add the carrier and tracking number; if not, please give us the new ship date:`,
          vendorPortalLink(po.id),
        ].join('\n'),
      });
      await tx`update orders.shipments set last_tracking_requested_at = ${now.toISOString()} where id = ${s.id}`;
      requested++;
    }
    return { requested };
  },
};

/** Poll the carrier for shipments in transit. */
export const trackingPoll: Job = {
  name: 'tracking-poll',
  everyMs: minutes(30),
  run: async ({ tx, now, log }) => {
    const rows = await tx<any[]>`
      select s.*, p.tenant_id as po_tenant, coalesce(p.transit_days, 5) as po_transit
      from orders.shipments s join orders.purchase_orders p on p.id = s.po_id
      where s.tracking_number is not null and s.status <> 'delivered' and p.status <> 'cancelled'
      order by s.tracking_checked_at nulls first limit 200`;
    const provider = trackingProvider();
    const counts: Record<string, number> = {};
    for (const s of rows) {
      try {
        const r = await provider.get(
          {
            carrier: s.carrier,
            trackingNumber: s.trackingNumber,
            shipDate: s.actualShipDate,
            transitDays: s.poTransit,
          },
          now,
        );
        const outcome = await withSavepoint(tx, () =>
          applyTrackingResult(tx, systemEmitter(s.poTenant), s.id, r),
        );
        counts[outcome] = (counts[outcome] ?? 0) + 1;
      } catch (err) {
        counts.failed = (counts.failed ?? 0) + 1;
        log.warn({ err: (err as Error).message, shipmentId: s.id }, 'tracking poll failed');
      }
    }
    return { provider: provider.name, polled: rows.length, ...counts };
  },
};

/** Recompute escalation for every open PO (rules depend on today's date). */
export const escalations: Job = {
  name: 'escalations',
  everyMs: minutes(15),
  run: async ({ tx, now }) => {
    const pos = await tx<{ id: string; tenantId: string }[]>`
      select id, tenant_id from orders.purchase_orders p where ${tx.unsafe(OPEN_PO)}`;
    let increased = 0;
    for (const p of pos) {
      const r = await recomputeEscalation(tx, p.id, systemEmitter(p.tenantId), now);
      if (r.after !== r.before && ['at_risk', 'critical'].includes(r.after)) increased++;
    }
    return { evaluated: pos.length, increased };
  },
};

async function withSavepoint<T>(tx: Tx, fn: () => Promise<T>): Promise<T> {
  return tx.savepoint(fn) as Promise<T>;
}

export const jobs: Job[] = [shipDateConfirmations, trackingMissing, trackingPoll, escalations];
