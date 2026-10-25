import { closeDb } from '@procure/platform';
import { seedIdentity } from './identity.js';

/**
 * Loads the JMHS demo dataset. Identity rows are inserted directly; everything else goes through the
 * real service APIs in-process (buildService + inject), so seeded data passes the same validation,
 * RLS and business rules as user input. Run on an empty database (`pnpm db:reset`).
 */
async function main() {
  process.env.APP_ENV ??= 'local';
  process.env.AUTH_KEYS_DIR ??= `${process.cwd()}/.local-storage/keys`;
  process.env.LOG_LEVEL ??= 'warn';
  process.env.JOBS_ENABLED = 'false';
  console.log('Seeding identity…');
  const ids = await seedIdentity();
  console.log(`  tenant ${ids.tenantId}, ${Object.keys(ids.users).length} staff`);
  try {
    const { seedBusiness } = await import('./business.js');
    await seedBusiness(ids);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND')
      console.log('  (business data seed not present yet)');
    else throw err;
  }
}

main()
  .then(() => closeDb())
  .then(() => console.log('Done.'))
  .catch(async (err) => {
    console.error(err);
    await closeDb();
    process.exit(1);
  });
