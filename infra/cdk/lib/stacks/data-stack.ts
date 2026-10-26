import { CustomResource, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as cr from 'aws-cdk-lib/custom-resources';
import type { Construct } from 'constructs';
import type { StageConfig } from '../../config/index.js';
import { procureLambda } from '../lambda.js';
import { names } from '../naming.js';

export interface DataStackProps extends StackProps {
  cfg: StageConfig;
  vpc: ec2.IVpc;
}

/**
 * Stateful resources: KMS keys, Aurora PostgreSQL 16 Serverless v2, DB role secrets + bootstrap,
 * application secrets, documents + inbound-email buckets.
 */
export class DataStack extends Stack {
  /**
   * Key *references* (by ARN). Everything — including resources in this stack — uses these, so grants
   * from other stacks go to the grantee's IAM policy (the default key policy delegates to IAM via the
   * account root) instead of mutating the key policy here, which would create cross-stack cycles.
   */
  readonly dataKey: kms.IKey;
  readonly documentsKey: kms.IKey;
  readonly cluster: rds.DatabaseCluster;
  readonly dbSecurityGroup: ec2.SecurityGroup;
  /** Security group whose members may connect to Aurora (ECS tasks, bootstrap Lambda). */
  readonly dbClientSecurityGroup: ec2.SecurityGroup;
  readonly ownerSecret: secretsmanager.Secret;
  readonly appSecret: secretsmanager.Secret;
  readonly signingKeySecret: secretsmanager.Secret;
  readonly internalSecret: secretsmanager.Secret;
  readonly financeTokenKeySecret: secretsmanager.Secret;
  readonly documentsBucket: s3.Bucket;
  readonly inboundBucket: s3.Bucket;
  readonly accessLogsBucket: s3.Bucket;
  readonly dbName: string;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);
    const { cfg, vpc } = props;
    const n = names(cfg);
    const prod = cfg.stage === 'prod';
    const retain = prod ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;
    this.dbName = n.dbName;

    // ------------------------------------------------------------------ KMS
    const dataKey = new kms.Key(this, 'DataKey', {
      alias: `alias/pro-cure-${cfg.stage}-data`,
      description: 'Pro-Cure: Aurora, Secrets Manager, SQS, logs',
      enableKeyRotation: true,
      removalPolicy: retain,
    });
    // CloudWatch Logs + EventBridge (→ SQS) need the key policy to allow them.
    dataKey.addToResourcePolicy(
      new iam.PolicyStatement({
        principals: [new iam.ServicePrincipal(`logs.${this.region}.amazonaws.com`)],
        actions: ['kms:Encrypt*', 'kms:Decrypt*', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:Describe*'],
        resources: ['*'],
      }),
    );
    dataKey.addToResourcePolicy(
      new iam.PolicyStatement({
        principals: [new iam.ServicePrincipal('events.amazonaws.com')],
        actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
        resources: ['*'],
      }),
    );
    const documentsKey = new kms.Key(this, 'DocumentsKey', {
      alias: `alias/pro-cure-${cfg.stage}-documents`,
      description: 'Pro-Cure: S3 documents and inbound email',
      enableKeyRotation: true,
      removalPolicy: retain,
    });
    // SES writes inbound mail into the KMS-encrypted inbound bucket.
    documentsKey.addToResourcePolicy(
      new iam.PolicyStatement({
        principals: [new iam.ServicePrincipal('ses.amazonaws.com')],
        actions: ['kms:GenerateDataKey*', 'kms:Encrypt'],
        resources: ['*'],
        conditions: { StringEquals: { 'aws:SourceAccount': this.account } },
      }),
    );

    this.dataKey = kms.Key.fromKeyArn(this, 'DataKeyRef', dataKey.keyArn);
    this.documentsKey = kms.Key.fromKeyArn(this, 'DocumentsKeyRef', documentsKey.keyArn);

    // ------------------------------------------------------------------ Aurora
    this.dbClientSecurityGroup = new ec2.SecurityGroup(this, 'DbClientSg', {
      vpc,
      description: 'Members may connect to Aurora',
    });
    this.dbSecurityGroup = new ec2.SecurityGroup(this, 'DbSg', {
      vpc,
      description: 'Aurora PostgreSQL',
      allowAllOutbound: false,
    });
    this.dbSecurityGroup.addIngressRule(
      this.dbClientSecurityGroup,
      ec2.Port.tcp(5432),
      'Postgres from app tier',
    );

    const parameterGroup = new rds.ParameterGroup(this, 'DbParams', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({ version: rds.AuroraPostgresEngineVersion.VER_16_6 }),
      parameters: {
        'rds.force_ssl': '1',
        log_min_duration_statement: '1000',
        'pg_stat_statements.track': 'all',
        shared_preload_libraries: 'pg_stat_statements',
      },
    });

    const pi = { enablePerformanceInsights: true, performanceInsightEncryptionKey: this.dataKey };
    this.cluster = new rds.DatabaseCluster(this, 'Aurora', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({ version: rds.AuroraPostgresEngineVersion.VER_16_6 }),
      clusterIdentifier: `pro-cure-${cfg.stage}`,
      credentials: rds.Credentials.fromGeneratedSecret('procure_admin', {
        secretName: n.secret('db/master'),
        encryptionKey: this.dataKey,
      }),
      defaultDatabaseName: 'postgres',
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [this.dbSecurityGroup],
      parameterGroup,
      serverlessV2MinCapacity: cfg.database.minAcu,
      serverlessV2MaxCapacity: cfg.database.maxAcu,
      writer: rds.ClusterInstance.serverlessV2('writer', { ...pi, publiclyAccessible: false }),
      readers: cfg.database.reader
        ? [
            rds.ClusterInstance.serverlessV2('reader', {
              ...pi,
              scaleWithWriter: true,
              publiclyAccessible: false,
            }),
          ]
        : [],
      storageEncrypted: true,
      storageEncryptionKey: this.dataKey,
      iamAuthentication: true,
      backup: { retention: Duration.days(cfg.database.backupRetentionDays), preferredWindow: '06:00-07:00' },
      preferredMaintenanceWindow: 'sun:07:30-sun:08:30',
      deletionProtection: cfg.database.deletionProtection,
      removalPolicy: prod ? RemovalPolicy.SNAPSHOT : RemovalPolicy.DESTROY,
      cloudwatchLogsExports: ['postgresql'],
      cloudwatchLogsRetention: cfg.services.logRetentionDays as logs.RetentionDays,
      copyTagsToSnapshot: true,
      monitoringInterval: prod ? Duration.seconds(60) : undefined,
    });

    // ------------------------------------------------------------------ DB role secrets
    const dbRoleSecret = (cid: string, username: string) =>
      new secretsmanager.Secret(this, cid, {
        secretName: n.secret(`db/${username}`),
        description: `Aurora role ${username} (host/port/dbname included for convenience)`,
        encryptionKey: this.dataKey,
        generateSecretString: {
          secretStringTemplate: JSON.stringify({
            username,
            engine: 'postgres',
            host: this.cluster.clusterEndpoint.hostname,
            port: this.cluster.clusterEndpoint.port,
            dbname: n.dbName,
          }),
          generateStringKey: 'password',
          // URL-safe: the container entrypoint assembles DATABASE_URL without encoding surprises.
          excludePunctuation: true,
          passwordLength: 40,
        },
        removalPolicy: retain,
      });
    this.ownerSecret = dbRoleSecret('OwnerSecret', 'procure_owner');
    this.appSecret = dbRoleSecret('AppSecret', 'procure_app');

    // Bootstrap: create roles + database (tools/db-create.mjs equivalent). Idempotent; re-runs when
    // `BootstrapVersion` changes.
    const bootstrapFn = procureLambda(this, 'DbBootstrapFn', 'db-bootstrap', {
      description: 'Creates procure_owner / procure_app roles and the procure database',
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [this.dbClientSecurityGroup],
      timeout: Duration.minutes(2),
      logGroup: new logs.LogGroup(this, 'DbBootstrapLogs', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });
    this.cluster.secret!.grantRead(bootstrapFn);
    this.ownerSecret.grantRead(bootstrapFn);
    this.appSecret.grantRead(bootstrapFn);
    const bootstrapProvider = new cr.Provider(this, 'DbBootstrapProvider', {
      onEventHandler: bootstrapFn,
      logGroup: new logs.LogGroup(this, 'DbBootstrapProviderLogs', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });
    const bootstrap = new CustomResource(this, 'DbBootstrap', {
      serviceToken: bootstrapProvider.serviceToken,
      resourceType: 'Custom::ProCureDbBootstrap',
      properties: {
        Host: this.cluster.clusterEndpoint.hostname,
        Port: String(this.cluster.clusterEndpoint.port),
        DatabaseName: n.dbName,
        MasterSecretArn: this.cluster.secret!.secretArn,
        OwnerSecretArn: this.ownerSecret.secretArn,
        AppSecretArn: this.appSecret.secretArn,
        BootstrapVersion: '1',
      },
    });
    bootstrap.node.addDependency(this.cluster);

    // ------------------------------------------------------------------ application secrets
    // Generated key material: a custom resource fills each secret on first deploy (never overwrites).
    const keyFn = procureLambda(this, 'SecretsBootstrapFn', 'secrets-bootstrap', {
      description: 'Fills generated key-material secrets (identity signing key, finance token key) if empty',
      logGroup: new logs.LogGroup(this, 'SecretsBootstrapLogs', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });
    const keyProvider = new cr.Provider(this, 'SecretsBootstrapProvider', { onEventHandler: keyFn });
    const generated = (
      cid: string,
      part: string,
      description: string,
      kind: 'rsa-pkcs8-pem' | 'random-base64-32',
    ) => {
      const secret = new secretsmanager.Secret(this, cid, {
        secretName: n.secret(part),
        description,
        encryptionKey: this.dataKey,
        // Placeholder value; replaced by the custom resource below before any task starts.
        generateSecretString: { passwordLength: 16, excludePunctuation: true },
        removalPolicy: retain,
      });
      secret.grantRead(keyFn);
      secret.grantWrite(keyFn);
      new CustomResource(this, `${cid}Material`, {
        serviceToken: keyProvider.serviceToken,
        resourceType: 'Custom::ProCureGeneratedSecret',
        properties: { SecretArn: secret.secretArn, Kind: kind, Version: '1' },
      });
      return secret;
    };
    this.signingKeySecret = generated(
      'SigningKeySecret',
      'auth-private-key-pem',
      'identity: AUTH_PRIVATE_KEY_PEM (RS256 private key, PKCS#8 PEM)',
      'rsa-pkcs8-pem',
    );
    this.financeTokenKeySecret = generated(
      'FinanceTokenKey',
      'finance-token-key',
      'finance: FINANCE_TOKEN_KEY (32 bytes, base64) — encrypts QBO tokens at rest, signs OAuth state',
      'random-base64-32',
    );

    this.internalSecret = new secretsmanager.Secret(this, 'InternalSecret', {
      secretName: n.secret('internal-shared-secret'),
      description: 'INTERNAL_SHARED_SECRET: x-procure-internal header for service-to-service calls',
      encryptionKey: this.dataKey,
      generateSecretString: { passwordLength: 48, excludePunctuation: true },
      removalPolicy: retain,
    });

    // ------------------------------------------------------------------ S3
    this.accessLogsBucket = new s3.Bucket(this, 'AccessLogs', {
      encryption: s3.BucketEncryption.S3_MANAGED, // S3 server access logging cannot target SSE-KMS buckets
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED,
      lifecycleRules: [{ expiration: Duration.days(prod ? 365 : 30) }],
      removalPolicy: retain,
      autoDeleteObjects: !prod,
    });

    const webOrigins = [
      `https://${cfg.domains.web}`,
      ...(cfg.stage === 'dev' ? ['http://localhost:5173'] : []),
    ];
    this.documentsBucket = new s3.Bucket(this, 'Documents', {
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.documentsKey,
      bucketKeyEnabled: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      serverAccessLogsBucket: this.accessLogsBucket,
      serverAccessLogsPrefix: 'documents/',
      cors: [
        {
          allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT, s3.HttpMethods.HEAD],
          allowedOrigins: webOrigins,
          allowedHeaders: ['*'],
          exposedHeaders: ['ETag', 'Content-Disposition'],
          maxAge: 3000,
        },
      ],
      lifecycleRules: [
        {
          transitions: [
            { storageClass: s3.StorageClass.INFREQUENT_ACCESS, transitionAfter: Duration.days(90) },
          ],
        },
        {
          noncurrentVersionExpiration: Duration.days(prod ? 365 : 30),
          abortIncompleteMultipartUploadAfter: Duration.days(7),
        },
      ],
      removalPolicy: retain,
      autoDeleteObjects: !prod,
    });

    this.inboundBucket = new s3.Bucket(this, 'InboundEmail', {
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.documentsKey,
      bucketKeyEnabled: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      serverAccessLogsBucket: this.accessLogsBucket,
      serverAccessLogsPrefix: 'inbound-email/',
      // Raw landing copy only; the Lambda copies each message into the documents bucket.
      lifecycleRules: [{ expiration: Duration.days(prod ? 90 : 14) }],
      removalPolicy: retain,
      autoDeleteObjects: !prod,
    });
    this.inboundBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowSESPuts',
        principals: [new iam.ServicePrincipal('ses.amazonaws.com')],
        actions: ['s3:PutObject'],
        resources: [this.inboundBucket.arnForObjects('raw/*')],
        conditions: { StringEquals: { 'aws:SourceAccount': this.account } },
      }),
    );
  }
}
