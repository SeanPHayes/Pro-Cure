import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * AES-256-GCM encryption for secrets at rest (QuickBooks OAuth tokens).
 * Format: `v1.<iv>.<tag>.<ciphertext>` — each part base64url.
 */
export function encryptSecret(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), data.toString('base64url')].join('.');
}

export function decryptSecret(enc: string, key: Buffer): string {
  const [v, iv, tag, data] = enc.split('.');
  if (v !== 'v1' || !iv || !tag || data === undefined) throw new Error('Unrecognized secret format');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}

export interface OAuthState {
  tenantId: string;
  userName: string | null;
  nonce: string;
  /** Expiry, epoch seconds. */
  exp: number;
}

const hmac = (body: string, key: Buffer) => createHmac('sha256', key).update(body).digest();

/** Signed, expiring OAuth `state`: `<base64url(json)>.<base64url(hmac)>`. */
export function signState(
  input: { tenantId: string; userName?: string | null },
  key: Buffer,
  ttlSeconds = 600,
  now = Date.now(),
): string {
  const payload: OAuthState = {
    tenantId: input.tenantId,
    userName: input.userName ?? null,
    nonce: randomBytes(12).toString('base64url'),
    exp: Math.floor(now / 1000) + ttlSeconds,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${hmac(body, key).toString('base64url')}`;
}

export class InvalidStateError extends Error {}

export function verifyState(state: string, key: Buffer, now = Date.now()): OAuthState {
  const [body, sig] = state.split('.');
  if (!body || !sig) throw new InvalidStateError('Malformed state');
  const expected = hmac(body, key);
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    throw new InvalidStateError('State signature mismatch');
  let payload: OAuthState;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidStateError('Malformed state');
  }
  if (typeof payload.tenantId !== 'string' || typeof payload.exp !== 'number')
    throw new InvalidStateError('Malformed state');
  if (payload.exp * 1000 < now) throw new InvalidStateError('State expired');
  return payload;
}
