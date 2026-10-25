import {
  type App,
  badRequest,
  config,
  type DbContext,
  unprocessable,
  withTenant,
  z,
} from '@procure/platform';
import { financeConfig, tokenKey } from '../config.js';
import { InvalidStateError, signState, verifyState } from '../domain/crypto.js';
import {
  DEFAULT_SETTINGS,
  decryptTokens,
  getConnection,
  refreshConnection,
  saveConnection,
} from '../qbo/connection.js';
import { authorizeUrl, exchangeCode, OAuthError, revokeToken } from '../qbo/oauth.js';
import { ALL_SYNC_ENTITIES, SyncEngine } from '../qbo/sync.js';
import {
  page,
  QboSettings,
  QboStatus,
  SyncBody,
  SyncLogEntry,
  SyncLogQuery,
  SyncResult,
} from '../schemas.js';

const TAGS = ['quickbooks'];

const reqCtx = (p: {
  tenantId: string;
  userId: string;
  orgId: string;
  actor: string;
  name: string;
}): DbContext => ({
  tenantId: p.tenantId,
  userId: p.userId,
  orgId: p.orgId,
  actor: p.actor as DbContext['actor'],
  userName: p.name,
});

export async function integrationRoutes(app: App) {
  const status = async (tenantId: string, run: <T>(fn: (tx: any) => Promise<T>) => Promise<T>) =>
    run(async (tx) => {
      const conn = await getConnection(tx, tenantId);
      const [pending] = await tx<
        { invoices: number; bills: number; payments: number; billPayments: number; errors: number }[]
      >`
        select
          (select count(*)::int from finance.invoices where qbo_sync_status = 'pending' and status <> 'draft') as invoices,
          (select count(*)::int from finance.vendor_bills where qbo_sync_status = 'pending') as bills,
          (select count(*)::int from finance.payments p join finance.invoices i on i.id = p.invoice_id
             where p.qbo_id is null and p.source = 'manual' and i.status <> 'draft') as payments,
          (select count(*)::int from finance.bill_payments where qbo_id is null) as bill_payments,
          ((select count(*)::int from finance.invoices where qbo_sync_status = 'error')
            + (select count(*)::int from finance.vendor_bills where qbo_sync_status = 'error')) as errors`;
      const connected = conn?.status === 'connected';
      return {
        configured: financeConfig().qboConfigured,
        connected,
        status: conn?.status ?? null,
        environment: conn?.environment ?? null,
        realmId: conn?.realmId ?? null,
        connectedByName: conn?.connectedByName ?? null,
        connectedAt: conn?.connectedAt ?? null,
        lastSyncAt: conn?.lastSyncAt ?? null,
        lastError: conn?.lastError ?? null,
        accessExpiresAt: conn?.accessExpiresAt ?? null,
        settings: conn?.settings ?? DEFAULT_SETTINGS,
        pending: pending!,
      };
    });

  app.get(
    '/integrations/qbo',
    {
      schema: {
        tags: TAGS,
        summary: 'QuickBooks Online connection status and pending sync counts',
        response: { 200: QboStatus },
      },
    },
    async (req) => {
      req.principal.require('finance:read');
      return status(req.principal.tenantId, (fn) => req.tx(fn));
    },
  );

  app.post(
    '/integrations/qbo/connect',
    {
      schema: {
        tags: TAGS,
        summary: 'Start the Intuit OAuth2 flow; returns the authorize URL to redirect the user to',
        response: { 200: z.object({ authorizeUrl: z.string(), state: z.string() }) },
      },
    },
    async (req) => {
      req.principal.require('integrations:write');
      if (!financeConfig().qboConfigured)
        throw unprocessable(
          'QuickBooks credentials are not configured; use POST /integrations/qbo/simulate for a demo connection',
        );
      const state = signState({ tenantId: req.principal.tenantId, userName: req.principal.name }, tokenKey());
      return { authorizeUrl: authorizeUrl(state), state };
    },
  );

  app.get(
    '/integrations/qbo/callback',
    {
      config: { public: true },
      schema: {
        tags: TAGS,
        summary:
          'Intuit OAuth2 redirect target (public): verifies state, stores encrypted tokens, redirects to the app',
        querystring: z.object({
          code: z.string().optional(),
          state: z.string().optional(),
          realmId: z.string().optional(),
          error: z.string().optional(),
          error_description: z.string().optional(),
        }),
      },
    },
    async (req, reply) => {
      const q = req.query;
      if (!q.state) throw badRequest('Missing state');
      let state: ReturnType<typeof verifyState>;
      try {
        state = verifyState(q.state, tokenKey());
      } catch (err) {
        if (err instanceof InvalidStateError) throw badRequest(`Invalid OAuth state: ${err.message}`);
        throw err;
      }
      const back = (result: string, message?: string) => {
        const url = new URL(`${config().PUBLIC_WEB_URL}/app/settings/integrations`);
        url.searchParams.set('qbo', result);
        if (message) url.searchParams.set('message', message.slice(0, 200));
        return reply.redirect(url.toString(), 302);
      };
      if (q.error) return back('error', q.error_description ?? q.error);
      if (!q.code || !q.realmId) throw badRequest('Missing code or realmId');
      try {
        const tokens = await exchangeCode(q.code);
        await withTenant(state.tenantId, (tx) =>
          saveConnection(tx, state.tenantId, {
            realmId: q.realmId!,
            environment: financeConfig().QBO_ENVIRONMENT,
            tokens,
            connectedByName: state.userName,
          }),
        );
      } catch (err) {
        req.log.warn({ err: (err as Error).message }, 'qbo oauth callback failed');
        if (err instanceof OAuthError) return back('error', err.message);
        throw err;
      }
      return back('connected');
    },
  );

  app.post(
    '/integrations/qbo/simulate',
    {
      schema: {
        tags: TAGS,
        summary: 'Create a simulated QuickBooks connection (only when Intuit credentials are not configured)',
        response: { 201: QboStatus },
      },
    },
    async (req, reply) => {
      req.principal.require('integrations:write');
      if (financeConfig().qboConfigured && config().APP_ENV === 'production')
        throw unprocessable('QuickBooks is configured; connect a real company instead');
      const tenantId = req.principal.tenantId;
      await req.tx(async (tx) => {
        await saveConnection(tx, tenantId, {
          realmId: `SIM-${tenantId.slice(0, 8)}`,
          environment: 'simulated',
          tokens: null,
          connectedByName: req.principal.name,
        });
        // Records created before connecting are synced on the first run.
        await tx`update finance.invoices set qbo_sync_status = 'pending'
                 where qbo_sync_status = 'not_synced' and status not in ('draft', 'void')`;
        await tx`update finance.vendor_bills set qbo_sync_status = 'pending'
                 where qbo_sync_status = 'not_synced' and status <> 'void'`;
      });
      return reply.status(201).send(await status(tenantId, (fn) => req.tx(fn)));
    },
  );

  app.post(
    '/integrations/qbo/disconnect',
    {
      schema: {
        tags: TAGS,
        summary: 'Disconnect QuickBooks (revokes tokens; keeps the id map for reconnecting the same company)',
        response: { 200: QboStatus },
      },
    },
    async (req) => {
      req.principal.require('integrations:write');
      const tenantId = req.principal.tenantId;
      const conn = await req.tx((tx) => getConnection(tx, tenantId));
      if (conn && conn.environment !== 'simulated' && conn.refreshTokenEnc) {
        try {
          await revokeToken(decryptTokens(conn).refreshToken);
        } catch {
          // token undecryptable — still disconnect locally
        }
      }
      await req.tx(
        (tx) => tx`update finance.qbo_connections set status = 'disconnected', access_token_enc = null,
                     refresh_token_enc = null, access_expires_at = null, refresh_expires_at = null, sync_lock_until = null
                   where tenant_id = ${tenantId}`,
      );
      return status(tenantId, (fn) => req.tx(fn));
    },
  );

  app.patch(
    '/integrations/qbo/settings',
    {
      schema: {
        tags: TAGS,
        summary: 'Set QuickBooks account/item mappings and whether payments sync',
        body: QboSettings.partial(),
        response: { 200: QboStatus },
      },
    },
    async (req) => {
      req.principal.require('integrations:write');
      const tenantId = req.principal.tenantId;
      await req.tx(async (tx) => {
        const conn = await getConnection(tx, tenantId);
        if (!conn) throw unprocessable('Connect QuickBooks first');
        const settings = { ...conn.settings, ...req.body };
        await tx`update finance.qbo_connections set settings = ${tx.json(settings as never)} where tenant_id = ${tenantId}`;
      });
      return status(tenantId, (fn) => req.tx(fn));
    },
  );

  app.post(
    '/integrations/qbo/sync',
    {
      schema: {
        tags: TAGS,
        summary:
          'Push pending customers, vendors, invoices, bills and payments; pull payments recorded in QuickBooks',
        body: SyncBody,
        response: { 200: SyncResult },
      },
    },
    async (req) => {
      req.principal.require('integrations:write');
      const p = req.principal;
      const conn = await req.tx((tx) => getConnection(tx, p.tenantId));
      if (!conn || conn.status !== 'connected')
        throw unprocessable(
          conn?.status === 'expired'
            ? 'QuickBooks authorization expired — reconnect'
            : 'QuickBooks is not connected',
        );
      const engine = new SyncEngine(reqCtx(p), p.tenantId, { principal: p, log: req.log });
      const result = await engine.run(req.body.entities ?? ALL_SYNC_ENTITIES);
      if (!result) throw unprocessable('QuickBooks is not connected');
      return result;
    },
  );

  app.post(
    '/integrations/qbo/refresh',
    {
      schema: {
        tags: TAGS,
        summary: 'Refresh the QuickBooks access token now',
        response: { 200: QboStatus },
      },
    },
    async (req) => {
      req.principal.require('integrations:write');
      await refreshConnection(reqCtx(req.principal), req.principal.tenantId);
      return status(req.principal.tenantId, (fn) => req.tx(fn));
    },
  );

  app.get(
    '/integrations/qbo/log',
    {
      schema: {
        tags: TAGS,
        summary: 'QuickBooks sync log (newest first)',
        querystring: SyncLogQuery,
        response: { 200: page(SyncLogEntry) },
      },
    },
    async (req) => {
      req.principal.require('finance:read');
      const q = req.query;
      return req.tx(async (tx) => {
        const where = tx`where true
          ${q.entityType ? tx`and entity_type = ${q.entityType}` : tx``}
          ${q.status ? tx`and status = ${q.status}` : tx``}
          ${q.localId ? tx`and local_id = ${q.localId}` : tx``}
          ${q.q ? tx`and (coalesce(message, '') || ' ' || coalesce(qbo_id, '')) ilike ${`%${q.q}%`}` : tx``}`;
        const [items, [count]] = await Promise.all([
          tx`select * from finance.qbo_sync_log ${where} order by created_at desc, id limit ${q.limit} offset ${q.offset}`,
          tx<{ n: number }[]>`select count(*)::int as n from finance.qbo_sync_log ${where}`,
        ]);
        return { items: items as never, total: count!.n, limit: q.limit, offset: q.offset };
      });
    },
  );
}
