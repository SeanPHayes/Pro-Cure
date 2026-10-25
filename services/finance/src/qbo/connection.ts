import { conflict, type Db, type DbContext, unprocessable, withContext } from '@procure/platform';
import { qboApiBase, tokenKey } from '../config.js';
import { decryptSecret, encryptSecret } from '../domain/crypto.js';
import { HttpQboClient } from './http-client.js';
import { OAuthError, refreshTokens } from './oauth.js';
import { SimulatedQboClient } from './simulated-client.js';
import type { QboClient, QboSettings, TokenSet } from './types.js';

export interface ConnectionRow {
  id: string;
  tenantId: string;
  realmId: string;
  environment: 'sandbox' | 'production' | 'simulated';
  accessTokenEnc: string | null;
  refreshTokenEnc: string | null;
  accessExpiresAt: string | null;
  refreshExpiresAt: string | null;
  status: 'connected' | 'expired' | 'disconnected';
  connectedByName: string | null;
  connectedAt: string;
  lastSyncAt: string | null;
  lastError: string | null;
  syncLockUntil: string | null;
  settings: QboSettings;
}

export const DEFAULT_SETTINGS: QboSettings = {
  incomeAccountId: null,
  expenseAccountId: null,
  depositAccountId: null,
  bankAccountId: null,
  itemId: null,
  syncPayments: true,
};

export async function getConnection(tx: Db, tenantId: string): Promise<ConnectionRow | null> {
  const [c] = await tx<ConnectionRow[]>`select * from finance.qbo_connections where tenant_id = ${tenantId}`;
  return c ? { ...c, settings: { ...DEFAULT_SETTINGS, ...(c.settings ?? {}) } } : null;
}

export const encryptTokens = (t: TokenSet) => {
  const key = tokenKey();
  return {
    accessTokenEnc: encryptSecret(t.accessToken, key),
    refreshTokenEnc: encryptSecret(t.refreshToken, key),
    accessExpiresAt: t.accessExpiresAt,
    refreshExpiresAt: t.refreshExpiresAt,
  };
};

export const decryptTokens = (c: ConnectionRow): TokenSet => {
  if (!c.accessTokenEnc || !c.refreshTokenEnc || !c.accessExpiresAt)
    throw unprocessable('QuickBooks connection has no tokens; reconnect');
  const key = tokenKey();
  return {
    accessToken: decryptSecret(c.accessTokenEnc, key),
    refreshToken: decryptSecret(c.refreshTokenEnc, key),
    accessExpiresAt: c.accessExpiresAt,
    refreshExpiresAt: c.refreshExpiresAt,
  };
};

/** Insert or replace the tenant's connection. */
export async function saveConnection(
  tx: Db,
  tenantId: string,
  input: {
    realmId: string;
    environment: ConnectionRow['environment'];
    tokens: TokenSet | null;
    connectedByName: string | null;
  },
) {
  const enc = input.tokens
    ? encryptTokens(input.tokens)
    : { accessTokenEnc: null, refreshTokenEnc: null, accessExpiresAt: null, refreshExpiresAt: null };
  const [existing] = await tx<{ realmId: string; settings: QboSettings }[]>`
    select realm_id, settings from finance.qbo_connections where tenant_id = ${tenantId} for update`;
  if (existing) {
    // A different company file invalidates every QBO id we hold.
    if (existing.realmId !== input.realmId) {
      await tx`delete from finance.qbo_entity_map where tenant_id = ${tenantId}`;
      await resetSyncState(tx, tenantId);
    }
    await tx`
      update finance.qbo_connections set ${tx({
        realmId: input.realmId,
        environment: input.environment,
        ...enc,
        status: 'connected',
        connectedByName: input.connectedByName,
        lastError: null,
        syncLockUntil: null,
      })}, connected_at = now()
      where tenant_id = ${tenantId}`;
  } else {
    await tx`
      insert into finance.qbo_connections ${tx({
        tenantId,
        realmId: input.realmId,
        environment: input.environment,
        ...enc,
        status: 'connected',
        connectedByName: input.connectedByName,
        settings: tx.json({ ...DEFAULT_SETTINGS } as never) as never,
      })}`;
  }
}

/** Mark every local record as needing a fresh push (after switching company files). */
export async function resetSyncState(tx: Db, tenantId: string) {
  await tx`update finance.invoices set qbo_id = null, qbo_sync_status = 'pending', qbo_error = null, qbo_synced_at = null
           where tenant_id = ${tenantId}`;
  await tx`update finance.vendor_bills set qbo_id = null, qbo_sync_status = 'pending', qbo_error = null, qbo_synced_at = null
           where tenant_id = ${tenantId}`;
  await tx`update finance.payments set qbo_id = null, qbo_error = null where tenant_id = ${tenantId} and source = 'manual'`;
  await tx`update finance.bill_payments set qbo_id = null, qbo_error = null where tenant_id = ${tenantId}`;
}

/** Refresh the tenant's tokens now and persist them. Marks the connection expired on invalid_grant. */
export async function refreshConnection(ctx: DbContext, tenantId: string): Promise<TokenSet> {
  const conn = await withContext(ctx, (tx) => getConnection(tx, tenantId));
  if (!conn || conn.environment === 'simulated') throw unprocessable('No refreshable QuickBooks connection');
  try {
    const tokens = await refreshTokens(decryptTokens(conn).refreshToken);
    await persistTokens(ctx, tenantId, tokens);
    return tokens;
  } catch (err) {
    if (err instanceof OAuthError && err.isInvalidGrant)
      await withContext(ctx, (tx) =>
        markExpired(tx, tenantId, 'Refresh token rejected — reconnect QuickBooks'),
      );
    throw err;
  }
}

export const persistTokens = (ctx: DbContext, tenantId: string, tokens: TokenSet) =>
  withContext(ctx, async (tx) => {
    await tx`update finance.qbo_connections set ${tx(encryptTokens(tokens))}, status = 'connected', last_error = null
             where tenant_id = ${tenantId}`;
  });

export const markExpired = async (tx: Db, tenantId: string, message: string) => {
  await tx`update finance.qbo_connections set status = 'expired', last_error = ${message} where tenant_id = ${tenantId}`;
};

/** Factory (overridable in tests) for the QBO client of a connection. */
export const qboClientFactory = {
  create(conn: ConnectionRow, ctx: DbContext): QboClient {
    if (conn.environment === 'simulated') return new SimulatedQboClient();
    return new HttpQboClient({
      realmId: conn.realmId,
      environment: conn.environment,
      tokens: decryptTokens(conn),
      onTokens: (t) => persistTokens(ctx, conn.tenantId, t),
    });
  },
};

/** Take the per-tenant sync lock (5 minutes); throws 409 if a sync is already running. */
export async function acquireSyncLock(ctx: DbContext, tenantId: string, throwIfBusy = true) {
  const rows = await withContext(
    ctx,
    (tx) => tx`
      update finance.qbo_connections set sync_lock_until = now() + interval '5 minutes'
      where tenant_id = ${tenantId} and status = 'connected'
        and (sync_lock_until is null or sync_lock_until < now())
      returning id`,
  );
  if (!rows.length && throwIfBusy)
    throw conflict('A QuickBooks sync is already running, or QuickBooks is not connected');
  return rows.length > 0;
}

export const releaseSyncLock = (ctx: DbContext, tenantId: string, patch: { lastError: string | null }) =>
  withContext(ctx, async (tx) => {
    await tx`update finance.qbo_connections set sync_lock_until = null, last_sync_at = now(), last_error = ${patch.lastError}
             where tenant_id = ${tenantId}`;
  });

export const apiBaseFor = (env: ConnectionRow['environment']) =>
  env === 'simulated' ? 'simulated://quickbooks' : qboApiBase(env);
