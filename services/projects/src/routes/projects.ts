import {
  ActivityEntry,
  type App,
  listActivity,
  notFound,
  orderBy,
  type Tx,
  unprocessable,
  z,
} from '@procure/platform';
import { applyTemplate, getProjectRow } from '../engine.js';
import {
  Contact,
  ContactInput,
  ContactPatch,
  IdParams,
  Ok,
  type Project,
  ProjectDetail,
  ProjectInput,
  ProjectListItem,
  ProjectListQuery,
  ProjectPatch,
  pageOf,
  TeamMember,
  TeamMemberInput,
} from '../schemas.js';
import { emitter, like, requireStaff, total } from './helpers.js';

const SORTS: Record<string, string> = {
  number: 'p.number',
  name: 'p.name',
  targetOpenDate: 'p.target_open_date',
  updatedAt: 'p.updated_at',
  createdAt: 'p.created_at',
  stage: 'p.stage',
};

/** Columns a PATCH may change (camelCase → stored as snake_case by postgres.js). */
const PATCHABLE = [
  'name',
  'propertyName',
  'brandId',
  'clientOrgId',
  'type',
  'stage',
  'status',
  'keys',
  'floors',
  'address',
  'shipToAddress',
  'targetOpenDate',
  'startDate',
  'budget',
  'creditTerms',
  'tags',
  'description',
] as const;
const JSON_COLS = new Set(['address', 'shipToAddress']);

export async function projectDetail(tx: Tx, id: string) {
  const p = await getProjectRow<z.infer<typeof Project>>(tx, id);
  const [team, contacts, milestones, counts] = await Promise.all([
    tx`select user_id, name, email, role, is_lead from projects.project_team where project_id = ${id}
       order by is_lead desc, role, name`,
    tx`select * from projects.project_contacts where project_id = ${id} order by role, name`,
    tx`select id, name, phase, party, status, start_date, due_date, completed_at from projects.tasks
       where project_id = ${id} and is_milestone order by due_date nulls last, sort`,
    tx<Record<string, number>[]>`
      select count(*) filter (where status = 'todo')::int as todo,
             count(*) filter (where status = 'in_progress')::int as in_progress,
             count(*) filter (where status = 'blocked')::int as blocked,
             count(*) filter (where status = 'done')::int as done,
             count(*) filter (where status = 'skipped')::int as skipped,
             count(*) filter (where status not in ('done','skipped') and due_date < current_date)::int as overdue,
             count(*)::int as total
      from projects.tasks where project_id = ${id}`,
  ]);
  const c = counts[0]!;
  return {
    ...p,
    team,
    contacts,
    milestones,
    // keys are camelCased by the driver; TaskCounts uses the status names verbatim
    taskCounts: {
      todo: c.todo ?? 0,
      in_progress: c.inProgress ?? 0,
      blocked: c.blocked ?? 0,
      done: c.done ?? 0,
      skipped: c.skipped ?? 0,
      overdue: c.overdue ?? 0,
      total: c.total ?? 0,
    },
  } as never;
}

/** Replace the team; open unassigned tasks whose role now has a member get assigned. */
async function replaceTeam(
  tx: Tx,
  tenantId: string,
  projectId: string,
  team: z.infer<typeof TeamMemberInput>[],
  emit: ReturnType<typeof emitter>,
) {
  await tx`delete from projects.project_team where project_id = ${projectId}`;
  const seen = new Set<string>();
  const rows = team
    .filter((m) => {
      const k = `${m.userId}:${m.role}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .map((m) => ({
      projectId,
      tenantId,
      userId: m.userId,
      name: m.name,
      email: m.email ?? null,
      role: m.role,
      isLead: m.isLead ?? false,
    }));
  if (rows.length) await tx`insert into projects.project_team ${tx(rows)}`;

  const firstByRole = new Map<string, { userId: string; name: string }>();
  for (const m of [...rows].sort((a, b) => Number(b.isLead) - Number(a.isLead)))
    if (!firstByRole.has(m.role)) firstByRole.set(m.role, m);
  for (const [role, m] of firstByRole) {
    const assigned = await tx<{ id: string; name: string; ready: boolean }[]>`
      update projects.tasks set assignee_user_id = ${m.userId}, assignee_name = ${m.name}
      where project_id = ${projectId} and assignee_user_id is null and assignee_role = ${role}
        and status not in ('done', 'skipped')
      returning id, name, ready`;
    for (const t of assigned)
      if (t.ready)
        await emit(tx, 'projects.task.assigned', {
          taskId: t.id,
          projectId,
          assigneeUserId: m.userId,
          name: t.name,
        });
  }
}

export async function projectRoutes(app: App) {
  app.get(
    '/projects',
    {
      schema: {
        tags: ['projects'],
        summary: 'List projects with open/overdue task counts and the next milestone',
        querystring: ProjectListQuery,
        response: { 200: pageOf(ProjectListItem) },
      },
    },
    async (req) => {
      requireStaff(req.principal, 'projects:read');
      const q = req.query;
      const assignee = q.assignee === 'me' ? req.principal.userId : q.assignee;
      return req.tx(async (tx) => {
        const rows = await tx<(z.infer<typeof ProjectListItem> & { totalCount: number })[]>`
          select p.*, count(*) over () as total_count,
            (select count(*) from projects.tasks t
              where t.project_id = p.id and t.status not in ('done', 'skipped'))::int as open_tasks,
            (select count(*) from projects.tasks t
              where t.project_id = p.id and t.status not in ('done', 'skipped') and t.due_date < current_date)::int
              as overdue_tasks,
            (select json_build_object('id', t.id, 'name', t.name, 'due', t.due_date) from projects.tasks t
              where t.project_id = p.id and t.is_milestone and t.status not in ('done', 'skipped')
              order by t.due_date nulls last, t.sort limit 1) as next_milestone
          from projects.projects p
          where true
            ${q.stage?.length ? tx`and p.stage in ${tx(q.stage)}` : tx``}
            ${q.status?.length ? tx`and p.status in ${tx(q.status)}` : tx``}
            ${q.clientOrgId ? tx`and p.client_org_id = ${q.clientOrgId}` : tx``}
            ${q.brandId ? tx`and p.brand_id = ${q.brandId}` : tx``}
            ${
              assignee
                ? tx`and (exists (select 1 from projects.project_team m where m.project_id = p.id and m.user_id = ${assignee})
                     or exists (select 1 from projects.tasks t where t.project_id = p.id and t.assignee_user_id = ${assignee}
                                and t.status not in ('done', 'skipped')))`
                : tx``
            }
            ${
              q.q
                ? tx`and (p.name || ' ' || coalesce(p.property_name, '') || ' ' || p.number) ilike ${like(q.q)}`
                : tx``
            }
          order by ${orderBy(tx, q.sort, SORTS, '-updatedAt')}, p.number desc
          limit ${q.limit} offset ${q.offset}`;
        return { items: rows, total: total(rows), limit: q.limit, offset: q.offset };
      });
    },
  );

  app.post(
    '/projects',
    {
      schema: {
        tags: ['projects'],
        summary: 'Create a project (optionally with a team and a task template applied)',
        body: ProjectInput,
        response: { 201: ProjectDetail },
      },
    },
    async (req, reply) => {
      requireStaff(req.principal, 'projects:write');
      const b = req.body;
      if (b.templateId && !b.anchorDate && !b.startDate)
        throw unprocessable('anchorDate (or startDate) is required to apply a template');
      const p = req.principal;
      const detail = await req.tx(async (tx) => {
        const [row] = await tx<{ id: string; number: string }[]>`
          insert into projects.projects (
            tenant_id, number, name, property_name, brand_id, client_org_id, type, stage, status, keys, floors,
            address, ship_to_address, target_open_date, start_date, budget, credit_terms, tags, description, created_by)
          values (
            ${p.tenantId}, platform.next_number(${p.tenantId}, 'P', 'P-{yy}-{seq:3}'), ${b.name},
            ${b.propertyName ?? null}, ${b.brandId ?? null}, ${b.clientOrgId ?? null}, ${b.type}, ${b.stage},
            ${b.status}, ${b.keys ?? null}, ${b.floors ?? null}, ${tx.json(b.address as never)},
            ${tx.json((b.shipToAddress ?? b.address) as never)}, ${b.targetOpenDate ?? null}, ${b.startDate ?? null},
            ${b.budget ?? null}, ${b.creditTerms ?? null}, ${b.tags}, ${b.description ?? null}, ${p.userId})
          returning id, number`;
        const emit = emitter(req);
        if (b.team?.length) await replaceTeam(tx, p.tenantId, row!.id, b.team, emit);
        if (b.templateId)
          await applyTemplate(
            tx,
            {
              tenantId: p.tenantId,
              projectId: row!.id,
              templateId: b.templateId,
              anchorDate: (b.anchorDate ?? b.startDate)!,
              mode: 'append',
            },
            emit,
          );
        await req.emit(tx, 'projects.project.created', {
          projectId: row!.id,
          number: row!.number,
          name: b.name,
          clientOrgId: b.clientOrgId ?? null,
        });
        return projectDetail(tx, row!.id);
      });
      return reply.status(201).send(detail);
    },
  );

  app.get(
    '/projects/:id',
    {
      schema: {
        tags: ['projects'],
        summary: 'Project with team, contacts, milestones and task counts by status',
        params: IdParams,
        response: { 200: ProjectDetail },
      },
    },
    async (req) => {
      requireStaff(req.principal, 'projects:read');
      return req.tx((tx) => projectDetail(tx, req.params.id));
    },
  );

  app.patch(
    '/projects/:id',
    {
      schema: {
        tags: ['projects'],
        summary: 'Update a project (emits projects.project.updated with the changed fields)',
        params: IdParams,
        body: ProjectPatch,
        response: { 200: ProjectDetail },
      },
    },
    async (req) => {
      requireStaff(req.principal, 'projects:write');
      return req.tx(async (tx) => {
        const before = await getProjectRow<Record<string, unknown>>(tx, req.params.id);
        const body = req.body as Record<string, unknown>;
        const changes: Record<string, { from: unknown; to: unknown }> = {};
        const set: Record<string, unknown> = {};
        for (const k of PATCHABLE) {
          if (body[k] === undefined) continue;
          const to = body[k];
          if (JSON.stringify(before[k]) === JSON.stringify(to)) continue;
          changes[k] = { from: before[k], to };
          set[k] = JSON_COLS.has(k) ? tx.json(to as never) : to;
        }
        if (Object.keys(set).length) {
          await tx`update projects.projects set ${tx(set, Object.keys(set))} where id = ${req.params.id}`;
          await req.emit(tx, 'projects.project.updated', { projectId: req.params.id, changes });
        }
        return projectDetail(tx, req.params.id);
      });
    },
  );

  app.delete(
    '/projects/:id',
    {
      schema: {
        tags: ['projects'],
        summary: 'Cancel a project (soft delete: status → cancelled)',
        params: IdParams,
        response: { 200: Ok },
      },
    },
    async (req) => {
      requireStaff(req.principal, 'projects:write');
      return req.tx(async (tx) => {
        const [p] = await tx<{ status: string }[]>`
          select status from projects.projects where id = ${req.params.id} for update`;
        if (!p) throw notFound('Project');
        if (p.status !== 'cancelled') {
          await tx`update projects.projects set status = 'cancelled' where id = ${req.params.id}`;
          await req.emit(tx, 'projects.project.updated', {
            projectId: req.params.id,
            changes: { status: { from: p.status, to: 'cancelled' } },
          });
        }
        return { ok: true };
      });
    },
  );

  app.get(
    '/projects/:id/activity',
    {
      schema: {
        tags: ['projects'],
        summary: 'Field-level activity for the project and its tasks, contacts, team and notes',
        params: IdParams,
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(1000).default(200) }),
        response: { 200: z.array(ActivityEntry) },
      },
    },
    async (req) => {
      requireStaff(req.principal, 'projects:read');
      return req.tx(async (tx) => {
        await getProjectRow(tx, req.params.id);
        return listActivity(tx, 'project', req.params.id, { includeChildren: true, limit: req.query.limit });
      });
    },
  );

  // ---------------------------------------------------------------- team
  app.put(
    '/projects/:id/team',
    {
      schema: {
        tags: ['projects'],
        summary: 'Replace the project team (unassigned open tasks pick up members by role)',
        params: IdParams,
        body: z.object({ team: z.array(TeamMemberInput).max(50) }),
        response: { 200: z.array(TeamMember) },
      },
    },
    async (req) => {
      requireStaff(req.principal, 'projects:write');
      return req.tx(async (tx) => {
        await getProjectRow(tx, req.params.id);
        await replaceTeam(tx, req.principal.tenantId, req.params.id, req.body.team, emitter(req));
        return tx`select user_id, name, email, role, is_lead from projects.project_team
                  where project_id = ${req.params.id} order by is_lead desc, role, name` as never;
      });
    },
  );

  // ---------------------------------------------------------------- contacts
  app.get(
    '/projects/:id/contacts',
    {
      schema: {
        tags: ['contacts'],
        summary: 'Project contacts (owner reps, GM, site manager, GC, installer, warehouse...)',
        params: IdParams,
        response: { 200: z.array(Contact) },
      },
    },
    async (req) => {
      requireStaff(req.principal, 'projects:read');
      return req.tx(async (tx) => {
        await getProjectRow(tx, req.params.id);
        return tx`select * from projects.project_contacts where project_id = ${req.params.id}
                  order by role, name` as never;
      });
    },
  );

  app.post(
    '/projects/:id/contacts',
    {
      schema: {
        tags: ['contacts'],
        summary: 'Add a project contact',
        params: IdParams,
        body: ContactInput,
        response: { 201: Contact },
      },
    },
    async (req, reply) => {
      requireStaff(req.principal, 'projects:write');
      const c = await req.tx(async (tx) => {
        await getProjectRow(tx, req.params.id);
        const b = req.body;
        const [row] = await tx`
          insert into projects.project_contacts ${tx({
            tenantId: req.principal.tenantId,
            projectId: req.params.id,
            name: b.name,
            company: b.company ?? null,
            role: b.role,
            email: b.email ?? null,
            phone: b.phone ?? null,
            isDeliveryRecipient: b.isDeliveryRecipient,
            visibleToClient: b.visibleToClient,
            notes: b.notes ?? null,
          })} returning *`;
        return row;
      });
      return reply.status(201).send(c as never);
    },
  );

  app.patch(
    '/projects/:id/contacts/:contactId',
    {
      schema: {
        tags: ['contacts'],
        summary: 'Update a project contact',
        params: z.object({ id: z.uuid(), contactId: z.uuid() }),
        body: ContactPatch,
        response: { 200: Contact },
      },
    },
    async (req) => {
      requireStaff(req.principal, 'projects:write');
      return req.tx(async (tx) => {
        const set = Object.fromEntries(Object.entries(req.body).filter(([, v]) => v !== undefined));
        const [row] = Object.keys(set).length
          ? await tx`update projects.project_contacts set ${tx(set, Object.keys(set))}
                     where id = ${req.params.contactId} and project_id = ${req.params.id} returning *`
          : await tx`select * from projects.project_contacts
                     where id = ${req.params.contactId} and project_id = ${req.params.id}`;
        if (!row) throw notFound('Contact');
        return row as never;
      });
    },
  );

  app.delete(
    '/projects/:id/contacts/:contactId',
    {
      schema: {
        tags: ['contacts'],
        summary: 'Remove a project contact',
        params: z.object({ id: z.uuid(), contactId: z.uuid() }),
        response: { 200: Ok },
      },
    },
    async (req) => {
      requireStaff(req.principal, 'projects:write');
      return req.tx(async (tx) => {
        const r = await tx`delete from projects.project_contacts
                           where id = ${req.params.contactId} and project_id = ${req.params.id} returning id`;
        if (!r.length) throw notFound('Contact');
        return { ok: true };
      });
    },
  );
}
