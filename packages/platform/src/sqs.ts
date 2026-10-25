import { DeleteMessageCommand, ReceiveMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { EventEnvelope } from '@procure/domain';
import type { Logger } from 'pino';
import { config } from './config.js';
import { consume, type Subscription } from './events.js';

/**
 * AWS transport consumer: long-polls the service's SQS queue (fed by EventBridge rules generated from
 * each service's subscription list) and hands events to `consume`. Failed messages return to the
 * queue and land in the DLQ after maxReceiveCount.
 */
export function startSqsConsumer(consumer: string, subs: Subscription[], log: Logger) {
  const url = config().EVENT_QUEUE_URL;
  if (!url) {
    log.warn('EVENT_QUEUE_URL not set; SQS consumer disabled');
    return () => {};
  }
  const client = new SQSClient({ region: config().AWS_REGION });
  let stopped = false;
  (async () => {
    while (!stopped) {
      try {
        const res = await client.send(
          new ReceiveMessageCommand({ QueueUrl: url, MaxNumberOfMessages: 10, WaitTimeSeconds: 20 }),
        );
        for (const m of res.Messages ?? []) {
          try {
            const body = JSON.parse(m.Body ?? '{}');
            // EventBridge -> SQS wraps the envelope in `detail`.
            const event = (body.detail ?? body) as EventEnvelope;
            await consume(consumer, event, subs, log);
            await client.send(new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: m.ReceiptHandle! }));
          } catch (err) {
            log.error({ err, messageId: m.MessageId }, 'event handler failed; message will be retried');
          }
        }
      } catch (err) {
        log.error({ err }, 'SQS receive failed');
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  })();
  return () => {
    stopped = true;
  };
}
