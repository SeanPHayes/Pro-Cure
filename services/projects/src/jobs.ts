import { emit, hours, type Job } from '@procure/platform';

/**
 * Daily overdue digest: one cmd.notify per assignee with their overdue open-task count (active
 * projects only). A single grouped query across tenants (system context), then one outbox row per
 * assignee attributed to that tenant.
 */
export const overdueDigest: Job = {
  name: 'overdue-digest',
  everyMs: hours(24),
  run: async ({ tx, now }) => {
    const asOf = now.toISOString().slice(0, 10);
    const rows = await tx<
      { tenantId: string; userId: string; overdue: number; projects: number; oldest: string }[]
    >`
      select t.tenant_id, t.assignee_user_id as user_id, count(*)::int as overdue,
             count(distinct t.project_id)::int as projects, min(t.due_date) as oldest
      from projects.tasks t
      join projects.projects p on p.id = t.project_id
      where t.status not in ('done', 'skipped') and t.due_date < ${asOf}
        and t.assignee_user_id is not null and p.status in ('active', 'on_hold', 'won')
      group by t.tenant_id, t.assignee_user_id`;
    for (const r of rows)
      await emit(
        tx,
        'projects',
        'cmd.notify',
        {
          userIds: [r.userId],
          roles: [],
          title: `You have ${r.overdue} overdue task${r.overdue === 1 ? '' : 's'}`,
          body: `${r.overdue} overdue across ${r.projects} project${r.projects === 1 ? '' : 's'} (oldest due ${r.oldest}).`,
          link: '/app/tasks?assignee=me&due=overdue',
          severity: r.overdue >= 5 ? 'warning' : 'info',
        },
        { tenantId: r.tenantId, actor: null },
      );
    return { notified: rows.length, tenants: new Set(rows.map((r) => r.tenantId)).size };
  },
};

export const jobs: Job[] = [overdueDigest];
