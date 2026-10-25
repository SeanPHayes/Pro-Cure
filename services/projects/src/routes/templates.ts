import { type App, notFound, type Tx, z } from '@procure/platform';
import { DEFAULT_TEMPLATE, DEFAULT_TEMPLATE_TASKS } from '../default-template.js';
import { applyTemplate, getProjectRow, taskCols } from '../engine.js';
import { topoSort } from '../scheduling.js';
import {
  ApplyTemplateBody,
  ApplyTemplateResult,
  IdParams,
  Ok,
  Template,
  TemplateDetail,
  TemplateInput,
  TemplatePatch,
  TemplateTask,
  TemplateTaskInput,
  TemplateTaskPatch,
  TemplateTasksReplace,
} from '../schemas.js';
import { emitter, requireStaff } from './helpers.js';

type TaskIn = z.input<typeof TemplateTaskInput>;

const templateCols = (tx: Tx) =>
  tx`tt.*, (select count(*) from projects.template_tasks x where x.template_id = tt.id)::int as task_count`;

async function templateDetail(tx: Tx, id: string) {
  const [t] = await tx`select ${templateCols(tx)} from projects.task_templates tt where tt.id = ${id}`;
  if (!t) throw notFound('Task template');
  const tasks = await tx`select * from projects.template_tasks where template_id = ${id} order by sort, key`;
  return { ...t, tasks } as never;
}

/** Validate (422 on unknown deps / cycles) then replace all tasks of a template. */
async function replaceTasks(tx: Tx, tenantId: string, templateId: string, tasks: TaskIn[]) {
  const parsed = tasks.map((t, i) => TemplateTaskInput.parse({ ...t, sort: t.sort ?? (i + 1) * 10 }));
  topoSort(parsed.map((t) => ({ key: t.key, dependsOn: t.dependsOn, durationDays: 0, offsetDays: 0 })));
  await tx`delete from projects.template_tasks where template_id = ${templateId}`;
  const rows = parsed.map((t) => ({
    templateId,
    tenantId,
    key: t.key,
    name: t.name,
    phase: t.phase ?? null,
    kind: t.kind,
    party: t.party,
    assigneeRole: t.assigneeRole ?? null,
    workHours: t.workHours ?? null,
    durationDays: t.durationDays,
    dependsOn: t.dependsOn,
    offsetDays: t.offsetDays,
    isMilestone: t.isMilestone,
    autoCompleteOn: t.autoCompleteOn ?? null,
    description: t.description ?? null,
    sort: t.sort!,
  }));
  for (let i = 0; i < rows.length; i += 200)
    await tx`insert into projects.template_tasks ${tx(rows.slice(i, i + 200))}`;
}

async function loadTasks(tx: Tx, templateId: string): Promise<TaskIn[]> {
  return tx`select key, name, phase, kind, party, assignee_role, work_hours, duration_days, depends_on,
                   offset_days, is_milestone, auto_complete_on, description, sort
            from projects.template_tasks where template_id = ${templateId} order by sort, key` as never;
}

async function createTemplate(tx: Tx, tenantId: string, b: z.infer<typeof TemplateInput>) {
  if (b.isDefault) await tx`update projects.task_templates set is_default = false where is_default`;
  const [t] = await tx<{ id: string }[]>`
    insert into projects.task_templates ${tx({
      tenantId,
      name: b.name,
      description: b.description ?? null,
      projectType: b.projectType ?? null,
      isDefault: b.isDefault,
    })} returning id`;
  if (b.tasks?.length) await replaceTasks(tx, tenantId, t!.id, b.tasks);
  return t!.id;
}

export async function templateRoutes(app: App) {
  app.get(
    '/task-templates',
    {
      schema: {
        tags: ['templates'],
        summary: 'List task templates',
        querystring: z.object({ projectType: z.string().optional() }),
        response: { 200: z.array(Template) },
      },
    },
    async (req) => {
      requireStaff(req.principal, 'projects:read');
      return req.tx(
        (tx) =>
          tx`select ${templateCols(tx)} from projects.task_templates tt
                   ${req.query.projectType ? tx`where tt.project_type is null or tt.project_type = ${req.query.projectType}` : tx``}
                   order by tt.is_default desc, tt.name` as never,
      );
    },
  );

  app.post(
    '/task-templates',
    {
      schema: {
        tags: ['templates'],
        summary: 'Create a task template (optionally with tasks)',
        body: TemplateInput,
        response: { 201: TemplateDetail },
      },
    },
    async (req, reply) => {
      requireStaff(req.principal, 'templates:write');
      const d = await req.tx(async (tx) =>
        templateDetail(tx, await createTemplate(tx, req.principal.tenantId, req.body)),
      );
      return reply.status(201).send(d);
    },
  );

  app.post(
    '/task-templates/default',
    {
      schema: {
        tags: ['templates'],
        summary: 'Create the standard hospitality FF&E template for this tenant',
        description:
          'Idempotent by name: returns the existing template if one with the standard name exists. ' +
          'Becomes the tenant default when no default exists yet.',
        response: { 200: TemplateDetail, 201: TemplateDetail },
      },
    },
    async (req, reply) => {
      requireStaff(req.principal, 'templates:write');
      const { detail, created } = await req.tx(async (tx) => {
        const [existing] = await tx<{ id: string }[]>`
          select id from projects.task_templates where name = ${DEFAULT_TEMPLATE.name} limit 1`;
        if (existing) return { detail: await templateDetail(tx, existing.id), created: false };
        const [hasDefault] = await tx`select 1 from projects.task_templates where is_default limit 1`;
        const id = await createTemplate(tx, req.principal.tenantId, {
          ...DEFAULT_TEMPLATE,
          projectType: null,
          isDefault: !hasDefault,
          tasks: DEFAULT_TEMPLATE_TASKS as never,
        });
        return { detail: await templateDetail(tx, id), created: true };
      });
      return reply.status(created ? 201 : 200).send(detail);
    },
  );

  app.get(
    '/task-templates/:id',
    {
      schema: {
        tags: ['templates'],
        summary: 'Template with its tasks',
        params: IdParams,
        response: { 200: TemplateDetail },
      },
    },
    async (req) => {
      requireStaff(req.principal, 'projects:read');
      return req.tx((tx) => templateDetail(tx, req.params.id));
    },
  );

  app.patch(
    '/task-templates/:id',
    {
      schema: {
        tags: ['templates'],
        summary: 'Update template name, description, project type or default flag',
        params: IdParams,
        body: TemplatePatch,
        response: { 200: TemplateDetail },
      },
    },
    async (req) => {
      requireStaff(req.principal, 'templates:write');
      return req.tx(async (tx) => {
        const [cur] = await tx`select id from projects.task_templates where id = ${req.params.id} for update`;
        if (!cur) throw notFound('Task template');
        if (req.body.isDefault)
          await tx`update projects.task_templates set is_default = false where is_default and id <> ${req.params.id}`;
        const set = Object.fromEntries(Object.entries(req.body).filter(([, v]) => v !== undefined));
        if (Object.keys(set).length)
          await tx`update projects.task_templates set ${tx(set, Object.keys(set))} where id = ${req.params.id}`;
        return templateDetail(tx, req.params.id);
      });
    },
  );

  app.delete(
    '/task-templates/:id',
    {
      schema: {
        tags: ['templates'],
        summary: 'Delete a template (projects keep their generated tasks)',
        params: IdParams,
        response: { 200: Ok },
      },
    },
    async (req) => {
      requireStaff(req.principal, 'templates:write');
      return req.tx(async (tx) => {
        const r = await tx`delete from projects.task_templates where id = ${req.params.id} returning id`;
        if (!r.length) throw notFound('Task template');
        return { ok: true };
      });
    },
  );

  // ---------------------------------------------------------------- template tasks
  app.get(
    '/task-templates/:id/tasks',
    {
      schema: {
        tags: ['templates'],
        summary: 'Tasks of a template',
        params: IdParams,
        response: { 200: z.array(TemplateTask) },
      },
    },
    async (req) => {
      requireStaff(req.principal, 'projects:read');
      return req.tx(async (tx) => {
        const [t] = await tx`select id from projects.task_templates where id = ${req.params.id}`;
        if (!t) throw notFound('Task template');
        return tx`select * from projects.template_tasks where template_id = ${req.params.id} order by sort, key` as never;
      });
    },
  );

  app.put(
    '/task-templates/:id/tasks',
    {
      schema: {
        tags: ['templates'],
        summary: 'Replace all tasks of a template (validated: unknown dependencies or cycles → 422)',
        params: IdParams,
        body: TemplateTasksReplace,
        response: { 200: z.array(TemplateTask) },
      },
    },
    async (req) => {
      requireStaff(req.principal, 'templates:write');
      return req.tx(async (tx) => {
        const [t] = await tx`select id from projects.task_templates where id = ${req.params.id} for update`;
        if (!t) throw notFound('Task template');
        await replaceTasks(tx, req.principal.tenantId, req.params.id, req.body.tasks);
        await tx`update projects.task_templates set updated_at = now() where id = ${req.params.id}`;
        return tx`select * from projects.template_tasks where template_id = ${req.params.id} order by sort, key` as never;
      });
    },
  );

  app.post(
    '/task-templates/:id/tasks',
    {
      schema: {
        tags: ['templates'],
        summary: 'Add a task to a template',
        params: IdParams,
        body: TemplateTaskInput,
        response: { 201: TemplateTask },
      },
    },
    async (req, reply) => {
      requireStaff(req.principal, 'templates:write');
      const row = await req.tx(async (tx) => {
        const [t] = await tx`select id from projects.task_templates where id = ${req.params.id} for update`;
        if (!t) throw notFound('Task template');
        const tasks = await loadTasks(tx, req.params.id);
        const maxSort = Math.max(0, ...tasks.map((x) => x.sort ?? 0));
        await replaceTasks(tx, req.principal.tenantId, req.params.id, [
          ...tasks,
          { ...req.body, sort: req.body.sort ?? maxSort + 10 },
        ]);
        const [created] = await tx`select * from projects.template_tasks
                                   where template_id = ${req.params.id} and key = ${req.body.key}`;
        return created;
      });
      return reply.status(201).send(row as never);
    },
  );

  app.patch(
    '/task-templates/:id/tasks/:taskId',
    {
      schema: {
        tags: ['templates'],
        summary: 'Update a template task',
        params: z.object({ id: z.uuid(), taskId: z.uuid() }),
        body: TemplateTaskPatch,
        response: { 200: TemplateTask },
      },
    },
    async (req) => {
      requireStaff(req.principal, 'templates:write');
      return req.tx(async (tx) => {
        const [cur] = await tx<{ key: string }[]>`
          select key from projects.template_tasks where id = ${req.params.taskId} and template_id = ${req.params.id}`;
        if (!cur) throw notFound('Template task');
        const tasks = await loadTasks(tx, req.params.id);
        const newKey = req.body.key ?? cur.key;
        const patch = Object.fromEntries(Object.entries(req.body).filter(([, v]) => v !== undefined));
        const next = tasks.map((t) => {
          const renamed = { ...t, dependsOn: (t.dependsOn ?? []).map((d) => (d === cur.key ? newKey : d)) };
          return t.key === cur.key ? { ...renamed, ...patch } : renamed;
        });
        await replaceTasks(tx, req.principal.tenantId, req.params.id, next);
        const [row] = await tx`select * from projects.template_tasks
                               where template_id = ${req.params.id} and key = ${newKey}`;
        return row as never;
      });
    },
  );

  app.delete(
    '/task-templates/:id/tasks/:taskId',
    {
      schema: {
        tags: ['templates'],
        summary: 'Remove a template task (and drop it from other tasks’ dependencies)',
        params: z.object({ id: z.uuid(), taskId: z.uuid() }),
        response: { 200: Ok },
      },
    },
    async (req) => {
      requireStaff(req.principal, 'templates:write');
      return req.tx(async (tx) => {
        const [cur] = await tx<{ key: string }[]>`
          delete from projects.template_tasks where id = ${req.params.taskId} and template_id = ${req.params.id}
          returning key`;
        if (!cur) throw notFound('Template task');
        await tx`update projects.template_tasks set depends_on = array_remove(depends_on, ${cur.key})
                 where template_id = ${req.params.id}`;
        return { ok: true };
      });
    },
  );

  // ---------------------------------------------------------------- apply to a project
  app.post(
    '/projects/:id/apply-template',
    {
      schema: {
        tags: ['templates'],
        summary: 'Generate project tasks from a template, scheduled forward in business days',
        description:
          'Tasks are scheduled from anchorDate skipping weekends, using duration_days, offset_days and ' +
          'dependencies (topological). Assignee = first team member with the matching role. ' +
          'mode=replace deletes existing tasks first. Cycles → 422.',
        params: IdParams,
        body: ApplyTemplateBody,
        response: { 200: ApplyTemplateResult },
      },
    },
    async (req) => {
      requireStaff(req.principal, 'tasks:write');
      return req.tx(async (tx) => {
        await getProjectRow(tx, req.params.id);
        const r = await applyTemplate(
          tx,
          { tenantId: req.principal.tenantId, projectId: req.params.id, ...req.body },
          emitter(req),
        );
        const tasks = await tx`select ${taskCols(tx)} from projects.tasks t where t.id = any(${r.ids}::uuid[])
                               order by t.sort`;
        return { created: r.ids.length, removed: r.removed, start: r.start, end: r.end, tasks } as never;
      });
    },
  );
}
