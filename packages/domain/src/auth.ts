import { z } from 'zod';
import { OrgType } from './enums.js';

/**
 * Who is acting. `internal` = a procurement-firm user (the tenant), `vendor` = a manufacturer/supplier
 * user, `client` = a hotel owner / management-company user, `service` = service-to-service, `platform`
 * = Pro-Cure operator (catalog curation, support).
 */
export const ActorType = z.enum(['internal', 'vendor', 'client', 'service', 'platform']);
export type ActorType = z.infer<typeof ActorType>;

export const actorTypeForOrg = (t: OrgType): ActorType =>
  t === 'procurement_firm' ? 'internal' : t === 'vendor' ? 'vendor' : t === 'client' ? 'client' : 'platform';

export const Permission = z.enum([
  // org / admin
  'org:admin',
  'users:read',
  'users:write',
  // catalog (shared intelligence)
  'catalog:read',
  'catalog:contribute',
  'catalog:curate',
  'vendors:read',
  'vendors:write',
  // projects
  'projects:read',
  'projects:write',
  'tasks:write',
  'templates:write',
  // specs & quotes
  'specs:read',
  'specs:write',
  'quotes:read',
  'quotes:write',
  'quotes:costs:read',
  'quotes:send',
  'approvals:decide',
  'approval_policies:write',
  'cost_requests:write',
  // orders
  'orders:read',
  'orders:write',
  'orders:issue',
  'logistics:write',
  'claims:write',
  // finance
  'finance:read',
  'finance:write',
  'integrations:write',
  // comms
  'messages:read',
  'messages:write',
  'inbox:triage',
  // ai
  'ai:use',
  // vendor portal
  'vendor:respond',
  // client portal
  'client:view',
  'client:approve',
  'client:report_claims',
  'client:manage_storage',
]);
export type Permission = z.infer<typeof Permission>;

export const InternalRole = z.enum([
  'admin',
  'executive',
  'project_manager',
  'designer',
  'procurement',
  'order_manager',
  'logistics',
  'accounting',
  'sales',
  'viewer',
]);
export const VendorRole = z.enum(['vendor_admin', 'vendor_user']);
export const ClientRole = z.enum(['client_admin', 'client_approver', 'client_viewer', 'site_manager']);
export const PlatformRole = z.enum(['platform_admin', 'catalog_curator']);
export const Role = z.union([InternalRole, VendorRole, ClientRole, PlatformRole]);
export type Role = z.infer<typeof Role>;

const ALL_INTERNAL_READ: Permission[] = [
  'users:read',
  'catalog:read',
  'vendors:read',
  'projects:read',
  'specs:read',
  'quotes:read',
  'orders:read',
  'messages:read',
  'ai:use',
];

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  admin: Permission.options,
  executive: [
    ...ALL_INTERNAL_READ,
    'quotes:costs:read',
    'finance:read',
    'approvals:decide',
    'approval_policies:write',
  ],
  project_manager: [
    ...ALL_INTERNAL_READ,
    'projects:write',
    'tasks:write',
    'templates:write',
    'quotes:costs:read',
    'quotes:send',
    'messages:write',
    'claims:write',
    'catalog:contribute',
    'finance:read',
  ],
  designer: [
    ...ALL_INTERNAL_READ,
    'specs:write',
    'quotes:write',
    'tasks:write',
    'messages:write',
    'catalog:contribute',
  ],
  procurement: [
    ...ALL_INTERNAL_READ,
    'specs:write',
    'quotes:write',
    'quotes:costs:read',
    'quotes:send',
    'cost_requests:write',
    'vendors:write',
    'orders:write',
    'orders:issue',
    'tasks:write',
    'messages:write',
    'inbox:triage',
    'catalog:contribute',
  ],
  order_manager: [
    ...ALL_INTERNAL_READ,
    'quotes:costs:read',
    'orders:write',
    'orders:issue',
    'logistics:write',
    'claims:write',
    'tasks:write',
    'messages:write',
    'inbox:triage',
    'vendors:write',
  ],
  logistics: [
    ...ALL_INTERNAL_READ,
    'logistics:write',
    'claims:write',
    'tasks:write',
    'messages:write',
    'inbox:triage',
  ],
  accounting: [
    ...ALL_INTERNAL_READ,
    'quotes:costs:read',
    'finance:read',
    'finance:write',
    'integrations:write',
    'messages:write',
  ],
  sales: [...ALL_INTERNAL_READ, 'projects:write', 'quotes:send', 'messages:write', 'tasks:write'],
  viewer: ALL_INTERNAL_READ,
  vendor_admin: [
    'vendor:respond',
    'messages:read',
    'messages:write',
    'users:read',
    'users:write',
    'org:admin',
  ],
  vendor_user: ['vendor:respond', 'messages:read', 'messages:write'],
  client_admin: [
    'client:view',
    'client:approve',
    'client:report_claims',
    'client:manage_storage',
    'messages:read',
    'messages:write',
    'users:read',
    'users:write',
  ],
  client_approver: [
    'client:view',
    'client:approve',
    'client:report_claims',
    'messages:read',
    'messages:write',
  ],
  client_viewer: ['client:view', 'messages:read'],
  site_manager: [
    'client:view',
    'client:report_claims',
    'client:manage_storage',
    'messages:read',
    'messages:write',
  ],
  platform_admin: Permission.options,
  catalog_curator: ['catalog:read', 'catalog:contribute', 'catalog:curate', 'vendors:read'],
};

export const permissionsFor = (roles: readonly Role[]): Permission[] => {
  const set = new Set<Permission>();
  for (const r of roles) for (const p of ROLE_PERMISSIONS[r] ?? []) set.add(p);
  return [...set].sort();
};

/** Claims carried in a Pro-Cure access token (RS256 JWT minted by the identity service). */
export const AccessClaims = z.object({
  sub: z.uuid(), // user id
  email: z.email(),
  name: z.string(),
  org: z.uuid(), // active organization
  orgType: OrgType,
  orgName: z.string(),
  /** Tenant whose data this actor works in. For internal users = their org. For vendors/clients = the
   *  procurement firm that invited them (vendor/client orgs can be connected to several tenants; the
   *  token is scoped to one). */
  tenant: z.uuid(),
  actor: ActorType,
  roles: z.array(Role),
  perms: z.array(Permission),
});
export type AccessClaims = z.infer<typeof AccessClaims>;
