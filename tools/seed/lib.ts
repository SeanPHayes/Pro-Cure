import { join } from 'node:path';
import type { Role, ServiceName } from '@procure/domain';
import {
  type App,
  buildService,
  consume,
  rootLogger,
  sql,
  type Subscription,
  withSystem,
} from '@procure/platform';
import { tokenFor } from '@procure/platform/testing';
import type { SeedIds } from './identity.js';

/**
 * In-process API client for seeding: builds each service's Fastify app and injects requests with a
 * real access token, so seeded data goes through validation, permissions, RLS and business rules.
 */
const apps = new Map<ServiceName, App>();
const subs = new Map<ServiceName, Subscription[]>();

async function load(name: ServiceName): Promise<App> {
  const cached = apps.get(name);
  if (cached) return cached;
  const mod = await import(join(process.cwd(), 'services', name, 'src', 'service.ts'));
  const def = mod[`${name}Service`];
  const app = await buildService(def, rootLogger(`seed:${name}`));
  apps.set(name, app);
  subs.set(name, def.subscriptions ?? []);
  return app;
}

export interface Actor {
  token: string;
  name: string;
}

export async function actor(
  ids: SeedIds,
  opts: {
    userId: string;
    orgId: string;
    actor?: 'internal' | 'vendor' | 'client';
    roles: Role[];
    name: string;
    email: string;
    orgName: string;
  },
): Promise<Actor> {
  const token = await tokenFor({
    userId: opts.userId,
    orgId: opts.orgId,
    tenantId: ids.tenantId,
    actor: opts.actor ?? 'internal',
    roles: opts.roles,
    name: opts.name,
    email: opts.email,
    orgName: opts.orgName,
  });
  return { token, name: opts.name };
}

export async function call<T = any>(
  who: Actor,
  service: ServiceName,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  body?: unknown,
): Promise<T> {
  const app = await load(service);
  const res = await app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${who.token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    payload: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.statusCode >= 400) {
    throw new Error(`${service} ${method} ${url} → ${res.statusCode}: ${res.body.slice(0, 800)}`);
  }
  return (res.body ? res.json() : undefined) as T;
}

/** Deliver every pending outbox event to every loaded service's subscriptions (no relay in seeding). */
export async function drainEvents(maxRounds = 10) {
  const log = rootLogger('seed:events');
  for (let round = 0; round < maxRounds; round++) {
    const rows = await withSystem(
      (tx) =>
        tx<any[]>`select id, source, type, version, tenant_id, actor, data, occurred_at from platform.outbox
                where published_at is null order by occurred_at limit 500`,
    );
    if (!rows.length) return;
    for (const r of rows) {
      const event = {
        id: r.id,
        type: r.type,
        version: r.version,
        occurredAt: r.occurredAt,
        source: r.source,
        tenantId: r.tenantId,
        actor: r.actor,
        data: r.data,
      };
      for (const [name, list] of subs) {
        if (!list.some((s) => s.type === r.type)) continue;
        try {
          await consume(name, event as never, list, log);
        } catch (err) {
          console.warn(`  ! ${name} failed handling ${r.type}: ${(err as Error).message}`);
        }
      }
      await sql()`update platform.outbox set published_at = now() where id = ${r.id}`;
    }
  }
}

export async function closeApps() {
  for (const a of apps.values()) await a.close();
}

/** Calendar helpers relative to "today" so the demo always looks current. */
export const day = (offset: number) => {
  const d = new Date();
  d.setUTCHours(12, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};
