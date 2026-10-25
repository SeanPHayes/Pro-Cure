import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Vitest global setup shared by every service: (re)creates the `procure_test` database once per test
 * run and applies all migrations, so tests exercise the real schema, RLS policies and triggers.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export default async function setup() {
  if (process.env.SKIP_DB_RESET === '1') return;
  execFileSync(
    'node',
    [join(root, 'tools/db-create.mjs'), '--drop', '--db', process.env.PROCURE_TEST_DB ?? 'procure_test'],
    {
      stdio: 'inherit',
      env: process.env,
    },
  );
  const { migrationScopes } = await import('./migrate.js');
  const { closeDb, migrate, ownerSql } = await import('@procure/platform');
  const wanted = process.env.PROCURE_TEST_SCOPES?.split(',').filter(Boolean);
  const scopes = migrationScopes().filter((s) => !wanted || wanted.includes(s.scope));
  await migrate(ownerSql(), scopes, () => {});
  await closeDb();
}
