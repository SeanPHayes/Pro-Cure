import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import type * as ec2 from 'aws-cdk-lib/aws-ec2';
import type * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import type * as events from 'aws-cdk-lib/aws-events';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import type * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import type { Construct } from 'constructs';
import type { StageConfig, TaskSizing } from '../../config/index.js';
import { dbEnv, dbSecrets } from '../env.js';
import { internalUrl, names } from '../naming.js';
import { SERVICE_NAMES, SERVICE_NEEDS, SERVICES, type ServiceName } from '../services.js';
import { SERVICE_ROUTING_HEADER } from './api-stack.js';
import type { ServiceQueues } from './events-stack.js';

export interface ServicesStackProps extends StackProps {
  cfg: StageConfig;
  imageTag: string;
  vpc: ec2.IVpc;
  cluster: ecs.ICluster;
  namespace: servicediscovery.IPrivateDnsNamespace;
  listener: elbv2.IApplicationListener;
  appSg: ec2.ISecurityGroup;
  dbClientSg: ec2.ISecurityGroup;
  repos: Record<ServiceName, ecr.IRepository>;
  bus: events.IEventBus;
  queues: Record<ServiceName, ServiceQueues>;
  dataKey: kms.IKey;
  documentsKey: kms.IKey;
  documentsBucket: s3.IBucket;
  appSecret: secretsmanager.ISecret;
  signingKeySecret: secretsmanager.ISecret;
  internalSecret: secretsmanager.ISecret;
  financeTokenKeySecret: secretsmanager.ISecret;
  dbHost: string;
  dbPort: string;
  dbName: string;
  webOrigin: string;
  userPoolId: string;
  userPoolClientId: string;
  sesConfigurationSetName: string;
}

export interface DeployedService {
  service: ecs.FargateService;
  targetGroup: elbv2.ApplicationTargetGroup;
  taskDefinition: ecs.FargateTaskDefinition;
}

/**
 * One Fargate service per backend service (ARM64). Each task:
 *   - registers in Cloud Map as <service>.procure.internal (A record) for service-to-service calls,
 *   - sits behind a target group on the internal ALB, selected by the `x-procure-service` header that
 *     API Gateway sets (the /api/<prefix> path prefix is already stripped there),
 *   - gets least-privilege IAM (see SERVICE_NEEDS) and every env var packages/platform/src/config.ts reads.
 */
export class ServicesStack extends Stack {
  readonly services = {} as Record<ServiceName, DeployedService>;

  constructor(scope: Construct, id: string, props: ServicesStackProps) {
    super(scope, id, props);
    const { cfg } = props;
    const n = names(cfg);

    const serviceUrls = Object.fromEntries(
      SERVICE_NAMES.map((s) => [`SERVICE_URL_${s.toUpperCase()}`, internalUrl(s, SERVICES[s].port)]),
    );

    // Optional, pre-created secrets (by name). Referenced only when configured.
    const optional = cfg.optionalSecrets;
    const anthropicSecret = optional.anthropicApiKey
      ? secretsmanager.Secret.fromSecretNameV2(this, 'AnthropicKey', optional.anthropicApiKey)
      : undefined;
    const qboSecret = optional.qbo
      ? secretsmanager.Secret.fromSecretNameV2(this, 'QboKeys', optional.qbo)
      : undefined;
    const aftershipSecret = optional.aftershipApiKey
      ? secretsmanager.Secret.fromSecretNameV2(this, 'AftershipKey', optional.aftershipApiKey)
      : undefined;
    const aiProvider = cfg.ai.provider === 'anthropic' && !anthropicSecret ? 'local' : cfg.ai.provider;

    for (const svc of SERVICE_NAMES) {
      const { port } = SERVICES[svc];
      const needs = SERVICE_NEEDS[svc];
      const sizing: TaskSizing = { ...cfg.services.defaults, ...(cfg.services.overrides?.[svc] ?? {}) };
      const { queue } = props.queues[svc];

      const logGroup = new logs.LogGroup(this, `${svc}Logs`, {
        logGroupName: n.logGroup(svc),
        retention: cfg.services.logRetentionDays as logs.RetentionDays,
        removalPolicy: cfg.stage === 'prod' ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      });

      const taskDefinition = new ecs.FargateTaskDefinition(this, `${svc}Task`, {
        family: `pro-cure-${cfg.stage}-${svc}`,
        cpu: sizing.cpu,
        memoryLimitMiB: sizing.memoryMiB,
        runtimePlatform: {
          cpuArchitecture: ecs.CpuArchitecture.ARM64,
          operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        },
      });
      const role = taskDefinition.taskRole;

      // ---------------------------------------------------------------- environment (config.ts)
      const environment: Record<string, string> = {
        APP_ENV: cfg.appEnv,
        LOG_LEVEL: cfg.logLevel,
        PORT: String(port),
        PUBLIC_WEB_URL: props.webOrigin,
        PUBLIC_API_URL: `${props.webOrigin}/api`,
        ...dbEnv(props.dbHost, props.dbPort, props.dbName),
        DB_POOL_MAX: String(cfg.database.poolMax),
        AUTH_ISSUER: `${props.webOrigin}/api/identity`,
        AUTH_AUDIENCE: 'pro-cure-api',
        AUTH_JWKS_URL: `${internalUrl('identity', SERVICES.identity.port)}/.well-known/jwks.json`,
        ACCESS_TOKEN_TTL_SECONDS: '3600',
        AUTH_DEV_LOGIN: 'false',
        COGNITO_USER_POOL_ID: props.userPoolId,
        COGNITO_CLIENT_ID: props.userPoolClientId,
        COGNITO_REGION: this.region,
        EVENT_TRANSPORT: 'eventbridge',
        EVENT_BUS_NAME: props.bus.eventBusName,
        EVENT_QUEUE_URL: queue.queueUrl,
        STORAGE_DRIVER: 's3',
        S3_BUCKET: props.documentsBucket.bucketName,
        AWS_REGION: this.region,
        AI_PROVIDER: aiProvider,
        AI_MODEL: cfg.ai.anthropicModel,
        BEDROCK_MODEL_ID: cfg.ai.bedrockModelId,
        OCR_PROVIDER: cfg.ai.ocrProvider,
        EMAIL_DRIVER: 'ses',
        EMAIL_FROM: cfg.email.fromAddress,
        INBOUND_EMAIL_DOMAIN: cfg.email.inboundDomain,
        JOBS_ENABLED: 'true',
        NODE_OPTIONS: '--enable-source-maps',
        ...serviceUrls,
      };
      const secrets: Record<string, ecs.Secret> = {
        ...dbSecrets(props.appSecret, 'DB'),
        INTERNAL_SHARED_SECRET: ecs.Secret.fromSecretsManager(props.internalSecret),
      };
      if (needs.signingKey)
        secrets.AUTH_PRIVATE_KEY_PEM = ecs.Secret.fromSecretsManager(props.signingKeySecret);
      if (anthropicSecret && svc === 'ai')
        secrets.ANTHROPIC_API_KEY = ecs.Secret.fromSecretsManager(anthropicSecret);
      if (svc === 'comms') environment.SES_CONFIGURATION_SET = props.sesConfigurationSetName;
      if (svc === 'finance') {
        environment.QBO_ENVIRONMENT = cfg.qboEnvironment;
        environment.QBO_REDIRECT_URI = `${props.webOrigin}/api/finance/integrations/qbo/callback`;
        secrets.FINANCE_TOKEN_KEY = ecs.Secret.fromSecretsManager(props.financeTokenKeySecret);
        if (qboSecret) {
          secrets.QBO_CLIENT_ID = ecs.Secret.fromSecretsManager(qboSecret, 'clientId');
          secrets.QBO_CLIENT_SECRET = ecs.Secret.fromSecretsManager(qboSecret, 'clientSecret');
        }
      }
      if (svc === 'orders') {
        environment.TRACKING_PROVIDER = aftershipSecret ? 'aftership' : 'simulated';
        if (aftershipSecret) secrets.AFTERSHIP_API_KEY = ecs.Secret.fromSecretsManager(aftershipSecret);
      }

      const container = taskDefinition.addContainer('app', {
        containerName: svc,
        image: ecs.ContainerImage.fromEcrRepository(props.repos[svc], props.imageTag),
        environment,
        secrets,
        portMappings: [{ containerPort: port, name: svc, protocol: ecs.Protocol.TCP }],
        logging: ecs.LogDrivers.awsLogs({
          streamPrefix: svc,
          logGroup,
          mode: ecs.AwsLogDriverMode.NON_BLOCKING,
        }),
        healthCheck: {
          command: ['CMD-SHELL', `wget -q -O /dev/null http://127.0.0.1:${port}/health || exit 1`],
          interval: Duration.seconds(30),
          timeout: Duration.seconds(5),
          retries: 3,
          startPeriod: Duration.seconds(30),
        },
        stopTimeout: Duration.seconds(30),
      });
      container.addUlimits({ name: ecs.UlimitName.NOFILE, softLimit: 65536, hardLimit: 65536 });

      if (cfg.services.xraySidecar) {
        taskDefinition.addContainer('otel', {
          containerName: 'aws-otel-collector',
          image: ecs.ContainerImage.fromRegistry(
            'public.ecr.aws/aws-observability/aws-otel-collector:v0.43.3',
          ),
          command: ['--config=/etc/ecs/ecs-default-config.yaml'],
          essential: false,
          memoryReservationMiB: 64,
          logging: ecs.LogDrivers.awsLogs({ streamPrefix: `${svc}-otel`, logGroup }),
        });
        role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AWSXRayDaemonWriteAccess'));
      }

      // ---------------------------------------------------------------- IAM (least privilege)
      props.bus.grantPutEventsTo(role);
      queue.grantConsumeMessages(role); // includes kms:Decrypt on the data key
      if (needs.documentsBucket === 'readwrite') {
        props.documentsBucket.grantReadWrite(role);
        props.documentsKey.grantEncryptDecrypt(role);
      } else if (needs.documentsBucket === 'read') {
        props.documentsBucket.grantRead(role);
        props.documentsKey.grantDecrypt(role);
      }
      if (needs.bedrock) {
        role.addToPrincipalPolicy(
          new iam.PolicyStatement({
            actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
            resources: [
              'arn:aws:bedrock:*::foundation-model/anthropic.*',
              `arn:aws:bedrock:*:${this.account}:inference-profile/*`,
            ],
          }),
        );
      }
      if (needs.textract) {
        role.addToPrincipalPolicy(
          new iam.PolicyStatement({
            actions: [
              'textract:AnalyzeDocument',
              'textract:DetectDocumentText',
              'textract:StartDocumentTextDetection',
              'textract:GetDocumentTextDetection',
              'textract:StartDocumentAnalysis',
              'textract:GetDocumentAnalysis',
            ],
            resources: ['*'], // Textract has no resource-level permissions
          }),
        );
      }
      if (needs.ses) {
        role.addToPrincipalPolicy(
          new iam.PolicyStatement({
            actions: ['ses:SendEmail', 'ses:SendRawEmail'],
            resources: [
              `arn:aws:ses:${this.region}:${this.account}:identity/${cfg.email.domain}`,
              `arn:aws:ses:${this.region}:${this.account}:identity/*@${cfg.email.domain}`,
              `arn:aws:ses:${this.region}:${this.account}:configuration-set/${props.sesConfigurationSetName}`,
            ],
          }),
        );
      }
      // ECS injects secrets with the execution role (granted automatically by ecs.Secret); KMS decrypt
      // for the customer-managed data key is needed explicitly.
      props.dataKey.grantDecrypt(taskDefinition.obtainExecutionRole());

      // ---------------------------------------------------------------- service
      const service = new ecs.FargateService(this, `${svc}Service`, {
        serviceName: svc,
        cluster: props.cluster,
        taskDefinition,
        desiredCount: sizing.desiredCount,
        securityGroups: [props.appSg, props.dbClientSg],
        vpcSubnets: { subnets: props.vpc.privateSubnets },
        assignPublicIp: false,
        circuitBreaker: { enable: true, rollback: true },
        minHealthyPercent: 100,
        maxHealthyPercent: 200,
        healthCheckGracePeriod: Duration.seconds(60),
        enableExecuteCommand: cfg.stage !== 'prod',
        propagateTags: ecs.PropagatedTagSource.SERVICE,
        cloudMapOptions: {
          name: svc,
          cloudMapNamespace: props.namespace,
          dnsTtl: Duration.seconds(10),
          container,
          containerPort: port,
        },
        capacityProviderStrategies: cfg.services.spot
          ? [
              { capacityProvider: 'FARGATE_SPOT', weight: 3 },
              { capacityProvider: 'FARGATE', weight: 1, base: 1 },
            ]
          : [{ capacityProvider: 'FARGATE', weight: 1 }],
      });

      const targetGroup = new elbv2.ApplicationTargetGroup(this, `${svc}Tg`, {
        vpc: props.vpc,
        port,
        protocol: elbv2.ApplicationProtocol.HTTP,
        targetType: elbv2.TargetType.IP,
        targets: [service.loadBalancerTarget({ containerName: svc, containerPort: port })],
        deregistrationDelay: Duration.seconds(15),
        healthCheck: {
          path: '/health',
          healthyHttpCodes: '200',
          interval: Duration.seconds(15),
          timeout: Duration.seconds(5),
          healthyThresholdCount: 2,
          unhealthyThresholdCount: 3,
        },
      });
      new elbv2.ApplicationListenerRule(this, `${svc}Rule`, {
        listener: props.listener,
        priority: 10 + SERVICE_NAMES.indexOf(svc) * 10,
        conditions: [elbv2.ListenerCondition.httpHeader(SERVICE_ROUTING_HEADER, [svc])],
        action: elbv2.ListenerAction.forward([targetGroup]),
      });

      const scaling = service.autoScaleTaskCount({
        minCapacity: sizing.minCount,
        maxCapacity: sizing.maxCount,
      });
      scaling.scaleOnCpuUtilization('Cpu', {
        targetUtilizationPercent: 60,
        scaleInCooldown: Duration.minutes(5),
        scaleOutCooldown: Duration.minutes(1),
      });
      scaling.scaleOnRequestCount('Requests', {
        requestsPerTarget: 1000,
        targetGroup,
        scaleInCooldown: Duration.minutes(5),
        scaleOutCooldown: Duration.minutes(1),
      });

      this.services[svc] = { service, targetGroup, taskDefinition };
    }

    new CfnOutput(this, 'ServiceNames', { value: SERVICE_NAMES.join(',') });
  }
}
