import { callService } from '@procure/platform';

/**
 * Synchronous calls comms makes to other services. Grouped on one mutable object so tests can stub
 * individual calls with `vi.spyOn(clients, 'listUsers')`.
 */
export interface DirectoryUser {
  id: string;
  email: string;
  name: string;
  orgId: string;
  orgType: string;
  roles: string[];
}

export interface StoredDocument {
  id: string;
  filename: string;
  contentType: string;
  size: number;
}

export interface CreateDocumentInput {
  tenantId: string;
  filename: string;
  contentType: string;
  base64: string;
  entityType?: string;
  entityId?: string;
  kind: string;
  visibility: 'internal' | 'vendor' | 'client';
  vendorOrgId?: string;
  clientOrgId?: string;
  uploadedByName?: string;
}

const tenantNames = new Map<string, { name: string; at: number }>();

export const clients = {
  /** identity: users of the tenant (and its connected orgs) filtered by roles / ids / org. */
  async listUsers(
    tenantId: string,
    filter: { roles?: string[]; ids?: string[]; orgId?: string },
  ): Promise<DirectoryUser[]> {
    if (filter.ids && !filter.ids.length && !filter.roles?.length && !filter.orgId) return [];
    return callService<DirectoryUser[]>('identity', '/internal/users', {
      query: {
        tenantId,
        roles: filter.roles?.length ? filter.roles.join(',') : undefined,
        ids: filter.ids?.length ? filter.ids.join(',') : undefined,
        orgId: filter.orgId,
      },
    });
  },

  /**
   * Display name of the tenant for email headers. identity has no internal org endpoint yet
   * (`GET /internal/orgs/:id` requested); fall back to a neutral name until it exists.
   */
  async tenantName(tenantId: string): Promise<string> {
    const hit = tenantNames.get(tenantId);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.name;
    let name = 'Pro-Cure';
    try {
      const org = await callService<{ name: string }>('identity', `/internal/orgs/${tenantId}`, {
        query: { tenantId },
      });
      if (org?.name) name = org.name;
    } catch {
      // endpoint not available — keep the fallback
    }
    tenantNames.set(tenantId, { name, at: Date.now() });
    return name;
  },

  /** documents: store a file (raw inbound .eml, attachments). */
  createDocument(input: CreateDocumentInput): Promise<StoredDocument> {
    return callService<StoredDocument>('documents', '/internal/documents', { body: input });
  },

  /** documents: bytes of a stored document, base64. */
  getDocumentContent(
    tenantId: string,
    documentId: string,
  ): Promise<{ filename: string; contentType: string; base64: string }> {
    return callService('documents', `/internal/documents/${documentId}/content`, { query: { tenantId } });
  },

  /** projects: the project (to verify a client org may open a thread on it). */
  getProject(tenantId: string, projectId: string): Promise<{ id: string; clientOrgId: string | null }> {
    return callService('projects', `/internal/projects/${projectId}`, { query: { tenantId } });
  },

  /** orders: set tracking on a shipment (inbox suggestion `set_tracking`). */
  setShipmentTracking(
    tenantId: string,
    shipmentId: string,
    body: { carrier: string; trackingNumber: string; shipDate?: string },
  ): Promise<unknown> {
    return callService('orders', `/internal/shipments/${shipmentId}/tracking`, { query: { tenantId }, body });
  },

  /** orders: set a pre-order requirement (inbox suggestion `complete_requirement`). */
  setPoRequirement(
    tenantId: string,
    poId: string,
    body: { kind: string; status: string; documentId?: string; note?: string },
  ): Promise<unknown> {
    return callService('orders', `/internal/purchase-orders/${poId}/requirements`, {
      query: { tenantId },
      body,
    });
  },
};
