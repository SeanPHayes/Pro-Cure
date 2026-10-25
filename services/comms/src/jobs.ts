import { type Job, minutes, type Tx } from '@procure/platform';
import { clients } from './clients.js';
import { deliver, type EmailRow, MAX_EMAIL_ATTEMPTS, queueEmail } from './email/outbound.js';
import { absoluteUrl } from './links.js';
import type { Logger } from './log.js';
import { serviceEmitter } from './threads.js';

/** Digest timezone. Per-tenant time zones are a follow-up (tenant settings live in identity). */
export const DIGEST_TZ = 'America/New_York';
export const DIGEST_HOUR = 7;

/** Retry failed emails whose backoff has elapsed (5, 10, 20, 40 min; gives up after 5 attempts). */
export async function retryFailedEmails(tx: Tx, log: Logger, limit = 50) {
  const due = await tx<EmailRow[]>`
    select * from comms.emails
    where status = 'failed' and attempts < ${MAX_EMAIL_ATTEMPTS}
      and next_attempt_at is not null and next_attempt_at <= now()
    order by next_attempt_at limit ${limit}
    for update skip locked`;
  let sent = 0;
  for (const row of due) {
    const r = await deliver(tx, row, log);
    if (r.status !== 'failed') sent++;
  }
  return { attempted: due.length, sent };
}

/** Local date/hour in the digest timezone. */
export const localParts = (now: Date, tz = DIGEST_TZ) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) };
};

/**
 * Daily digest: at/after 07:00 local, once per local day per user (last_digest_on), email users with
 * email_digest = 'daily' their unread notifications from the last 24 h. Runs every 15 minutes so
 * missed ticks (deploys) catch up the same morning.
 */
export async function sendDailyDigests(tx: Tx, log: Logger, now: Date, force = false) {
  const { date, hour } = localParts(now);
  if (!force && hour < DIGEST_HOUR) return { skipped: 'before digest hour', sent: 0 };
  const prefs = await tx<{ tenantId: string; userId: string }[]>`
    select tenant_id, user_id from comms.notification_preferences
    where email_digest = 'daily' and (last_digest_on is null or last_digest_on < ${date}::date)
    for update skip locked`;
  let sent = 0;
  const byTenant = new Map<string, string[]>();
  for (const p of prefs) byTenant.set(p.tenantId, [...(byTenant.get(p.tenantId) ?? []), p.userId]);

  for (const [tenantId, userIds] of byTenant) {
    let users: Awaited<ReturnType<typeof clients.listUsers>> = [];
    try {
      users = await clients.listUsers(tenantId, { ids: userIds });
    } catch (err) {
      log.warn({ tenantId, err: (err as Error).message }, 'digest: user lookup failed; will retry next tick');
      continue;
    }
    const emailOf = new Map(users.map((u) => [u.id, u]));
    for (const userId of userIds) {
      const items = await tx<
        { title: string; body: string; link: string | null; severity: string; createdAt: string }[]
      >`
        select title, body, link, severity, created_at from comms.notifications
        where tenant_id = ${tenantId} and user_id = ${userId} and read_at is null
          and created_at > ${now.toISOString()}::timestamptz - interval '24 hours'
        order by (severity = 'critical') desc, (severity = 'warning') desc, created_at desc
        limit 50`;
      const user = emailOf.get(userId);
      if (items.length && user) {
        const lines = items.map(
          (n) =>
            `${n.severity === 'critical' ? '[Critical] ' : n.severity === 'warning' ? '[Attention] ' : ''}${n.title}` +
            `${n.link ? `\n${absoluteUrl(n.link)}` : ''}`,
        );
        await queueEmail(
          tx,
          serviceEmitter(tenantId),
          {
            tenantId,
            to: [user.email],
            subject: `Your Pro-Cure digest: ${items.length} unread update${items.length === 1 ? '' : 's'}`,
            heading: `Good morning, ${user.name.split(' ')[0]}`,
            text: `Here is what happened in the last 24 hours.\n\n${lines.join('\n\n')}`,
            cta: { label: 'Open Pro-Cure', url: absoluteUrl('/app') },
          },
          log,
        );
        sent++;
      }
      await tx`update comms.notification_preferences set last_digest_on = ${date}::date
               where tenant_id = ${tenantId} and user_id = ${userId}`;
    }
  }
  return { sent, users: prefs.length };
}

export const jobs: Job[] = [
  { name: 'email-retry', everyMs: minutes(5), run: ({ tx, log }) => retryFailedEmails(tx, log) },
  { name: 'daily-digest', everyMs: minutes(15), run: ({ tx, log, now }) => sendDailyDigests(tx, log, now) },
];
