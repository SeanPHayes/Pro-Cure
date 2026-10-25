import type { ServiceDefinition } from '@procure/platform';
import { documentRoutes } from './routes/documents.js';
import { internalRoutes } from './routes/internal.js';
import { reportRoutes } from './routes/reports.js';
import { MAX_UPLOAD_BYTES } from './store.js';

export const documentsService: ServiceDefinition = {
  name: 'documents',
  title: 'Documents',
  description:
    'Every file in Pro-Cure — spec sheets, drawings, photos, email attachments, contracts — with tenant, ' +
    'vendor and client sharing enforced by row-level security, plus generated PDF reports: quotes, purchase ' +
    'orders and revisions, spec books (with merged vendor documents), schedules, cost requests, invoices and claims.',
  maxUploadBytes: MAX_UPLOAD_BYTES,
  routes: async (app) => {
    await documentRoutes(app);
    await reportRoutes(app);
    await internalRoutes(app);
  },
};
