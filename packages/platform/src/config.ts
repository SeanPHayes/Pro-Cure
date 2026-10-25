import { z } from 'zod';

const bool = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1');

/**
 * Runtime configuration, read once from the environment. Every value has a local-dev default so
 * `pnpm dev` works with zero setup; production values come from ECS task definitions / Secrets Manager.
 */
const ConfigSchema = z.object({
  APP_ENV: z.enum(['local', 'test', 'dev', 'staging', 'production']).default('local'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  PUBLIC_WEB_URL: z.string().default('http://localhost:5173'),
  PUBLIC_API_URL: z.string().default('http://localhost:8080/api'),

  // Database — the app role is subject to row-level security; the migration role owns the schemas.
  DATABASE_URL: z.string().default('postgres://procure_app:procure_app@localhost:5432/procure'),
  MIGRATION_DATABASE_URL: z.string().default('postgres://procure_owner:procure_owner@localhost:5432/procure'),
  DB_POOL_MAX: z.coerce.number().default(10),

  // Auth — identity signs RS256 access tokens; services verify against identity's JWKS.
  AUTH_ISSUER: z.string().default('https://auth.pro-cure.local'),
  AUTH_AUDIENCE: z.string().default('pro-cure-api'),
  AUTH_JWKS_URL: z.string().optional(),
  AUTH_PRIVATE_KEY_PEM: z.string().optional(),
  AUTH_KEYS_DIR: z.string().default('.local-storage/keys'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().default(3600),
  /** Local only: enables passwordless "sign in as" for seeded demo users. */
  AUTH_DEV_LOGIN: bool.default(false),
  COGNITO_USER_POOL_ID: z.string().optional(),
  COGNITO_CLIENT_ID: z.string().optional(),
  COGNITO_REGION: z.string().default('us-east-1'),

  // Events
  EVENT_TRANSPORT: z.enum(['http', 'eventbridge']).default('http'),
  EVENT_BUS_NAME: z.string().default('pro-cure'),
  EVENT_QUEUE_URL: z.string().optional(),

  // Storage
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('.local-storage/files'),
  S3_BUCKET: z.string().default('pro-cure-documents'),
  AWS_REGION: z.string().default('us-east-1'),

  // AI
  AI_PROVIDER: z.enum(['bedrock', 'anthropic', 'local']).default('local'),
  ANTHROPIC_API_KEY: z.string().optional(),
  AI_MODEL: z.string().default('claude-sonnet-5-5'),
  BEDROCK_MODEL_ID: z.string().default('anthropic.claude-sonnet-5-5-v1:0'),
  OCR_PROVIDER: z.enum(['textract', 'local']).default('local'),

  // Email
  EMAIL_DRIVER: z.enum(['ses', 'outbox']).default('outbox'),
  EMAIL_FROM: z.string().default('Pro-Cure <noreply@pro-cure.local>'),
  INBOUND_EMAIL_DOMAIN: z.string().default('inbound.pro-cure.local'),

  // Scheduled jobs run in-process under an advisory lock; disable on API-only replicas if desired.
  JOBS_ENABLED: z
    .string()
    .optional()
    .transform((v) => v !== 'false'),
});

export type Config = z.infer<typeof ConfigSchema>;

let cached: Config | undefined;
export const config = (): Config => {
  cached ??= ConfigSchema.parse(process.env);
  return cached;
};
/** Test helper. */
export const resetConfig = () => {
  cached = undefined;
};

export const serviceUrl = (name: string, port: number): string =>
  process.env[`SERVICE_URL_${name.toUpperCase()}`] ?? `http://127.0.0.1:${port}`;
