import { CfnOutput, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import type * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import type * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import type { Construct } from 'constructs';
import type { StageConfig } from '../../config/index.js';
import { dbEnv, dbSecrets } from '../env.js';
import { names } from '../naming.js';

export interface PlatformStackProps extends StackProps {
  cfg: StageConfig;
  vpc: ec2.IVpc;
  albSg: ec2.ISecurityGroup;
  dbClientSg: ec2.ISecurityGroup;
  toolsRepo: ecr.IRepository;
  imageTag: string;
  ownerSecret: secretsmanager.ISecret;
  dbHost: string;
  dbPort: string;
  dbName: string;
  accessLogsBucket: s3.IBucket;
}

/**
 * Shared compute plumbing: ECS cluster, Cloud Map namespace `procure.internal`, the internal ALB +
 * listener (rules are added per service by the services stack) and the one-off `migrate` task
 * definition that CI runs before rolling services.
 */
export class PlatformStack extends Stack {
  readonly cluster: ecs.Cluster;
  readonly namespace: servicediscovery.PrivateDnsNamespace;
  readonly alb: elbv2.ApplicationLoadBalancer;
  readonly listener: elbv2.ApplicationListener;
  readonly migrateTask: ecs.FargateTaskDefinition;

  constructor(scope: Construct, id: string, props: PlatformStackProps) {
    super(scope, id, props);
    const { cfg, vpc } = props;
    const n = names(cfg);

    this.cluster = new ecs.Cluster(this, 'Cluster', {
      clusterName: n.cluster,
      vpc,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
      enableFargateCapacityProviders: true,
    });

    this.namespace = new servicediscovery.PrivateDnsNamespace(this, 'Namespace', {
      name: n.namespace,
      vpc,
      description: 'Pro-Cure service-to-service DNS (<service>.procure.internal)',
    });

    this.alb = new elbv2.ApplicationLoadBalancer(this, 'InternalAlb', {
      vpc,
      internetFacing: false,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroup: props.albSg,
      dropInvalidHeaderFields: true,
      idleTimeout: undefined,
      deletionProtection: cfg.stage === 'prod',
    });
    this.alb.logAccessLogs(props.accessLogsBucket, 'alb');
    // Private ALB behind API Gateway's VPC link; TLS terminates at CloudFront / API Gateway.
    this.listener = this.alb.addListener('Http', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      open: false,
      defaultAction: elbv2.ListenerAction.fixedResponse(404, {
        contentType: 'application/problem+json',
        messageBody: JSON.stringify({
          type: 'about:blank',
          title: 'Route not found',
          status: 404,
          code: 'not_found',
        }),
      }),
    });

    // ---- migrate: one-off task (same tools image) — see docs/deployment.md "Migrations"
    const migrateLogs = new logs.LogGroup(this, 'MigrateLogs', {
      logGroupName: n.logGroup('migrate'),
      retention: cfg.services.logRetentionDays as logs.RetentionDays,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    this.migrateTask = new ecs.FargateTaskDefinition(this, 'MigrateTask', {
      family: n.migrateFamily,
      cpu: 256,
      memoryLimitMiB: 512,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });
    this.migrateTask.addContainer('migrate', {
      containerName: 'migrate',
      image: ecs.ContainerImage.fromEcrRepository(props.toolsRepo, props.imageTag),
      command: ['node', 'dist-tools/migrate.mjs'],
      environment: {
        APP_ENV: cfg.appEnv,
        LOG_LEVEL: cfg.logLevel,
        ...dbEnv(props.dbHost, props.dbPort, props.dbName),
      },
      secrets: dbSecrets(props.ownerSecret, 'MIGRATION_DB'),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'migrate', logGroup: migrateLogs }),
      readonlyRootFilesystem: true,
    });

    new CfnOutput(this, 'ClusterName', { value: this.cluster.clusterName });
    new CfnOutput(this, 'MigrateTaskDefinitionArn', { value: this.migrateTask.taskDefinitionArn });
    new CfnOutput(this, 'MigrateSubnets', {
      value: vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }).subnetIds.join(','),
    });
    new CfnOutput(this, 'MigrateSecurityGroup', { value: props.dbClientSg.securityGroupId });
    new CfnOutput(this, 'InternalAlbDns', { value: this.alb.loadBalancerDnsName });
  }
}
