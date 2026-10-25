import { callService, type Principal } from '@procure/platform';

/**
 * Every call this service makes to other services lives here so tests can `vi.mock('../src/clients.js')`.
 */

export interface RenderedDocument {
  id: string;
  filename: string;
  contentType: string;
  [k: string]: unknown;
}

export interface ScheduleReportData {
  tenant: { name: string; address?: unknown; phone?: string | null; email?: string | null };
  project: Record<string, unknown>;
  generatedAt: string;
  notes: string;
  headerFields: { label: string; value: string }[];
  milestones: {
    name: string;
    party: string;
    start: string | null;
    due: string | null;
    status: string;
    completedAt: string | null;
  }[];
}

/** documents POST /internal/reports/render — template 'schedule'. */
export const renderScheduleReport = (args: {
  tenantId: string;
  data: ScheduleReportData;
  filename: string;
  projectId: string;
  visibility: 'internal' | 'client';
  clientOrgId: string | null;
}) =>
  callService<RenderedDocument>('documents', '/internal/reports/render', {
    method: 'POST',
    body: {
      tenantId: args.tenantId,
      template: 'schedule',
      data: args.data,
      filename: args.filename,
      entityType: 'project',
      entityId: args.projectId,
      visibility: args.visibility,
      ...(args.visibility === 'client' && args.clientOrgId ? { clientOrgId: args.clientOrgId } : {}),
    },
  });

export interface OrgInfo {
  id: string;
  name: string;
  address?: unknown;
  phone?: string | null;
  email?: string | null;
}

/** identity GET /orgs/:id (with the caller's token). Falls back to a minimal tenant block on failure. */
export const getOrg = async (id: string, principal: Principal): Promise<OrgInfo | null> => {
  try {
    return await callService<OrgInfo>('identity', `/orgs/${id}`, { principal });
  } catch {
    return null;
  }
};
