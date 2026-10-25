import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AccessClaims, type Permission } from '@procure/domain';
import * as jose from 'jose';
import { config } from './config.js';
import { forbidden, unauthorized } from './errors.js';

/**
 * Pro-Cure access tokens are RS256 JWTs minted by the identity service after it authenticates the
 * user (Cognito federation in AWS, dev sign-in locally). Every service verifies them offline against
 * identity's JWKS; no per-request call to identity.
 */

const ALG = 'RS256';
const KID = 'procure-1';

type KeyResolver = jose.JWTVerifyGetKey | jose.CryptoKey | Uint8Array;
let verifyKey: KeyResolver | undefined;
let signingKey: { key: jose.CryptoKey; jwk: jose.JWK } | undefined;

/** Identity only: load (or in local dev, create) the signing key. */
export async function loadSigningKey() {
  if (signingKey) return signingKey;
  let pem = config().AUTH_PRIVATE_KEY_PEM;
  if (!pem) {
    const dir = config().AUTH_KEYS_DIR;
    const file = join(dir, 'private.pem');
    if (existsSync(file)) {
      pem = await readFile(file, 'utf8');
    } else {
      if (!['local', 'test', 'dev'].includes(config().APP_ENV))
        throw new Error('AUTH_PRIVATE_KEY_PEM is required outside local/dev');
      const { privateKey } = await jose.generateKeyPair(ALG, { extractable: true });
      pem = await jose.exportPKCS8(privateKey);
      await mkdir(dir, { recursive: true });
      await writeFile(file, pem, { mode: 0o600 });
    }
  }
  const key = await jose.importPKCS8(pem, ALG, { extractable: true });
  const pub = await jose.exportJWK(key);
  // Strip private parts for publication.
  const { d, p, q, dp, dq, qi, ...publicJwk } = pub;
  signingKey = { key, jwk: { ...publicJwk, kid: KID, alg: ALG, use: 'sig' } };
  return signingKey;
}

export async function jwks(): Promise<{ keys: jose.JWK[] }> {
  const { jwk } = await loadSigningKey();
  return { keys: [jwk] };
}

export async function signAccessToken(claims: AccessClaims, ttlSeconds = config().ACCESS_TOKEN_TTL_SECONDS) {
  const { key } = await loadSigningKey();
  const { sub, ...rest } = claims;
  return new jose.SignJWT(rest as unknown as jose.JWTPayload)
    .setProtectedHeader({ alg: ALG, kid: KID })
    .setSubject(sub)
    .setIssuer(config().AUTH_ISSUER)
    .setAudience(config().AUTH_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .setJti(crypto.randomUUID())
    .sign(key);
}

const resolver = (): KeyResolver => {
  if (verifyKey) return verifyKey;
  const url = config().AUTH_JWKS_URL ?? 'http://127.0.0.1:4001/.well-known/jwks.json';
  verifyKey = jose.createRemoteJWKSet(new URL(url), { cooldownDuration: 30_000, cacheMaxAge: 600_000 });
  return verifyKey;
};

/** Tests / identity itself: verify against a local key instead of fetching JWKS. */
export const setVerifyKey = (k: KeyResolver | undefined) => {
  verifyKey = k;
};

export async function verifyAccessToken(token: string): Promise<AccessClaims> {
  try {
    const key = resolver();
    const opts = { issuer: config().AUTH_ISSUER, audience: config().AUTH_AUDIENCE, algorithms: [ALG] };
    const { payload } =
      typeof key === 'function'
        ? await jose.jwtVerify(token, key, opts)
        : await jose.jwtVerify(token, key, opts);
    return AccessClaims.parse(payload);
  } catch {
    throw unauthorized('Invalid or expired access token');
  }
}

/** The authenticated principal attached to every request. */
export class Principal {
  constructor(
    public readonly claims: AccessClaims,
    public readonly token: string,
  ) {}
  get userId() {
    return this.claims.sub;
  }
  get tenantId() {
    return this.claims.tenant;
  }
  get orgId() {
    return this.claims.org;
  }
  get actor() {
    return this.claims.actor;
  }
  get name() {
    return this.claims.name;
  }
  get isInternal() {
    return this.claims.actor === 'internal';
  }
  get isVendor() {
    return this.claims.actor === 'vendor';
  }
  get isClient() {
    return this.claims.actor === 'client';
  }
  can(p: Permission) {
    return this.claims.perms.includes(p);
  }
  require(...ps: Permission[]) {
    for (const p of ps) if (!this.can(p)) throw forbidden(`Missing permission: ${p}`);
  }
  requireInternal() {
    if (!this.isInternal && this.claims.actor !== 'platform') throw forbidden('Internal users only');
  }
}
