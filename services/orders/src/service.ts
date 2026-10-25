import type { App, ServiceDefinition } from '@procure/platform';
import { jobs } from './jobs.js';
import { clientPortalRoutes } from './routes/client-portal.js';
import { internalRoutes } from './routes/internal.js';
import { logisticsRoutes } from './routes/logistics.js';
import { purchaseOrderRoutes } from './routes/purchase-orders.js';
import { requirementRoutes } from './routes/requirements.js';
import { shipmentRoutes } from './routes/shipments.js';
import { vendorPortalRoutes } from './routes/vendor-portal.js';
import { subscriptions } from './subscriptions.js';

async function routes(app: App) {
  await purchaseOrderRoutes(app);
  await requirementRoutes(app);
  await shipmentRoutes(app);
  await logisticsRoutes(app);
  await vendorPortalRoutes(app);
  await clientPortalRoutes(app);
  await internalRoutes(app);
}

export const ordersService: ServiceDefinition = {
  name: 'orders',
  title: 'Orders',
  description:
    'Purchase orders and revisions, pre-order requirements and release-by dates, split shipments, ship-date ' +
    'confirmations, carrier tracking, escalation, receiving and storage, claims, and the vendor and owner portals.',
  routes,
  subscriptions,
  jobs,
};
