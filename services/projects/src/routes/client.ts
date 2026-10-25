import { type App, forbidden, notFound, type Principal, withTenant, z } from '@procure/platform';
import { completeTask } from '../engine.js';
import { ClientProjectDetail, ClientProjectSummary, ClientTask, IdParams, pageOf } from '../schemas.js';
import { emitter, total } from './helpers.js';

/**
 * Owner (client) portal. Rows are limited by RLS (client_read policies keyed on client_org_id); columns
 * are limited by the dedicated Client* response schemas, so budget, credit terms, internal notes,
 * internal tasks, work hours and assignees never serialize even if a query over-selects.
 */
const requireClient = (p: Principal, perm: 'client:view' | 'client:approve') => {
  if (!p.isClient) throw forbidden('Client portal only');
  p.require(perm);
};

const clientTaskCols = `t.id, t.name, t.description, t.phase, t.kind, t.party, t.status, t.is_milestone,
  t.start_date, t.due_date, t.completed_at, t.completed_by_name,
  (t.party = 'client' and t.status not in ('done', 'skipped')) as can_complete`;

export async function clientRoutes(app: App) {
  app.get(
    '/client/projects',
    {
      schema: {
        tags: ['client portal'],
        summary: 'Projects of the signed-in owner organization',
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(200).default(50),
          offset: z.coerce.number().int().min(0).default(0),
        }),
        response: { 200: pageOf(ClientProjectSummary) },
      },
    },
    async (req) => {
      requireClient(req.principal, 'client:view');
      const { limit, offset } = req.query;
      return req.tx(async (tx) => {
        const rows = await tx<{ totalCount: number }[]>`
          select p.id, p.number, p.name, p.property_name, p.type, p.stage, p.status, p.address, p.target_open_date,
            count(*) over () as total_count,
            (select count(*) from projects.tasks t where t.project_id = p.id and t.party = 'client'
               and t.status not in ('done', 'skipped'))::int as open_client_tasks,
            (select json_build_object('id', t.id, 'name', t.name, 'due', t.due_date) from projects.tasks t
              where t.project_id = p.id and t.is_milestone and t.status not in ('done', 'skipped')
              order by t.due_date nulls last, t.sort limit 1) as next_milestone
          from projects.projects p
          where p.client_org_id = ${req.principal.orgId} and p.status <> 'cancelled'
          order by p.target_open_date nulls last, p.number
          limit ${limit} offset ${offset}`;
        return { items: rows as never, total: total(rows), limit, offset };
      });
    },
  );

  app.get(
    '/client/projects/:id',
    {
      schema: {
        tags: ['client portal'],
        summary: 'Client-safe project view: who to call, milestones, your action items, shared notes',
        params: IdParams,
        response: { 200: ClientProjectDetail },
      },
    },
    async (req) => {
      requireClient(req.principal, 'client:view');
      return req.tx(async (tx) => {
        const [p] = await tx`
          select id, number, name, property_name, type, stage, status, keys, address, ship_to_address, target_open_date
          from projects.projects where id = ${req.params.id} and client_org_id = ${req.principal.orgId}`;
        if (!p) throw notFound('Project');
        const [team, contacts, tasks, notes] = await Promise.all([
          tx`select name, email, role, is_lead from projects.project_team where project_id = ${req.params.id}
             order by is_lead desc, role, name`,
          tx`select id, name, company, role, email, phone from projects.project_contacts
             where project_id = ${req.params.id} and visible_to_client order by role, name`,
          tx`select ${tx.unsafe(clientTaskCols)} from projects.tasks t
             where t.project_id = ${req.params.id} and (t.party = 'client' or t.is_milestone)
             order by t.due_date nulls last, t.sort`,
          tx`select id, author_name, body, pinned, created_at from projects.notes
             where project_id = ${req.params.id} and visibility = 'client' order by pinned desc, created_at desc limit 100`,
        ]);
        return {
          ...p,
          team,
          contacts,
          milestones: tasks.filter((t) => t.isMilestone),
          tasks: tasks.filter((t) => t.party === 'client'),
          notes,
        } as never;
      });
    },
  );

  app.post(
    '/client/tasks/:id/complete',
    {
      schema: {
        tags: ['client portal'],
        summary: 'Complete one of your action items (client-party tasks only)',
        params: IdParams,
        body: z.object({ note: z.string().max(2000).optional() }).optional(),
        response: { 200: ClientTask },
      },
    },
    async (req) => {
      requireClient(req.principal, 'client:approve');
      const p = req.principal;
      // Visibility check under the client's own RLS context: the task must be readable by this client.
      const visible = await req.tx(async (tx) => {
        const [t] = await tx<{ id: string; party: string; projectId: string; name: string }[]>`
          select t.id, t.party, t.project_id, t.name from projects.tasks t
          join projects.projects pr on pr.id = t.project_id and pr.client_org_id = ${p.orgId}
          where t.id = ${req.params.id}`;
        return t;
      });
      if (!visible) throw notFound('Task');
      if (visible.party !== 'client')
        throw forbidden('Only client action items can be completed in the portal');

      // Completion touches internal rows (dependents) the client cannot update, so it runs with service
      // context for the tenant; events are still attributed to the client user.
      const emit = emitter(req);
      const completedBy = `${p.name} (${p.claims.orgName})`;
      await withTenant(p.tenantId, async (tx) => {
        await tx`select set_config('app.user_id', ${p.userId}, true), set_config('app.user_name', ${completedBy}, true)`;
        const r = await completeTask(tx, visible.id, { name: completedBy }, emit);
        if (r.changed) {
          const pms = await tx<{ userId: string }[]>`
            select user_id from projects.project_team
            where project_id = ${visible.projectId} and role = 'project_manager'`;
          await req.emit(tx, 'cmd.notify', {
            userIds: pms.map((m) => m.userId),
            roles: pms.length ? [] : ['project_manager'],
            title: `${completedBy} completed “${visible.name}”`,
            body: req.body?.note
              ? `Note: ${req.body.note}`
              : 'A client action item was completed in the owner portal.',
            link: `/app/projects/${visible.projectId}`,
            severity: 'success',
          });
        }
      });
      return req.tx(async (tx) => {
        const [t] =
          await tx`select ${tx.unsafe(clientTaskCols)} from projects.tasks t where t.id = ${visible.id}`;
        return t as never;
      });
    },
  );
}
