/**
 * CloudFormation custom resource: fills a Secrets Manager secret with generated key material if it
 * does not already hold some. Never overwrites existing material, so a value placed manually (see
 * docs/deployment.md) or rotated out-of-band survives stack updates. Delete is a no-op.
 *
 * Kinds:
 *   rsa-pkcs8-pem     RS256 private key, PKCS#8 PEM — identity AUTH_PRIVATE_KEY_PEM
 *                     (format expected by packages/platform/src/auth.ts → jose.importPKCS8)
 *   random-base64-32  32 random bytes, base64 — finance FINANCE_TOKEN_KEY (AES-256-GCM + HMAC)
 */
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import {
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import type { CloudFormationCustomResourceEvent } from 'aws-lambda';

const sm = new SecretsManagerClient({});

type Kind = 'rsa-pkcs8-pem' | 'random-base64-32';

const isPresent = (kind: Kind, v: string | undefined) => {
  if (!v) return false;
  if (kind === 'rsa-pkcs8-pem') return v.includes('-----BEGIN PRIVATE KEY-----');
  return Buffer.from(v, 'base64').length === 32 && /^[A-Za-z0-9+/]+=*$/.test(v);
};

const generate = (kind: Kind) => {
  if (kind === 'rsa-pkcs8-pem') {
    return generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    }).privateKey;
  }
  return randomBytes(32).toString('base64');
};

export async function handler(event: CloudFormationCustomResourceEvent) {
  const { SecretArn: secretArn, Kind: kind } = event.ResourceProperties as unknown as {
    SecretArn: string;
    Kind: Kind;
  };
  const physicalId = `pro-cure-generated-${kind}-${secretArn.split(':').pop()}`;
  if (event.RequestType === 'Delete') return { PhysicalResourceId: physicalId };
  if (kind !== 'rsa-pkcs8-pem' && kind !== 'random-base64-32') throw new Error(`unknown Kind ${kind}`);

  const current = await sm.send(new GetSecretValueCommand({ SecretId: secretArn }));
  if (isPresent(kind, current.SecretString)) {
    console.log(`${kind}: key material already present; leaving it unchanged`);
    return { PhysicalResourceId: physicalId };
  }
  await sm.send(new PutSecretValueCommand({ SecretId: secretArn, SecretString: generate(kind) }));
  console.log(`${kind}: generated new key material`);
  return { PhysicalResourceId: physicalId };
}
