/**
 * The service registry is the single source of truth in packages/domain/src/services.ts (ports, route
 * prefixes, schemas). It has no imports, so the CDK app imports it directly instead of copying it.
 */
import { SERVICE_NAMES, SERVICES, type ServiceName } from '../../../packages/domain/src/services.js';

export { SERVICE_NAMES, SERVICES, type ServiceName };

/** What each service needs from AWS beyond the baseline (events, own queue, DB + auth secrets). */
export interface ServiceNeeds {
  /** Read/write the documents bucket. */
  documentsBucket?: 'readwrite' | 'read';
  bedrock?: boolean;
  textract?: boolean;
  ses?: boolean;
  /** Holds the RS256 signing key (identity). */
  signingKey?: boolean;
}

export const SERVICE_NEEDS: Record<ServiceName, ServiceNeeds> = {
  identity: { signingKey: true },
  catalog: {},
  projects: {},
  quoting: {},
  orders: {},
  finance: {},
  documents: { documentsBucket: 'readwrite' },
  // ai stores split/extracted artifacts (storage().put) and Textract reads documents from S3.
  ai: { documentsBucket: 'readwrite', bedrock: true, textract: true },
  // comms reads inbound raw MIME via storage().get(s3Key) (the inbound Lambda copies it into the
  // documents bucket first) and sends with SESv2.
  comms: { documentsBucket: 'readwrite', ses: true },
};
