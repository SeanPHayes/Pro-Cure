import type { EventEnvelope, EventType } from '@procure/domain';
import { emit, on, type Subscription, type Tx } from '@procure/platform';
import { completeTask, type Emitter } from './engine.js';

/**
 * Auto-completion: a not-done task whose `auto_complete_on` equals the event type and whose project
 * matches `data.projectId` is completed by the system ('Pro-Cure'), readying its dependents.
 * Idempotency: platform.inbox dedupes deliveries; completeTask is also a no-op on done tasks.
 */
export const SYSTEM_NAME = 'Pro-Cure';

const systemEmitter =
  (tenantId: string | null): Emitter =>
  (tx, type, data) =>
    emit(tx, 'projects', type, data, { tenantId, actor: { userId: null, orgId: null, name: SYSTEM_NAME } });

export async function autoComplete(
  tx: Tx,
  event: Pick<EventEnvelope<{ projectId?: string }>, 'type' | 'tenantId' | 'data'>,
  log?: { info: (obj: object, msg: string) => void },
) {
  const projectId = event.data.projectId;
  if (!event.tenantId || !projectId) return [];
  await tx`select set_config('app.user_name', ${SYSTEM_NAME}, true)`;
  const tasks = await tx<{ id: string }[]>`
    select id from projects.tasks
    where tenant_id = ${event.tenantId} and project_id = ${projectId}
      and auto_complete_on = ${event.type} and status not in ('done', 'skipped')
    order by sort`;
  const emitFn = systemEmitter(event.tenantId);
  for (const t of tasks) await completeTask(tx, t.id, { name: SYSTEM_NAME }, emitFn);
  if (tasks.length)
    log?.info({ event: event.type, projectId, completed: tasks.length }, 'auto-completed tasks');
  return tasks.map((t) => t.id);
}

const handler = <T extends EventType>(
  type: T,
  accept: (data: Record<string, unknown>) => boolean = () => true,
) =>
  on(type, async (event, { tx, log }) => {
    const data = event.data as Record<string, unknown>;
    if (!accept(data)) return;
    await autoComplete(
      tx,
      { type: event.type, tenantId: event.tenantId, data: data as { projectId?: string } },
      log,
    );
  });

export const subscriptions: Subscription[] = [
  handler('quoting.quote.client_decided', (d) => d.decision === 'approved'),
  handler('quoting.quote.sent_to_client'),
  handler('orders.po.issued'),
  handler('orders.shipment.delivered'),
  handler('finance.payment.received'),
];
