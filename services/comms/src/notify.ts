import type { Tx } from '@procure/platform';
import { clients } from './clients.js';
import { asService } from './context.js';
import { absoluteUrl } from './links.js';
import type { Logger } from './log.js';
import type { Emitter } from './threads.js';

export type Severity = 'info' | 'success' | 'warning' | 'critical';

export interface NotifyInput {
  userIds?: string[];
  roles?: string[];
  /** Only resolve role members belonging to the tenant org itself (not vendor/client users). */
  internalOnly?: boolean;
  excludeUserIds?: string[];
  type: string;
  title: string;
  body?: string;
  link?: string | null;
  severity?: Severity;
  entityType?: string | null;
  entityId?: string | null;
}

/** Internal roles responsible for an entity: they hear about outside messages on its threads. */
export function responsibleRoles(entityType: string): string[] {
  switch (entityType) {
    case 'purchase_order':
    case 'shipment':
    case 'claim':
      return ['order_manager'];
    case 'cost_request':
    case 'quote':
      return ['procurement'];
    case 'project':
      return ['project_manager'];
    default:
      return ['project_manager'];
  }
}

/**
 * Resolve recipients (explicit user ids ∪ members having any of `roles`, via identity) and write one
 * notification per user, skipping users who muted the type. Writes run in service context so any
 * caller (including vendor/client actors) can trigger fan-out without seeing other users' rows.
 * When a user has `immediate_critical` email preference and severity is critical, an email command
 * is emitted as well (requires `emitter`). Returns the recipients notified.
 */
export async function notifyUsers(
  tx: Tx,
  tenantId: string,
  n: NotifyInput,
  log?: Logger,
  emitter?: Emitter,
): Promise<string[]> {
  const ids = new Set(n.userIds ?? []);
  const emails = new Map<string, string>();
  if (n.roles?.length) {
    try {
      const users = await clients.listUsers(tenantId, { roles: n.roles });
      for (const u of users) {
        if (n.internalOnly && u.orgId !== tenantId) continue;
        ids.add(u.id);
        emails.set(u.id, u.email);
      }
    } catch (err) {
      // Never fail the caller's write because the directory is unreachable; explicit ids still go out.
      log?.warn(
        { err: (err as Error).message, roles: n.roles },
        'role lookup failed; notifying explicit users only',
      );
    }
  }
  for (const x of n.excludeUserIds ?? []) ids.delete(x);
  if (!ids.size) return [];
  const severity = n.severity ?? 'info';

  return asService(tx, tenantId, async () => {
    const list = [...ids];
    const prefs = await tx<{ userId: string; emailDigest: string; mutedTypes: string[] }[]>`
      select user_id, email_digest, muted_types from comms.notification_preferences
      where tenant_id = ${tenantId} and user_id in ${tx(list)}`;
    const byUser = new Map(prefs.map((p) => [p.userId, p]));
    const recipients = list.filter((u) => !byUser.get(u)?.mutedTypes.includes(n.type));
    if (!recipients.length) return [];
    await tx`
      insert into comms.notifications ${tx(
        recipients.map((userId) => ({
          tenantId,
          userId,
          type: n.type,
          title: n.title.slice(0, 500),
          body: n.body ?? '',
          link: n.link ?? null,
          severity,
          entityType: n.entityType ?? null,
          entityId: n.entityId ?? null,
        })),
      )}`;

    if (severity === 'critical' && emitter) {
      const wantEmail = recipients.filter((u) => byUser.get(u)?.emailDigest === 'immediate_critical');
      const missing = wantEmail.filter((u) => !emails.has(u));
      if (missing.length) {
        try {
          for (const u of await clients.listUsers(tenantId, { ids: missing })) emails.set(u.id, u.email);
        } catch (err) {
          log?.warn({ err: (err as Error).message }, 'could not resolve emails for critical notification');
        }
      }
      const to = wantEmail.map((u) => emails.get(u)).filter((e): e is string => !!e);
      if (to.length)
        await emitter(tx, 'cmd.email.send', {
          to,
          cc: [],
          subject: n.title,
          text: `${n.body ?? ''}${n.link ? `\n\nOpen: ${absoluteUrl(n.link)}` : ''}`,
          html: null,
          replyTo: null,
          attachments: [],
          threadId: null,
        });
    }
    return recipients;
  });
}
