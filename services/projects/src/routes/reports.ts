import type { App } from '@procure/platform';
import { getOrg, renderScheduleReport } from '../clients.js';
import { getProjectRow } from '../engine.js';
import { DocumentOut, IdParams, ScheduleReportBody } from '../schemas.js';
import { requireStaff } from './helpers.js';

interface ProjectRow {
  id: string;
  number: string;
  name: string;
  propertyName: string | null;
  address: Record<string, string>;
  targetOpenDate: string | null;
  stage: string;
  keys: number | null;
  clientOrgId: string | null;
}

const fmtAddress = (a: Record<string, string> | null | undefined) =>
  a
    ? [a.line1, a.line2, [a.city, a.region].filter(Boolean).join(', '), a.postalCode]
        .filter(Boolean)
        .join(' · ')
    : '';

export async function reportRoutes(app: App) {
  app.post(
    '/projects/:id/reports/schedule',
    {
      schema: {
        tags: ['reports'],
        summary: 'Render the project schedule (milestones) as a PDF via the documents service',
        params: IdParams,
        body: ScheduleReportBody,
        response: { 201: DocumentOut },
      },
    },
    async (req, reply) => {
      requireStaff(req.principal, 'projects:read');
      const b = req.body;
      const { project, rows, lead } = await req.tx(async (tx) => {
        const project = await getProjectRow<ProjectRow>(tx, req.params.id);
        const parties = b.includeParties ?? null;
        const rows = await tx<
          {
            name: string;
            party: string;
            startDate: string | null;
            dueDate: string | null;
            status: string;
            completedAt: string | null;
          }[]
        >`
          select name, party, start_date, due_date, status, completed_at from projects.tasks
          where project_id = ${project.id} and status <> 'skipped'
            ${b.visibility === 'client' ? tx`and (is_milestone or party = 'client')` : tx``}
            ${b.allTasks ? tx`` : parties?.includes('client') ? tx`and (is_milestone or party = 'client')` : tx`and is_milestone`}
            ${parties ? tx`and party in ${tx(parties)}` : tx``}
          order by due_date nulls last, sort`;
        const [lead] = await tx<{ name: string }[]>`
          select name from projects.project_team where project_id = ${project.id} and role = 'project_manager'
          order by is_lead desc limit 1`;
        return { project, rows, lead };
      });
      const tenant = await getOrg(req.principal.tenantId, req.principal);
      const generatedAt = new Date().toISOString();
      const doc = await renderScheduleReport({
        tenantId: req.principal.tenantId,
        projectId: project.id,
        visibility: b.visibility,
        clientOrgId: project.clientOrgId,
        filename: `${project.number} Schedule ${generatedAt.slice(0, 10)}.pdf`,
        data: {
          tenant: {
            name: tenant?.name ?? req.principal.claims.orgName,
            address: tenant?.address ?? null,
            phone: tenant?.phone ?? null,
            email: tenant?.email ?? null,
          },
          project: {
            number: project.number,
            name: project.name,
            propertyName: project.propertyName,
            address: project.address,
          },
          generatedAt,
          notes: b.notes ?? '',
          headerFields: [
            { label: 'Project', value: `${project.number} — ${project.name}` },
            { label: 'Property', value: project.propertyName ?? '' },
            { label: 'Address', value: fmtAddress(project.address) },
            { label: 'Rooms', value: project.keys != null ? String(project.keys) : '' },
            { label: 'Target open', value: project.targetOpenDate ?? 'TBD' },
            { label: 'Project manager', value: lead?.name ?? '' },
          ].filter((f) => f.value),
          milestones: rows.map((r) => ({
            name: r.name,
            party: r.party,
            start: r.startDate,
            due: r.dueDate,
            status: r.status,
            completedAt: r.completedAt,
          })),
        },
      });
      return reply.status(201).send(doc);
    },
  );
}
