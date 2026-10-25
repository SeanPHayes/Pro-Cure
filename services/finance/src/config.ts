import { createHash } from 'node:crypto';
import { config, z } from '@procure/platform';

/**
 * Finance-specific configuration. Read from the environment on each call (cheap) so tests can switch
 * QuickBooks credentials on and off without re-importing modules.
 *
 *   QBO_CLIENT_ID / QBO_CLIENT_SECRET  Intuit app keys. Absent → only the simulated connection is offered.
 *   QBO_REDIRECT_URI                    OAuth2 redirect registered with Intuit (→ GET /integrations/qbo/callback).
 *   QBO_ENVIRONMENT                     sandbox | production.
 *   FINANCE_TOKEN_KEY                   32-byte key, base64. Encrypts QBO tokens at rest (AES-256-GCM) and
 *                                       signs OAuth state (HMAC-SHA256). Required outside local/test.
 */
const FinanceEnv = z.object({
  QBO_CLIENT_ID: z.string().min(1).optional(),
  QBO_CLIENT_SECRET: z.string().min(1).optional(),
  QBO_REDIRECT_URI: z.string().optional(),
  QBO_ENVIRONMENT: z.enum(['sandbox', 'production']).default('sandbox'),
  QBO_AUTHORIZE_URL: z.string().default('https://appcenter.intuit.com/connect/oauth2'),
  QBO_TOKEN_URL: z.string().default('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer'),
  QBO_REVOKE_URL: z.string().default('https://developer.api.intuit.com/v2/oauth2/tokens/revoke'),
  FINANCE_TOKEN_KEY: z.string().optional(),
});

export type FinanceConfig = z.infer<typeof FinanceEnv> & { redirectUri: string; qboConfigured: boolean };

export const financeConfig = (): FinanceConfig => {
  const env = FinanceEnv.parse(process.env);
  return {
    ...env,
    redirectUri: env.QBO_REDIRECT_URI ?? `${config().PUBLIC_API_URL}/finance/integrations/qbo/callback`,
    qboConfigured: Boolean(env.QBO_CLIENT_ID && env.QBO_CLIENT_SECRET),
  };
};

const DEV_KEY_SEED = 'pro-cure-finance-dev-token-key-do-not-use-in-production';

/** The 32-byte key for token encryption and state signing. */
export const tokenKey = (): Buffer => {
  const raw = financeConfig().FINANCE_TOKEN_KEY;
  if (raw) {
    const key = Buffer.from(raw, 'base64');
    if (key.length !== 32) throw new Error('FINANCE_TOKEN_KEY must be 32 bytes, base64-encoded');
    return key;
  }
  const env = config().APP_ENV;
  if (env === 'local' || env === 'test') return createHash('sha256').update(DEV_KEY_SEED).digest();
  throw new Error('FINANCE_TOKEN_KEY is required in this environment');
};

export const qboApiBase = (environment: 'sandbox' | 'production') =>
  environment === 'production'
    ? 'https://quickbooks.api.intuit.com'
    : 'https://sandbox-quickbooks.api.intuit.com';

export const QBO_SCOPE = 'com.intuit.quickbooks.accounting';
export const QBO_MINOR_VERSION = 73;
