import { type App, withOwner } from '@procure/platform';
import { auth, type World } from '@procure/platform/testing';
import { expect } from 'vitest';

type Res = Awaited<ReturnType<App['inject']>>;

export const post = async (
  app: App,
  url: string,
  token: string,
  payload?: unknown,
  status = 0,
): Promise<Res> => {
  const res = await app.inject({ method: 'POST', url, headers: auth(token), payload: payload as never });
  if (status) expect(res.statusCode, res.body).toBe(status);
  return res;
};
export const get = async (app: App, url: string, token: string, status = 0): Promise<Res> => {
  const res = await app.inject({ method: 'GET', url, headers: auth(token) });
  if (status) expect(res.statusCode, res.body).toBe(status);
  return res;
};
export const patch = async (
  app: App,
  url: string,
  token: string,
  payload: unknown,
  status = 0,
): Promise<Res> => {
  const res = await app.inject({ method: 'PATCH', url, headers: auth(token), payload: payload as never });
  if (status) expect(res.statusCode, res.body).toBe(status);
  return res;
};
export const put = async (
  app: App,
  url: string,
  token: string,
  payload: unknown,
  status = 0,
): Promise<Res> => {
  const res = await app.inject({ method: 'PUT', url, headers: auth(token), payload: payload as never });
  if (status) expect(res.statusCode, res.body).toBe(status);
  return res;
};

export const createProject = async (app: App, w: World, extra: Record<string, unknown> = {}) =>
  (
    await post(
      app,
      '/projects',
      w.adminToken,
      {
        name: 'Home2 Suites Raleigh Renovation',
        propertyName: 'Home2 Suites Raleigh Durham Airport',
        clientOrgId: w.clientOrgId,
        type: 'renovation',
        stage: 'design',
        keys: 118,
        address: { line1: '1 Airport Blvd', city: 'Morrisville', region: 'NC', postalCode: '27560' },
        budget: 1250000,
        creditTerms: 'Net 30, 50% deposit',
        ...extra,
      },
      201,
    )
  ).json();

/** Outbox rows written by this service for a tenant, newest first. */
export const outbox = (tenantId: string, type?: string) =>
  withOwner(
    (tx) =>
      tx<{ type: string; data: Record<string, any>; actor: Record<string, any> | null }[]>`
      select type, data, actor from platform.outbox
      where source = 'projects' and tenant_id = ${tenantId} ${type ? tx`and type = ${type}` : tx``}
      order by occurred_at desc`,
  );

export const isWeekend = (d: string) => {
  const w = new Date(`${d}T00:00:00Z`).getUTCDay();
  return w === 0 || w === 6;
};
