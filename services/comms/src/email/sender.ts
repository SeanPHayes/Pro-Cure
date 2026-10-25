import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { config } from '@procure/platform';
import { buildMime, encodeAddress, type OutgoingEmail } from './mime.js';

export interface SendResult {
  status: 'sent' | 'delivered-local';
  providerMessageId: string | null;
}

/** Delivers one rendered email. The comms.emails row is the log; senders only transmit. */
export interface EmailSender {
  readonly name: string;
  send(email: OutgoingEmail): Promise<SendResult>;
}

/** Local/test driver: nothing leaves the machine; the stored row is viewable at GET /emails/:id. */
export class OutboxSender implements EmailSender {
  readonly name = 'outbox';
  async send(): Promise<SendResult> {
    return { status: 'delivered-local', providerMessageId: null };
  }
}

/**
 * Amazon SES v2. Raw MIME when there are attachments (or threading headers to preserve); otherwise
 * the Simple content type with custom headers.
 */
export class SesSender implements EmailSender {
  readonly name = 'ses';
  private client = new SESv2Client({ region: config().AWS_REGION });
  constructor(private configurationSet = process.env.SES_CONFIGURATION_SET) {}

  async send(e: OutgoingEmail): Promise<SendResult> {
    const common = {
      FromEmailAddress: encodeAddress(e.from),
      Destination: { ToAddresses: e.to, CcAddresses: e.cc.length ? e.cc : undefined },
      ReplyToAddresses: e.replyTo ? [e.replyTo] : undefined,
      ConfigurationSetName: this.configurationSet || undefined,
    };
    const cmd = e.attachments.length
      ? new SendEmailCommand({ ...common, Content: { Raw: { Data: new Uint8Array(buildMime(e)) } } })
      : new SendEmailCommand({
          ...common,
          Content: {
            Simple: {
              Subject: { Data: e.subject, Charset: 'UTF-8' },
              Body: {
                Text: { Data: e.text, Charset: 'UTF-8' },
                ...(e.html ? { Html: { Data: e.html, Charset: 'UTF-8' } } : {}),
              },
              Headers: [
                ...(e.inReplyTo ? [{ Name: 'In-Reply-To', Value: e.inReplyTo }] : []),
                ...(e.references?.length ? [{ Name: 'References', Value: e.references.join(' ') }] : []),
                { Name: 'X-Pro-Cure-Message-Id', Value: e.messageId },
              ],
            },
          },
        });
    const res = await this.client.send(cmd);
    return { status: 'sent', providerMessageId: res.MessageId ?? null };
  }
}

let override: EmailSender | undefined;
let cached: EmailSender | undefined;

export const emailSender = (): EmailSender => {
  if (override) return override;
  cached ??= config().EMAIL_DRIVER === 'ses' ? new SesSender() : new OutboxSender();
  return cached;
};

/** Tests: inject a sender (e.g. one that fails). Pass undefined to restore. */
export const setEmailSender = (s: EmailSender | undefined) => {
  override = s;
};
