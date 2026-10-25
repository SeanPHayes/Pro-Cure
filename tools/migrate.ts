import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIGRATION_ORDER } from '@procure/domain';
import { closeDb, migrate, ownerSql } from '@procure/platform';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export const migrationScopes = () => [
  { scope: 'platform', dir: join(root, 'packages/platform/migrations') },
  ...MIGRATION_ORDER.map((s) => ({ scope: s, dir: join(root, 'services', s, 'migrations') })),
];

export async function runMigrations(log = console.log) {
  log('Applying migrations…');
  // PROCURE_MIGRATE_SCOPES=platform,identity,projects limits which scopes run (useful mid-development).
  const only = process.env.PROCURE_MIGRATE_SCOPES?.split(',').filter(Boolean);
  const scopes = migrationScopes().filter((s) => !only || only.includes(s.scope));
  const n = await migrate(ownerSql(), scopes, log);
  log(n ? `Applied ${n} migration(s).` : 'Database is up to date.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations()
    .then(() => closeDb())
    .catch(async (err) => {
      console.error(err);
      await closeDb();
      process.exit(1);
    });
}
