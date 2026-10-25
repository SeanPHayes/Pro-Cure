import { AppError } from '@procure/platform';
import { financeConfig, QBO_SCOPE } from '../config.js';
import type { TokenSet } from './types.js';

/** Intuit OAuth 2.0 (authorization-code flow) helpers. */

export const authorizeUrl = (state: string) => {
  const cfg = financeConfig();
  const url = new URL(cfg.QBO_AUTHORIZE_URL);
  url.searchParams.set('client_id', cfg.QBO_CLIENT_ID ?? '');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', QBO_SCOPE);
  url.searchParams.set('redirect_uri', cfg.redirectUri);
  url.searchParams.set('state', state);
  return url.toString();
};

export class OAuthError extends AppError {
  constructor(
    message: string,
    public readonly oauthError: string | null,
    status = 502,
  ) {
    super(status, 'qbo_oauth', message, oauthError ?? undefined);
  }
  /** The refresh token is no longer usable — the user must reconnect. */
  get isInvalidGrant() {
    return this.oauthError === 'invalid_grant';
  }
}

const basicAuth = () => {
  const cfg = financeConfig();
  return `Basic ${Buffer.from(`${cfg.QBO_CLIENT_ID ?? ''}:${cfg.QBO_CLIENT_SECRET ?? ''}`).toString('base64')}`;
};

interface IntuitTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  x_refresh_token_expires_in?: number;
  token_type: string;
}

async function tokenRequest(form: Record<string, string>, now = Date.now()): Promise<TokenSet> {
  const res = await fetch(financeConfig().QBO_TOKEN_URL, {
    method: 'POST',
    headers: {
      authorization: basicAuth(),
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = {};
  }
  if (!res.ok || !json.access_token)
    throw new OAuthError(
      `QuickBooks token request failed (HTTP ${res.status})${json.error_description ? `: ${json.error_description}` : ''}`,
      json.error ?? null,
    );
  const t = json as IntuitTokenResponse;
  return {
    accessToken: t.access_token,
    refreshToken: t.refresh_token,
    accessExpiresAt: new Date(now + t.expires_in * 1000).toISOString(),
    refreshExpiresAt: t.x_refresh_token_expires_in
      ? new Date(now + t.x_refresh_token_expires_in * 1000).toISOString()
      : null,
  };
}

export const exchangeCode = (code: string) =>
  tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: financeConfig().redirectUri });

export const refreshTokens = (refreshToken: string) =>
  tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });

/** Best-effort revoke on disconnect. */
export async function revokeToken(token: string) {
  try {
    await fetch(financeConfig().QBO_REVOKE_URL, {
      method: 'POST',
      headers: { authorization: basicAuth(), accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // ignore — the local connection is removed regardless
  }
}
