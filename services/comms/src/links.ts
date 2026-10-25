import { config } from '@procure/platform';

/** Web-app paths (see docs/service-contracts.md). Notifications store the path; emails absolutise it. */
const INTERNAL: Record<string, string> = {
  project: '/app/projects/:id',
  quote: '/app/quotes/:id',
  purchase_order: '/app/orders/:id',
  cost_request: '/app/cost-requests/:id',
  claim: '/app/claims/:id',
  invoice: '/app/invoices/:id',
};
const VENDOR: Record<string, string> = {
  cost_request: '/vendor/cost-requests/:id',
  purchase_order: '/vendor/orders/:id',
};
const CLIENT: Record<string, string> = {
  project: '/portal/projects/:id',
  quote: '/portal/quotes/:id',
  claim: '/portal/claims/:id',
  invoice: '/portal/invoices/:id',
};

export type Audience = 'internal' | 'vendor' | 'client';

export function entityPath(audience: Audience, entityType: string, entityId: string): string | null {
  const table = audience === 'vendor' ? VENDOR : audience === 'client' ? CLIENT : INTERNAL;
  const tpl = table[entityType];
  return tpl ? tpl.replace(':id', entityId) : null;
}

/** Link to a thread for an audience: the entity page with ?thread=, or the inbox/home as fallback. */
export function threadPath(
  audience: Audience,
  thread: { id: string; entityType: string; entityId: string },
): string {
  const base = entityPath(audience, thread.entityType, thread.entityId);
  if (base) return `${base}?thread=${thread.id}`;
  return audience === 'vendor'
    ? `/vendor?thread=${thread.id}`
    : audience === 'client'
      ? `/portal?thread=${thread.id}`
      : `/app/inbox?thread=${thread.id}`;
}

export const absoluteUrl = (path: string) =>
  /^https?:\/\//.test(path) ? path : `${config().PUBLIC_WEB_URL.replace(/\/$/, '')}${path}`;
