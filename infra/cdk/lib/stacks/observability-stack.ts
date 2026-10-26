import { Duration, Stack, type StackProps } from 'aws-cdk-lib';
import type * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import type * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import type * as rds from 'aws-cdk-lib/aws-rds';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import type { Construct } from 'constructs';
import type { StageConfig } from '../../config/index.js';
import { SERVICE_NAMES, type ServiceName } from '../services.js';
import type { ServiceQueues } from './events-stack.js';
import type { DeployedService } from './services-stack.js';

export interface ObservabilityStackProps extends StackProps {
  cfg: StageConfig;
  alb: elbv2.ApplicationLoadBalancer;
  services: Record<ServiceName, DeployedService>;
  queues: Record<ServiceName, ServiceQueues>;
  cluster: rds.IDatabaseCluster;
  api: apigw.IHttpApi;
}

/** CloudWatch dashboard + alarms → SNS (email). */
export class ObservabilityStack extends Stack {
  readonly topic: sns.Topic;

  constructor(scope: Construct, id: string, props: ObservabilityStackProps) {
    super(scope, id, props);
    const { cfg } = props;
    const p = `pro-cure-${cfg.stage}`;
    const m1 = Duration.minutes(1);
    const m5 = Duration.minutes(5);

    this.topic = new sns.Topic(this, 'Alarms', {
      topicName: `${p}-alarms`,
      displayName: `Pro-Cure ${cfg.stage} alarms`,
    });
    this.topic.addSubscription(new subs.EmailSubscription(cfg.alarms.email));
    const action = new cwActions.SnsAction(this.topic);
    const alarm = (aid: string, a: cloudwatch.AlarmProps) => {
      const al = new cloudwatch.Alarm(this, aid, {
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        ...a,
      });
      al.addAlarmAction(action);
      al.addOkAction(action);
      return al;
    };

    const albMetric = (metricName: string, tg: elbv2.ApplicationTargetGroup, statistic = 'Sum') =>
      new cloudwatch.Metric({
        namespace: 'AWS/ApplicationELB',
        metricName,
        statistic,
        period: m5,
        dimensionsMap: {
          LoadBalancer: props.alb.loadBalancerFullName,
          TargetGroup: tg.targetGroupFullName,
        },
      });
    const apiMetric = (metricName: string, statistic = 'Sum') =>
      new cloudwatch.Metric({
        namespace: 'AWS/ApiGateway',
        metricName,
        statistic,
        period: m5,
        dimensionsMap: { ApiId: props.api.apiId, Stage: '$default' },
      });

    // ---- alarms
    for (const svc of SERVICE_NAMES) {
      const { service, targetGroup } = props.services[svc];
      const { queue, dlq } = props.queues[svc];
      alarm(`${svc}Dlq`, {
        alarmName: `${p}-${svc}-dlq-not-empty`,
        alarmDescription: `${svc}: events failed 5 deliveries and are parked in the DLQ. Fix, then redrive.`,
        metric: dlq.metricApproximateNumberOfMessagesVisible({ period: m1, statistic: 'Maximum' }),
        threshold: 0,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 1,
      });
      alarm(`${svc}QueueAge`, {
        alarmName: `${p}-${svc}-queue-age`,
        alarmDescription: `${svc}: oldest event waiting > 10 minutes (consumer down or stuck).`,
        metric: queue.metricApproximateAgeOfOldestMessage({ period: m5, statistic: 'Maximum' }),
        threshold: 600,
        evaluationPeriods: 2,
      });
      alarm(`${svc}5xx`, {
        alarmName: `${p}-${svc}-5xx`,
        alarmDescription: `${svc}: > 10 target 5xx responses in 5 minutes.`,
        metric: albMetric('HTTPCode_Target_5XX_Count', targetGroup),
        threshold: 10,
        evaluationPeriods: 1,
      });
      alarm(`${svc}Unhealthy`, {
        alarmName: `${p}-${svc}-unhealthy-hosts`,
        metric: albMetric('UnHealthyHostCount', targetGroup, 'Maximum'),
        threshold: 0,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 3,
      });
      alarm(`${svc}Cpu`, {
        alarmName: `${p}-${svc}-cpu-high`,
        metric: service.metricCpuUtilization({ period: m5 }),
        threshold: 85,
        evaluationPeriods: 3,
      });
      alarm(`${svc}Mem`, {
        alarmName: `${p}-${svc}-memory-high`,
        metric: service.metricMemoryUtilization({ period: m5 }),
        threshold: 85,
        evaluationPeriods: 3,
      });
    }
    alarm('DbCpu', {
      alarmName: `${p}-aurora-cpu`,
      metric: props.cluster.metricCPUUtilization({ period: m5 }),
      threshold: 80,
      evaluationPeriods: 3,
    });
    const acu = props.cluster.metric('ServerlessDatabaseCapacity', { period: m5, statistic: 'Maximum' });
    alarm('DbAcu', {
      alarmName: `${p}-aurora-acu-near-max`,
      alarmDescription: `Aurora is at >= 90% of max ACU (${cfg.database.maxAcu}); raise maxAcu.`,
      metric: acu,
      threshold: cfg.database.maxAcu * 0.9,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 3,
    });
    alarm('Api5xx', {
      alarmName: `${p}-api-5xx`,
      metric: apiMetric('5xx'),
      threshold: 25,
      evaluationPeriods: 1,
    });

    // ---- dashboard
    const dash = new cloudwatch.Dashboard(this, 'Dashboard', { dashboardName: p });
    const per = <T>(f: (s: ServiceName) => T) => SERVICE_NAMES.map(f);
    dash.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'API Gateway requests / 4xx / 5xx',
        left: [apiMetric('Count'), apiMetric('4xx'), apiMetric('5xx')],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'API Gateway latency p50/p99 (ms)',
        left: [
          apiMetric('Latency', 'p50'),
          apiMetric('Latency', 'p99'),
          apiMetric('IntegrationLatency', 'p99'),
        ],
        width: 12,
      }),
    );
    dash.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'ALB target 5xx by service',
        left: per((s) =>
          albMetric('HTTPCode_Target_5XX_Count', props.services[s].targetGroup).with({ label: s }),
        ),
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'ALB target response time p95 (s) by service',
        left: per((s) =>
          albMetric('TargetResponseTime', props.services[s].targetGroup, 'p95').with({ label: s }),
        ),
        width: 12,
      }),
    );
    dash.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'ECS CPU % by service',
        left: per((s) => props.services[s].service.metricCpuUtilization({ period: m5, label: s })),
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'ECS memory % by service',
        left: per((s) => props.services[s].service.metricMemoryUtilization({ period: m5, label: s })),
        width: 12,
      }),
    );
    dash.addWidgets(
      new cloudwatch.GraphWidget({ title: 'Aurora ACU', left: [acu], width: 8 }),
      new cloudwatch.GraphWidget({
        title: 'Aurora connections',
        left: [props.cluster.metricDatabaseConnections({ period: m5 })],
        width: 8,
      }),
      new cloudwatch.GraphWidget({
        title: 'Aurora CPU %',
        left: [props.cluster.metricCPUUtilization({ period: m5 })],
        width: 8,
      }),
    );
    dash.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'SQS age of oldest message (s)',
        left: per((s) =>
          props.queues[s].queue.metricApproximateAgeOfOldestMessage({
            period: m5,
            statistic: 'Maximum',
            label: s,
          }),
        ),
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'DLQ depth',
        left: per((s) =>
          props.queues[s].dlq.metricApproximateNumberOfMessagesVisible({
            period: m5,
            statistic: 'Maximum',
            label: s,
          }),
        ),
        width: 12,
      }),
    );
  }
}
