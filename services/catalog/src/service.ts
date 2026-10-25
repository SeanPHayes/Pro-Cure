import type { ServiceDefinition } from '@procure/platform';
import { brandStandardRoutes } from './routes/brand-standards.js';
import { brandRoutes } from './routes/brands.js';
import { internalRoutes } from './routes/internal.js';
import { productRoutes } from './routes/products.js';
import { searchRoutes } from './routes/search.js';
import { vendorRoutes } from './routes/vendors.js';

export const catalogService: ServiceDefinition = {
  name: 'catalog',
  title: 'Catalog',
  description:
    'Shared intelligence for hospitality FF&E: hotel brands, brand-standard packages and items, the network ' +
    'vendor directory and product catalog — plus each firm’s private vendor relationships (terms, lead ' +
    'times, contacts, ratings). Firms contribute drafts; catalog curators publish them to every tenant.',
  routes: async (app) => {
    await brandRoutes(app);
    await brandStandardRoutes(app);
    await vendorRoutes(app);
    await productRoutes(app);
    await searchRoutes(app);
    await internalRoutes(app);
  },
};
