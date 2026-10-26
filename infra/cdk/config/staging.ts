import type { StageConfig } from './types.js';

export const staging: StageConfig = {
  stage: 'staging',
  account: '222222222222',
  region: 'us-east-1',
  appEnv: 'staging',
  logLevel: 'info',
  domains: {
    web: 'staging.app.pro-cure.example',
    api: 'staging.api.pro-cure.example',
    useCustomDomains: false,
  },
  network: { cidr: '10.20.0.0/16', natGateways: 1, endpointAzCount: 2, flowLogRetentionDays: 30 },
  database: {
    minAcu: 0.5,
    maxAcu: 8,
    reader: false,
    backupRetentionDays: 7,
    deletionProtection: true,
    poolMax: 8,
  },
  services: {
    defaults: { cpu: 512, memoryMiB: 1024, desiredCount: 1, minCount: 1, maxCount: 4 },
    overrides: { documents: { memoryMiB: 2048 }, ai: { memoryMiB: 2048 } },
    logRetentionDays: 30,
    xraySidecar: false,
    spot: true,
  },
  api: { throttleRateLimit: 500, throttleBurstLimit: 1000 },
  ai: {
    provider: 'bedrock',
    bedrockModelId: 'us.anthropic.claude-sonnet-5-5-v1:0',
    anthropicModel: 'claude-sonnet-5-5',
    ocrProvider: 'textract',
  },
  email: {
    domain: 'staging.pro-cure.example',
    inboundDomain: 'inbound.staging.pro-cure.example',
    fromAddress: 'Pro-Cure Staging <noreply@staging.pro-cure.example>',
    activateReceiptRuleSet: true,
  },
  auth: {
    cognitoDomainPrefix: 'pro-cure-staging-auth',
    extraCallbackUrls: [],
    mfa: 'optional',
    featurePlan: 'PLUS',
  },
  optionalSecrets: {},
  qboEnvironment: 'sandbox',
  alarms: { email: 'alerts-staging@pro-cure.example' },
  tags: {},
};
