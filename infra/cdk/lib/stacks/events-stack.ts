import { Duration, Stack, type StackProps } from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import type * as kms from 'aws-cdk-lib/aws-kms';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';
import type { StageConfig } from '../../config/index.js';
import { names } from '../naming.js';
import { SERVICE_NAMES, type ServiceName } from '../services.js';
import { SUBSCRIPTIONS } from '../subscriptions.js';

export interface EventsStackProps extends StackProps {
  cfg: StageConfig;
  dataKey: kms.IKey;
}

export interface ServiceQueues {
  queue: sqs.Queue;
  dlq: sqs.Queue;
}

/**
 * EventBridge custom bus `pro-cure-<stage>` (+ 30-day archive for replay), one SQS queue + DLQ per
 * service, and one rule per subscribing service matching its detail-types (lib/subscriptions.ts).
 *
 * Producers: EventBridgeTransport (packages/platform/src/events.ts) PutEvents with
 *   Source = `pro-cure.<service>`, DetailType = event type, Detail = envelope.
 * Consumers: startSqsConsumer (packages/platform/src/sqs.ts) reads `body.detail`, so targets deliver
 * the full EventBridge event (no input transformer). DLQ alarms live in the observability stack.
 */
export class EventsStack extends Stack {
  readonly bus: events.EventBus;
  readonly queues: Record<ServiceName, ServiceQueues>;

  constructor(scope: Construct, id: string, props: EventsStackProps) {
    super(scope, id, props);
    const { cfg, dataKey } = props;
    const n = names(cfg);

    this.bus = new events.EventBus(this, 'Bus', { eventBusName: n.eventBus });
    this.bus.archive('Archive', {
      archiveName: `${n.eventBus}-archive`,
      description: 'All Pro-Cure integration events (replay for recovery / new consumers)',
      eventPattern: { source: events.Match.prefix('pro-cure.') },
      retention: Duration.days(30),
    });

    this.queues = {} as Record<ServiceName, ServiceQueues>;
    for (const svc of SERVICE_NAMES) {
      const dlq = new sqs.Queue(this, `${svc}Dlq`, {
        queueName: n.dlq(svc),
        encryption: sqs.QueueEncryption.KMS,
        encryptionMasterKey: dataKey,
        dataKeyReuse: Duration.hours(1),
        retentionPeriod: Duration.days(14),
        enforceSSL: true,
      });
      const queue = new sqs.Queue(this, `${svc}Queue`, {
        queueName: n.queue(svc),
        encryption: sqs.QueueEncryption.KMS,
        encryptionMasterKey: dataKey,
        dataKeyReuse: Duration.hours(1),
        // Handlers run DB transactions; keep well above worst-case handler time.
        visibilityTimeout: Duration.minutes(5),
        retentionPeriod: Duration.days(4),
        receiveMessageWaitTime: Duration.seconds(20),
        deadLetterQueue: { queue: dlq, maxReceiveCount: 5 },
        enforceSSL: true,
      });
      this.queues[svc] = { queue, dlq };

      const types = SUBSCRIPTIONS[svc];
      if (types.length) {
        new events.Rule(this, `${svc}Rule`, {
          ruleName: `${n.queue(svc)}-subscriptions`,
          description: `Route ${svc} subscriptions to its queue (generated from lib/subscriptions.ts)`,
          eventBus: this.bus,
          eventPattern: { source: events.Match.prefix('pro-cure.'), detailType: [...types] },
          targets: [
            new targets.SqsQueue(queue, {
              deadLetterQueue: dlq,
              retryAttempts: 185,
              maxEventAge: Duration.hours(24),
            }),
          ],
        });
      }
    }
  }
}
