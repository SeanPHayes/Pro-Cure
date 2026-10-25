import { z } from 'zod';
import type { Db } from './db.js';

export const ActivityEntry = z.object({
  id: z.number(),
  entityType: z.string(),
  entityId: z.string(),
  action: z.enum(['insert', 'update', 'delete']),
  changes: z.record(z.string(), z.unknown()),
  actorUserId: z.string().nullable(),
  actorName: z.string().nullable(),
  actorType: z.string().nullable(),
  occurredAt: z.string(),
});
export type ActivityEntry = z.infer<typeof ActivityEntry>;

/**
 * Activity for an entity and (optionally) everything whose audit trigger names it as parent —
 * e.g. a purchase order plus its lines, shipments and requirements.
 */
export async function listActivity(
  tx: Db,
  entityType: string,
  entityId: string,
  opts: { includeChildren?: boolean; limit?: number } = {},
): Promise<ActivityEntry[]> {
  const limit = opts.limit ?? 200;
  return opts.includeChildren
    ? tx<ActivityEntry[]>`
        select id, entity_type, entity_id, action, changes, actor_user_id, actor_name, actor_type, occurred_at
        from platform.activity_log
        where (entity_type = ${entityType} and entity_id = ${entityId})
           or (parent_type = ${entityType} and parent_id = ${entityId})
        order by occurred_at desc, id desc limit ${limit}`
    : tx<ActivityEntry[]>`
        select id, entity_type, entity_id, action, changes, actor_user_id, actor_name, actor_type, occurred_at
        from platform.activity_log
        where entity_type = ${entityType} and entity_id = ${entityId}
        order by occurred_at desc, id desc limit ${limit}`;
}
