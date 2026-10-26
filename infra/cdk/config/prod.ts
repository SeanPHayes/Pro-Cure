import type { StageConfig } from './types.js';

export const prod: StageConfig = {
  stage: 'prod',
  account: '333333333333',
  region: 'us-east-1',
  appEnv: 'production',
  logLevel: 'info',
  domains: {
    web: 'app.pro-cure.example',
    api: 'api.pro-cure.example',
    // Fill in once issued (CloudFront cert must be in us-east-1), then set useCustomDomains: true.
    // webCertificateArn: 'arn:aws:acm:us-east-1:333333333333:certificate/…',
    // apiCertificateArn: 'arn:aws:acm:us-east-1:333333333333:certificate/…',
    useCustomDomains: false,
  },
  network: { cidr: '10.30.0.0/16', natGateways: 3, endpointAzCount: 3, flowLogRetentionDays: 90 },
  database: {
    minAcu: 1,
    maxAcu: 16,
    reader: true,
    backupRetentionDays: 35,
    deletionProtection: true,
    poolMax: 10,
  },
  services: {
    defaults: { cpu: 512, memoryMiB: 1024, desiredCount: 2, minCount: 2, maxCount: 8 },
    overrides: {
      documents: { cpu: 1024, memoryMiB: 2048 },
      ai: { cpu: 1024, memoryMiB: 2048 },
      quoting: { cpu: 1024, memoryMiB: 2048 },
    },
    logRetentionDays: 365,
    xraySidecar: true,
    spot: false,
  },
  api: { throttleRateLimit: 1000, throttleBurstLimit: 2000 },
  ai: {
    provider: 'bedrock',
    bedrockModelId: 'us.anthropic.claude-sonnet-5-5-v1:0',
    anthropicModel: 'claude-sonnet-5-5',
    ocrProvider: 'textract',
  },
  email: {
    domain: 'pro-cure.example',
    inboundDomain: 'inbound.pro-cure.example',
    fromAddress: 'Pro-Cure <noreply@pro-cure.example>',
    activateReceiptRuleSet: true,
  },
  auth: {
    cognitoDomainPrefix: 'pro-cure-auth',
    extraCallbackUrls: [],
    mfa: 'optional',
    featurePlan: 'PLUS',
    // Entra ID (Azure AD) SAML — see docs/deployment.md "Entra ID SAML app".
    // entraSaml: { metadataUrl: 'https://login.microsoftonline.com/<tenant-id>/federationmetadata/2007-06/federationmetadata.xml?appid=<app-id>', providerName: 'EntraID' },
    // google: { clientId: '<id>.apps.googleusercontent.com', clientSecretName: 'pro-cure/prod/google-client-secret' },
  },
  optionalSecrets: {
    // anthropicApiKey: 'pro-cure/prod/anthropic-api-key',
    // qbo: 'pro-cure/prod/qbo',
    // aftershipApiKey: 'pro-cure/prod/aftership-api-key',
  },
  qboEnvironment: 'production',
  alarms: { email: 'alerts@pro-cure.example' },
  tags: { CostCenter: 'platform' },
};
