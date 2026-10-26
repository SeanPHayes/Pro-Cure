import { CfnOutput, Fn, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { AccessLogFormat } from 'aws-cdk-lib/aws-apigateway';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import type * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';
import type { StageConfig } from '../../config/index.js';
import { names } from '../naming.js';
import { SERVICE_NAMES, SERVICES } from '../services.js';

/** Header API Gateway sets on every forwarded request; the internal ALB routes on it. */
export const SERVICE_ROUTING_HEADER = 'x-procure-service';

export interface ApiStackProps extends StackProps {
  cfg: StageConfig;
  vpc: ec2.IVpc;
  vpcLinkSg: ec2.ISecurityGroup;
  listener: elbv2.IApplicationListener;
}

/**
 * Public API: HTTP API → VPC link → internal ALB.
 *
 * Route per service: `ANY /api/<prefix>/{proxy+}`. The integration
 *   - overwrites the path with `/$request.path.proxy` (services mount routes at root), and
 *   - overwrites header `x-procure-service: <service>`, which the ALB listener rules match on
 *     (the prefix is gone by the time the request reaches the ALB, so path rules can't be used).
 * A client-supplied x-procure-service header is always replaced.
 *
 * WAF cannot attach to HTTP APIs; the web ACL is on CloudFront, which fronts /api/* (WebStack).
 */
export class ApiStack extends Stack {
  readonly api: apigw.HttpApi;
  readonly stage: apigw.HttpStage;
  /** `<id>.execute-api.<region>.amazonaws.com` for the CloudFront origin. */
  readonly apiDomain: string;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);
    const { cfg } = props;
    const n = names(cfg);

    this.api = new apigw.HttpApi(this, 'HttpApi', {
      apiName: `pro-cure-${cfg.stage}`,
      description: 'Pro-Cure public API (/api/<service>/*)',
      createDefaultStage: false,
    });

    const vpcLink = new apigw.VpcLink(this, 'VpcLink', {
      vpc: props.vpc,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [props.vpcLinkSg],
    });

    for (const svc of SERVICE_NAMES) {
      const { prefix } = SERVICES[svc];
      this.api.addRoutes({
        path: `/api/${prefix}/{proxy+}`,
        methods: [apigw.HttpMethod.ANY],
        integration: new integrations.HttpAlbIntegration(`${svc}Integration`, props.listener, {
          vpcLink,
          parameterMapping: new apigw.ParameterMapping()
            .overwritePath(apigw.MappingValue.custom('/$request.path.proxy'))
            .overwriteHeader(SERVICE_ROUTING_HEADER, apigw.MappingValue.custom(svc)),
        }),
      });
    }

    const accessLogs = new logs.LogGroup(this, 'AccessLogs', {
      logGroupName: n.logGroup('api-access'),
      retention: cfg.services.logRetentionDays as logs.RetentionDays,
      removalPolicy: cfg.stage === 'prod' ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });
    this.stage = new apigw.HttpStage(this, 'DefaultStage', {
      httpApi: this.api,
      stageName: '$default',
      autoDeploy: true,
      throttle: { rateLimit: cfg.api.throttleRateLimit, burstLimit: cfg.api.throttleBurstLimit },
      accessLogSettings: {
        destination: new apigw.LogGroupLogDestination(accessLogs),
        format: AccessLogFormat.custom(
          JSON.stringify({
            requestId: '$context.requestId',
            ip: '$context.identity.sourceIp',
            requestTime: '$context.requestTime',
            method: '$context.httpMethod',
            routeKey: '$context.routeKey',
            path: '$context.path',
            status: '$context.status',
            protocol: '$context.protocol',
            responseLength: '$context.responseLength',
            latency: '$context.responseLatency',
            integrationLatency: '$context.integrationLatency',
            integrationStatus: '$context.integrationStatus',
            integrationError: '$context.integrationErrorMessage',
            userAgent: '$context.identity.userAgent',
          }),
        ),
      },
    });

    this.apiDomain = Fn.select(2, Fn.split('/', this.api.apiEndpoint));

    // Optional direct custom domain (CloudFront already serves /api/* on the web domain).
    if (cfg.domains.apiCertificateArn) {
      const domainName = new apigw.DomainName(this, 'ApiDomain', {
        domainName: cfg.domains.api,
        certificate: acm.Certificate.fromCertificateArn(this, 'ApiCert', cfg.domains.apiCertificateArn),
      });
      new apigw.ApiMapping(this, 'ApiMapping', { api: this.api, domainName, stage: this.stage });
      new CfnOutput(this, 'ApiCustomDomainTarget', {
        value: domainName.regionalDomainName,
        description: `CNAME/ALIAS ${cfg.domains.api} -> this`,
      });
    }

    new CfnOutput(this, 'ApiEndpoint', { value: this.api.apiEndpoint });
    new CfnOutput(this, 'ApiId', { value: this.api.apiId });
  }
}
