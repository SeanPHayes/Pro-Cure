import type { ActorType } from '@procure/domain';
import postgres from 'postgres';
import { config } from './config.js';

export type Sql = postgres.Sql<Record<string, unknown>>;
export type Tx = postgres.TransactionSql<Record<string, unknown>>;
export type Db = Sql | Tx;

/**
 * Who a database transaction runs as. These values are written to transaction-local settings
 * (`app.*`) which the row-level-security policies and the audit trigger read. `system` is used only
 * by background jobs and the event relay, never by request handlers.
 */
export interface DbContext {
  tenantId: string | null;
  userId: string | null;
  orgId: string | null;
  actor: ActorType | 'system';
  userName?: string | null;
}

const typeOptions = {
  // NUMERIC -> number (amounts are rounded to <= 4dp; see domain/money.ts)
  numeric: {
    to: 1700,
    from: [1700],
    serialize: (x: unknown) => String(x),
    parse: (x: string) => Number.parseFloat(x),
  },
  // BIGINT -> number (counts/ids well below 2^53)
  bigint: { to: 20, from: [20], serialize: (x: unknown) => String(x), parse: (x: string) => Number(x) },
  // DATE -> 'YYYY-MM-DD' string (no timezone shifting)
  date: { to: 1082, from: [1082], serialize: (x: unknown) => String(x), parse: (x: string) => x },
  // TIMESTAMPTZ -> ISO-8601 string
  timestamptz: {
    to: 1184,
    from: [1184, 1114],
    serialize: (x: unknown) => (x instanceof Date ? x.toISOString() : String(x)),
    parse: (x: string) => new Date(x).toISOString(),
  },
};

const make = (url: string, max: number): Sql =>
  postgres(url, {
    max,
    idle_timeout: 30,
    connect_timeout: 10,
    transform: postgres.camel,
    types: typeOptions,
    onnotice: () => {},
  }) as unknown as Sql;

let appPool: Sql | undefined;
let ownerPool: Sql | undefined;

/** Pool for the application role (RLS enforced). */
export const sql = (): Sql => {
  appPool ??= make(config().DATABASE_URL, config().DB_POOL_MAX);
  return appPool;
};

/** Pool for the schema-owner role. Migrations and seeding only. */
export const ownerSql = (): Sql => {
  ownerPool ??= make(config().MIGRATION_DATABASE_URL, 2);
  return ownerPool;
};

export const closeDb = async () => {
  await Promise.all([appPool?.end({ timeout: 5 }), ownerPool?.end({ timeout: 5 })]);
  appPool = undefined;
  ownerPool = undefined;
};

export const applyContext = async (tx: Tx, ctx: DbContext) => {
  await tx`
    select
      set_config('app.tenant_id', ${ctx.tenantId ?? ''}, true),
      set_config('app.user_id', ${ctx.userId ?? ''}, true),
      set_config('app.org_id', ${ctx.orgId ?? ''}, true),
      set_config('app.actor_type', ${ctx.actor}, true),
      set_config('app.user_name', ${ctx.userName ?? ''}, true)
  `;
};

/** Run `fn` in a transaction with the given tenant/actor context applied. */
export const withContext = <T>(ctx: DbContext, fn: (tx: Tx) => Promise<T>, pool: Sql = sql()): Promise<T> =>
  pool.begin(async (tx) => {
    await applyContext(tx as Tx, ctx);
    return fn(tx as Tx);
  }) as Promise<T>;

export const SYSTEM_CONTEXT: DbContext = { tenantId: null, userId: null, orgId: null, actor: 'system' };

/** Background work that must see every tenant (relay, scheduled jobs). */
export const withSystem = <T>(fn: (tx: Tx) => Promise<T>, tenantId: string | null = null): Promise<T> =>
  withContext({ ...SYSTEM_CONTEXT, tenantId }, fn);

/**
 * Work on behalf of a tenant without a user (event handlers, internal endpoints called by other
 * services). RLS still scopes every query to `tenantId`.
 */
export const withTenant = <T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> =>
  withContext({ tenantId, userId: null, orgId: null, actor: 'service', userName: 'Pro-Cure' }, fn);

/** Seeding / tests / admin tooling: system context on the schema-owner connection. */
export const withOwner = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> =>
  withContext(SYSTEM_CONTEXT, fn, ownerSql());

/** Escape hatch for building dynamic ORDER BY safely from an allow-list. */
export const orderBy = (
  tx: Db,
  sort: string | undefined,
  allowed: Record<string, string>,
  fallback: string,
) => {
  const raw = sort ?? fallback;
  const desc = raw.startsWith('-');
  const key = desc ? raw.slice(1) : raw;
  const col = allowed[key] ?? allowed[fallback.replace(/^-/, '')]!;
  return tx.unsafe(`${col} ${desc ? 'desc' : 'asc'} nulls last`);
};
