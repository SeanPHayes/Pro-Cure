import { type DbContext, forbidden, type Principal, type Tx, withContext } from '@procure/platform';

/** The slice of a Fastify request the catalog helpers need (fastify is not a direct dependency). */
export interface Req {
  principal: Principal;
  tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
}

/**
 * Brand standards are public intelligence: any authenticated actor may read published packages
 * (vendors use them to know what a brand requires; owners to see what was specified). Internal users
 * additionally need catalog:read.
 */
export const requireStandardsRead = (p: Principal) => {
  if (p.isInternal || p.actor === 'platform') p.require('catalog:read');
};

/**
 * The vendor directory and product catalog are for procurement firms only: vendors must never browse
 * other vendors, and owners never see sourcing.
 */
export const requireDirectoryRead = (
  p: Principal,
  perm: 'vendors:read' | 'catalog:read' = 'vendors:read',
) => {
  if (!p.isInternal && p.actor !== 'platform') throw forbidden('Internal users only');
  p.require(perm);
};

export const requireContribute = (p: Principal) => {
  if (!p.isInternal && p.actor !== 'platform') throw forbidden('Internal users only');
  p.require('catalog:contribute');
};

/**
 * Catalog curators publish shared intelligence across tenants. Tenant admins hold every permission
 * (including catalog:curate) for their own tenant, so curation additionally requires a Pro-Cure
 * operator (platform actor) or the explicit catalog_curator role.
 */
export const isCurator = (p: Principal) =>
  p.can('catalog:curate') &&
  (p.actor === 'platform' ||
    p.claims.roles.includes('catalog_curator') ||
    p.claims.roles.includes('platform_admin'));

export const requireCurator = (p: Principal) => {
  if (!isCurator(p)) throw forbidden('Catalog curators only');
};

/** RLS context for curator work: same user attribution, but acting as the platform. */
export const curatorContext = (p: Principal): DbContext => ({
  tenantId: p.tenantId,
  userId: p.userId,
  orgId: p.orgId,
  actor: 'platform',
  userName: p.name,
});

/** Run in the curator context when the caller is a curator, otherwise in the caller's own context. */
export const catalogTx = <T>(req: Req, fn: (tx: Tx) => Promise<T>): Promise<T> =>
  isCurator(req.principal) ? withContext(curatorContext(req.principal), fn) : req.tx(fn);

/** Tenant id to stamp on contributions; platform operators contribute as "the platform" (null). */
export const contributorTenant = (p: Principal) => (p.actor === 'platform' ? null : p.tenantId);
