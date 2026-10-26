import type { ServiceName } from '../lib/services.js';

export type StageName = 'dev' | 'staging' | 'prod';

export interface TaskSizing {
  /** Fargate CPU units (256, 512, 1024, 2048, 4096). */
  cpu: number;
  /** Fargate memory MiB (must be valid for the CPU value). */
  memoryMiB: number;
  desiredCount: number;
  minCount: number;
  maxCount: number;
}

export interface StageConfig {
  stage: StageName;
  /** AWS account id. Placeholder by default; override with `-c account=…` or CDK_DEFAULT_ACCOUNT. */
  account: string;
  region: string;
  /** `APP_ENV` passed to services (packages/platform/src/config.ts enum). */
  appEnv: 'dev' | 'staging' | 'production';
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

  domains: {
    /** Web origin, e.g. app.pro-cure.example. Served by CloudFront. */
    web: string;
    /** Optional direct API domain on API Gateway (CloudFront also serves /api/* on the web domain). */
    api: string;
    /** ACM certificate in us-east-1 for `web` (CloudFront). Omit → CloudFront default domain. */
    webCertificateArn?: string;
    /** Regional ACM certificate for `api` (API Gateway custom domain). Omit → no custom domain. */
    apiCertificateArn?: string;
    /**
     * When false, PUBLIC_WEB_URL/PUBLIC_API_URL use the CloudFront *.cloudfront.net domain (first
     * deploy before DNS/certificates exist). Set true once `web` resolves to the distribution.
     */
    useCustomDomains: boolean;
  };

  network: {
    cidr: string;
    /** Defaults to <region>a/b/c. Override if the account lacks one of them. */
    availabilityZones?: string[];
    natGateways: number;
    /** Interface VPC endpoints are ~$7/AZ/month each; dev places them in fewer AZs. */
    endpointAzCount: number;
    flowLogRetentionDays: number;
  };

  database: {
    minAcu: number;
    maxAcu: number;
    /** Add a Serverless v2 reader instance (prod: Multi-AZ failover target). */
    reader: boolean;
    backupRetentionDays: number;
    deletionProtection: boolean;
    /** Connection pool per task (DB_POOL_MAX). */
    poolMax: number;
  };

  services: {
    defaults: TaskSizing;
    overrides?: Partial<Record<ServiceName, Partial<TaskSizing>>>;
    logRetentionDays: number;
    /** Add an AWS Distro for OpenTelemetry collector sidecar (X-Ray) to every task. */
    xraySidecar: boolean;
    /** Use FARGATE_SPOT capacity (dev/staging cost saver). */
    spot: boolean;
  };

  api: {
    throttleRateLimit: number;
    throttleBurstLimit: number;
  };

  ai: {
    provider: 'bedrock' | 'anthropic' | 'local';
    /** Bedrock model or inference-profile id (cross-region profiles start with `us.`). */
    bedrockModelId: string;
    /** Model name for the Anthropic API provider. */
    anthropicModel: string;
    ocrProvider: 'textract' | 'local';
  };

  email: {
    /** SES sending domain (identity + DKIM). */
    domain: string;
    /** Inbound receiving domain (MX → inbound-smtp.<region>.amazonaws.com). */
    inboundDomain: string;
    fromAddress: string;
    /** Activate the receipt rule set (only one rule set per account/region can be active). */
    activateReceiptRuleSet: boolean;
  };

  auth: {
    /** Cognito hosted UI domain prefix (globally unique per region). */
    cognitoDomainPrefix: string;
    /** Extra OAuth callback URLs (e.g. http://localhost:5173/auth/callback for dev). */
    extraCallbackUrls: string[];
    mfa: 'off' | 'optional' | 'required';
    /** Cognito feature plan; PLUS enables threat protection (advanced security) audit mode. */
    featurePlan: 'ESSENTIALS' | 'PLUS';
    /** Entra ID SAML: either a metadata URL or the XML document. Omit → provider not created. */
    entraSaml?: { metadataUrl?: string; metadataXml?: string; providerName?: string };
    /**
     * Google OAuth client. The client secret is read from Secrets Manager (plain-text secret name);
     * create it before deploying. Omit → provider not created.
     */
    google?: { clientId: string; clientSecretName: string };
  };

  /** Optional pre-created secrets (Secrets Manager names). Omit → feature disabled. */
  optionalSecrets: {
    /** Plain string: Anthropic API key (AI_PROVIDER=anthropic). */
    anthropicApiKey?: string;
    /** JSON { "clientId": "...", "clientSecret": "..." } — QuickBooks Online app keys. */
    qbo?: string;
    /** Plain string: AfterShip API key (TRACKING_PROVIDER=aftership). */
    aftershipApiKey?: string;
  };
  qboEnvironment: 'sandbox' | 'production';

  alarms: {
    email: string;
  };

  tags: Record<string, string>;
}
