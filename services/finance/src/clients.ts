import { callService, type Principal } from '@procure/platform';

/**
 * Synchronous reads from other services. Grouped in one object so tests can replace individual
 * calls (`vi.spyOn(clients, 'quoteSummary')`). Internal endpoints take `tenantId` and do not need
 * a user token, so they also work from event handlers and jobs.
 */

export interface QuoteSummary {
  id: string;
  number: string;
  name: string;
  status: string;
  costTotal: number;
  sellTotal: number;
  approvedAt: string | null;
}

export interface PoSummary {
  id: string;
  number: string;
  vendorId: string;
  status: string;
  total: number;
  issuedAt: string | null;
}

export interface VendorInfo {
  id: string;
  name: string;
  orgId: string | null;
  website: string | null;
  profile: {
    paymentTerms: string | null;
    depositPct: number | null;
    primaryContact: { name: string; email: string; phone: string } | null;
    accountNumber: string | null;
  } | null;
}

export interface ProjectInfo {
  id: string;
  number: string;
  name: string;
  propertyName: string | null;
  clientOrgId: string | null;
  address: Record<string, unknown> | null;
  status: string;
  stage?: string;
  contacts?: {
    name: string;
    email: string | null;
    phone: string | null;
    company: string | null;
    role: string;
  }[];
}

export interface OrgInfo {
  id: string;
  type: string;
  name: string;
  legalName?: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  address: Record<string, unknown>;
}

export interface RenderedDocument {
  id: string;
  filename: string;
}

export interface RenderRequest {
  tenantId: string;
  template: string;
  data: unknown;
  filename: string;
  entityType?: string;
  entityId?: string;
  visibility: 'internal' | 'vendor' | 'client';
  clientOrgId?: string;
}

export const clients = {
  async quoteSummary(tenantId: string, projectId: string): Promise<QuoteSummary[]> {
    const r = await callService<{ quotes: QuoteSummary[] }>('quoting', '/internal/quotes/summary', {
      query: { tenantId, projectId },
    });
    return r.quotes;
  },

  /** Quote header (incl. projectId) via quoting's order-lines endpoint with no lines requested. */
  async quoteHeader(
    tenantId: string,
    quoteId: string,
  ): Promise<{ id: string; number: string; name: string; projectId: string; status: string }> {
    const r = await callService<{
      quote: { id: string; number: string; name: string; projectId: string; status: string };
    }>('quoting', `/internal/quotes/${quoteId}/order-lines`, { query: { tenantId, lineIds: '' } });
    return r.quote;
  },

  async poSummary(tenantId: string, projectId: string): Promise<PoSummary[]> {
    const r = await callService<{ pos: PoSummary[] }>('orders', '/internal/purchase-orders/summary', {
      query: { tenantId, projectId },
    });
    return r.pos;
  },

  vendor(tenantId: string, vendorId: string): Promise<VendorInfo> {
    return callService<VendorInfo>('catalog', `/internal/vendors/${vendorId}`, { query: { tenantId } });
  },

  project(tenantId: string, projectId: string): Promise<ProjectInfo> {
    return callService<ProjectInfo>('projects', `/internal/projects/${projectId}`, { query: { tenantId } });
  },

  projects(tenantId: string, ids: string[]): Promise<ProjectInfo[]> {
    if (!ids.length) return Promise.resolve([]);
    return callService<ProjectInfo[]>('projects', '/internal/projects', {
      query: { tenantId, ids: ids.join(',') },
    });
  },

  /** identity GET /orgs/:id is a user route, so it needs the caller's token. */
  async org(principal: Principal | null, orgId: string): Promise<OrgInfo | null> {
    if (!principal) return null;
    return callService<OrgInfo>('identity', `/orgs/${orgId}`, { principal });
  },

  renderReport(req: RenderRequest): Promise<RenderedDocument> {
    return callService<RenderedDocument>('documents', '/internal/reports/render', { body: req });
  },
};

export type Clients = typeof clients;

/** Run a read that may fail; return `fallback` and push a warning instead of failing the request. */
export async function tolerant<T>(
  warnings: string[],
  what: string,
  fn: () => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    warnings.push(`${what} unavailable: ${(err as Error).message}`);
    return fallback;
  }
}
