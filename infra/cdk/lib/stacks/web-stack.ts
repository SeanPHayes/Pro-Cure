import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Annotations, CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import type { Construct } from 'constructs';
import type { StageConfig } from '../../config/index.js';
import { REPO_ROOT } from '../lambda.js';

export interface WebStackProps extends StackProps {
  cfg: StageConfig;
  /** `<id>.execute-api.<region>.amazonaws.com` */
  apiDomain: string;
  accessLogsBucket: s3.IBucket;
}

/**
 * SPA hosting + edge: private S3 bucket (OAC) behind CloudFront; `/api/*` → API Gateway (no cache, all
 * viewer headers except Host). WAFv2 web ACL (CLOUDFRONT scope) with AWS managed rules + rate limit.
 *
 * SPA fallback is a viewer-request CloudFront Function on the *default* behavior (extension-less paths
 * → /index.html) rather than distribution-wide 403/404 custom error responses, which would also rewrite
 * API 404s from /api/* into index.html.
 */
export class WebStack extends Stack {
  readonly bucket: s3.Bucket;
  readonly distribution: cloudfront.Distribution;
  readonly webOrigin: string;
  readonly webAcl?: wafv2.CfnWebACL;

  constructor(scope: Construct, id: string, props: WebStackProps) {
    super(scope, id, props);
    const { cfg } = props;
    const prod = cfg.stage === 'prod';

    this.bucket = new s3.Bucket(this, 'WebBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      lifecycleRules: [{ noncurrentVersionExpiration: Duration.days(30) }],
      removalPolicy: prod ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      autoDeleteObjects: !prod,
    });

    // ---- WAF (CLOUDFRONT-scoped ACLs must live in us-east-1)
    if (this.region === 'us-east-1' || cfg.region === 'us-east-1') {
      this.webAcl = new wafv2.CfnWebACL(this, 'WebAcl', {
        name: `pro-cure-${cfg.stage}-edge`,
        scope: 'CLOUDFRONT',
        defaultAction: { allow: {} },
        visibilityConfig: {
          cloudWatchMetricsEnabled: true,
          metricName: `pro-cure-${cfg.stage}-edge`,
          sampledRequestsEnabled: true,
        },
        rules: [
          managedRule('AWSManagedRulesAmazonIpReputationList', 10),
          // Uploads (multipart PDFs/drawings) exceed the 8 KB body inspection limit; count, don't block.
          managedRule('AWSManagedRulesCommonRuleSet', 20, [
            { name: 'SizeRestrictions_BODY', actionToUse: { count: {} } },
          ]),
          managedRule('AWSManagedRulesKnownBadInputsRuleSet', 30),
          {
            name: 'RateLimitPerIp',
            priority: 40,
            action: { block: {} },
            statement: {
              rateBasedStatement: { limit: 2000, aggregateKeyType: 'IP', evaluationWindowSec: 300 },
            },
            visibilityConfig: {
              cloudWatchMetricsEnabled: true,
              metricName: 'RateLimitPerIp',
              sampledRequestsEnabled: true,
            },
          },
        ],
      });
      const wafLogs = new logs.LogGroup(this, 'WafLogs', {
        logGroupName: `aws-waf-logs-pro-cure-${cfg.stage}`,
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      });
      new wafv2.CfnLoggingConfiguration(this, 'WafLogging', {
        resourceArn: this.webAcl.attrArn,
        logDestinationConfigs: [
          Stack.of(this).formatArn({
            service: 'logs',
            resource: 'log-group',
            resourceName: wafLogs.logGroupName,
            arnFormat: 2 as never, // ArnFormat.COLON_RESOURCE_NAME
          }),
        ],
        redactedFields: [{ singleHeader: { Name: 'authorization' } }, { singleHeader: { Name: 'cookie' } }],
      });
    } else {
      Annotations.of(this).addWarningV2(
        'procure:waf-region',
        'WAF for CloudFront must be created in us-east-1; this stage is not in us-east-1 so no web ACL is attached.',
      );
    }

    // ---- headers
    const csp = [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https://*.amazonaws.com",
      "font-src 'self' data:",
      `connect-src 'self' https://cognito-idp.${cfg.region}.amazonaws.com https://*.auth.${cfg.region}.amazoncognito.com https://*.amazonaws.com`,
      "frame-src 'self' blob: https://*.amazonaws.com",
      `form-action 'self' https://*.auth.${cfg.region}.amazoncognito.com`,
      "frame-ancestors 'none'",
      "object-src 'none'",
      "base-uri 'self'",
      'upgrade-insecure-requests',
    ].join('; ');
    const headers = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      responseHeadersPolicyName: `pro-cure-${cfg.stage}-security`,
      securityHeadersBehavior: {
        strictTransportSecurity: {
          accessControlMaxAge: Duration.days(730),
          includeSubdomains: true,
          preload: true,
          override: true,
        },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true,
        },
        contentSecurityPolicy: { contentSecurityPolicy: csp, override: true },
        xssProtection: { protection: true, modeBlock: true, override: true },
      },
      customHeadersBehavior: {
        customHeaders: [
          { header: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()', override: true },
        ],
      },
    });
    // API responses: HSTS/nosniff only (the API sets its own content types; CSP is for documents).
    const apiHeaders = new cloudfront.ResponseHeadersPolicy(this, 'ApiHeaders', {
      responseHeadersPolicyName: `pro-cure-${cfg.stage}-api`,
      securityHeadersBehavior: {
        strictTransportSecurity: {
          accessControlMaxAge: Duration.days(730),
          includeSubdomains: true,
          preload: true,
          override: true,
        },
        contentTypeOptions: { override: true },
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true,
        },
      },
    });

    const spaRewrite = new cloudfront.Function(this, 'SpaRewrite', {
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      comment: 'SPA fallback: extension-less paths → /index.html',
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var req = event.request;
  var last = req.uri.split('/').pop();
  if (last === '' || last.indexOf('.') === -1) req.uri = '/index.html';
  return req;
}`),
    });

    const useDomain = Boolean(cfg.domains.webCertificateArn);
    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `Pro-Cure ${cfg.stage}`,
      defaultRootObject: 'index.html',
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      priceClass: prod ? cloudfront.PriceClass.PRICE_CLASS_ALL : cloudfront.PriceClass.PRICE_CLASS_100,
      webAclId: this.webAcl?.attrArn,
      enableLogging: true,
      logBucket: props.accessLogsBucket,
      logFilePrefix: 'cloudfront/',
      ...(useDomain
        ? {
            domainNames: [cfg.domains.web],
            minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
            certificate: acm.Certificate.fromCertificateArn(this, 'WebCert', cfg.domains.webCertificateArn!),
          }
        : {}),
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: headers,
        compress: true,
        functionAssociations: [
          { function: spaRewrite, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
        ],
      },
      additionalBehaviors: {
        '/api/*': {
          origin: new origins.HttpOrigin(props.apiDomain, {
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
            originSslProtocols: [cloudfront.OriginSslPolicy.TLS_V1_2],
            readTimeout: Duration.seconds(60),
          }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          responseHeadersPolicy: apiHeaders,
          compress: true,
        },
      },
    });

    this.webOrigin = cfg.domains.useCustomDomains
      ? `https://${cfg.domains.web}`
      : `https://${this.distribution.distributionDomainName}`;

    // ---- optional: publish apps/web/dist if it was built before synth (CI publishes separately).
    const dist = join(REPO_ROOT, 'apps/web/dist');
    if (existsSync(join(dist, 'index.html'))) {
      new s3deploy.BucketDeployment(this, 'DeployWeb', {
        sources: [s3deploy.Source.asset(dist)],
        destinationBucket: this.bucket,
        distribution: this.distribution,
        distributionPaths: ['/index.html'],
        prune: false,
        memoryLimit: 512,
      });
    } else {
      Annotations.of(this).addWarningV2(
        'procure:web-dist-missing',
        'apps/web/dist not found at synth time — skipping BucketDeployment. The deploy workflow builds the SPA with stack outputs and syncs it to the bucket.',
      );
    }

    new CfnOutput(this, 'WebUrl', { value: this.webOrigin });
    new CfnOutput(this, 'CloudFrontDomain', { value: this.distribution.distributionDomainName });
    new CfnOutput(this, 'DistributionId', { value: this.distribution.distributionId });
    new CfnOutput(this, 'WebBucketName', { value: this.bucket.bucketName });
  }
}

function managedRule(
  name: string,
  priority: number,
  ruleActionOverrides?: wafv2.CfnWebACL.RuleActionOverrideProperty[],
): wafv2.CfnWebACL.RuleProperty {
  return {
    name,
    priority,
    overrideAction: { none: {} },
    statement: { managedRuleGroupStatement: { vendorName: 'AWS', name, ruleActionOverrides } },
    visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: name, sampledRequestsEnabled: true },
  };
}
