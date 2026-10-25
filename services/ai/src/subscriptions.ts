import { on, type Subscription } from '@procure/platform';
import { insertJob, scheduleJob } from './engine.js';

/**
 * comms.inbound_email.received → an inbox_route job (idempotent per email via idempotency key, on top
 * of the platform inbox dedupe). The job runs after the consuming transaction commits.
 *
 * identity.org.created (procurement_firm) → register the tenant for the scheduled risk model.
 */
export const subscriptions: Subscription[] = [
  on('comms.inbound_email.received', async (event, { tx, log }) => {
    if (!event.tenantId) return;
    const { job, created } = await insertJob(tx, {
      tenantId: event.tenantId,
      kind: 'inbox_route',
      title: 'Inbox routing',
      input: { inboundEmailId: event.data.inboundEmailId },
      entityType: 'inbound_email',
      entityId: event.data.inboundEmailId,
      createdByName: 'Pro-Cure inbox agent',
      idempotencyKey: `inbound:${event.data.inboundEmailId}`,
    });
    if (created) scheduleJob(event.tenantId, job.id, log);
  }),
  on('identity.org.created', async (event, { tx }) => {
    if (event.data.type !== 'procurement_firm') return;
    await tx`insert into ai.tenants (tenant_id, name) values (${event.data.orgId}, ${event.data.name})
             on conflict (tenant_id) do update set name = excluded.name`;
  }),
];
