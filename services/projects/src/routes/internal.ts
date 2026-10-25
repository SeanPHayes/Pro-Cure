import { type App, notFound, withTenant, z } from '@procure/platform';
import { InternalProject } from '../schemas.js';

/** Service-to-service reads (docs/service-contracts.md → projects). */
export async function internalRoutes(app: App) {
  app.get(
    '/internal/projects/:id',
    {
      config: { internal: true },
      schema: {
        hide: true,
        tags: ['internal'],
        summary: 'Project with team and contacts (internal)',
        params: z.object({ id: z.uuid() }),
        querystring: z.object({ tenantId: z.uuid() }),
        response: { 200: InternalProject },
      },
    },
    async (req) =>
      withTenant(req.query.tenantId, async (tx) => {
        const [p] = await tx`
          select id, number, name, property_name, brand_id, client_org_id, address, ship_to_address,
                 target_open_date, stage, status
          from projects.projects where id = ${req.params.id}`;
        if (!p) throw notFound('Project');
        const [team, contacts] = await Promise.all([
          tx`select user_id, name, email, role from projects.project_team where project_id = ${req.params.id}
             order by is_lead desc, role, name`,
          tx`select name, email, phone, company, role, is_delivery_recipient from projects.project_contacts
             where project_id = ${req.params.id} order by is_delivery_recipient desc, role, name`,
        ]);
        return { ...p, team, contacts } as never;
      }),
  );

  app.get(
    '/internal/projects',
    {
      config: { internal: true },
      schema: {
        hide: true,
        tags: ['internal'],
        summary: 'Projects by id with team (internal)',
        querystring: z.object({ tenantId: z.uuid(), ids: z.string().optional() }),
        response: { 200: z.array(InternalProject) },
      },
    },
    async (req) => {
      const ids = (req.query.ids ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => z.uuid().safeParse(s).success)
        .slice(0, 500);
      if (!ids.length) return [];
      return withTenant(req.query.tenantId, async (tx) => {
        const rows = await tx<{ id: string }[]>`
          select id, number, name, property_name, brand_id, client_org_id, address, ship_to_address,
                 target_open_date, stage, status
          from projects.projects where id in ${tx(ids)} order by number`;
        const team = await tx<{ projectId: string }[]>`
          select project_id, user_id, name, email, role from projects.project_team
          where project_id in ${tx(ids)} order by is_lead desc, role, name`;
        return rows.map((r) => ({
          ...r,
          team: team.filter((m) => m.projectId === r.id).map(({ projectId, ...m }) => m),
        })) as never;
      });
    },
  );
}
