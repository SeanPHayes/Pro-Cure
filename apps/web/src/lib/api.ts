import type { ServiceName } from '@procure/domain';

/**
 * Thin client over the Pro-Cure REST API (/api/<service>/...). Handles the bearer token, a single
 * refresh-and-retry on 401, and RFC 9457 problem responses (thrown as ApiError).
 */

export interface Session {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  user: { id: string; email: string; name: string };
  context: {
    orgId: string;
    orgName: string;
    orgType: 'procurement_firm' | 'vendor' | 'client' | 'platform';
    tenantId: string;
    actor: 'internal' | 'vendor' | 'client' | 'platform';
    roles: string[];
    permissions: string[];
  };
  contexts: {
    orgId: string;
    orgName: string;
    orgType: string;
    tenantId: string;
    tenantName: string;
    roles: string[];
  }[];
}

const KEY = 'procure.session';
let session: Session | null = (() => {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
})();
const listeners = new Set<(s: Session | null) => void>();

export const getSession = () => session;
export const setSession = (s: Session | null) => {
  session = s;
  try {
    if (s) localStorage.setItem(KEY, JSON.stringify(s));
    else localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable: keep in memory */
  }
  for (const l of listeners) l(s);
};
export const onSession = (fn: (s: Session | null) => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public detail?: unknown,
    public errors?: { path: string; message: string }[],
  ) {
    super(message);
  }
}

type Query = Record<string, string | number | boolean | null | undefined | string[]>;

const buildUrl = (service: ServiceName, path: string, query?: Query) => {
  const url = new URL(`/api/${service}${path.startsWith('/') ? path : `/${path}`}`, window.location.origin);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined || v === null || v === '') continue;
    url.searchParams.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  return url.toString().replace(window.location.origin, '');
};

let refreshing: Promise<boolean> | null = null;
async function refresh(): Promise<boolean> {
  if (!session?.refreshToken) return false;
  refreshing ??= (async () => {
    try {
      const res = await fetch('/api/identity/auth/refresh', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: session?.refreshToken }),
      });
      if (!res.ok) {
        setSession(null);
        return false;
      }
      setSession(toSession(await res.json()));
      return true;
    } finally {
      setTimeout(() => {
        refreshing = null;
      }, 0);
    }
  })();
  return refreshing;
}

export const toSession = (r: any): Session => ({
  accessToken: r.accessToken,
  refreshToken: r.refreshToken,
  expiresAt: Date.now() + r.expiresIn * 1000,
  user: r.user,
  context: r.context,
  contexts: r.contexts,
});

async function request<T>(
  method: string,
  service: ServiceName,
  path: string,
  opts: {
    query?: Query;
    body?: unknown;
    form?: FormData;
    headers?: Record<string, string>;
    raw?: boolean;
  } = {},
  retried = false,
): Promise<T> {
  if (session && session.expiresAt - Date.now() < 30_000 && !retried) await refresh();
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (session) headers.authorization = `Bearer ${session.accessToken}`;
  let body: BodyInit | undefined;
  if (opts.form) body = opts.form;
  else if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(buildUrl(service, path, opts.query), { method, headers, body });
  if (res.status === 401 && !retried && session) {
    if (await refresh()) return request(method, service, path, opts, true);
  }
  if (opts.raw) {
    if (!res.ok) throw new ApiError(res.status, 'error', res.statusText);
    return res as unknown as T;
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const json = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    throw new ApiError(
      res.status,
      json?.code ?? 'error',
      json?.title ?? res.statusText,
      json?.detail,
      json?.errors,
    );
  }
  return json as T;
}

export const api = {
  get: <T>(s: ServiceName, p: string, query?: Query) => request<T>('GET', s, p, { query }),
  post: <T>(s: ServiceName, p: string, body?: unknown, query?: Query) =>
    request<T>('POST', s, p, { body: body ?? {}, query }),
  put: <T>(s: ServiceName, p: string, body?: unknown) => request<T>('PUT', s, p, { body: body ?? {} }),
  patch: <T>(s: ServiceName, p: string, body?: unknown, headers?: Record<string, string>) =>
    request<T>('PATCH', s, p, { body: body ?? {}, headers }),
  del: <T>(s: ServiceName, p: string, query?: Query) => request<T>('DELETE', s, p, { query }),
  upload: <T>(s: ServiceName, p: string, form: FormData) => request<T>('POST', s, p, { form }),
  raw: (s: ServiceName, p: string, query?: Query) => request<Response>('GET', s, p, { query, raw: true }),
};

/** URL a browser element (<a>, <img>, <iframe>) can load directly; the token rides as a query param. */
export const documentUrl = (documentId: string, download = false) =>
  `/api/documents/documents/${documentId}/download?token=${encodeURIComponent(session?.accessToken ?? '')}${
    download ? '&download=1' : ''
  }`;

export const can = (perm: string) => !!session?.context.permissions.includes(perm);

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export const errorMessage = (e: unknown): string => {
  if (e instanceof ApiError) {
    if (e.errors?.length)
      return `${e.message}: ${e.errors.map((x) => `${x.path || 'request'} ${x.message}`).join('; ')}`;
    if (typeof e.detail === 'string') return `${e.message} (${e.detail})`;
    return e.message;
  }
  return e instanceof Error ? e.message : 'Something went wrong';
};
