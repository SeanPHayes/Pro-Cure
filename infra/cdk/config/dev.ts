import type { StageConfig } from './types.js';

export const dev: StageConfig = {
  stage: 'dev',
  account: '111111111111',
  region: 'us-east-1',
  appEnv: 'dev',
  logLevel: 'debug',
  domains: {
    web: 'dev.app.pro-cure.example',
    api: 'dev.api.pro-cure.example',
    useCustomDomains: false,
  },
  network: { cidr: '10.10.0.0/16', natGateways: 1, endpointAzCount: 1, flowLogRetentionDays: 14 },
  database: {
    minAcu: 0.5,
    maxAcu: 4,
    reader: false,
    backupRetentionDays: 7,
    deletionProtection: false,
    poolMax: 5,
  },
  services: {
    defaults: { cpu: 256, memoryMiB: 512, desiredCount: 1, minCount: 1, maxCount: 2 },
    overrides: {
      documents: { cpu: 512, memoryMiB: 1024 },
      ai: { cpu: 512, memoryMiB: 1024 },
    },
    logRetentionDays: 14,
    xraySidecar: false,
    spot: true,
  },
  api: { throttleRateLimit: 200, throttleBurstLimit: 400 },
  ai: {
    provider: 'bedrock',
    bedrockModelId: 'us.anthropic.claude-sonnet-5-5-v1:0',
    anthropicModel: 'claude-sonnet-5-5',
    ocrProvider: 'textract',
  },
  email: {
    domain: 'dev.pro-cure.example',
    inboundDomain: 'inbound.dev.pro-cure.example',
    fromAddress: 'Pro-Cure Dev <noreply@dev.pro-cure.example>',
    activateReceiptRuleSet: true,
  },
  auth: {
    cognitoDomainPrefix: 'pro-cure-dev-auth',
    extraCallbackUrls: ['http://localhost:5173/auth/callback'],
    mfa: 'optional',
    featurePlan: 'PLUS',
  },
  optionalSecrets: {},
  qboEnvironment: 'sandbox',
  alarms: { email: 'alerts-dev@pro-cure.example' },
  tags: {},
};
