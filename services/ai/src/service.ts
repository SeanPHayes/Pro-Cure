import type { ServiceDefinition } from '@procure/platform';
import { setEngineLogger } from './engine.js';
import { jobs } from './jobs.js';
import { insightRoutes } from './routes/insights.js';
import { jobRoutes } from './routes/jobs.js';
import { subscriptions } from './subscriptions.js';

export const aiService: ServiceDefinition = {
  name: 'ai',
  title: 'AI',
  description:
    'Reviewable AI jobs: brand-standard PDF extraction, vendor-quote PDF extraction and cost matching, drawing-packet ' +
    'splitting, inbox routing for vendor emails, and late-delivery risk prediction. Works offline with deterministic ' +
    'heuristics when no model is configured.',
  routes: async (app) => {
    setEngineLogger(app.log);
    await jobRoutes(app);
    await insightRoutes(app);
  },
  subscriptions,
  jobs,
  maxUploadBytes: 1024 * 1024,
};
