import { SERVICES, type ServiceName } from '@procure/domain';
import type { Principal } from './auth.js';
import { serviceUrl } from './config.js';
import { AppError } from './errors.js';
import { internalSecret } from './events.js';

/**
 * Synchronous service-to-service call, forwarding the caller's access token so the downstream service
 * applies the same tenant scope and permissions. Use for reads needed to answer a request; use events
 * for side effects.
 */
export async function callService<T = unknown>(
  service: ServiceName,
  path: string,
  opts: { principal?: Principal; method?: string; body?: unknown; query?: Record<string, unknown> } = {},
): Promise<T> {
  const base = serviceUrl(service, SERVICES[service].port);
  const url = new URL(path.replace(/^\//, ''), `${base}/`);
  for (const [k, v] of Object.entries(opts.query ?? {}))
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  const headers: Record<string, string> = { 'x-procure-internal': internalSecret() };
  if (opts.principal) headers.authorization = `Bearer ${opts.principal.token}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(url, {
    method: opts.method ?? (opts.body === undefined ? 'GET' : 'POST'),
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    throw new AppError(
      res.status >= 500 ? 502 : res.status,
      json?.code ?? 'upstream_error',
      `${service}: ${json?.title ?? res.statusText}`,
      json?.detail,
    );
  }
  return json as T;
}
