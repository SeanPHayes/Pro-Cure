import { buildService, internalSecret } from '@procure/platform';
import { auth, type World } from '@procure/platform/testing';
import { quotingService } from '../src/service.js';

export type TestApp = Awaited<ReturnType<typeof buildService>>;
export const build = () => buildService(quotingService);

export const internal = { 'x-procure-internal': internalSecret() };

/** Thin JSON client around app.inject. */
export function client(app: TestApp, token: string) {
  const call = async (
    method: string,
    url: string,
    payload?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const res = await app.inject({
      method: method as never,
      url,
      headers: { ...auth(token), ...headers },
      ...(payload !== undefined ? { payload: payload as never } : {}),
    });
    const body = res.body
      ? res.headers['content-type']?.includes('json')
        ? res.json()
        : res.body
      : undefined;
    return { status: res.statusCode, body: body as any, headers: res.headers };
  };
  return {
    get: (u: string, h?: Record<string, string>) => call('GET', u, undefined, h),
    post: (u: string, b: unknown = {}, h?: Record<string, string>) => call('POST', u, b, h),
    patch: (u: string, b: unknown, h?: Record<string, string>) => call('PATCH', u, b, h),
    put: (u: string, b: unknown, h?: Record<string, string>) => call('PUT', u, b, h),
    del: (u: string, h?: Record<string, string>) => call('DELETE', u, undefined, h),
  };
}
export type Client = ReturnType<typeof client>;

/** Every key anywhere in a JSON value. */
export function allKeys(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) {
    for (const x of v) allKeys(x, out);
  } else if (v && typeof v === 'object')
    for (const [k, x] of Object.entries(v)) {
      out.add(k);
      allKeys(x, out);
    }
  return out;
}

export const uuid = () => crypto.randomUUID();

export const daysFromNow = (n: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** A small JMHS-style quote: rooms King ×62 / QQ ×48, locations Guestrooms>King, Public>Lobby. */
export async function seedQuote(c: Client, w: World, opts: { projectId?: string; vendorId?: string } = {}) {
  const vendorId = opts.vendorId ?? uuid();
  const projectId = opts.projectId ?? uuid();
  const mk = async (body: Record<string, unknown>) => {
    const r = await c.post('/specs', body);
    if (r.status !== 201) throw new Error(`spec create failed: ${JSON.stringify(r.body)}`);
    return r.body;
  };
  const suffix = uuid().slice(0, 6);
  const headboard = await mk({
    code: `CG-101-${suffix}`,
    name: 'King Headboard',
    category: 'casegoods',
    vendorId,
    vendorName: 'Kimball Hospitality',
    finish: 'Walnut',
    dimensions: '80"W x 2"D x 48"H',
    cost: 400,
    costExpiresAt: daysFromNow(90),
  });
  const nightstand = await mk({
    code: `CG-102-${suffix}`,
    name: 'Nightstand',
    category: 'casegoods',
    vendorId,
    vendorName: 'Kimball Hospitality',
    cost: 150,
    costExpiresAt: daysFromNow(90),
  });
  const carpet = await mk({
    code: `FL-1-${suffix}`,
    name: 'Broadloom carpet',
    category: 'carpet',
    unit: 'sy',
    cost: 20,
  });
  const q = (
    await c.post('/quotes', {
      projectId,
      name: 'Hampton Inn Raleigh',
      phase: 'Phase 1 – Guestrooms',
      defaultMarkupPct: 20,
    })
  ).body;
  const king = (await c.post(`/quotes/${q.id}/room-types`, { code: 'K', name: 'King', count: 62 })).body;
  const qq = (await c.post(`/quotes/${q.id}/room-types`, { code: 'QQ', name: 'Queen/Queen', count: 48 }))
    .body;
  const guest = (await c.post(`/quotes/${q.id}/locations`, { name: 'Guestrooms' })).body;
  const kingLoc = (
    await c.post(`/quotes/${q.id}/locations`, { name: 'King', parentId: guest.id, kind: 'room' })
  ).body;
  const pub = (await c.post(`/quotes/${q.id}/locations`, { name: 'Public' })).body;
  const lobby = (await c.post(`/quotes/${q.id}/locations`, { name: 'Lobby', parentId: pub.id, kind: 'room' }))
    .body;
  void w;
  return { q, king, qq, guest, kingLoc, pub, lobby, headboard, nightstand, carpet, vendorId, projectId };
}
