import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { EVENTS, type EventData, type EventEnvelope, type EventType } from '@procure/domain';
import type { Logger } from 'pino';
import { config } from './config.js';
import { type Db, sql, type Tx, withSystem } from './db.js';

/**
 * Transactional outbox. Call `emit` inside the same transaction as the state change; the relay
 * publishes it after commit. Guarantees at-least-once delivery; consumers dedupe via platform.inbox.
 */
export interface EmitActor {
  userId: string | null;
  orgId: string | null;
  name: string | null;
}

export async function emit<T extends EventType>(
  tx: Db,
  source: string,
  type: T,
  data: EventData<T>,
  meta: { tenantId: string | null; actor?: EmitActor | null },
): Promise<string> {
  const parsed = EVENTS[type].parse(data);
  const id = crypto.randomUUID();
  await tx`
    insert into platform.outbox (id, source, type, tenant_id, actor, data)
    values (${id}, ${source}, ${type}, ${meta.tenantId}, ${meta.actor ? tx.json(meta.actor as never) : null},
            ${tx.json(parsed as never)})`;
  return id;
}

export type EventHandler<T = Record<string, unknown>> = (
  event: EventEnvelope<T>,
  ctx: { tx: Tx; log: Logger },
) => Promise<void>;

export interface Subscription {
  type: EventType | string;
  handler: EventHandler<any>;
}

/** Typed helper for declaring subscriptions. */
export const on = <T extends EventType>(type: T, handler: EventHandler<EventData<T>>): Subscription => ({
  type,
  handler: handler as EventHandler<any>,
});

/**
 * Deliver an event to a consumer exactly once (per consumer). Runs the handler in a system
 * transaction scoped to the event's tenant, and records the event id in platform.inbox in the same
 * transaction so retries are no-ops.
 */
export async function consume(consumer: string, event: EventEnvelope, subs: Subscription[], log: Logger) {
  const matching = subs.filter((s) => s.type === event.type);
  if (!matching.length) return 'ignored' as const;
  return withSystem(async (tx) => {
    const inserted = await tx`
      insert into platform.inbox (consumer, event_id, event_type) values (${consumer}, ${event.id}, ${event.type})
      on conflict do nothing returning event_id`;
    if (!inserted.length) return 'duplicate' as const;
    for (const s of matching) await s.handler(event, { tx, log });
    return 'processed' as const;
  }, event.tenantId);
}

// ---------------------------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------------------------
type OutboxRow = {
  id: string;
  source: string;
  type: string;
  version: number;
  tenantId: string | null;
  actor: EmitActor | null;
  data: Record<string, unknown>;
  occurredAt: string;
};

const toEnvelope = (r: OutboxRow): EventEnvelope => ({
  id: r.id,
  type: r.type,
  version: r.version,
  occurredAt: r.occurredAt,
  source: r.source,
  tenantId: r.tenantId,
  actor: r.actor,
  data: r.data,
});

interface Transport {
  publish(events: EventEnvelope[]): Promise<void>;
}

/** Local transport: POST each event to every subscribed service's /internal/events endpoint. */
class HttpTransport implements Transport {
  constructor(private log: Logger) {}
  async publish(events: EventEnvelope[]) {
    if (!events.length) return;
    const types = [...new Set(events.map((e) => e.type))];
    const subs = await sql()<{ consumer: string; eventType: string; endpoint: string }[]>`
      select consumer, event_type, endpoint from platform.event_subscriptions where event_type in ${sql()(types)}`;
    for (const e of events) {
      for (const s of subs.filter((x) => x.eventType === e.type)) {
        let status = 'delivered';
        let error: string | null = null;
        try {
          const res = await fetch(s.endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-procure-internal': internalSecret() },
            body: JSON.stringify(e),
            signal: AbortSignal.timeout(15_000),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
        } catch (err) {
          status = 'failed';
          error = (err as Error).message;
          this.log.warn({ event: e.type, consumer: s.consumer, err: error }, 'event delivery failed');
        }
        await sql()`insert into platform.event_deliveries (event_id, consumer, status, error)
                    values (${e.id}, ${s.consumer}, ${status}, ${error})`;
        if (status === 'failed') throw new Error(`delivery to ${s.consumer} failed: ${error}`);
      }
    }
  }
}

/** AWS transport: EventBridge bus; rules route each detail-type to the consuming service's SQS queue. */
class EventBridgeTransport implements Transport {
  private client = new EventBridgeClient({ region: config().AWS_REGION });
  async publish(events: EventEnvelope[]) {
    for (let i = 0; i < events.length; i += 10) {
      const batch = events.slice(i, i + 10);
      const res = await this.client.send(
        new PutEventsCommand({
          Entries: batch.map((e) => ({
            EventBusName: config().EVENT_BUS_NAME,
            Source: `pro-cure.${e.source}`,
            DetailType: e.type,
            Detail: JSON.stringify(e),
          })),
        }),
      );
      if (res.FailedEntryCount) throw new Error(`EventBridge rejected ${res.FailedEntryCount} events`);
    }
  }
}

export const internalSecret = () => process.env.INTERNAL_SHARED_SECRET ?? 'local-internal-secret';

/**
 * Poll the outbox for this service's unpublished events and publish them. Uses SKIP LOCKED so many
 * replicas can run the relay concurrently.
 */
export function startOutboxRelay(source: string, log: Logger, intervalMs = 500) {
  const transport: Transport =
    config().EVENT_TRANSPORT === 'eventbridge' ? new EventBridgeTransport() : new HttpTransport(log);
  let stopped = false;
  let running = false;
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await withSystem(async (tx) => {
        const rows = await tx<OutboxRow[]>`
          select id, source, type, version, tenant_id, actor, data, occurred_at
          from platform.outbox
          where source = ${source} and published_at is null and attempts < 25
          order by occurred_at
          limit 50
          for update skip locked`;
        for (const r of rows) {
          try {
            await transport.publish([toEnvelope(r)]);
            await tx`update platform.outbox set published_at = now(), attempts = attempts + 1 where id = ${r.id}`;
          } catch (err) {
            await tx`update platform.outbox set attempts = attempts + 1, last_error = ${(err as Error).message}
                     where id = ${r.id}`;
          }
        }
      });
    } catch (err) {
      log.error({ err }, 'outbox relay tick failed');
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, intervalMs);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/** Local transport: register this service's subscriptions so the relay knows where to deliver. */
export async function registerSubscriptions(consumer: string, endpoint: string, subs: Subscription[]) {
  const types = [...new Set(subs.map((s) => s.type))];
  await withSystem(async (tx) => {
    await tx`delete from platform.event_subscriptions where consumer = ${consumer}`;
    for (const t of types)
      await tx`insert into platform.event_subscriptions (consumer, event_type, endpoint) values (${consumer}, ${t}, ${endpoint})`;
  });
}
