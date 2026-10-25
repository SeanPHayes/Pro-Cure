import type { Permission } from '@procure/domain';
import { badRequest, forbidden, type Principal } from '@procure/platform';
import type { Visibility } from './schemas.js';

/**
 * Documents piggy-back on the permissions of the entities they attach to (there is no separate
 * documents permission). Row-level security decides which rows each actor sees; these helpers decide
 * which actors may call which routes.
 */
const INTERNAL_WRITE: Permission[] = [
  'projects:write',
  'specs:write',
  'quotes:write',
  'cost_requests:write',
  'orders:write',
  'logistics:write',
  'claims:write',
  'finance:write',
  'messages:write',
  'vendors:write',
  'catalog:contribute',
];

export const isInternalActor = (p: Principal) => p.isInternal || p.actor === 'platform';

export function requireRead(p: Principal) {
  if (p.isVendor) return p.require('vendor:respond');
  if (p.isClient) return p.require('client:view');
  if (!isInternalActor(p)) throw forbidden();
}

export function requireUpload(p: Principal) {
  if (p.isVendor) return p.require('vendor:respond');
  if (p.isClient) {
    if (!p.can('client:report_claims') && !p.can('client:manage_storage') && !p.can('client:approve'))
      throw forbidden('Missing permission to upload documents');
    return;
  }
  requireInternalWrite(p);
}

/** Changing or removing existing documents is for the procurement firm only. */
export function requireInternalWrite(p: Principal) {
  if (!isInternalActor(p)) throw forbidden('Internal users only');
  if (!INTERNAL_WRITE.some((perm) => p.can(perm))) throw forbidden('Missing permission to manage documents');
}

export interface SharingInput {
  visibility?: Visibility;
  vendorOrgId?: string | null;
  clientOrgId?: string | null;
}

/**
 * Resolve the sharing of a new or edited document. External uploaders are pinned to their own org and
 * matching visibility; internal users must name the org a vendor/client document is shared with.
 */
export function resolveSharing(p: Principal | null, s: SharingInput) {
  if (p?.isVendor) {
    if (
      (s.visibility && s.visibility !== 'vendor') ||
      (s.vendorOrgId && s.vendorOrgId !== p.orgId) ||
      s.clientOrgId
    )
      throw forbidden('Vendors can only share documents with the procurement firm as vendor-visible');
    return { visibility: 'vendor' as const, vendorOrgId: p.orgId, clientOrgId: null };
  }
  if (p?.isClient) {
    if (
      (s.visibility && s.visibility !== 'client') ||
      (s.clientOrgId && s.clientOrgId !== p.orgId) ||
      s.vendorOrgId
    )
      throw forbidden('Clients can only share documents with the procurement firm as client-visible');
    return { visibility: 'client' as const, vendorOrgId: null, clientOrgId: p.orgId };
  }
  const visibility = s.visibility ?? 'internal';
  const vendorOrgId = s.vendorOrgId ?? null;
  const clientOrgId = s.clientOrgId ?? null;
  if (visibility === 'vendor' && !vendorOrgId)
    throw badRequest('vendorOrgId is required for vendor visibility');
  if (visibility === 'client' && !clientOrgId)
    throw badRequest('clientOrgId is required for client visibility');
  return { visibility, vendorOrgId, clientOrgId };
}
