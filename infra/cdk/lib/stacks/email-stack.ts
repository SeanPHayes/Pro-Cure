import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import type * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ses from 'aws-cdk-lib/aws-ses';
import * as actions from 'aws-cdk-lib/aws-ses-actions';
import * as cr from 'aws-cdk-lib/custom-resources';
import type { Construct } from 'constructs';
import type { StageConfig } from '../../config/index.js';
import { procureLambda } from '../lambda.js';
import { internalUrl } from '../naming.js';
import { SERVICES } from '../services.js';

export const sesConfigurationSetName = (stage: string) => `pro-cure-${stage}`;

export interface EmailStackProps extends StackProps {
  cfg: StageConfig;
  vpc: ec2.IVpc;
  internalClientSg: ec2.ISecurityGroup;
  inboundBucket: s3.IBucket;
  documentsBucket: s3.IBucket;
  documentsKey: kms.IKey;
  internalSecret: secretsmanager.ISecret;
}

/**
 * Outbound: SES domain identity (Easy DKIM) + configuration set with CloudWatch event destination.
 * Inbound: receipt rule for <inboundDomain> → S3 (raw/) → Lambda → comms /inbound/ses (internal network).
 * DNS (DKIM CNAMEs, MX for the inbound domain) is published manually — see docs/deployment.md.
 */
export class EmailStack extends Stack {
  readonly configurationSet: ses.ConfigurationSet;
  readonly inboundFn: ReturnType<typeof procureLambda>;

  constructor(scope: Construct, id: string, props: EmailStackProps) {
    super(scope, id, props);
    const { cfg } = props;

    this.configurationSet = new ses.ConfigurationSet(this, 'ConfigSet', {
      configurationSetName: sesConfigurationSetName(cfg.stage),
      reputationMetrics: true,
      sendingEnabled: true,
      suppressionReasons: ses.SuppressionReasons.BOUNCES_AND_COMPLAINTS,
    });
    this.configurationSet.addEventDestination('CloudWatch', {
      destination: ses.EventDestination.cloudWatchDimensions([
        {
          name: 'ses:configuration-set',
          source: ses.CloudWatchDimensionSource.MESSAGE_TAG,
          defaultValue: sesConfigurationSetName(cfg.stage),
        },
      ]),
      events: [
        ses.EmailSendingEvent.SEND,
        ses.EmailSendingEvent.DELIVERY,
        ses.EmailSendingEvent.BOUNCE,
        ses.EmailSendingEvent.COMPLAINT,
        ses.EmailSendingEvent.REJECT,
        ses.EmailSendingEvent.RENDERING_FAILURE,
        ses.EmailSendingEvent.DELIVERY_DELAY,
      ],
    });

    const identity = new ses.EmailIdentity(this, 'DomainIdentity', {
      identity: ses.Identity.domain(cfg.email.domain),
      configurationSet: this.configurationSet,
      mailFromDomain: `mail.${cfg.email.domain}`,
    });

    // ---- inbound
    this.inboundFn = procureLambda(this, 'InboundEmailFn', 'inbound-email', {
      description: 'SES inbound: copy raw MIME to documents bucket, POST comms /inbound/ses',
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [props.internalClientSg],
      timeout: Duration.seconds(60),
      retryAttempts: 2,
      deadLetterQueueEnabled: true,
      environment: {
        INBOUND_BUCKET: props.inboundBucket.bucketName,
        INBOUND_PREFIX: 'raw/',
        DOCUMENTS_BUCKET: props.documentsBucket.bucketName,
        DOCUMENTS_KMS_KEY_ARN: props.documentsKey.keyArn,
        COMMS_URL: internalUrl('comms', SERVICES.comms.port),
        INTERNAL_SECRET_ARN: props.internalSecret.secretArn,
      },
      logGroup: new logs.LogGroup(this, 'InboundEmailLogs', {
        retention: cfg.services.logRetentionDays as logs.RetentionDays,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });
    props.inboundBucket.grantRead(this.inboundFn, 'raw/*');
    props.documentsBucket.grantPut(this.inboundFn, 'inbound-email/*');
    props.documentsKey.grantEncryptDecrypt(this.inboundFn);
    props.internalSecret.grantRead(this.inboundFn);

    const ruleSet = new ses.ReceiptRuleSet(this, 'RuleSet', {
      receiptRuleSetName: `pro-cure-${cfg.stage}-inbound`,
    });
    ruleSet.addRule('Inbound', {
      receiptRuleName: 'to-inbound-domain',
      recipients: [cfg.email.inboundDomain],
      scanEnabled: true,
      tlsPolicy: ses.TlsPolicy.REQUIRE,
      actions: [
        // No `kmsKey` here: that would make SES use client-side encryption. The bucket's default
        // SSE-KMS encryption applies instead.
        new actions.S3({ bucket: props.inboundBucket, objectKeyPrefix: 'raw/' }),
        new actions.Lambda({ function: this.inboundFn, invocationType: actions.LambdaInvocationType.EVENT }),
      ],
    });

    if (cfg.email.activateReceiptRuleSet) {
      // CloudFormation cannot activate a rule set; only one can be active per account/region.
      new cr.AwsCustomResource(this, 'ActivateRuleSet', {
        onUpdate: {
          service: 'SES',
          action: 'setActiveReceiptRuleSet',
          parameters: { RuleSetName: ruleSet.receiptRuleSetName },
          physicalResourceId: cr.PhysicalResourceId.of(`active-${ruleSet.receiptRuleSetName}`),
        },
        onDelete: { service: 'SES', action: 'setActiveReceiptRuleSet', parameters: {} },
        policy: cr.AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({ actions: ['ses:SetActiveReceiptRuleSet'], resources: ['*'] }),
        ]),
        installLatestAwsSdk: false,
      });
    }

    for (let i = 0; i < 3; i++) {
      new CfnOutput(this, `DkimRecord${i + 1}`, {
        value: `${identity.dkimRecords[i]!.name} CNAME ${identity.dkimRecords[i]!.value}`,
      });
    }
    new CfnOutput(this, 'InboundMxRecord', {
      value: `${cfg.email.inboundDomain} MX 10 inbound-smtp.${this.region}.amazonaws.com`,
    });
    new CfnOutput(this, 'ConfigurationSetName', { value: this.configurationSet.configurationSetName });
  }
}
