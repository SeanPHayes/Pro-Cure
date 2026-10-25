import { buildService, closeDb, withOwner } from '@procure/platform';
import { auth, createWorld, type World } from '@procure/platform/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { tokenKey } from '../src/config.js';
import { decryptSecret, signState } from '../src/domain/crypto.js';
import { refreshExpiringTokens } from '../src/jobs.js';
import { qboClientFactory } from '../src/qbo/connection.js';
import { SimulatedQboClient } from '../src/qbo/simulated-client.js';
import { financeService } from '../src/service.js';
import { seedProject, stubClients, upstream } from './helpers.js';

let app: Awaited<ReturnType<typeof buildService>>;
let a: World;
let b: World;

beforeAll(async () => {
  app = await buildService(financeService);
  a = await createWorld('QboA');
  b = await createWorld('QboB');
});
beforeEach(() => {
  stubClients();
});
afterAll(async () => {
  await app.close();
  await closeDb();
});

const post = (token: string, url: string, payload: unknown = {}) =>
  app.inject({ method: 'POST', url, headers: auth(token), payload: payload as never });
const get = (token: string, url: string) => app.inject({ method: 'GET', url, headers: auth(token) });

describe('simulated QuickBooks', () => {
  it('connect + sync assigns QBO ids, logs every push, and is idempotent', async () => {
    const { projectId, quoteId } = seedProject(a, { sellTotal: 20_000 });
    const dep = (await post(a.adminToken, '/invoices/from-quote', { quoteId, kind: 'deposit' })).json();
    await post(a.adminToken, `/invoices/${dep.id}/send`, {});
    await post(a.adminToken, `/invoices/${dep.id}/payments`, { amount: 4000, reference: 'ACH-77' });
    const vendorId = crypto.randomUUID();
    upstream.vendors.set(vendorId, { id: vendorId, name: 'Sim Vendor', depositPct: null });
    const bill = (
      await post(a.adminToken, '/bills', { projectId, vendorId, number: 'SV-1', amount: 1500 })
    ).json();
    await post(a.adminToken, `/bills/${bill.id}/payments`, { amount: 500 });

    const before = (await get(a.adminToken, '/integrations/qbo')).json();
    expect(before).toMatchObject({ configured: false, connected: false });
    expect((await post(a.adminToken, '/integrations/qbo/connect')).statusCode).toBe(422);

    const sim = await post(a.adminToken, '/integrations/qbo/simulate');
    expect(sim.statusCode).toBe(201);
    expect(sim.json()).toMatchObject({
      connected: true,
      environment: 'simulated',
      pending: { invoices: 1, bills: 1 },
    });

    const r1 = await post(a.adminToken, '/integrations/qbo/sync', {});
    expect(r1.statusCode).toBe(200);
    expect(r1.json()).toMatchObject({
      customers: { success: 1, error: 0 },
      vendors: { success: 1, error: 0 },
      invoices: { success: 1, error: 0 },
      bills: { success: 1, error: 0 },
      payments: { success: 1, error: 0 },
      billPayments: { success: 1, error: 0 },
    });

    const inv = (await get(a.adminToken, `/invoices/${dep.id}`)).json();
    expect(inv.qboSyncStatus).toBe('synced');
    expect(inv.qboId).toMatch(/^SIM-INV-\d{4}-/);
    expect(inv.payments[0].qboId).toMatch(/^SIM-PMT-/);
    const b1 = (await get(a.adminToken, `/bills/${bill.id}`)).json();
    expect(b1.qboId).toMatch(/^SIM-BILL-/);
    expect(b1.payments[0].qboId).toMatch(/^SIM-BPMT-/);

    const log1 = (await get(a.adminToken, '/integrations/qbo/log?limit=100')).json();
    expect(log1.total).toBe(6);
    expect(log1.items.every((l: any) => l.status === 'success' && l.direction === 'push')).toBe(true);

    // Second run: nothing pending, nothing logged, ids unchanged.
    const r2 = (await post(a.adminToken, '/integrations/qbo/sync', {})).json();
    expect(r2.invoices).toEqual({ success: 0, error: 0 });
    expect(r2.customers).toEqual({ success: 0, error: 0 });
    expect((await get(a.adminToken, '/integrations/qbo/log')).json().total).toBe(6);

    // An edit re-queues the record; the same QBO id is reused (update, not duplicate).
    await app.inject({
      method: 'PATCH',
      url: `/bills/${bill.id}`,
      headers: auth(a.adminToken),
      payload: { notes: 'updated' },
    });
    const r3 = (await post(a.adminToken, '/integrations/qbo/sync', { entities: ['bills'] })).json();
    expect(r3.bills).toEqual({ success: 1, error: 0 });
    expect((await get(a.adminToken, `/bills/${bill.id}`)).json().qboId).toBe(b1.qboId);
    const maps = await withOwner(
      (tx) =>
        tx<
          { syncToken: string }[]
        >`select sync_token from finance.qbo_entity_map where local_id = ${bill.id} and entity_type = 'bill'`,
    );
    expect(maps[0]!.syncToken).toBe('1');

    const status = (await get(a.adminToken, '/integrations/qbo')).json();
    expect(status.lastSyncAt).not.toBeNull();
    expect(status.pending).toMatchObject({ invoices: 0, bills: 0, payments: 0, billPayments: 0, errors: 0 });

    // Tenant B sees none of A's sync state.
    expect((await get(b.adminToken, '/integrations/qbo/log')).json().total).toBe(0);
    expect((await get(b.adminToken, '/integrations/qbo')).json().connected).toBe(false);
  });

  it('pulls payments recorded in QuickBooks once (dedup by qbo id)', async () => {
    const { projectId } = seedProject(b);
    const inv = (
      await post(b.adminToken, '/invoices', { projectId, lines: [{ description: 'Fee', unitPrice: 1000 }] })
    ).json();
    await post(b.adminToken, `/invoices/${inv.id}/send`, {});
    await post(b.adminToken, '/integrations/qbo/simulate');
    await post(b.adminToken, '/integrations/qbo/sync', {});
    const qboInvId = (await get(b.adminToken, `/invoices/${inv.id}`)).json().qboId;

    class PayingClient extends SimulatedQboClient {
      override async paymentsSince() {
        return [
          {
            Id: 'QBO-PAY-1',
            SyncToken: '0',
            TxnDate: '2026-10-20',
            TotalAmt: 250,
            PaymentRefNum: '1044',
            PaymentMethodRef: { value: '2', name: 'Check' },
            CustomerRef: { value: 'c' },
            Line: [{ Amount: 250, LinkedTxn: [{ TxnId: qboInvId, TxnType: 'Invoice' }] }],
          },
        ];
      }
    }
    const spy = vi.spyOn(qboClientFactory, 'create').mockReturnValue(new PayingClient());
    const r1 = (await post(b.adminToken, '/integrations/qbo/sync', { entities: ['payments'] })).json();
    expect(r1.pulledPayments).toEqual({ success: 1, error: 0 });
    const r2 = (await post(b.adminToken, '/integrations/qbo/sync', { entities: ['payments'] })).json();
    expect(r2.pulledPayments).toEqual({ success: 0, error: 0 });
    spy.mockRestore();

    const after = (await get(b.adminToken, `/invoices/${inv.id}`)).json();
    expect(after).toMatchObject({ status: 'partially_paid', amountPaid: 250, balance: 750 });
    expect(after.payments).toHaveLength(1);
    expect(after.payments[0]).toMatchObject({
      source: 'qbo',
      qboId: 'QBO-PAY-1',
      method: 'check',
      reference: '1044',
    });
    // Pulled payment is not pushed back.
    const r3 = (await post(b.adminToken, '/integrations/qbo/sync', { entities: ['payments'] })).json();
    expect(r3.payments).toEqual({ success: 0, error: 0 });
  });

  it('per-record QBO errors are logged and retried on the next run', async () => {
    const { projectId } = seedProject(a);
    const inv = (
      await post(a.adminToken, '/invoices', { projectId, lines: [{ description: 'E', unitPrice: 10 }] })
    ).json();
    await post(a.adminToken, `/invoices/${inv.id}/send`, {});
    class Failing extends SimulatedQboClient {
      override async saveInvoice(): Promise<never> {
        throw new Error('Business Validation Error: invalid date');
      }
    }
    const spy = vi.spyOn(qboClientFactory, 'create').mockReturnValue(new Failing());
    const r = (await post(a.adminToken, '/integrations/qbo/sync', { entities: ['invoices'] })).json();
    expect(r.invoices.error).toBe(1);
    spy.mockRestore();
    const failed = (await get(a.adminToken, `/invoices/${inv.id}`)).json();
    expect(failed).toMatchObject({
      qboSyncStatus: 'error',
      qboError: 'Business Validation Error: invalid date',
    });
    expect(
      (await get(a.adminToken, `/integrations/qbo/log?status=error&localId=${inv.id}`)).json().total,
    ).toBe(1);
    const ok = (await post(a.adminToken, '/integrations/qbo/sync', { entities: ['invoices'] })).json();
    expect(ok.invoices.success).toBe(1);
    expect((await get(a.adminToken, `/invoices/${inv.id}`)).json().qboSyncStatus).toBe('synced');
  });

  it('settings and disconnect require integrations:write', async () => {
    const viewer = await a.tokenAs(['project_manager']);
    expect((await post(viewer, '/integrations/qbo/sync', {})).statusCode).toBe(403);
    const res = await app.inject({
      method: 'PATCH',
      url: '/integrations/qbo/settings',
      headers: auth(a.adminToken),
      payload: { incomeAccountId: '79', syncPayments: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().settings).toMatchObject({ incomeAccountId: '79', syncPayments: true });
  });
});

describe('real QuickBooks OAuth', () => {
  beforeEach(() => {
    process.env.QBO_CLIENT_ID = 'client-123';
    process.env.QBO_CLIENT_SECRET = 'shh';
    process.env.QBO_REDIRECT_URI = 'https://api.example.com/api/finance/integrations/qbo/callback';
  });
  const cleanup = () => {
    delete process.env.QBO_CLIENT_ID;
    delete process.env.QBO_CLIENT_SECRET;
    delete process.env.QBO_REDIRECT_URI;
    vi.unstubAllGlobals();
  };

  it('connect returns the Intuit authorize URL with signed state; callback stores encrypted tokens', async () => {
    try {
      const w = await createWorld('OAuth');
      const res = await post(w.adminToken, '/integrations/qbo/connect');
      expect(res.statusCode).toBe(200);
      const url = new URL(res.json().authorizeUrl);
      expect(url.origin + url.pathname).toBe('https://appcenter.intuit.com/connect/oauth2');
      expect(url.searchParams.get('scope')).toBe('com.intuit.quickbooks.accounting');
      expect(url.searchParams.get('client_id')).toBe('client-123');
      expect(url.searchParams.get('response_type')).toBe('code');
      expect(url.searchParams.get('redirect_uri')).toBe(process.env.QBO_REDIRECT_URI);
      const state = url.searchParams.get('state')!;

      const fetchMock = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              access_token: 'AT-1',
              refresh_token: 'RT-1',
              expires_in: 3600,
              x_refresh_token_expires_in: 8_726_400,
              token_type: 'bearer',
            }),
            { status: 200 },
          ),
      );
      vi.stubGlobal('fetch', fetchMock);
      const cb = await app.inject({
        method: 'GET',
        url: `/integrations/qbo/callback?code=AUTH&realmId=4620816365&state=${encodeURIComponent(state)}`,
      });
      expect(cb.statusCode).toBe(302);
      expect(cb.headers.location).toBe('http://localhost:5173/app/settings/integrations?qbo=connected');
      const body = String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body);
      expect(body).toContain('grant_type=authorization_code');
      expect(body).toContain('code=AUTH');

      const [row] = await withOwner(
        (tx) => tx<
          { accessTokenEnc: string; refreshTokenEnc: string; realmId: string; environment: string }[]
        >`
          select access_token_enc, refresh_token_enc, realm_id, environment from finance.qbo_connections where tenant_id = ${w.tenantId}`,
      );
      expect(row).toMatchObject({ realmId: '4620816365', environment: 'sandbox' });
      expect(row!.accessTokenEnc).not.toContain('AT-1');
      expect(decryptSecret(row!.accessTokenEnc, tokenKey())).toBe('AT-1');
      expect(decryptSecret(row!.refreshTokenEnc, tokenKey())).toBe('RT-1');

      const status = (await get(w.adminToken, '/integrations/qbo')).json();
      expect(status).toMatchObject({ configured: true, connected: true, environment: 'sandbox' });
      expect(JSON.stringify(status)).not.toContain('AT-1');

      // Token-refresh job: expire the token, run, and verify rotation.
      await withOwner(
        (tx) =>
          tx`update finance.qbo_connections set access_expires_at = now() + interval '2 minutes' where tenant_id = ${w.tenantId}`,
      );
      fetchMock.mockImplementation(
        async () =>
          new Response(
            JSON.stringify({
              access_token: 'AT-2',
              refresh_token: 'RT-2',
              expires_in: 3600,
              token_type: 'bearer',
            }),
            { status: 200 },
          ),
      );
      const { rootLogger } = await import('@procure/platform');
      const r = await withOwner((tx) => refreshExpiringTokens(tx, rootLogger('test')));
      expect(r.refreshed).toBeGreaterThanOrEqual(1);
      const [rotated] = await withOwner(
        (tx) =>
          tx<
            { refreshTokenEnc: string }[]
          >`select refresh_token_enc from finance.qbo_connections where tenant_id = ${w.tenantId}`,
      );
      expect(decryptSecret(rotated!.refreshTokenEnc, tokenKey())).toBe('RT-2');

      const dis = await post(w.adminToken, '/integrations/qbo/disconnect');
      expect(dis.json()).toMatchObject({ connected: false, status: 'disconnected' });
    } finally {
      cleanup();
    }
  });

  it('rejects a tampered or forged state with 400', async () => {
    try {
      const res = await post(a.adminToken, '/integrations/qbo/connect');
      const state = new URL(res.json().authorizeUrl).searchParams.get('state')!;
      const [body, sig] = state.split('.');
      const payload = JSON.parse(Buffer.from(body!, 'base64url').toString());
      const forgedBody = Buffer.from(JSON.stringify({ ...payload, tenantId: b.tenantId })).toString(
        'base64url',
      );
      const tampered = await app.inject({
        method: 'GET',
        url: `/integrations/qbo/callback?code=x&realmId=1&state=${encodeURIComponent(`${forgedBody}.${sig}`)}`,
      });
      expect(tampered.statusCode).toBe(400);
      expect(tampered.json().title).toMatch(/Invalid OAuth state/);

      const wrongKey = signState({ tenantId: a.tenantId }, Buffer.alloc(32, 1));
      const forged = await app.inject({
        method: 'GET',
        url: `/integrations/qbo/callback?code=x&realmId=1&state=${encodeURIComponent(wrongKey)}`,
      });
      expect(forged.statusCode).toBe(400);
      const missing = await app.inject({ method: 'GET', url: '/integrations/qbo/callback?code=x&realmId=1' });
      expect(missing.statusCode).toBe(400);
    } finally {
      cleanup();
    }
  });
});
