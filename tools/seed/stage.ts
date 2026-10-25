/**
 * Dev helper: run individual seed stages against an existing database (identity is idempotent).
 *   npx tsx tools/seed/stage.ts catalog quoting
 */
import { closeDb } from '@procure/platform';
import { seedIdentity } from './identity.js';

process.env.APP_ENV ??= 'local';
process.env.AUTH_KEYS_DIR ??= `${process.cwd()}/.local-storage/keys`;
process.env.LOG_LEVEL ??= 'warn';
process.env.JOBS_ENABLED = 'false';

const { seedBusiness } = await import('./business.js');
const ids = await seedIdentity();
await seedBusiness(ids, process.argv.slice(2));
await closeDb();
