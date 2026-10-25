import type { App, ServiceDefinition } from '@procure/platform';
import { jobs } from './jobs.js';
import { clientRoutes } from './routes/client.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { internalRoutes } from './routes/internal.js';
import { noteRoutes } from './routes/notes.js';
import { projectRoutes } from './routes/projects.js';
import { reportRoutes } from './routes/reports.js';
import { taskRoutes } from './routes/tasks.js';
import { templateRoutes } from './routes/templates.js';
import { subscriptions } from './subscriptions.js';

async function routes(app: App) {
  await projectRoutes(app);
  await taskRoutes(app);
  await templateRoutes(app);
  await noteRoutes(app);
  await reportRoutes(app);
  await dashboardRoutes(app);
  await clientRoutes(app);
  await internalRoutes(app);
}

export const projectsService: ServiceDefinition = {
  name: 'projects',
  title: 'Projects',
  description:
    'Projects, teams and contacts, task templates, schedules (tasks, milestones, Gantt, critical path), ' +
    'notes, schedule reports, the portfolio dashboard and the owner-portal project view.',
  routes,
  subscriptions,
  jobs,
};
