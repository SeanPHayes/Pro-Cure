import { internalSecret, withOwner } from '@procure/platform';
import type { World } from '@procure/platform/testing';
import { vi } from 'vitest';
import { clients, type ProjectInfo, type QuoteSummary } from '../src/clients.js';

/**
 * Upstream services are not running in finance tests: every cross-service read goes through
 * `clients`, which is stubbed per world here.
 */
export interface Upstream {
  projects: Map<string, ProjectInfo>;
  quotes: Map<string, QuoteSummary[]>;
  pos: Map<
    string,
    { id: string; number: string; vendorId: string; status: string; total: number; issuedAt: string | null }[]
  >;
  vendors: Map<string, { id: string; name: string; depositPct: number | null; paymentTerms?: string | null }>;
  rendered: { template: string; data: any; clientOrgId?: string }[];
  quotingDown: boolean;
}

export const upstream: Upstream = {
  projects: new Map(),
  quotes: new Map(),
  pos: new Map(),
  vendors: new Map(),
  rendered: [],
  quotingDown: false,
};

export function stubClients() {
  vi.spyOn(clients, 'project').mockImplementation(async (_t, id) => {
    const p = upstream.projects.get(id);
    if (!p) throw Object.assign(new Error('projects: Project not found'), { status: 404 });
    return p;
  });
  vi.spyOn(clients, 'projects').mockImplementation(async (_t, ids) =>
    ids.map((id) => upstream.projects.get(id)).filter((p): p is ProjectInfo => Boolean(p)),
  );
  vi.spyOn(clients, 'quoteSummary').mockImplementation(async (_t, projectId) => {
    if (upstream.quotingDown) throw new Error('quoting: connect ECONNREFUSED');
    return upstream.quotes.get(projectId) ?? [];
  });
  vi.spyOn(clients, 'quoteHeader').mockImplementation(async (_t, quoteId) => {
    for (const [projectId, qs] of upstream.quotes) {
      const q = qs.find((x) => x.id === quoteId);
      if (q) return { id: q.id, number: q.number, name: q.name, status: q.status, projectId };
    }
    throw Object.assign(new Error('quoting: not found'), { status: 404 });
  });
  vi.spyOn(clients, 'poSummary').mockImplementation(
    async (_t, projectId) => upstream.pos.get(projectId) ?? [],
  );
  vi.spyOn(clients, 'vendor').mockImplementation(async (_t, vendorId) => {
    const v = upstream.vendors.get(vendorId);
    if (!v) throw new Error('catalog: Vendor not found');
    return {
      id: v.id,
      name: v.name,
      orgId: null,
      website: null,
      profile: {
        depositPct: v.depositPct,
        paymentTerms: v.paymentTerms ?? null,
        primaryContact: null,
        accountNumber: null,
      },
    };
  });
  vi.spyOn(clients, 'org').mockImplementation(async (_p, orgId) => ({
    id: orgId,
    type: 'client',
    name: `Org ${orgId.slice(0, 4)}`,
    phone: null,
    email: null,
    website: null,
    address: {},
  }));
  vi.spyOn(clients, 'renderReport').mockImplementation(async (req) => {
    upstream.rendered.push({ template: req.template, data: req.data, clientOrgId: req.clientOrgId });
    return { id: crypto.randomUUID(), filename: req.filename };
  });
}

/** Register a project (with owner contacts) and an approved quote for a world. */
export function seedProject(
  w: World,
  opts: { sellTotal?: number; costTotal?: number; status?: string } = {},
) {
  const projectId = crypto.randomUUID();
  const quoteId = crypto.randomUUID();
  upstream.projects.set(projectId, {
    id: projectId,
    number: `P-26-${projectId.slice(0, 4)}`,
    name: 'Hampton Inn Raleigh',
    propertyName: 'Hampton Inn Raleigh Downtown',
    clientOrgId: w.clientOrgId,
    address: { city: 'Raleigh', region: 'NC' },
    status: 'active',
    contacts: [
      {
        name: 'Olivia Owner',
        email: 'olivia@owner.example',
        phone: null,
        company: 'Lakeside',
        role: 'owner_rep',
      },
      { name: 'Gary GM', email: 'gm@hotel.example', phone: null, company: 'Hotel', role: 'gm' },
      {
        name: 'Ian Installer',
        email: 'ian@install.example',
        phone: null,
        company: 'Install Co',
        role: 'installer',
      },
    ],
  });
  upstream.quotes.set(projectId, [
    {
      id: quoteId,
      number: 'Q-26-0012',
      name: 'Guestroom FF&E',
      status: opts.status ?? 'client_approved',
      costTotal: opts.costTotal ?? 80_000,
      sellTotal: opts.sellTotal ?? 100_000,
      approvedAt: new Date().toISOString(),
    },
  ]);
  return { projectId, quoteId };
}

export const internalHeaders = { 'x-procure-internal': internalSecret() };

export const event = (tenantId: string, type: string, data: Record<string, unknown>) => ({
  id: crypto.randomUUID(),
  type,
  version: 1,
  occurredAt: new Date().toISOString(),
  source: 'test',
  tenantId,
  actor: null,
  data,
});

export const outbox = (tenantId: string, type: string) =>
  withOwner(
    (tx) => tx<{ data: any; occurredAt: string }[]>`
      select data, occurred_at from platform.outbox where tenant_id = ${tenantId} and type = ${type} order by occurred_at`,
  );
