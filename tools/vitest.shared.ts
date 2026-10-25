import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Each service can use its own test database (PROCURE_TEST_DB) so suites can run in parallel. */
const testDb = process.env.PROCURE_TEST_DB ?? 'procure_test';

const env: Record<string, string> = {
  PROCURE_TEST_DB: testDb,
  APP_ENV: 'test',
  LOG_LEVEL: 'warn',
  DATABASE_URL:
    process.env.TEST_DATABASE_URL ?? `postgres://procure_app:procure_app@localhost:5432/${testDb}`,
  MIGRATION_DATABASE_URL:
    process.env.TEST_MIGRATION_DATABASE_URL ??
    `postgres://procure_owner:procure_owner@localhost:5432/${testDb}`,
  PG_SUPERUSER_URL: process.env.PG_SUPERUSER_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres',
  AUTH_KEYS_DIR: join(root, '.local-storage/test-keys'),
  STORAGE_LOCAL_DIR: join(root, '.local-storage/test-files'),
  AUTH_DEV_LOGIN: 'true',
  JOBS_ENABLED: 'false',
  AI_PROVIDER: 'local',
};
// Global setup runs in the main process, which does not receive `test.env`.
for (const [k, v] of Object.entries(env)) process.env[k] ??= v;

/**
 * Shared Vitest settings for service integration tests. Pass the service name so only the platform,
 * identity (fixtures) and that service's migrations are applied — a broken migration elsewhere in the
 * monorepo then cannot break this suite.
 */
export const serviceTestConfig = (service?: string) => {
  if (service) process.env.PROCURE_TEST_SCOPES ??= ['platform', 'identity', service].join(',');
  return {
    test: {
      globalSetup: [join(root, 'tools/test-global-setup.ts')],
      fileParallelism: false,
      testTimeout: 30_000,
      hookTimeout: 60_000,
      env,
    },
  };
};
