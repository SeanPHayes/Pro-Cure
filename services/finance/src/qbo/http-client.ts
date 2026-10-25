import { AppError } from '@procure/platform';
import { QBO_MINOR_VERSION, qboApiBase } from '../config.js';
import { refreshTokens } from './oauth.js';
import type {
  QboBillInput,
  QboBillPaymentInput,
  QboClient,
  QboCustomerInput,
  QboEntity,
  QboInvoiceInput,
  QboPayment,
  QboPaymentInput,
  QboVendorInput,
  TokenSet,
} from './types.js';

/** A QBO `Fault` response mapped to an application error. */
export class QboFaultError extends AppError {
  constructor(
    public readonly httpStatus: number,
    public readonly faultType: string | null,
    public readonly errors: { code: string | null; message: string; detail: string | null }[],
  ) {
    const first = errors[0];
    const msg = first ? `${first.message}${first.detail ? ` — ${first.detail}` : ''}` : `HTTP ${httpStatus}`;
    const status =
      httpStatus === 401 || httpStatus === 403
        ? 502
        : httpStatus === 400 || httpStatus === 404
          ? 422
          : httpStatus === 429
            ? 503
            : 502;
    super(status, 'qbo_fault', `QuickBooks: ${msg}`, { faultType, errors });
  }
  get isAuth() {
    return this.httpStatus === 401 || this.faultType === 'AUTHENTICATION';
  }
  /** Stale object error (someone edited the record in QBO). */
  get isStale() {
    return this.errors.some((e) => e.code === '5010');
  }
}

export interface HttpQboClientOptions {
  realmId: string;
  environment: 'sandbox' | 'production';
  tokens: TokenSet;
  /** Persist rotated tokens (called after every refresh). */
  onTokens?: (t: TokenSet) => Promise<void>;
  maxRetries?: number;
  /** Base backoff in ms; doubles per attempt (+ jitter). Honors Retry-After when present. */
  backoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Real QuickBooks Online REST v3 client. */
export class HttpQboClient implements QboClient {
  readonly kind = 'http' as const;
  private tokens: TokenSet;
  private readonly base: string;
  private readonly maxRetries: number;
  private readonly backoffMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly opts: HttpQboClientOptions) {
    this.tokens = opts.tokens;
    this.base = `${qboApiBase(opts.environment)}/v3/company/${encodeURIComponent(opts.realmId)}`;
    this.maxRetries = opts.maxRetries ?? 4;
    this.backoffMs = opts.backoffMs ?? 500;
    this.sleep = opts.sleep ?? defaultSleep;
    this.now = opts.now ?? Date.now;
  }

  /** Current tokens (after any refresh). */
  get currentTokens(): TokenSet {
    return this.tokens;
  }

  url(path: string, params: Record<string, string> = {}) {
    const u = new URL(`${this.base}/${path.replace(/^\//, '')}`);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    u.searchParams.set('minorversion', String(QBO_MINOR_VERSION));
    return u.toString();
  }

  /** Refresh when the access token expires within 60 seconds. */
  async ensureFreshToken(force = false) {
    const expiresAt = Date.parse(this.tokens.accessExpiresAt);
    if (!force && expiresAt - this.now() > 60_000) return;
    this.tokens = await refreshTokens(this.tokens.refreshToken);
    await this.opts.onTokens?.(this.tokens);
  }

  async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    params: Record<string, string> = {},
  ) {
    await this.ensureFreshToken();
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(this.url(path, params), {
          method,
          headers: {
            authorization: `Bearer ${this.tokens.accessToken}`,
            accept: 'application/json',
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(30_000),
        });
      } catch (err) {
        if (attempt < this.maxRetries) {
          await this.sleep(this.delay(attempt, null));
          continue;
        }
        throw new AppError(502, 'qbo_unreachable', `QuickBooks unreachable: ${(err as Error).message}`);
      }
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        await this.ensureFreshToken(true);
        attempt--;
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < this.maxRetries) {
        await res.text().catch(() => '');
        await this.sleep(this.delay(attempt, res.headers.get('retry-after')));
        continue;
      }
      const text = await res.text();
      let json: any;
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        json = {};
      }
      const fault = json.Fault ?? json.fault;
      if (!res.ok || fault) throw toFault(res.status, fault);
      return json as T;
    }
  }

  private delay(attempt: number, retryAfter: string | null) {
    const ra = retryAfter ? Number(retryAfter) : Number.NaN;
    if (Number.isFinite(ra) && ra >= 0) return ra * 1000;
    return this.backoffMs * 2 ** attempt + Math.floor(Math.random() * this.backoffMs * 0.25);
  }

  private async post<K extends string>(entity: K, body: unknown, params: Record<string, string> = {}) {
    const res = await this.request<Record<string, any>>('POST', entity.toLowerCase(), body, params);
    const obj = res[entity];
    if (!obj?.Id) throw new AppError(502, 'qbo_fault', `QuickBooks returned no ${entity}`);
    return { Id: String(obj.Id), SyncToken: String(obj.SyncToken ?? '0') };
  }

  createCustomer(_localId: string, input: QboCustomerInput) {
    return this.post('Customer', input);
  }
  createVendor(_localId: string, input: QboVendorInput) {
    return this.post('Vendor', input);
  }
  saveInvoice(_localId: string, input: QboInvoiceInput) {
    return this.post('Invoice', input);
  }
  voidInvoice(_localId: string, ref: QboEntity) {
    return this.post('Invoice', { Id: ref.Id, SyncToken: ref.SyncToken }, { operation: 'void' });
  }
  saveBill(_localId: string, input: QboBillInput) {
    return this.post('Bill', input);
  }
  async deleteBill(_localId: string, ref: QboEntity) {
    await this.request('POST', 'bill', { Id: ref.Id, SyncToken: ref.SyncToken }, { operation: 'delete' });
  }
  createPayment(_localId: string, input: QboPaymentInput) {
    return this.post('Payment', input);
  }
  createBillPayment(_localId: string, input: QboBillPaymentInput) {
    return this.post('BillPayment', input);
  }

  async paymentsSince(since: string): Promise<QboPayment[]> {
    const out: QboPayment[] = [];
    const pageSize = 500;
    for (let start = 1; ; start += pageSize) {
      const q = `select * from Payment where MetaData.LastUpdatedTime >= '${since.replace(/'/g, '')}' startposition ${start} maxresults ${pageSize}`;
      const res = await this.request<{ QueryResponse?: { Payment?: QboPayment[] } }>(
        'GET',
        'query',
        undefined,
        {
          query: q,
        },
      );
      const rows = res.QueryResponse?.Payment ?? [];
      out.push(...rows);
      if (rows.length < pageSize) return out;
    }
  }
}

function toFault(status: number, fault: any): QboFaultError {
  const errs: any[] = fault?.Error ?? fault?.error ?? [];
  return new QboFaultError(
    status,
    fault?.type ?? null,
    errs.map((e) => ({
      code: e.code ?? null,
      message: e.Message ?? e.message ?? 'Error',
      detail: e.Detail ?? e.detail ?? null,
    })),
  );
}
