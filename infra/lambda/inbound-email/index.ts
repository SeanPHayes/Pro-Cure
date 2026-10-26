/**
 * SES inbound receipt rule → (S3 action writes raw MIME to the inbound bucket) → this Lambda.
 *
 * 1. Copies the raw message from the inbound landing bucket into the documents bucket under
 *    `inbound-email/<messageId>.eml` (comms reads with storage().get(s3Key) against S3_BUCKET, i.e. the
 *    documents bucket, and ignores `s3Bucket`).
 * 2. POSTs { s3Key, s3Bucket } to comms `/inbound/ses` over the internal network (Cloud Map DNS) with the
 *    `x-procure-internal` shared secret.
 *
 * Throws on failure so the asynchronous invocation is retried (2x) and then lands in the DLQ.
 */
import { CopyObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { SESEvent } from 'aws-lambda';

const s3 = new S3Client({});
const sm = new SecretsManagerClient({});

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is not set`);
  return v;
};

let secretCache: string | undefined;
const internalSecret = async (): Promise<string> => {
  if (!secretCache) {
    const res = await sm.send(new GetSecretValueCommand({ SecretId: env('INTERNAL_SECRET_ARN') }));
    if (!res.SecretString) throw new Error('internal shared secret is empty');
    secretCache = res.SecretString;
  }
  return secretCache;
};

export async function handler(event: SESEvent) {
  const inboundBucket = env('INBOUND_BUCKET');
  const inboundPrefix = process.env.INBOUND_PREFIX ?? 'raw/';
  const documentsBucket = env('DOCUMENTS_BUCKET');
  const commsUrl = env('COMMS_URL');

  for (const record of event.Records) {
    const messageId = record.ses.mail.messageId;
    if (!/^[A-Za-z0-9._-]+$/.test(messageId)) throw new Error(`unexpected SES messageId: ${messageId}`);
    const sourceKey = `${inboundPrefix}${messageId}`;
    const s3Key = `inbound-email/${messageId}.eml`;

    await s3.send(
      new CopyObjectCommand({
        Bucket: documentsBucket,
        Key: s3Key,
        CopySource: `${inboundBucket}/${encodeURIComponent(sourceKey)}`,
        ContentType: 'message/rfc822',
        MetadataDirective: 'REPLACE',
        ServerSideEncryption: 'aws:kms',
        ...(process.env.DOCUMENTS_KMS_KEY_ARN ? { SSEKMSKeyId: process.env.DOCUMENTS_KMS_KEY_ARN } : {}),
      }),
    );

    const res = await fetch(`${commsUrl}/inbound/ses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-procure-internal': await internalSecret() },
      body: JSON.stringify({ s3Key, s3Bucket: documentsBucket }),
      signal: AbortSignal.timeout(25_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`comms /inbound/ses → HTTP ${res.status}: ${text.slice(0, 500)}`);
    console.log(JSON.stringify({ messageId, s3Key, status: res.status, response: text.slice(0, 300) }));
  }
  return { disposition: 'CONTINUE' };
}
