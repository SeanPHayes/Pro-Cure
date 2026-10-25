import { type DbContext, emit, hours, type Job, minutes, type Tx } from '@procure/platform';
import type { Logger } from './log.js';
import { refreshConnection } from './qbo/connection.js';
import { SyncEngine } from './qbo/sync.js';

/** Context for per-tenant background work: RLS-scoped to one tenant, attributed to Pro-Cure. */
const tenantCtx = (tenantId: string): DbContext => ({
  tenantId,
  userId: null,
  orgId: null,
  actor: 'service',
  userName: 'Pro-Cure',
});

/** Sent / partially paid invoices past due → overdue, and one notification per tenant to accounting. */
export async function markOverdue(tx: Tx, asOf: string) {
  const rows = await tx<
    { id: string; tenantId: string; number: string; balance: number; clientName: string }[]
  >`
    update finance.invoices set status = 'overdue'
    where status in ('sent', 'partially_paid') and due_date < ${asOf} and balance > 0
    returning id, tenant_id, number, balance, client_name`;
  type Row = (typeof rows)[number];
  const byTenant = new Map<string, Row[]>();
  for (const r of rows) byTenant.set(r.tenantId, [...(byTenant.get(r.tenantId) ?? []), r]);
  for (const [tenantId, list] of byTenant) {
    const total = list.reduce((s, r) => s + r.balance, 0);
    const one = list.length === 1 ? list[0]! : null;
    await emit(
      tx,
      'finance',
      'cmd.notify',
      {
        userIds: [],
        roles: ['accounting'],
        title: one ? `Invoice ${one.number} is overdue` : `${list.length} invoices became overdue`,
        body: one
          ? `${one.clientName} owes $${one.balance.toFixed(2)} on ${one.number}.`
          : `${list.map((r) => r.number).join(', ')} — $${total.toFixed(2)} outstanding.`,
        link: one ? `/app/invoices/${one.id}` : '/app/invoices?overdue=true',
        severity: 'warning',
      },
      { tenantId, actor: null },
    );
  }
  return { marked: rows.length, tenants: byTenant.size };
}

export async function syncAllTenants(tx: Tx, log: Logger) {
  const tenants = await tx<{ tenantId: string }[]>`
    select tenant_id from finance.qbo_connections
    where status = 'connected' and (sync_lock_until is null or sync_lock_until < now())`;
  let synced = 0;
  let failed = 0;
  for (const { tenantId } of tenants) {
    try {
      const r = await new SyncEngine(tenantCtx(tenantId), tenantId, { log }).run(undefined, false);
      if (r) synced++;
    } catch (err) {
      failed++;
      log.warn({ tenantId, err: (err as Error).message }, 'qbo sync failed for tenant');
    }
  }
  return { tenants: tenants.length, synced, failed };
}

export async function refreshExpiringTokens(tx: Tx, log: Logger) {
  const rows = await tx<{ tenantId: string }[]>`
    select tenant_id from finance.qbo_connections
    where status = 'connected' and environment <> 'simulated' and refresh_token_enc is not null
      and access_expires_at < now() + interval '10 minutes'`;
  let refreshed = 0;
  let failed = 0;
  for (const { tenantId } of rows) {
    try {
      await refreshConnection(tenantCtx(tenantId), tenantId);
      refreshed++;
    } catch (err) {
      failed++;
      log.warn({ tenantId, err: (err as Error).message }, 'qbo token refresh failed');
    }
  }
  return { due: rows.length, refreshed, failed };
}

export const jobs: Job[] = [
  {
    name: 'invoice-overdue',
    everyMs: hours(24),
    initialDelayMs: minutes(1),
    run: ({ tx, now }) => markOverdue(tx, now.toISOString().slice(0, 10)),
  },
  { name: 'qbo-sync', everyMs: minutes(15), run: ({ tx, log }) => syncAllTenants(tx, log) },
  { name: 'qbo-token-refresh', everyMs: minutes(30), run: ({ tx, log }) => refreshExpiringTokens(tx, log) },
];
