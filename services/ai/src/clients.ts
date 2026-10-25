import type { ServiceName, SpecCategory } from '@procure/domain';
import { AppError, callService as rawCallService } from '@procure/platform';

/**
 * callService, but a connection failure ("fetch failed", timeouts) names the service that is down, so the
 * job error a reviewer sees says "orders is unavailable" instead of a bare network message.
 */
const callService = async <T>(service: ServiceName, path: string, opts?: Parameters<typeof rawCallService>[2]) => {
  try {
    return await rawCallService<T>(service, path, opts);
  } catch (err) {
    if (err instanceof AppError) throw err;
    const cause = (err as { cause?: { code?: string } }).cause?.code ?? (err as Error).name;
    throw new AppError(503, 'upstream_unavailable', `${service} is unavailable (${cause || (err as Error).message})`);
  }
};

/**
 * Every call this service makes to another service lives here so tests can `vi.mock('../src/clients.js')`.
 * All are `/internal/*` routes (shared-secret header added by callService) scoped by `tenantId`.
 * Shapes follow docs/service-contracts.md.
 */

// ---------------------------------------------------------------- documents
export interface DocumentContent {
  filename: string;
  contentType: string;
  base64: string;
}
export interface DocumentRecord {
  id: string;
  filename: string;
  contentType: string;
  kind: string;
  entityType: string | null;
  entityId: string | null;
  pageCount?: number | null;
}

export const getDocumentContent = (tenantId: string, documentId: string) =>
  callService<DocumentContent>('documents', `/internal/documents/${documentId}/content`, {
    query: { tenantId },
  });

export const createDocument = (
  tenantId: string,
  body: {
    filename: string;
    contentType: string;
    base64: string;
    entityType?: string;
    entityId?: string;
    kind: string;
    visibility: 'internal' | 'vendor' | 'client';
    vendorOrgId?: string | null;
    includeInSpecBook?: boolean;
    uploadedByName?: string;
  },
) => callService<DocumentRecord>('documents', '/internal/documents', { body: { tenantId, ...body } });

// ---------------------------------------------------------------- catalog
export interface Vendor {
  id: string;
  name: string;
  orgId: string | null;
  website: string | null;
  categories?: string[];
  profile?: {
    leadTimeWeeks: number | null;
    primaryContact: { name: string; email: string; phone: string } | null;
    onTimeRate?: number | null;
  } | null;
}

export const getVendor = (tenantId: string, vendorId: string) =>
  callService<Vendor>('catalog', `/internal/vendors/${vendorId}`, { query: { tenantId } });

export const findVendorsByDomain = (tenantId: string, domain: string) =>
  callService<Vendor[]>('catalog', '/internal/vendors', { query: { tenantId, domain } });

export interface BrandStandard {
  id: string;
  brandId: string;
  brandName: string;
  name: string;
  version: string | null;
  items: { code: string }[];
}

export const getBrandStandard = (tenantId: string, id: string) =>
  callService<BrandStandard>('catalog', `/internal/brand-standards/${id}`, { query: { tenantId } });

export interface BrandStandardItemInput {
  code: string;
  area: string | null;
  category: SpecCategory;
  name: string;
  description: string | null;
  dimensions: string | null;
  finish: string | null;
  materials: string | null;
  approvedVendors: { name: string; model?: string }[];
  quantityBasis: string | null;
  attributes?: Record<string, unknown>;
}

export const upsertBrandStandardItems = (
  tenantId: string,
  standardId: string,
  items: BrandStandardItemInput[],
) =>
  callService<unknown>('catalog', `/internal/brand-standards/${standardId}/items`, {
    query: { tenantId },
    body: { items },
  });

// ---------------------------------------------------------------- quoting
export interface CostRequestLine {
  id: string;
  quoteLineId: string | null;
  specId: string | null;
  code: string | null;
  name: string;
  description: string | null;
  vendorSku: string | null;
  quantity: number | null;
  currentCost: number | null;
}
export interface CostRequest {
  id: string;
  number: string;
  quoteId: string;
  vendorId: string;
  status: string;
  lines: CostRequestLine[];
}

export const getCostRequest = (tenantId: string, id: string) =>
  callService<CostRequest>('quoting', `/internal/cost-requests/${id}`, { query: { tenantId } });

export const postCostResponse = (
  tenantId: string,
  costRequestId: string,
  body: {
    source: 'ai_pdf' | 'manual';
    lines: {
      costRequestLineId: string;
      cost: number;
      expiresAt?: string | null;
      leadTimeWeeks?: number | null;
      notes?: string | null;
    }[];
  },
) =>
  callService<unknown>('quoting', `/internal/cost-requests/${costRequestId}/responses`, {
    query: { tenantId },
    body,
  });

export interface SpecSummary {
  id: string;
  code: string;
  name: string;
  category: string | null;
  vendorId: string | null;
  vendorSku: string | null;
  description: string | null;
}

export const listSpecs = (tenantId: string, q: { quoteId?: string; ids?: string[] }) =>
  callService<SpecSummary[]>('quoting', '/internal/specs', {
    query: { tenantId, quoteId: q.quoteId, ids: q.ids?.join(',') },
  });

export const importSpecs = (
  tenantId: string,
  rows: {
    code: string;
    name: string;
    category: SpecCategory;
    vendorId?: string | null;
    description?: string | null;
    dimensions?: string | null;
    finish?: string | null;
    materials?: string | null;
  }[],
) =>
  callService<{ created: number; updated: number }>('quoting', '/internal/specs/import', {
    query: { tenantId },
    body: { rows },
  });

// ---------------------------------------------------------------- orders
export interface OpenPurchaseOrder {
  id: string;
  number: string;
  projectId: string;
  projectName: string | null;
  vendorId: string;
  vendorName: string | null;
  status: string;
  revision: number;
}

export const listOpenPurchaseOrders = (tenantId: string, vendorId?: string) =>
  callService<OpenPurchaseOrder[]>('orders', '/internal/purchase-orders/open', {
    query: { tenantId, vendorId },
  });

export interface ShipmentHistory {
  vendorId: string;
  origin: 'domestic' | 'international' | string | null;
  plannedShipDate: string | null;
  actualShipDate: string | null;
  requestedDeliveryDate: string | null;
  deliveredAt: string | null;
  shipDateChanges: number | null;
  /** Optional extras the orders service may provide. */
  leadTimeWeeks?: number | null;
  orderedAt?: string | null;
}

export const listShipmentHistory = (tenantId: string) =>
  callService<ShipmentHistory[]>('orders', '/internal/shipments/history', { query: { tenantId } });

/**
 * Open shipment with risk features. Field names are tolerant: the orders README is the source of
 * truth; anything missing is treated as unknown (neutral) by the model.
 */
export interface OpenShipment {
  shipmentId?: string;
  id?: string;
  poId?: string | null;
  poNumber?: string | null;
  projectId?: string | null;
  projectName?: string | null;
  vendorId: string;
  vendorName?: string | null;
  label?: string | null;
  status?: string | null;
  origin?: string | null;
  requestedDeliveryDate?: string | null;
  estimatedShipDate?: string | null;
  estimatedDeliveryDate?: string | null;
  transitDays?: number | null;
  releaseByDate?: string | null;
  pendingRequirements?: number | null;
  shipDateChanges?: number | null;
  confirmedAt?: string | null;
  lastConfirmedAt?: string | null;
  leadTimeWeeks?: number | null;
  orderedAt?: string | null;
  issuedAt?: string | null;
}

export const listOpenShipments = (tenantId: string) =>
  callService<OpenShipment[]>('orders', '/internal/shipments/open', { query: { tenantId } });

export const postRiskScores = (
  tenantId: string,
  scores: { shipmentId: string; score: number; level: string; reasons: string[] }[],
) => callService<unknown>('orders', '/internal/risk-scores', { query: { tenantId }, body: { scores } });

export const addTracking = (
  tenantId: string,
  shipmentId: string,
  body: { carrier: string; trackingNumber: string; shipDate?: string | null },
) =>
  callService<unknown>('orders', `/internal/shipments/${shipmentId}/tracking`, { query: { tenantId }, body });

export const setRequirement = (
  tenantId: string,
  poId: string,
  body: { kind: string; status: string; documentId?: string | null; note?: string | null },
) =>
  callService<unknown>('orders', `/internal/purchase-orders/${poId}/requirements`, {
    query: { tenantId },
    body,
  });

// ---------------------------------------------------------------- comms
export interface InboundEmail {
  id: string;
  from: string;
  to: string | string[];
  subject: string | null;
  text: string | null;
  receivedAt: string;
  attachments: { documentId: string; filename: string; contentType: string }[];
}

export const getInboundEmail = (tenantId: string, id: string) =>
  callService<InboundEmail>('comms', `/internal/inbound/${id}`, { query: { tenantId } });

export const routeInboundEmail = (
  tenantId: string,
  id: string,
  body: {
    status: 'routed' | 'needs_review';
    threadId?: string;
    entityType?: string;
    entityId?: string;
    vendorOrgId?: string;
    confidence: number;
    reasons: string[];
    suggestions: { type: string; label: string; payload: Record<string, unknown> }[];
  },
) => callService<unknown>('comms', `/internal/inbound/${id}/route`, { query: { tenantId }, body });

export const createThread = (
  tenantId: string,
  body: {
    entityType: string;
    entityId: string;
    subject: string;
    visibility: 'internal' | 'vendor' | 'client';
    vendorOrgId?: string | null;
  },
) => callService<{ id: string }>('comms', '/internal/threads', { body: { tenantId, ...body } });
