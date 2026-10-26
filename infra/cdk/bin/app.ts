/**
 * Pro-Cure CDK app.
 *
 *   npx cdk synth --all -c stage=dev                       # no AWS credentials needed
 *   npx cdk deploy --all -c stage=dev -c imageTag=<sha> -c account=<id>
 *
 * Context: stage (dev|staging|prod, default dev), imageTag (default latest), account, region.
 * Stack order: Network → Ecr, Data, Events → Platform → Api → Web → Auth → Services → Email → Observability
 */
import { App, CfnOutput, Tags } from 'aws-cdk-lib';
import { loadConfig } from '../config/index.js';
import { names } from '../lib/naming.js';
import { ApiStack } from '../lib/stacks/api-stack.js';
import { AuthStack } from '../lib/stacks/auth-stack.js';
import { DataStack } from '../lib/stacks/data-stack.js';
import { EcrStack } from '../lib/stacks/ecr-stack.js';
import { EmailStack, sesConfigurationSetName } from '../lib/stacks/email-stack.js';
import { EventsStack } from '../lib/stacks/events-stack.js';
import { NetworkStack } from '../lib/stacks/network-stack.js';
import { ObservabilityStack } from '../lib/stacks/observability-stack.js';
import { PlatformStack } from '../lib/stacks/platform-stack.js';
import { ServicesStack } from '../lib/stacks/services-stack.js';
import { WebStack } from '../lib/stacks/web-stack.js';

const app = new App();
const stage = (app.node.tryGetContext('stage') as string | undefined) ?? 'dev';
const imageTag = (app.node.tryGetContext('imageTag') as string | undefined) ?? 'latest';
const cfg = loadConfig(stage, {
  account: app.node.tryGetContext('account') as string | undefined,
  region: app.node.tryGetContext('region') as string | undefined,
});
const env = { account: cfg.account, region: cfg.region };
const n = names(cfg);
const common = { env, cfg, terminationProtection: cfg.stage === 'prod' };

const network = new NetworkStack(app, n.stack('Network'), {
  ...common,
  description: 'Pro-Cure VPC, endpoints, SGs',
});
const ecrStack = new EcrStack(app, n.stack('Ecr'), { ...common, description: 'Pro-Cure ECR repositories' });
const data = new DataStack(app, n.stack('Data'), {
  ...common,
  description: 'Pro-Cure Aurora, KMS, secrets, S3',
  vpc: network.vpc,
});
const eventsStack = new EventsStack(app, n.stack('Events'), {
  ...common,
  description: 'Pro-Cure EventBridge bus, per-service SQS queues + DLQs',
  dataKey: data.dataKey,
});
const dbHost = data.cluster.clusterEndpoint.hostname;
const dbPort = String(data.cluster.clusterEndpoint.port);

const platform = new PlatformStack(app, n.stack('Platform'), {
  ...common,
  description: 'Pro-Cure ECS cluster, Cloud Map, internal ALB, migrate task',
  vpc: network.vpc,
  albSg: network.albSg,
  dbClientSg: data.dbClientSecurityGroup,
  toolsRepo: ecrStack.repos.tools,
  imageTag,
  ownerSecret: data.ownerSecret,
  dbHost,
  dbPort,
  dbName: data.dbName,
  accessLogsBucket: data.accessLogsBucket,
});
const api = new ApiStack(app, n.stack('Api'), {
  ...common,
  description: 'Pro-Cure HTTP API + VPC link',
  vpc: network.vpc,
  vpcLinkSg: network.vpcLinkSg,
  listener: platform.listener,
});
const web = new WebStack(app, n.stack('Web'), {
  ...common,
  description: 'Pro-Cure SPA bucket, CloudFront, WAF',
  apiDomain: api.apiDomain,
  accessLogsBucket: data.accessLogsBucket,
});
const auth = new AuthStack(app, n.stack('Auth'), {
  ...common,
  description: 'Pro-Cure Cognito user pool',
  webOrigins: [...new Set([web.webOrigin, `https://${cfg.domains.web}`])],
});
const services = new ServicesStack(app, n.stack('Services'), {
  ...common,
  description: 'Pro-Cure Fargate services',
  imageTag,
  vpc: network.vpc,
  cluster: platform.cluster,
  namespace: platform.namespace,
  listener: platform.listener,
  appSg: network.appSg,
  dbClientSg: data.dbClientSecurityGroup,
  repos: ecrStack.repos,
  bus: eventsStack.bus,
  queues: eventsStack.queues,
  dataKey: data.dataKey,
  documentsKey: data.documentsKey,
  documentsBucket: data.documentsBucket,
  appSecret: data.appSecret,
  signingKeySecret: data.signingKeySecret,
  internalSecret: data.internalSecret,
  financeTokenKeySecret: data.financeTokenKeySecret,
  dbHost,
  dbPort,
  dbName: data.dbName,
  webOrigin: web.webOrigin,
  userPoolId: auth.userPool.userPoolId,
  userPoolClientId: auth.client.userPoolClientId,
  sesConfigurationSetName: sesConfigurationSetName(cfg.stage),
});
const email = new EmailStack(app, n.stack('Email'), {
  ...common,
  description: 'Pro-Cure SES outbound + inbound',
  vpc: network.vpc,
  internalClientSg: network.internalClientSg,
  inboundBucket: data.inboundBucket,
  documentsBucket: data.documentsBucket,
  documentsKey: data.documentsKey,
  internalSecret: data.internalSecret,
});
new ObservabilityStack(app, n.stack('Observability'), {
  ...common,
  description: 'Pro-Cure dashboard + alarms',
  alb: platform.alb,
  services: services.services,
  queues: eventsStack.queues,
  cluster: data.cluster,
  api: api.api,
});

// Convenience outputs used by the deploy workflow (web build env) and humans.
new CfnOutput(data, 'DocumentsBucketName', { value: data.documentsBucket.bucketName });
new CfnOutput(data, 'InboundBucketName', { value: data.inboundBucket.bucketName });
new CfnOutput(data, 'ClusterEndpoint', { value: dbHost });
new CfnOutput(data, 'ClusterReaderEndpoint', { value: data.cluster.clusterReadEndpoint.hostname });
new CfnOutput(web, 'ApiUrl', { value: `${web.webOrigin}/api` });
new CfnOutput(email, 'InboundLambdaName', { value: email.inboundFn.functionName });

Tags.of(app).add('Project', 'Pro-Cure');
Tags.of(app).add('Stage', cfg.stage);
Tags.of(app).add('Owner', 'JMHS');
for (const [k, v] of Object.entries(cfg.tags)) Tags.of(app).add(k, v);

app.synth();
