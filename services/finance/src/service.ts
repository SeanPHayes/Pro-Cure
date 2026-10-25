import type { App, ServiceDefinition } from '@procure/platform';
import { jobs } from './jobs.js';
import { billRoutes } from './routes/bills.js';
import { clientPortalRoutes } from './routes/client-portal.js';
import { exportRoutes } from './routes/exports.js';
import { financialsRoutes } from './routes/financials.js';
import { integrationRoutes } from './routes/integrations.js';
import { invoiceRoutes } from './routes/invoices.js';
import { subscriptions } from './subscriptions.js';

async function routes(app: App) {
  await invoiceRoutes(app);
  await billRoutes(app);
  await financialsRoutes(app);
  await integrationRoutes(app);
  await exportRoutes(app);
  await clientPortalRoutes(app);
}

export const financeService: ServiceDefinition = {
  name: 'finance',
  title: 'Finance',
  description:
    'Native AR (deposit/progress/final invoices, payments) and AP (vendor bills), project and portfolio ' +
    'financials, QuickBooks Online two-way sync, and CSV/IIF exports.',
  routes,
  subscriptions,
  jobs,
};
