import type { App, ServiceDefinition } from '@procure/platform';
import { jobs } from './jobs.js';
import { approvalRoutes } from './routes/approvals.js';
import { clientFlowRoutes } from './routes/client-flow.js';
import { costRequestRoutes } from './routes/cost-requests.js';
import { internalRoutes } from './routes/internal.js';
import { lineRoutes } from './routes/lines.js';
import { masterSpecRoutes } from './routes/master-specs.js';
import { pricingRoutes } from './routes/pricing.js';
import { quoteRoutes } from './routes/quotes.js';
import { specRoutes } from './routes/specs.js';
import { structureRoutes } from './routes/structure.js';
import { subscriptions } from './subscriptions.js';

async function routes(app: App) {
  await specRoutes(app);
  await masterSpecRoutes(app);
  await quoteRoutes(app);
  await structureRoutes(app);
  await lineRoutes(app);
  await pricingRoutes(app);
  await costRequestRoutes(app);
  await approvalRoutes(app);
  await clientFlowRoutes(app);
  await internalRoutes(app);
}

export const quotingService: ServiceDefinition = {
  name: 'quoting',
  title: 'Quoting',
  description:
    'Private spec library, master specs (competing vendors), quotes by location × room type, vendor cost requests, ' +
    'merchandising, approval rules engine and client quote approval.',
  routes,
  subscriptions,
  jobs,
};
