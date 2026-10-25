import { callService, type Principal } from '@procure/platform';

/**
 * Every synchronous call quoting makes to another service lives here so tests can `vi.mock` it.
 * All calls use the internal endpoints with an explicit tenantId (contracts in docs/service-contracts.md).
 */

export interface VendorInfo {
  id: string;
  name: string;
  orgId: string | null;
  website: string | null;
  categories: string[];
  profile: {
    leadTimeWeeks: number | null;
    preferred: boolean;
    primaryContact: { name: string; email: string; phone: string | null } | null;
    [k: string]: unknown;
  } | null;
}

export interface ProjectInfo {
  id: string;
  number: string;
  name: string;
  propertyName: string | null;
  brandId: string | null;
  clientOrgId: string | null;
  address: Record<string, unknown> | null;
  team?: { userId: string; name: string; email: string; role: string }[];
  contacts?: {
    name: string;
    email: string | null;
    phone: string | null;
    company: string | null;
    role: string | null;
    isDeliveryRecipient?: boolean;
  }[];
}

export interface BrandStandardItem {
  id: string;
  code: string;
  name: string;
  category?: string | null;
  description?: string | null;
  dimensions?: string | null;
  finish?: string | null;
  materials?: string | null;
  vendorId?: string | null;
  [k: string]: unknown;
}

export interface BrandStandard {
  id: string;
  brandId: string;
  brandName: string;
  name: string;
  version: string | number | null;
  items: BrandStandardItem[];
}

export interface DocumentInfo {
  id: string;
  filename: string;
  kind: string;
  includeInSpecBook?: boolean;
  [k: string]: unknown;
}

export interface OrgInfo {
  id: string;
  name: string;
  address?: Record<string, unknown>;
  phone?: string | null;
  email?: string | null;
}

export const catalog = {
  vendor: (tenantId: string, vendorId: string) =>
    callService<VendorInfo>('catalog', `/internal/vendors/${vendorId}`, { query: { tenantId } }),
  brandStandard: (tenantId: string, id: string) =>
    callService<BrandStandard>('catalog', `/internal/brand-standards/${id}`, { query: { tenantId } }),
};

export const projects = {
  get: (tenantId: string, id: string) =>
    callService<ProjectInfo>('projects', `/internal/projects/${id}`, { query: { tenantId } }),
};

export const documents = {
  render: (body: {
    tenantId: string;
    template: string;
    data: unknown;
    filename: string;
    entityType?: string;
    entityId?: string;
    visibility: 'internal' | 'vendor' | 'client';
    vendorOrgId?: string | null;
    clientOrgId?: string | null;
  }) => callService<DocumentInfo>('documents', '/internal/reports/render', { method: 'POST', body }),
  list: (tenantId: string, entityType: string, entityId: string) =>
    callService<DocumentInfo[]>('documents', '/internal/documents', {
      query: { tenantId, entityType, entityId },
    }),
};

export const identity = {
  /** Organization (tenant letterhead for rendered PDFs). Forwards the caller's token. */
  org: (principal: Principal, id: string) => callService<OrgInfo>('identity', `/orgs/${id}`, { principal }),
};

/** Run `fn`, returning null (and calling onError) instead of throwing. For optional enrichment. */
export async function tolerate<T>(fn: () => Promise<T>, onError?: (e: unknown) => void): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    onError?.(e);
    return null;
  }
}
