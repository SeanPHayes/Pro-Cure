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
  execFileSync('node', [join(root, 'tools/db-create.mjs'), '--drop', '--db', 'procure_test'], {
    stdio: 'inherit',
    env: process.env,
  });
  const { runMigrations } = await import('./migrate.js');
  const { closeDb } = await import('@procure/platform');
  await runMigrations(() => {});
  await closeDb();
}
