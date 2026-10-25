import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpQboClient, QboFaultError } from '../src/qbo/http-client.js';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const tokens = (expiresInMs: number) => ({
  accessToken: 'old-access',
  refreshToken: 'old-refresh',
  accessExpiresAt: new Date(Date.now() + expiresInMs).toISOString(),
  refreshExpiresAt: null,
});

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  process.env.QBO_CLIENT_ID = 'cid';
  process.env.QBO_CLIENT_SECRET = 'secret';
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.QBO_CLIENT_ID;
  delete process.env.QBO_CLIENT_SECRET;
});

describe('HttpQboClient', () => {
  it('builds REST v3 requests against the sandbox with minorversion and bearer auth', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { Invoice: { Id: '42', SyncToken: '0' } }));
    const c = new HttpQboClient({ realmId: '9130', environment: 'sandbox', tokens: tokens(3_600_000) });
    const res = await c.saveInvoice('local', {
      DocNumber: 'INV-26-0001',
      TxnDate: '2026-10-01',
      DueDate: '2026-10-31',
      CustomerRef: { value: '7' },
      Line: [],
    });
    expect(res).toEqual({ Id: '42', SyncToken: '0' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(
      'https://sandbox-quickbooks.api.intuit.com/v3/company/9130/invoice?minorversion=73',
    );
    expect(init.method).toBe('POST');
    expect(init.headers.authorization).toBe('Bearer old-access');
    expect(JSON.parse(init.body)).toMatchObject({ DocNumber: 'INV-26-0001', CustomerRef: { value: '7' } });
  });

  it('uses the production host and void operation', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { Invoice: { Id: '42', SyncToken: '3' } }));
    const c = new HttpQboClient({ realmId: '1', environment: 'production', tokens: tokens(3_600_000) });
    await c.voidInvoice('x', { Id: '42', SyncToken: '2' });
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      'https://quickbooks.api.intuit.com/v3/company/1/invoice?operation=void&minorversion=73',
    );
  });

  it('refreshes an expired access token first and persists the rotated tokens', async () => {
    fetchMock
      .mockResolvedValueOnce(
        json(200, {
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          expires_in: 3600,
          x_refresh_token_expires_in: 8_640_000,
          token_type: 'bearer',
        }),
      )
      .mockResolvedValueOnce(json(200, { Customer: { Id: '5', SyncToken: '0' } }));
    const onTokens = vi.fn(async () => {});
    const c = new HttpQboClient({ realmId: '9130', environment: 'sandbox', tokens: tokens(-1000), onTokens });
    await c.createCustomer('x', { DisplayName: 'Lakeside' });
    const [tokenUrl, tokenInit] = fetchMock.mock.calls[0]!;
    expect(String(tokenUrl)).toBe('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer');
    expect(tokenInit.headers.authorization).toBe(`Basic ${Buffer.from('cid:secret').toString('base64')}`);
    expect(tokenInit.body).toBe('grant_type=refresh_token&refresh_token=old-refresh');
    expect(fetchMock.mock.calls[1]![1].headers.authorization).toBe('Bearer new-access');
    expect(onTokens).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: 'new-access', refreshToken: 'new-refresh' }),
    );
    expect(c.currentTokens.refreshToken).toBe('new-refresh');
  });

  it('refreshes once on a 401 and retries the call', async () => {
    fetchMock
      .mockResolvedValueOnce(
        json(401, { fault: { type: 'AUTHENTICATION', error: [{ message: 'expired', code: '3200' }] } }),
      )
      .mockResolvedValueOnce(
        json(200, { access_token: 'a2', refresh_token: 'r2', expires_in: 3600, token_type: 'bearer' }),
      )
      .mockResolvedValueOnce(json(200, { Vendor: { Id: '9', SyncToken: '0' } }));
    const c = new HttpQboClient({ realmId: '1', environment: 'sandbox', tokens: tokens(3_600_000) });
    expect(await c.createVendor('x', { DisplayName: 'Acme' })).toEqual({ Id: '9', SyncToken: '0' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('retries 429 / 5xx with backoff, honoring Retry-After', async () => {
    const sleep = vi.fn(async () => {});
    fetchMock
      .mockResolvedValueOnce(
        json(429, { Fault: { Error: [{ Message: 'Throttled' }] } }, { 'retry-after': '2' }),
      )
      .mockResolvedValueOnce(json(503, {}))
      .mockResolvedValueOnce(json(200, { Bill: { Id: '11', SyncToken: '0' } }));
    const c = new HttpQboClient({
      realmId: '1',
      environment: 'sandbox',
      tokens: tokens(3_600_000),
      sleep,
      backoffMs: 100,
    });
    expect(
      await c.saveBill('x', {
        DocNumber: 'B',
        TxnDate: '2026-10-01',
        DueDate: '2026-10-08',
        VendorRef: { value: '1' },
        Line: [],
      }),
    ).toEqual({
      Id: '11',
      SyncToken: '0',
    });
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls[0]).toEqual([2000]);
    expect((sleep.mock.calls[1] as unknown as [number])[0]).toBeGreaterThanOrEqual(200);
  });

  it('gives up after max retries and maps QBO Fault to an error', async () => {
    fetchMock.mockImplementation(async () =>
      json(429, { Fault: { Error: [{ Message: 'Throttled' }], type: 'SERVICE' } }),
    );
    const c = new HttpQboClient({
      realmId: '1',
      environment: 'sandbox',
      tokens: tokens(3_600_000),
      sleep: async () => {},
      maxRetries: 2,
    });
    await expect(c.createVendor('x', { DisplayName: 'A' })).rejects.toBeInstanceOf(QboFaultError);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('maps a 400 validation Fault', async () => {
    fetchMock.mockResolvedValueOnce(
      json(400, {
        Fault: {
          type: 'ValidationFault',
          Error: [
            {
              Message: 'Duplicate Name Exists Error',
              Detail: 'The name supplied already exists.',
              code: '6240',
            },
          ],
        },
      }),
    );
    const c = new HttpQboClient({ realmId: '1', environment: 'sandbox', tokens: tokens(3_600_000) });
    const err = (await c.createCustomer('x', { DisplayName: 'Dup' }).catch((e) => e)) as QboFaultError;
    expect(err).toBeInstanceOf(QboFaultError);
    expect(err.status).toBe(422);
    expect(err.message).toContain('Duplicate Name Exists Error');
    expect(err.errors[0]!.code).toBe('6240');
  });

  it('queries payments since a timestamp', async () => {
    fetchMock.mockResolvedValueOnce(
      json(200, {
        QueryResponse: {
          Payment: [
            { Id: 'P1', SyncToken: '0', TxnDate: '2026-10-01', TotalAmt: 10, CustomerRef: { value: '1' } },
          ],
        },
      }),
    );
    const c = new HttpQboClient({ realmId: '1', environment: 'sandbox', tokens: tokens(3_600_000) });
    const res = await c.paymentsSince('2026-10-01T00:00:00.000Z');
    expect(res).toHaveLength(1);
    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.pathname).toBe('/v3/company/1/query');
    expect(url.searchParams.get('query')).toContain(
      "from Payment where MetaData.LastUpdatedTime >= '2026-10-01T00:00:00.000Z'",
    );
  });
});
