import { on, type Subscription } from '@procure/platform';
import { systemEmitter } from './core.js';
import { afterRequirementsChanged, setRequirementStatus } from './ops.js';

/**
 * Event handlers. Each runs in a system transaction scoped to the event's tenant, recorded in platform.inbox
 * (so redelivery is a no-op); handlers are also idempotent on their own (re-approving is skipped).
 */
export const subscriptions: Subscription[] = [
  // A paid deposit bill satisfies the PO's deposit requirement.
  on('finance.vendor_bill.paid', async (event, { tx, log }) => {
    const { poId, kind, billId } = event.data;
    if (kind !== 'deposit' || !poId || !event.tenantId) return;
    const em = systemEmitter(event.tenantId);
    const reqs = await tx<{ id: string; status: string }[]>`
      select id, status from orders.pre_order_requirements
      where po_id = ${poId} and tenant_id = ${event.tenantId} and kind = 'deposit'`;
    if (!reqs.length) {
      log.info({ poId, billId }, 'deposit paid for a PO without a deposit requirement');
      return;
    }
    let changed = false;
    for (const r of reqs.filter((x) => x.status !== 'approved' && x.status !== 'waived')) {
      await setRequirementStatus(tx, em, r.id, 'approved', {
        actorName: 'Accounting (deposit paid)',
        note: `Deposit paid (bill ${billId})`,
      });
      changed = true;
    }
    if (changed) await afterRequirementsChanged(tx, em, poId);
  }),
];
