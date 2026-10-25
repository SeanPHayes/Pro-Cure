import { type App, notFound, orderBy, type Tx, unprocessable, z } from '@procure/platform';
import { addCalendarDays, today, weekBounds } from '../dates.js';
import {
  completeTask,
  depsDone,
  getProjectRow,
  getTask,
  refreshDependents,
  reopenTask,
  reschedule,
  taskCols,
  validateDependencies,
} from '../engine.js';
import { criticalPath } from '../scheduling.js';
import {
  CompleteBody,
  Gantt,
  IdParams,
  pageOf,
  RescheduleBody,
  RescheduleQuery,
  RescheduleResult,
  Task,
  TaskInput,
  TaskListQuery,
  TaskPatch,
  TaskWithProject,
} from '../schemas.js';
import { emitter, like, requireStaff, total } from './helpers.js';

type ListQuery = z.infer<typeof TaskListQuery>;

const SORTS: Record<string, string> = {
  dueDate: 't.due_date',
  updatedAt: 't.updated_at',
  project: 'p.number',
};

/** WHERE fragment for the cross-portfolio task filters (shared with the dashboard). */
export function taskFilters(tx: Tx, q: Partial<ListQuery>, userId: string) {
  const now = today();
  const wk = weekBounds(now);
  const next = { start: addCalendarDays(wk.start, 7), end: addCalendarDays(wk.end, 7) };
  const assignee = q.assignee === 'me' ? userId : q.assignee;
  const open = tx`t.status not in ('done', 'skipped')`;
  return tx`
    ${q.activeProjectsOnly === false ? tx`` : tx`and p.status in ('active', 'on_hold', 'won')`}
    ${
      assignee === 'unassigned'
        ? tx`and t.assignee_user_id is null`
        : assignee
          ? tx`and t.assignee_user_id = ${assignee}`
          : tx``
    }
    ${q.projectId ? tx`and t.project_id = ${q.projectId}` : tx``}
    ${q.status?.length ? tx`and t.status in ${tx(q.status)}` : tx``}
    ${q.party ? tx`and t.party = ${q.party}` : tx``}
    ${q.kind ? tx`and t.kind = ${q.kind}` : tx``}
    ${q.milestone === undefined ? tx`` : tx`and t.is_milestone = ${q.milestone}`}
    ${q.ready === undefined ? tx`` : tx`and t.ready = ${q.ready}`}
    ${
      q.due === 'overdue'
        ? tx`and ${open} and t.due_date < ${now}`
        : q.due === 'today'
          ? tx`and t.due_date = ${now}`
          : q.due === 'this_week'
            ? tx`and t.due_date between ${wk.start} and ${wk.end}`
            : q.due === 'next_week'
              ? tx`and t.due_date between ${next.start} and ${next.end}`
              : q.due === 'no_date'
                ? tx`and t.due_date is null`
                : tx``
    }
    ${q.q ? tx`and (t.name || ' ' || coalesce(t.description, '') || ' ' || p.name) ilike ${like(q.q)}` : tx``}`;
}

export const taskWithProjectCols = (tx: Tx) =>
  tx`${taskCols(tx)}, p.number as project_number, p.name as project_name, p.property_name`;

export async function taskRoutes(app: App) {
  app.get(
    '/tasks',
    {
      schema: {
        tags: ['tasks'],
        summary: 'Cross-portfolio "action required" task list',
        description:
          'Defaults to open tasks (todo, in_progress, blocked) of active projects sorted by due date. ' +
          'assignee=me|unassigned|<userId>; due=overdue|today|this_week|next_week|no_date.',
        querystring: TaskListQuery,
        response: { 200: pageOf(TaskWithProject) },
      },
    },
    async (req) => {
      requireStaff(req.principal, 'projects:read');
      const q = { ...req.query, status: req.query.status ?? ['todo', 'in_progress', 'blocked'] };
      return req.tx(async (tx) => {
        const rows = await tx<{ totalCount: number }[]>`
          select ${taskWithProjectCols(tx)}, count(*) over () as total_count
          from projects.tasks t join projects.projects p on p.id = t.project_id
          where true ${taskFilters(tx, q, req.principal.userId)}
          order by ${orderBy(tx, q.sort, SORTS, 'dueDate')}, t.sort
          limit ${q.limit} offset ${q.offset}`;
        return { items: rows as never, total: total(rows), limit: q.limit, offset: q.offset };
      });
    },
  );

  app.post(
    '/tasks',
    {
      schema: {
        tags: ['tasks'],
        summary: 'Create an ad hoc task on a project',
        body: TaskInput,
        response: { 201: Task },
      },
    },
    async (req, reply) => {
      requireStaff(req.principal, 'tasks:write');
      const b = req.body;
      const t = await req.tx(async (tx) => {
        await getProjectRow(tx, b.projectId);
        const id = crypto.randomUUID();
        await validateDependencies(tx, b.projectId, id, b.dependsOn);
        const ready = await depsDone(tx, b.dependsOn);
        const [{ s } = { s: 0 }] = await tx<{ s: number }[]>`
          select coalesce(max(sort), 0)::int + 10 as s from projects.tasks where project_id = ${b.projectId}`;
        await tx`insert into projects.tasks ${tx({
          id,
          tenantId: req.principal.tenantId,
          projectId: b.projectId,
          name: b.name,
          description: b.description ?? null,
          phase: b.phase ?? null,
          kind: b.kind,
          party: b.party,
          assigneeUserId: b.assigneeUserId ?? null,
          assigneeName: b.assigneeName ?? null,
          assigneeRole: b.assigneeRole ?? null,
          workHours: b.workHours ?? null,
          durationDays: b.durationDays ?? 1,
          startDate: b.startDate ?? null,
          dueDate: b.dueDate ?? null,
          dependsOn: b.dependsOn,
          isMilestone: b.isMilestone,
          autoCompleteOn: b.autoCompleteOn ?? null,
          ready,
          sort: s,
        })}`;
        if (b.assigneeUserId && ready)
          await req.emit(tx, 'projects.task.assigned', {
            taskId: id,
            projectId: b.projectId,
            assigneeUserId: b.assigneeUserId,
            name: b.name,
          });
        return getTask(tx, id);
      });
      return reply.status(201).send(t);
    },
  );

  app.get(
    '/tasks/:id',
    {
      schema: { tags: ['tasks'], summary: 'Get a task', params: IdParams, response: { 200: Task } },
    },
    async (req) => {
      requireStaff(req.principal, 'projects:read');
      return req.tx((tx) => getTask(tx, req.params.id));
    },
  );

  app.patch(
    '/tasks/:id',
    {
      schema: {
        tags: ['tasks'],
        summary: 'Update a task (status, assignee, dates, name, description, dependencies)',
        description:
          'Changing due_date does not move dependents; preview/apply that with POST /projects/:id/reschedule.',
        params: IdParams,
        body: TaskPatch,
        response: { 200: Task },
      },
    },
    async (req) => {
      requireStaff(req.principal, 'tasks:write');
      const emit = emitter(req);
      return req.tx(async (tx) => {
        const cur = await getTask(tx, req.params.id);
        const { status, ...rest } = req.body;
        if (rest.dependsOn) await validateDependencies(tx, cur.projectId, cur.id, rest.dependsOn);
        const start = rest.startDate === undefined ? cur.startDate : rest.startDate;
        const due = rest.dueDate === undefined ? cur.dueDate : rest.dueDate;
        if (start && due && due < start) throw unprocessable('dueDate must be on or after startDate');

        const set = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
        if (Object.keys(set).length)
          await tx`update projects.tasks set ${tx(set, Object.keys(set))} where id = ${cur.id}`;
        if (rest.dependsOn) {
          const ready = await depsDone(tx, rest.dependsOn);
          await tx`update projects.tasks set ready = ${ready} where id = ${cur.id}`;
        }

        if (status && status !== cur.status) {
          if (status === 'done') await completeTask(tx, cur.id, { name: req.principal.name }, emit);
          else if (cur.status === 'done' || cur.status === 'skipped') {
            await reopenTask(tx, cur.id, emit);
            if (status !== 'todo')
              await tx`update projects.tasks set status = ${status} where id = ${cur.id}`;
          } else {
            await tx`update projects.tasks set status = ${status} where id = ${cur.id}`;
            if (status === 'skipped') await refreshDependents(tx, [cur.id], emit);
          }
        }

        const after = await getTask(tx, cur.id);
        if (
          after.assigneeUserId &&
          after.assigneeUserId !== cur.assigneeUserId &&
          after.ready &&
          after.status !== 'done' &&
          after.status !== 'skipped'
        )
          await req.emit(tx, 'projects.task.assigned', {
            taskId: after.id,
            projectId: after.projectId,
            assigneeUserId: after.assigneeUserId,
            name: after.name,
          });
        return after;
      });
    },
  );

  app.delete(
    '/tasks/:id',
    {
      schema: {
        tags: ['tasks'],
        summary: 'Delete a task (removed from dependents)',
        params: IdParams,
        response: { 200: z.object({ ok: z.boolean() }) },
      },
    },
    async (req) => {
      requireStaff(req.principal, 'tasks:write');
      return req.tx(async (tx) => {
        const r = await tx`delete from projects.tasks where id = ${req.params.id} returning id`;
        if (!r.length) throw notFound('Task');
        const affected = await tx<{ id: string }[]>`
          update projects.tasks set depends_on = array_remove(depends_on, ${req.params.id}::uuid)
          where ${req.params.id}::uuid = any(depends_on) returning id`;
        for (const a of affected) {
          const [t] = await tx<
            { dependsOn: string[] }[]
          >`select depends_on from projects.tasks where id = ${a.id}`;
          const ready = await depsDone(tx, t!.dependsOn);
          await tx`update projects.tasks set ready = ${ready} where id = ${a.id}`;
        }
        return { ok: true };
      });
    },
  );

  app.post(
    '/tasks/:id/complete',
    {
      schema: {
        tags: ['tasks'],
        summary: 'Complete a task; dependents whose prerequisites are all done become ready',
        params: IdParams,
        body: CompleteBody,
        response: { 200: Task },
      },
    },
    async (req) => {
      requireStaff(req.principal, 'tasks:write');
      return req.tx(async (tx) => {
        await completeTask(tx, req.params.id, { name: req.principal.name }, emitter(req));
        return getTask(tx, req.params.id);
      });
    },
  );

  app.post(
    '/tasks/:id/reopen',
    {
      schema: {
        tags: ['tasks'],
        summary: 'Reopen a completed or skipped task (dependents become not ready)',
        params: IdParams,
        response: { 200: Task },
      },
    },
    async (req) => {
      requireStaff(req.principal, 'tasks:write');
      return req.tx(async (tx) => {
        await reopenTask(tx, req.params.id, emitter(req));
        return getTask(tx, req.params.id);
      });
    },
  );

  // ---------------------------------------------------------------- project-scoped schedule
  app.get(
    '/projects/:id/tasks',
    {
      schema: {
        tags: ['tasks'],
        summary: 'All tasks of a project in schedule order',
        params: IdParams,
        response: { 200: z.array(Task) },
      },
    },
    async (req) => {
      requireStaff(req.principal, 'projects:read');
      return req.tx(async (tx) => {
        await getProjectRow(tx, req.params.id);
        return tx`select ${taskCols(tx)} from projects.tasks t where t.project_id = ${req.params.id}
                  order by t.sort, t.start_date nulls last` as never;
      });
    },
  );

  app.post(
    '/projects/:id/reschedule',
    {
      schema: {
        tags: ['tasks'],
        summary: 'Shift downstream open tasks by the same business-day delta as the source task',
        description:
          'Delta = the last due-date change recorded on fromTaskId (activity log); falls back to the gap ' +
          'between its finish and its earliest open successor. Use ?dryRun=true to preview.',
        params: IdParams,
        querystring: RescheduleQuery,
        body: RescheduleBody.extend({ deltaDays: z.number().int().min(-500).max(500).optional() }),
        response: { 200: RescheduleResult },
      },
    },
    async (req) => {
      requireStaff(req.principal, 'tasks:write');
      return req.tx(async (tx) => {
        await getProjectRow(tx, req.params.id);
        const t = await getTask(tx, req.body.fromTaskId);
        if (t.projectId !== req.params.id) throw notFound('Task');
        return reschedule(tx, req.params.id, t.id, {
          deltaDays: req.body.deltaDays,
          dryRun: req.query.dryRun,
        });
      });
    },
  );

  app.get(
    '/projects/:id/gantt',
    {
      schema: {
        tags: ['tasks'],
        summary: 'Gantt data: tasks with dates, dependencies, progress and critical-path flags',
        params: IdParams,
        response: { 200: Gantt },
      },
    },
    async (req) => {
      requireStaff(req.principal, 'projects:read');
      return req.tx(async (tx) => {
        const p = await getProjectRow<{ id: string; targetOpenDate: string | null }>(tx, req.params.id);
        const tasks = await tx<z.infer<typeof Task>[]>`
          select ${taskCols(tx)} from projects.tasks t where t.project_id = ${p.id}
          order by t.sort, t.start_date nulls last`;
        const crit = criticalPath(
          tasks.map((t) => ({
            id: t.id,
            dependsOn: t.dependsOn,
            dueDate: t.dueDate,
            isMilestone: t.isMilestone,
            open: t.status !== 'done' && t.status !== 'skipped',
          })),
        );
        const starts = tasks
          .map((t) => t.startDate)
          .filter(Boolean)
          .sort() as string[];
        const dues = tasks
          .map((t) => t.dueDate)
          .filter(Boolean)
          .sort() as string[];
        return {
          projectId: p.id,
          start: starts[0] ?? null,
          end: dues[dues.length - 1] ?? null,
          targetOpenDate: p.targetOpenDate,
          tasks: tasks.map((t) => ({
            id: t.id,
            key: t.key,
            name: t.name,
            phase: t.phase,
            party: t.party,
            kind: t.kind,
            status: t.status,
            assigneeName: t.assigneeName,
            start: t.startDate,
            due: t.dueDate,
            durationDays: t.durationDays,
            dependsOn: t.dependsOn,
            progress:
              t.status === 'done' || t.status === 'skipped' ? 1 : t.status === 'in_progress' ? 0.5 : 0,
            isMilestone: t.isMilestone,
            critical: crit.has(t.id),
            overdue: t.overdue,
          })),
        };
      });
    },
  );
}
