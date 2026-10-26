import { RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';
import type { StageConfig } from '../../config/index.js';
import { SERVICES } from '../services.js';

const PORTS = Object.values(SERVICES).map((s) => s.port);
const SERVICE_PORT_MIN = Math.min(...PORTS);
const SERVICE_PORT_MAX = Math.max(...PORTS);

export interface NetworkStackProps extends StackProps {
  cfg: StageConfig;
}

/**
 * VPC across 3 AZs: public (NAT, nothing else), private-with-egress (ECS tasks, Lambdas, internal ALB,
 * VPC link, interface endpoints) and isolated (Aurora). AWS API traffic stays on VPC endpoints.
 */
export class NetworkStack extends Stack {
  readonly vpc: ec2.Vpc;
  /** API Gateway VPC link ENIs. */
  readonly vpcLinkSg: ec2.SecurityGroup;
  /** Internal ALB: HTTP from the VPC link only. */
  readonly albSg: ec2.SecurityGroup;
  /** ECS service tasks: service ports from the ALB, from each other, and from internal clients. */
  readonly appSg: ec2.SecurityGroup;
  /** Attach to anything that must call services directly over Cloud Map (inbound-email Lambda). */
  readonly internalClientSg: ec2.SecurityGroup;

  private readonly azs: string[];

  /** Fixed AZ list instead of a context lookup (synth must work without AWS credentials). */
  override get availabilityZones(): string[] {
    return this.azs;
  }

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);
    const { cfg } = props;
    this.azs = cfg.network.availabilityZones ?? ['a', 'b', 'c'].map((z) => `${cfg.region}${z}`);

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr(cfg.network.cidr),
      // Explicit AZs: no context lookup, so synth works without credentials.
      availabilityZones: this.azs,
      natGateways: cfg.network.natGateways,
      restrictDefaultSecurityGroup: true,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'app', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 20 },
        { name: 'db', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    const flowLogs = new logs.LogGroup(this, 'FlowLogs', {
      retention: cfg.network.flowLogRetentionDays as logs.RetentionDays,
      removalPolicy: cfg.stage === 'prod' ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });
    this.vpc.addFlowLog('FlowLog', {
      destination: ec2.FlowLogDestination.toCloudWatchLogs(flowLogs),
      trafficType: ec2.FlowLogTrafficType.REJECT,
    });

    // ---- shared security groups (defined here so App/Email/Api stacks never reference each other)
    const servicePorts = ec2.Port.tcpRange(SERVICE_PORT_MIN, SERVICE_PORT_MAX);
    this.vpcLinkSg = new ec2.SecurityGroup(this, 'VpcLinkSg', {
      vpc: this.vpc,
      description: 'API Gateway VPC link',
    });
    this.albSg = new ec2.SecurityGroup(this, 'AlbSg', {
      vpc: this.vpc,
      description: 'Internal ALB (API Gateway VPC link to services)',
    });
    this.albSg.addIngressRule(this.vpcLinkSg, ec2.Port.tcp(80), 'HTTP from API Gateway VPC link');
    this.appSg = new ec2.SecurityGroup(this, 'AppSg', {
      vpc: this.vpc,
      description: 'Pro-Cure ECS services',
    });
    this.internalClientSg = new ec2.SecurityGroup(this, 'InternalClientSg', {
      vpc: this.vpc,
      description: 'Internal callers of service ports (Lambdas)',
    });
    this.appSg.addIngressRule(this.albSg, servicePorts, 'Service ports from internal ALB');
    this.appSg.addIngressRule(this.appSg, servicePorts, 'Service-to-service (Cloud Map)');
    this.appSg.addIngressRule(this.internalClientSg, servicePorts, 'Internal clients (inbound-email Lambda)');

    // Gateway endpoint (free): S3 for documents, ECR layers, inbound email.
    this.vpc.addGatewayEndpoint('S3', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
      subnets: [
        { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      ],
    });

    // Interface endpoints. Dev puts them in a single AZ to save cost (cross-AZ traffic still works).
    const endpointSubnets: ec2.SubnetSelection = {
      subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      availabilityZones: this.vpc.availabilityZones.slice(0, Math.max(1, cfg.network.endpointAzCount)),
    };
    const endpointSg = new ec2.SecurityGroup(this, 'EndpointSg', {
      vpc: this.vpc,
      description: 'Interface VPC endpoints: HTTPS from inside the VPC',
      allowAllOutbound: false,
    });
    endpointSg.addIngressRule(ec2.Peer.ipv4(this.vpc.vpcCidrBlock), ec2.Port.tcp(443), 'HTTPS from VPC');

    const interfaceEndpoints: Record<string, ec2.InterfaceVpcEndpointAwsService> = {
      EcrApi: ec2.InterfaceVpcEndpointAwsService.ECR,
      EcrDkr: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
      SecretsManager: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
      Sqs: ec2.InterfaceVpcEndpointAwsService.SQS,
      EventBridge: ec2.InterfaceVpcEndpointAwsService.EVENTBRIDGE,
      Logs: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
      BedrockRuntime: ec2.InterfaceVpcEndpointAwsService.BEDROCK_RUNTIME,
      Textract: ec2.InterfaceVpcEndpointAwsService.TEXTRACT,
      Kms: ec2.InterfaceVpcEndpointAwsService.KMS,
      // SES v2 API (email.<region>.amazonaws.com) used by comms' SESv2Client.
      SesApi: ec2.InterfaceVpcEndpointAwsService.EMAIL,
      Sts: ec2.InterfaceVpcEndpointAwsService.STS,
    };
    for (const [name, service] of Object.entries(interfaceEndpoints)) {
      this.vpc.addInterfaceEndpoint(name, {
        service,
        subnets: endpointSubnets,
        securityGroups: [endpointSg],
        privateDnsEnabled: true,
      });
    }
  }
}
