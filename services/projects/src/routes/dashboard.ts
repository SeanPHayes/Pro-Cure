import type { App } from '@procure/platform';
import { addCalendarDays, today, weekBounds } from '../dates.js';
import { Dashboard } from '../schemas.js';
import { requireStaff } from './helpers.js';
import { taskWithProjectCols } from './tasks.js';

export async function dashboardRoutes(app: App) {
  app.get(
    '/dashboard',
    {
      schema: {
        tags: ['dashboard'],
        summary: 'Portfolio dashboard: active projects by stage, due/overdue tasks, my tasks, milestones',
        response: { 200: Dashboard },
      },
    },
    async (req) => {
      requireStaff(req.principal, 'projects:read');
      const now = today();
      const wk = weekBounds(now);
      const horizon = addCalendarDays(now, 14);
      const me = req.principal.userId;
      return req.tx(async (tx) => {
        const active = tx`p.status in ('active', 'on_hold', 'won')`;
        const open = tx`t.status not in ('done', 'skipped')`;
        const [[counts], byStage, myTasks, upcoming, recent] = await Promise.all([
          tx<{ activeProjects: number; tasksDueThisWeek: number; overdueTasks: number }[]>`
            select
              (select count(*) from projects.projects p where ${active})::int as active_projects,
              (select count(*) from projects.tasks t join projects.projects p on p.id = t.project_id
                where ${active} and ${open} and t.due_date between ${wk.start} and ${wk.end})::int as tasks_due_this_week,
              (select count(*) from projects.tasks t join projects.projects p on p.id = t.project_id
                where ${active} and ${open} and t.due_date < ${now})::int as overdue_tasks`,
          tx`select p.stage, count(*)::int as count from projects.projects p where ${active}
             group by p.stage order by min(array_position(array['lead','proposal','design','quoting','client_approval',
               'procurement','production','logistics','installation','closeout','complete'], p.stage))`,
          tx`select ${taskWithProjectCols(tx)} from projects.tasks t join projects.projects p on p.id = t.project_id
             where ${active} and ${open} and t.assignee_user_id = ${me}
             order by t.ready desc, t.due_date nulls last, t.sort limit 10`,
          tx`select ${taskWithProjectCols(tx)} from projects.tasks t join projects.projects p on p.id = t.project_id
             where ${active} and ${open} and t.is_milestone and t.due_date between ${now} and ${horizon}
             order by t.due_date, t.sort limit 10`,
          tx`select id, number, name, stage, status, updated_at from projects.projects p
             order by updated_at desc limit 10`,
        ]);
        return {
          ...counts!,
          byStage,
          myTasks,
          upcomingMilestones: upcoming,
          recentlyUpdatedProjects: recent,
        } as never;
      });
    },
  );
}
