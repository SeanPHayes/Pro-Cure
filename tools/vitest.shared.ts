import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const env: Record<string, string> = {
  APP_ENV: 'test',
  LOG_LEVEL: 'warn',
  DATABASE_URL:
    process.env.TEST_DATABASE_URL ?? 'postgres://procure_app:procure_app@localhost:5432/procure_test',
  MIGRATION_DATABASE_URL:
    process.env.TEST_MIGRATION_DATABASE_URL ??
    'postgres://procure_owner:procure_owner@localhost:5432/procure_test',
  PG_SUPERUSER_URL: process.env.PG_SUPERUSER_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres',
  AUTH_KEYS_DIR: join(root, '.local-storage/test-keys'),
  STORAGE_LOCAL_DIR: join(root, '.local-storage/test-files'),
  AUTH_DEV_LOGIN: 'true',
  JOBS_ENABLED: 'false',
  AI_PROVIDER: 'local',
};
// Global setup runs in the main process, which does not receive `test.env`.
for (const [k, v] of Object.entries(env)) process.env[k] ??= v;

/** Shared Vitest settings for service integration tests. */
export const serviceTestConfig = {
  test: {
    globalSetup: [join(root, 'tools/test-global-setup.ts')],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env,
  },
};
