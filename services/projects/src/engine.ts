import type { EventData, EventType } from '@procure/domain';
import { notFound, type Tx, unprocessable } from '@procure/platform';
import { addBusinessDays, businessDaysBetween, dueFor, maxDate, today } from './dates.js';
import { downstream, schedule, topoSort } from './scheduling.js';
import type { TaskRow } from './schemas.js';

/**
 * Task engine shared by HTTP routes, event subscriptions and jobs: completion + dependency readiness,
 * template application and downstream rescheduling. Every function runs inside the caller's
 * transaction; `emit` writes to the outbox in that same transaction.
 */
export type Emitter = <T extends EventType>(tx: Tx, type: T, data: EventData<T>) => Promise<unknown>;

export const OPEN = ['todo', 'in_progress', 'blocked'] as const;

/** Column list for task reads (adds the computed `overdue`). */
export const taskCols = (tx: Tx) =>
  tx`t.*, coalesce(t.status not in ('done', 'skipped') and t.due_date < current_date, false) as overdue`;

export async function getTask(tx: Tx, id: string): Promise<TaskRow> {
  const [t] = await tx<TaskRow[]>`select ${taskCols(tx)} from projects.tasks t where t.id = ${id}`;
  if (!t) throw notFound('Task');
  return t;
}

export async function getProjectRow<T extends object = Record<string, unknown>>(
  tx: Tx,
  id: string,
): Promise<T> {
  const [p] = await tx<T[]>`select * from projects.projects where id = ${id}`;
  if (!p) throw notFound('Project');
  return p;
}

interface Actor {
  name: string;
}

/**
 * Re-evaluate readiness of the direct dependents of `taskIds`. Newly-ready tasks that have not
 * started get start_date = max(today, planned) (due moves out to keep the duration) and their
 * assignees are notified via projects.task.assigned. Returns the ids that became ready.
 */
export async function refreshDependents(tx: Tx, taskIds: string[], emit: Emitter): Promise<string[]> {
  if (!taskIds.length) return [];
  const deps = await tx<
    {
      id: string;
      projectId: string;
      name: string;
      status: string;
      ready: boolean;
      allDone: boolean;
      startDate: string | null;
      dueDate: string | null;
      durationDays: number;
      assigneeUserId: string | null;
    }[]
  >`
    select t.id, t.project_id, t.name, t.status, t.ready, t.start_date, t.due_date, t.duration_days,
           t.assignee_user_id,
           not exists (select 1 from projects.tasks d
                       where d.id = any(t.depends_on) and d.status not in ('done', 'skipped')) as all_done
    from projects.tasks t
    where t.depends_on && ${taskIds}::uuid[] and t.status not in ('done', 'skipped')
    for update of t`;
  const now = today();
  const readied: string[] = [];
  for (const d of deps) {
    if (d.allDone && !d.ready) {
      let start = d.startDate;
      let due = d.dueDate;
      if (d.status === 'todo') {
        start = maxDate(now, d.startDate);
        if (start && start !== d.startDate) {
          const minDue = dueFor(start, d.durationDays);
          due = maxDate(d.dueDate, minDue);
        }
      }
      await tx`update projects.tasks set ready = true, start_date = ${start}, due_date = ${due} where id = ${d.id}`;
      readied.push(d.id);
      if (d.assigneeUserId)
        await emit(tx, 'projects.task.assigned', {
          taskId: d.id,
          projectId: d.projectId,
          assigneeUserId: d.assigneeUserId,
          name: d.name,
        });
    } else if (!d.allDone && d.ready) {
      await tx`update projects.tasks set ready = false where id = ${d.id}`;
    }
  }
  return readied;
}

/** Mark a task done (idempotent), ready its dependents and emit projects.task.completed. */
export async function completeTask(tx: Tx, id: string, by: Actor, emit: Emitter) {
  const [t] = await tx<
    { id: string; projectId: string; name: string; status: string; isMilestone: boolean }[]
  >`
    select id, project_id, name, status, is_milestone from projects.tasks where id = ${id} for update`;
  if (!t) throw notFound('Task');
  if (t.status === 'done') return { task: t, readied: [] as string[], changed: false };
  await tx`update projects.tasks
           set status = 'done', completed_at = now(), completed_by_name = ${by.name}
           where id = ${id}`;
  await emit(tx, 'projects.task.completed', {
    taskId: t.id,
    projectId: t.projectId,
    name: t.name,
    isMilestone: t.isMilestone,
  });
  const readied = await refreshDependents(tx, [id], emit);
  return { task: t, readied, changed: true };
}

/** Undo completion; open dependents become not-ready again. */
export async function reopenTask(tx: Tx, id: string, emit: Emitter) {
  const [t] = await tx<{ status: string }[]>`select status from projects.tasks where id = ${id} for update`;
  if (!t) throw notFound('Task');
  if (t.status !== 'done' && t.status !== 'skipped') return false;
  await tx`update projects.tasks set status = 'todo', completed_at = null, completed_by_name = null where id = ${id}`;
  await refreshDependents(tx, [id], emit);
  return true;
}

/** Ensure `dependsOn` are tasks of the same project and the project graph stays acyclic. */
export async function validateDependencies(tx: Tx, projectId: string, taskId: string, dependsOn: string[]) {
  if (!dependsOn.length) return;
  const rows = await tx<{ id: string; dependsOn: string[] }[]>`
    select id, depends_on from projects.tasks where project_id = ${projectId}`;
  const ids = new Set(rows.map((r) => r.id));
  const missing = dependsOn.filter((d) => !ids.has(d) || d === taskId);
  if (missing.length)
    throw unprocessable('Dependencies must be other tasks of the same project', { missing });
  const nodes = rows.map((r) => ({
    key: r.id,
    dependsOn: (r.id === taskId ? dependsOn : r.dependsOn).filter((d) => ids.has(d)),
    durationDays: 0,
    offsetDays: 0,
  }));
  if (!ids.has(taskId)) nodes.push({ key: taskId, dependsOn, durationDays: 0, offsetDays: 0 });
  topoSort(nodes); // 422 on cycle
}

/** True when every dependency is done/skipped. */
export async function depsDone(tx: Tx, dependsOn: string[]) {
  if (!dependsOn.length) return true;
  const [r] = await tx<{ n: number }[]>`
    select count(*)::int as n from projects.tasks where id = any(${dependsOn}::uuid[]) and status not in ('done', 'skipped')`;
  return r!.n === 0;
}

// ---------------------------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------------------------
interface TemplateTaskRow {
  id: string;
  key: string;
  name: string;
  phase: string | null;
  kind: string;
  party: string;
  assigneeRole: string | null;
  workHours: number | null;
  durationDays: number;
  dependsOn: string[];
  offsetDays: number;
  isMilestone: boolean;
  autoCompleteOn: string | null;
  description: string | null;
  sort: number;
}

export async function applyTemplate(
  tx: Tx,
  args: {
    tenantId: string;
    projectId: string;
    templateId: string;
    anchorDate: string;
    mode: 'append' | 'replace';
  },
  emit: Emitter,
) {
  const [tpl] = await tx`select id from projects.task_templates where id = ${args.templateId}`;
  if (!tpl) throw notFound('Task template');
  const ttasks = await tx<TemplateTaskRow[]>`
    select * from projects.template_tasks where template_id = ${args.templateId} order by sort, key`;
  if (!ttasks.length) throw unprocessable('Template has no tasks');
  const { order, dates } = schedule(ttasks, args.anchorDate); // 422 on cycles / unknown deps

  let removed = 0;
  if (args.mode === 'replace') {
    const r = await tx`delete from projects.tasks where project_id = ${args.projectId} returning id`;
    removed = r.length;
  }
  const [{ maxSort } = { maxSort: 0 }] = await tx<{ maxSort: number }[]>`
    select coalesce(max(sort), 0)::int as max_sort from projects.tasks where project_id = ${args.projectId}`;

  // First team member per role (leads first) becomes the assignee.
  const team = await tx<{ userId: string; name: string; role: string }[]>`
    select user_id, name, role from projects.project_team where project_id = ${args.projectId}
    order by is_lead desc, created_at, name`;
  const byRole = new Map<string, { userId: string; name: string }>();
  for (const m of team) if (!byRole.has(m.role)) byRole.set(m.role, m);

  const idFor = new Map(ttasks.map((t) => [t.key, crypto.randomUUID()]));
  const rows = order.map((t) => {
    const d = dates.get(t.key)!;
    const who = t.assigneeRole ? byRole.get(t.assigneeRole) : undefined;
    return {
      id: idFor.get(t.key)!,
      tenantId: args.tenantId,
      projectId: args.projectId,
      templateTaskId: t.id,
      key: t.key,
      name: t.name,
      description: t.description,
      phase: t.phase,
      kind: t.kind,
      party: t.party,
      status: 'todo',
      assigneeUserId: who?.userId ?? null,
      assigneeName: who?.name ?? null,
      assigneeRole: t.assigneeRole,
      workHours: t.workHours,
      durationDays: t.durationDays,
      startDate: d.start,
      dueDate: d.due,
      dependsOn: t.dependsOn.map((k) => idFor.get(k)!),
      isMilestone: t.isMilestone,
      autoCompleteOn: t.autoCompleteOn,
      ready: t.dependsOn.length === 0,
      sort: maxSort + t.sort + 1,
    };
  });
  // Insert in chunks to stay well under the bind-parameter limit.
  for (let i = 0; i < rows.length; i += 200)
    await tx`insert into projects.tasks ${tx(rows.slice(i, i + 200))}`;

  for (const r of rows)
    if (r.ready && r.assigneeUserId)
      await emit(tx, 'projects.task.assigned', {
        taskId: r.id,
        projectId: args.projectId,
        assigneeUserId: r.assigneeUserId,
        name: r.name,
      });

  const starts = rows.map((r) => r.startDate).sort();
  const ends = rows.map((r) => r.dueDate).sort();
  return {
    ids: rows.map((r) => r.id),
    removed,
    start: starts[0] ?? null,
    end: ends[ends.length - 1] ?? null,
  };
}

// ---------------------------------------------------------------------------------------------
// Rescheduling
// ---------------------------------------------------------------------------------------------
/**
 * Shift every not-done task downstream of `fromTaskId` by `deltaDays` business days. When delta is
 * not given it is derived from the gap between the task's (new) finish and its earliest open direct
 * successor's start: positive pushes successors out, negative pulls them in.
 */
export async function reschedule(
  tx: Tx,
  projectId: string,
  fromTaskId: string,
  opts: { deltaDays?: number; dryRun: boolean },
) {
  const tasks = await tx<
    {
      id: string;
      name: string;
      status: string;
      dependsOn: string[];
      startDate: string | null;
      dueDate: string | null;
      durationDays: number;
    }[]
  >`select id, name, status, depends_on, start_date, due_date, duration_days
    from projects.tasks where project_id = ${projectId} for update`;
  const from = tasks.find((t) => t.id === fromTaskId);
  if (!from) throw notFound('Task');
  const ids = downstream(tasks, fromTaskId);
  const affected = tasks.filter((t) => ids.has(t.id) && t.status !== 'done' && t.status !== 'skipped');

  let delta = opts.deltaDays;
  if (delta === undefined) {
    // The field-level audit log records the last due-date edit on the source task: shift by that.
    const [last] = await tx<{ from: string | null; to: string | null }[]>`
      select changes -> 'due_date' ->> 'from' as from, changes -> 'due_date' ->> 'to' as to
      from platform.activity_log
      where entity_type = 'task' and entity_id = ${fromTaskId} and action = 'update' and changes ? 'due_date'
      order by occurred_at desc, id desc limit 1`;
    if (last?.from && last.to) delta = businessDaysBetween(last.from, last.to);
  }
  if (delta === undefined) {
    // No recorded edit: close the gap between the task's finish and its earliest open successor.
    const direct = affected.filter((t) => t.dependsOn.includes(fromTaskId) && t.startDate);
    const earliest = direct.map((t) => t.startDate!).sort()[0];
    delta =
      earliest && from.dueDate
        ? Math.max(
            0,
            businessDaysBetween(earliest, addBusinessDays(from.dueDate, from.durationDays === 0 ? 0 : 1)),
          )
        : 0;
  }

  const changes = affected
    .map((t) => ({
      taskId: t.id,
      name: t.name,
      fromStart: t.startDate,
      toStart: t.startDate && delta ? addBusinessDays(t.startDate, delta) : t.startDate,
      fromDue: t.dueDate,
      toDue: t.dueDate && delta ? addBusinessDays(t.dueDate, delta) : t.dueDate,
    }))
    .filter((c) => c.fromStart !== c.toStart || c.fromDue !== c.toDue);

  if (!opts.dryRun)
    for (const c of changes)
      await tx`update projects.tasks set start_date = ${c.toStart}, due_date = ${c.toDue} where id = ${c.taskId}`;
  return { dryRun: opts.dryRun, deltaDays: delta, changes };
}
