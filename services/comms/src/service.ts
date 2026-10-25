import type { App, ServiceDefinition } from '@procure/platform';
import { jobs } from './jobs.js';
import { emailRoutes } from './routes/emails.js';
import { inboundRoutes } from './routes/inbound.js';
import { internalRoutes } from './routes/internal.js';
import { notificationRoutes } from './routes/notifications.js';
import { threadRoutes } from './routes/threads.js';
import { subscriptions } from './subscriptions.js';

async function routes(app: App) {
  await threadRoutes(app);
  await inboundRoutes(app);
  await internalRoutes(app);
  await notificationRoutes(app);
  await emailRoutes(app);
}

export const commsService: ServiceDefinition = {
  name: 'comms',
  title: 'Comms',
  description:
    'Conversation threads on every project, quote, cost request, PO, shipment and claim (in-app and by email), ' +
    'inbound email ingestion and routing, the triage inbox, notifications (incl. SSE stream) and outbound email.',
  routes,
  subscriptions,
  jobs,
  maxUploadBytes: 40 * 1024 * 1024,
};
