import { callService, type Principal } from '@procure/platform';

/**
 * Every synchronous call the orders service makes to other services. Kept in one module so tests can
 * replace it with `vi.mock('../src/clients.js')`.
 */

// ---------------------------------------------------------------- quoting
export interface OrderLine {
  id: string;
  specId: string | null;
  code: string;
  name: string;
  description: string | null;
  category: string | null;
  vendorId: string | null;
  vendorSku: string | null;
  finish: string | null;
  dimensions: string | null;
  locationName: string | null;
  quantity: number;
  unitCost: number | null;
  unitPrice?: number | null; // never stored or exposed by orders
  readyToOrder: boolean;
  poId: string | null;
}
export interface OrderLines {
  quote: { id: string; number: string; name: string; projectId: string; status: string };
  lines: OrderLine[];
}
export const getOrderLines = (tenantId: string, quoteId: string, lineIds?: string[]) =>
  callService<OrderLines>('quoting', `/internal/quotes/${quoteId}/order-lines`, {
    query: { tenantId, lineIds: lineIds?.length ? lineIds.join(',') : undefined },
  });

// ---------------------------------------------------------------- catalog
export interface Contact {
  name: string | null;
  email: string | null;
  phone: string | null;
}
export interface Vendor {
  id: string;
  name: string;
  orgId: string | null;
  website: string | null;
  categories: string[];
  profile: {
    leadTimeWeeks: number | null;
    shipMethod: string | null;
    freightTerms: string | null;
    paymentTerms: string | null;
    depositPct: number | null;
    primaryContact: Contact | null;
    rating: number | null;
    onTimeRate: number | null;
    preferred: boolean;
    accountNumber: string | null;
    /** Optional extras (catalog vendor_profiles.origin / transit_days). */
    origin?: 'domestic' | 'international' | null;
    transitDays?: number | null;
  } | null;
}
export const getVendor = (tenantId: string, vendorId: string) =>
  callService<Vendor>('catalog', `/internal/vendors/${vendorId}`, { query: { tenantId } });

// ---------------------------------------------------------------- projects
export interface Project {
  id: string;
  number: string;
  name: string;
  propertyName: string | null;
  brandId: string | null;
  clientOrgId: string | null;
  address: Record<string, unknown> | null;
  shipToAddress: Record<string, unknown> | null;
  targetOpenDate: string | null;
  stage: string;
  status: string;
  team: { userId: string; name: string; email: string; role: string }[];
  contacts?: {
    name: string;
    email: string | null;
    phone: string | null;
    company: string | null;
    role: string | null;
    isDeliveryRecipient: boolean;
  }[];
}
export const getProject = (tenantId: string, projectId: string) =>
  callService<Project>('projects', `/internal/projects/${projectId}`, { query: { tenantId } });

// ---------------------------------------------------------------- identity
export interface Org {
  id: string;
  name: string;
  address: Record<string, unknown>;
  phone: string | null;
  email: string | null;
  website: string | null;
}
export const getOrg = (principal: Principal, orgId: string) =>
  callService<Org>('identity', `/orgs/${orgId}`, { principal });

// ---------------------------------------------------------------- documents
export interface Document {
  id: string;
  filename: string;
  contentType: string;
  downloadUrl: string;
  [k: string]: unknown;
}
export interface RenderRequest {
  tenantId: string;
  template: 'purchase_order' | 'po_revision' | 'claim';
  data: Record<string, unknown>;
  filename: string;
  entityType?: string;
  entityId?: string;
  visibility: 'internal' | 'vendor' | 'client';
  vendorOrgId?: string | null;
  clientOrgId?: string | null;
}
export const renderReport = (body: RenderRequest) =>
  callService<Document>('documents', '/internal/reports/render', { body });

// ---------------------------------------------------------------- comms
export interface ThreadRequest {
  tenantId: string;
  entityType: 'purchase_order' | 'claim' | 'shipment';
  entityId: string;
  subject: string;
  visibility: 'internal' | 'vendor' | 'client';
  vendorOrgId?: string | null;
  clientOrgId?: string | null;
}
/** Idempotent on entity + visibility. Returns null when comms is unavailable (emails still go out, unthreaded). */
export async function openThread(body: ThreadRequest): Promise<string | null> {
  try {
    const t = await callService<{ id: string }>('comms', '/internal/threads', { body });
    return t?.id ?? null;
  } catch {
    return null;
  }
}
