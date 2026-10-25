import { buildService, closeDb, consume, runJobOnce } from '@procure/platform';
import { auth, createWorld, type World } from '@procure/platform/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { addBusinessDays, addCalendarDays, today, weekBounds } from '../src/dates.js';
import { overdueDigest } from '../src/jobs.js';
import { schedule } from '../src/scheduling.js';
import { projectsService } from '../src/service.js';
import { subscriptions } from '../src/subscriptions.js';
import { createProject, get, isWeekend, outbox, patch, post, put } from './helpers.js';

vi.mock('../src/clients.js', () => ({
  getOrg: vi.fn(async () => ({
    id: 't',
    name: 'JM Hospitality Solutions',
    address: {},
    phone: null,
    email: null,
  })),
  renderScheduleReport: vi.fn(async (args: { filename: string }) => ({
    id: '00000000-0000-4000-8000-000000000001',
    filename: args.filename,
    contentType: 'application/pdf',
    downloadUrl: '/api/documents/documents/00000000-0000-4000-8000-000000000001/download',
  })),
}));
const clients = await import('../src/clients.js');

let app: Awaited<ReturnType<typeof buildService>>;
let a: World;
let b: World;
const log = () => app.log;

beforeAll(async () => {
  app = await buildService(projectsService);
  a = await createWorld('Alpha');
  b = await createWorld('Bravo');
});
afterAll(async () => {
  await app.close();
  await closeDb();
});

/** A small linear template: a(2d) → b(3d, +1 lag) → c(milestone 0d); d(1d) independent. */
const smallTemplate = {
  name: 'Small',
  tasks: [
    { key: 'a', name: 'Design', durationDays: 2, assigneeRole: 'designer' },
    {
      key: 'b',
      name: 'Quote',
      durationDays: 3,
      dependsOn: ['a'],
      offsetDays: 1,
      assigneeRole: 'procurement',
    },
    {
      key: 'c',
      name: 'Client approval',
      durationDays: 0,
      dependsOn: ['b'],
      isMilestone: true,
      party: 'client',
      kind: 'approval',
      autoCompleteOn: 'quoting.quote.client_decided',
    },
    { key: 'd', name: 'Kickoff call', durationDays: 1 },
  ],
};

describe('projects CRUD', () => {
  it('creates projects with sequential per-tenant numbers and ship-to defaulting to address', async () => {
    const p1 = await createProject(app, a);
    const p2 = await createProject(app, a, { name: 'Tru by Hilton Cary' });
    const yy = new Date().getFullYear().toString().slice(2);
    expect(p1.number).toMatch(new RegExp(`^P-${yy}-\\d{3}$`));
    expect(Number(p2.number.slice(-3))).toBe(Number(p1.number.slice(-3)) + 1);
    expect(p1.shipToAddress).toEqual(p1.address);
    expect(p1.taskCounts.total).toBe(0);
    const created = await outbox(a.tenantId, 'projects.project.created');
    expect(created.map((e) => e.data.projectId)).toContain(p1.id);

    const pb = await createProject(app, b);
    expect(pb.number.slice(-3)).toBe('001');
  });

  it('patches, emits changed fields only, lists and soft-deletes', async () => {
    const p = await createProject(app, a, { name: 'Hampton Inn Apex' });
    const res = await patch(app, `/projects/${p.id}`, a.adminToken, { stage: 'quoting', keys: 118 }, 200);
    expect(res.json().stage).toBe('quoting');
    const [ev] = await outbox(a.tenantId, 'projects.project.updated');
    expect(ev!.data).toMatchObject({
      projectId: p.id,
      changes: { stage: { from: 'design', to: 'quoting' } },
    });
    expect(ev!.data.changes.keys).toBeUndefined();

    const list = (await get(app, '/projects?q=apex&stage=quoting', a.adminToken, 200)).json();
    expect(list.items.map((x: any) => x.id)).toEqual([p.id]);
    expect(list.total).toBe(1);
    expect(list.items[0]).toMatchObject({ openTasks: 0, overdueTasks: 0, nextMilestone: null });

    await app.inject({ method: 'DELETE', url: `/projects/${p.id}`, headers: auth(a.adminToken) });
    expect((await get(app, `/projects/${p.id}`, a.adminToken, 200)).json().status).toBe('cancelled');

    const activity = (await get(app, `/projects/${p.id}/activity`, a.adminToken, 200)).json();
    expect(activity.some((e: any) => e.changes.stage?.to === 'quoting')).toBe(true);
  });

  it('manages contacts and team', async () => {
    const p = await createProject(app, a);
    const c = await post(
      app,
      `/projects/${p.id}/contacts`,
      a.adminToken,
      {
        name: 'Pat GM',
        role: 'gm',
        email: 'gm@hotel.example',
        isDeliveryRecipient: true,
        visibleToClient: true,
      },
      201,
    );
    await patch(
      app,
      `/projects/${p.id}/contacts/${c.json().id}`,
      a.adminToken,
      { phone: '919-555-0100' },
      200,
    );
    const team = await put(
      app,
      `/projects/${p.id}/team`,
      a.adminToken,
      { team: [{ userId: a.adminId, name: 'Alpha Admin', role: 'project_manager', isLead: true }] },
      200,
    );
    expect(team.json()).toHaveLength(1);
    const detail = (await get(app, `/projects/${p.id}`, a.adminToken, 200)).json();
    expect(detail.contacts[0]).toMatchObject({ phone: '919-555-0100', isDeliveryRecipient: true });
    expect(detail.team[0]).toMatchObject({ role: 'project_manager', isLead: true });
  });

  it('requires projects:write and blocks portal actors from workspace routes', async () => {
    const viewer = await a.tokenAs(['viewer']);
    await post(app, '/projects', viewer, { name: 'x' }, 403);
    await get(app, '/projects', a.clientToken, 403);
    await get(app, '/projects', a.vendorToken, 403);
  });
});

describe('templates & scheduling', () => {
  it('schedules forward in business days respecting dependencies and lags', () => {
    const fri = '2026-10-30'; // Friday
    const { dates } = schedule(
      smallTemplate.tasks.map((t) => ({
        key: t.key,
        durationDays: t.durationDays,
        offsetDays: t.offsetDays ?? 0,
        dependsOn: t.dependsOn ?? [],
      })),
      fri,
    );
    expect(dates.get('a')).toEqual({ start: '2026-10-30', due: '2026-11-02' }); // Fri → Mon
    // b: next business day after Mon (Tue 3rd) + 1 lag = Wed 4th, 3 days → Fri 6th
    expect(dates.get('b')).toEqual({ start: '2026-11-04', due: '2026-11-06' });
    // c: 0-day milestone the next business day after Fri → Mon 9th
    expect(dates.get('c')).toEqual({ start: '2026-11-09', due: '2026-11-09' });
    expect(dates.get('d')).toEqual({ start: '2026-10-30', due: '2026-10-30' });
  });

  it('applies a template: weekend-free dates, deps, assignees by role, readiness', async () => {
    const tpl = (await post(app, '/task-templates', a.adminToken, smallTemplate, 201)).json();
    expect(tpl.taskCount).toBe(4);
    const p = await createProject(app, a, {
      team: [
        { userId: a.adminId, name: 'Alpha Admin', role: 'designer' },
        { userId: crypto.randomUUID(), name: 'Pia Procurement', role: 'procurement' },
      ],
    });
    const res = await post(
      app,
      `/projects/${p.id}/apply-template`,
      a.adminToken,
      { templateId: tpl.id, anchorDate: '2026-10-31' }, // Saturday → rolls to Monday
      200,
    );
    const r = res.json();
    expect(r.created).toBe(4);
    const byKey = Object.fromEntries(r.tasks.map((t: any) => [t.key, t]));
    expect(byKey.a.startDate).toBe('2026-11-02');
    for (const t of r.tasks) {
      expect(isWeekend(t.startDate)).toBe(false);
      expect(isWeekend(t.dueDate)).toBe(false);
    }
    expect(byKey.b.dependsOn).toEqual([byKey.a.id]);
    expect(byKey.b.startDate > byKey.a.dueDate).toBe(true);
    expect(byKey.c.startDate > byKey.b.dueDate).toBe(true);
    expect(byKey.a).toMatchObject({ assigneeUserId: a.adminId, ready: true });
    expect(byKey.b).toMatchObject({ assigneeName: 'Pia Procurement', ready: false });
    expect(byKey.c.assigneeUserId).toBeNull();

    // replace mode removes the previous tasks
    const again = (
      await post(
        app,
        `/projects/${p.id}/apply-template`,
        a.adminToken,
        { templateId: tpl.id, anchorDate: '2026-11-02', mode: 'replace' },
        200,
      )
    ).json();
    expect(again.removed).toBe(4);
    expect((await get(app, `/projects/${p.id}`, a.adminToken, 200)).json().taskCounts.total).toBe(4);
  });

  it('rejects cyclic and dangling dependencies with 422', async () => {
    const cyc = await post(app, '/task-templates', a.adminToken, {
      name: 'Cyclic',
      tasks: [
        { key: 'x', name: 'X', dependsOn: ['z'] },
        { key: 'y', name: 'Y', dependsOn: ['x'] },
        { key: 'z', name: 'Z', dependsOn: ['y'] },
      ],
    });
    expect(cyc.statusCode).toBe(422);
    expect(cyc.json().title).toMatch(/cycle/);
    const dangling = await post(app, '/task-templates', a.adminToken, {
      name: 'Dangling',
      tasks: [{ key: 'x', name: 'X', dependsOn: ['nope'] }],
    });
    expect(dangling.statusCode).toBe(422);

    // cycle introduced on project tasks via PATCH
    const tpl = (
      await post(app, '/task-templates', a.adminToken, { ...smallTemplate, name: 'S2' }, 201)
    ).json();
    const p = await createProject(app, a, { templateId: tpl.id, anchorDate: '2026-11-02' });
    const tasks = (await get(app, `/projects/${p.id}/tasks`, a.adminToken, 200)).json();
    const ta = tasks.find((t: any) => t.key === 'a');
    const tc = tasks.find((t: any) => t.key === 'c');
    await patch(app, `/tasks/${ta.id}`, a.adminToken, { dependsOn: [tc.id] }, 422);
  });

  it('creates the default hospitality template once and it schedules cleanly', async () => {
    const first = await post(app, '/task-templates/default', a.adminToken, undefined, 201);
    const t = first.json();
    expect(t.tasks.length).toBeGreaterThanOrEqual(40);
    expect(t.isDefault).toBe(true);
    const approval = t.tasks.find((x: any) => x.key === 'client-quote-approval');
    expect(approval).toMatchObject({ party: 'client', autoCompleteOn: 'quoting.quote.client_decided' });
    expect(t.tasks.find((x: any) => x.key === 'po-issuance').autoCompleteOn).toBe('orders.po.issued');
    await post(app, '/task-templates/default', a.adminToken, undefined, 200);

    const p = await createProject(app, a, { templateId: t.id, anchorDate: '2026-11-02' });
    const g = (await get(app, `/projects/${p.id}/gantt`, a.adminToken, 200)).json();
    expect(g.tasks).toHaveLength(t.tasks.length);
    expect(g.tasks.every((x: any) => !isWeekend(x.start) && !isWeekend(x.due))).toBe(true);
    const crit = g.tasks.filter((x: any) => x.critical).map((x: any) => x.key);
    expect(crit).toContain('closeout');
    expect(crit).toContain('production');
    expect(crit).toContain('kickoff');
    expect(g.end).toBe(g.tasks.find((x: any) => x.key === 'closeout').due);
  });
});

describe('task completion and rescheduling', () => {
  it('completing a task readies dependents, shifts their start and emits events', async () => {
    const tpl = (
      await post(app, '/task-templates', a.adminToken, { ...smallTemplate, name: 'S3' }, 201)
    ).json();
    const pia = crypto.randomUUID();
    // anchor in the past so the dependent's planned start is before today
    const anchor = addBusinessDays(today(), -20);
    const p = await createProject(app, a, {
      templateId: tpl.id,
      anchorDate: anchor,
      team: [
        { userId: a.adminId, name: 'Alpha Admin', role: 'designer' },
        { userId: pia, name: 'Pia Procurement', role: 'procurement' },
      ],
    });
    const tasks = (await get(app, `/projects/${p.id}/tasks`, a.adminToken, 200)).json();
    const ta = tasks.find((t: any) => t.key === 'a');
    const tb = tasks.find((t: any) => t.key === 'b');
    expect(tb.ready).toBe(false);

    const done = (await post(app, `/tasks/${ta.id}/complete`, a.adminToken, {}, 200)).json();
    expect(done).toMatchObject({ status: 'done', completedByName: 'Test User' });
    const after = (await get(app, `/tasks/${tb.id}`, a.adminToken, 200)).json();
    expect(after.ready).toBe(true);
    expect(after.startDate).toBe(today());
    expect(after.dueDate >= after.startDate).toBe(true);

    const completed = await outbox(a.tenantId, 'projects.task.completed');
    expect(completed[0]!.data).toMatchObject({ taskId: ta.id, projectId: p.id, isMilestone: false });
    const assigned = await outbox(a.tenantId, 'projects.task.assigned');
    expect(assigned[0]!.data).toMatchObject({ taskId: tb.id, assigneeUserId: pia });

    // idempotent
    await post(app, `/tasks/${ta.id}/complete`, a.adminToken, {}, 200);
    expect((await outbox(a.tenantId, 'projects.task.completed')).length).toBe(completed.length);

    // reopen → dependent no longer ready
    await post(app, `/tasks/${ta.id}/reopen`, a.adminToken, {}, 200);
    expect((await get(app, `/tasks/${tb.id}`, a.adminToken, 200)).json().ready).toBe(false);
  });

  it('reschedule shifts downstream open tasks by the same business-day delta', async () => {
    const tpl = (
      await post(app, '/task-templates', a.adminToken, { ...smallTemplate, name: 'S4' }, 201)
    ).json();
    const p = await createProject(app, a, { templateId: tpl.id, anchorDate: '2026-11-02' });
    const tasks = (await get(app, `/projects/${p.id}/tasks`, a.adminToken, 200)).json();
    const k = (key: string) => tasks.find((t: any) => t.key === key);
    const newDue = addBusinessDays(k('a').dueDate, 3);
    await patch(app, `/tasks/${k('a').id}`, a.adminToken, { dueDate: newDue }, 200);

    const preview = (
      await post(
        app,
        `/projects/${p.id}/reschedule?dryRun=true`,
        a.adminToken,
        { fromTaskId: k('a').id },
        200,
      )
    ).json();
    expect(preview).toMatchObject({ dryRun: true, deltaDays: 3 });
    expect(preview.changes.map((c: any) => c.taskId).sort()).toEqual([k('b').id, k('c').id].sort());
    // dry run leaves data unchanged
    expect((await get(app, `/tasks/${k('b').id}`, a.adminToken, 200)).json().startDate).toBe(
      k('b').startDate,
    );

    await post(app, `/projects/${p.id}/reschedule`, a.adminToken, { fromTaskId: k('a').id }, 200);
    const b2 = (await get(app, `/tasks/${k('b').id}`, a.adminToken, 200)).json();
    const c2 = (await get(app, `/tasks/${k('c').id}`, a.adminToken, 200)).json();
    expect(b2.startDate).toBe(addBusinessDays(k('b').startDate, 3));
    expect(b2.dueDate).toBe(addBusinessDays(k('b').dueDate, 3));
    expect(c2.dueDate).toBe(addBusinessDays(k('c').dueDate, 3));
    expect((await get(app, `/tasks/${k('d').id}`, a.adminToken, 200)).json().startDate).toBe(
      k('d').startDate,
    );
  });
});

describe('cross-portfolio task view', () => {
  it('filters overdue, this_week and assignee=me across projects', async () => {
    const other = crypto.randomUUID();
    const p1 = await createProject(app, a, { name: 'Portfolio One' });
    const p2 = await createProject(app, a, { name: 'Portfolio Two' });
    const now = today();
    const wk = weekBounds(now);
    const mk = (projectId: string, name: string, dueDate: string | null, assigneeUserId: string | null) =>
      post(app, '/tasks', a.adminToken, { projectId, name, dueDate, assigneeUserId }, 201);
    const overdue = (await mk(p1.id, 'Overdue mine', addCalendarDays(now, -10), a.adminId)).json();
    const week = (await mk(p2.id, 'This week mine', wk.end, a.adminId)).json();
    const others = (await mk(p2.id, 'Overdue other', addCalendarDays(now, -3), other)).json();
    const nodate = (await mk(p1.id, 'Someday', null, null)).json();

    const ids = async (qs: string) =>
      (await get(app, `/tasks?${qs}&limit=500`, a.adminToken, 200)).json().items.map((t: any) => t.id);

    const od = await ids('due=overdue');
    expect(od).toEqual(expect.arrayContaining([overdue.id, others.id]));
    expect(od).not.toContain(week.id);
    const mine = await ids('assignee=me');
    expect(mine).toEqual(expect.arrayContaining([overdue.id, week.id]));
    expect(mine).not.toContain(others.id);
    expect(await ids('due=this_week')).toContain(week.id);
    expect(await ids('assignee=unassigned&due=no_date')).toContain(nodate.id);
    expect(await ids(`projectId=${p1.id}`)).toEqual([overdue.id, nodate.id]); // sorted by due, nulls last

    const res = (await get(app, '/tasks?assignee=me&due=overdue&limit=500', a.adminToken, 200)).json();
    expect(res.items.find((t: any) => t.id === overdue.id)).toMatchObject({
      projectNumber: p1.number,
      projectName: 'Portfolio One',
      overdue: true,
    });

    // done tasks leave the default action list
    await post(app, `/tasks/${overdue.id}/complete`, a.adminToken, {}, 200);
    expect(await ids('due=overdue')).not.toContain(overdue.id);

    const dash = (await get(app, '/dashboard', a.adminToken, 200)).json();
    expect(dash.activeProjects).toBeGreaterThanOrEqual(2);
    expect(dash.overdueTasks).toBeGreaterThanOrEqual(1);
    expect(dash.myTasks.map((t: any) => t.id)).toContain(week.id);
    expect(dash.byStage.find((s: any) => s.stage === 'design').count).toBeGreaterThanOrEqual(2);
  });

  it('overdue digest emits one cmd.notify per assignee', async () => {
    await runJobOnce('projects', overdueDigest, log());
    const notes = await outbox(a.tenantId, 'cmd.notify');
    const mine = notes.filter((n) => n.data.userIds.includes(a.adminId) && /overdue/.test(n.data.title));
    expect(mine.length).toBeGreaterThanOrEqual(1);
  });
});

describe('tenant isolation', () => {
  it("cannot see or modify another tenant's projects, tasks or templates", async () => {
    const p = await createProject(app, b, { name: 'Bravo secret' });
    const t = (await post(app, '/tasks', b.adminToken, { projectId: p.id, name: 'Bravo task' }, 201)).json();
    await get(app, `/projects/${p.id}`, a.adminToken, 404);
    await get(app, `/tasks/${t.id}`, a.adminToken, 404);
    await patch(app, `/projects/${p.id}`, a.adminToken, { name: 'pwned' }, 404);
    await post(app, `/tasks/${t.id}/complete`, a.adminToken, {}, 404);
    const list = (await get(app, '/projects?limit=500', a.adminToken, 200)).json();
    expect(list.items.map((x: any) => x.id)).not.toContain(p.id);
    const tasks = (await get(app, '/tasks?limit=500', a.adminToken, 200)).json();
    expect(tasks.items.map((x: any) => x.id)).not.toContain(t.id);
    await post(app, '/tasks', a.adminToken, { projectId: p.id, name: 'inject' }, 404);
  });
});

describe('client portal', () => {
  it('shows only own projects with client-safe fields', async () => {
    const tpl = (
      await post(app, '/task-templates', a.adminToken, { ...smallTemplate, name: 'S5' }, 201)
    ).json();
    const mine = await createProject(app, a, {
      name: 'Owner project',
      templateId: tpl.id,
      anchorDate: '2026-11-02',
    });
    const theirs = await createProject(app, a, { name: 'Other owner', clientOrgId: crypto.randomUUID() });
    await post(
      app,
      `/projects/${mine.id}/notes`,
      a.adminToken,
      { body: 'Margin is thin here', visibility: 'internal' },
      201,
    );
    await post(
      app,
      `/projects/${mine.id}/notes`,
      a.adminToken,
      { body: 'Deliveries start Monday', visibility: 'client' },
      201,
    );
    await post(app, `/projects/${mine.id}/contacts`, a.adminToken, { name: 'Hidden GC', role: 'gc' }, 201);
    await post(
      app,
      `/projects/${mine.id}/contacts`,
      a.adminToken,
      { name: 'Site Sam', role: 'site_manager', visibleToClient: true },
      201,
    );

    const list = (await get(app, '/client/projects', a.clientToken, 200)).json();
    const ids = list.items.map((x: any) => x.id);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(theirs.id);
    await get(app, `/client/projects/${theirs.id}`, a.clientToken, 404);

    const res = await get(app, `/client/projects/${mine.id}`, a.clientToken, 200);
    const d = res.json();
    expect(res.body).not.toMatch(/budget|creditTerms|Margin is thin|Hidden GC|workHours|assignee/);
    expect(d.budget).toBeUndefined();
    expect(d.notes.map((n: any) => n.body)).toEqual(['Deliveries start Monday']);
    expect(d.contacts.map((c: any) => c.name)).toEqual(['Site Sam']);
    expect(d.tasks.every((t: any) => t.party === 'client')).toBe(true);
    expect(d.milestones.map((m: any) => m.name)).toEqual(['Client approval']);
    expect(d.tasks.map((t: any) => t.name)).not.toContain('Design');

    // other tenant's client sees nothing
    await get(app, `/client/projects/${mine.id}`, b.clientToken, 404);
    // clients cannot use the internal list even with RLS
    await get(app, `/projects/${mine.id}`, a.clientToken, 403);
  });

  it('client completes client tasks but not internal ones', async () => {
    const tpl = (
      await post(app, '/task-templates', a.adminToken, { ...smallTemplate, name: 'S6' }, 201)
    ).json();
    const p = await createProject(app, a, {
      templateId: tpl.id,
      anchorDate: '2026-11-02',
      team: [{ userId: a.adminId, name: 'Alpha Admin', role: 'project_manager' }],
    });
    const tasks = (await get(app, `/projects/${p.id}/tasks`, a.adminToken, 200)).json();
    const internal = tasks.find((t: any) => t.key === 'a');
    const client = tasks.find((t: any) => t.key === 'c');
    // internal task invisible to client → 404 (no existence leak)
    await post(app, `/client/tasks/${internal.id}/complete`, a.clientToken, {}, 404);
    const res = (await post(app, `/client/tasks/${client.id}/complete`, a.clientToken, {}, 200)).json();
    expect(res).toMatchObject({ status: 'done', canComplete: false });
    expect(res.completedByName).toMatch(/Alpha Owner|Test User/);
    const n = (await outbox(a.tenantId, 'cmd.notify'))[0]!;
    expect(n.data.userIds).toEqual([a.adminId]);

    // a client-party task on another owner's project is not reachable
    const other = await createProject(app, a, {
      clientOrgId: crypto.randomUUID(),
      templateId: tpl.id,
      anchorDate: '2026-11-02',
    });
    const otherTasks = (await get(app, `/projects/${other.id}/tasks`, a.adminToken, 200)).json();
    await post(
      app,
      `/client/tasks/${otherTasks.find((t: any) => t.key === 'c').id}/complete`,
      a.clientToken,
      {},
      404,
    );

    // vendor actors are rejected
    await post(app, `/client/tasks/${client.id}/complete`, a.vendorToken, {}, 403);
  });
});

describe('subscriptions', () => {
  it('auto-completes matching tasks and readies dependents; idempotent', async () => {
    const tpl = (
      await post(
        app,
        '/task-templates',
        a.adminToken,
        {
          name: 'Auto',
          tasks: [
            {
              key: 'approve',
              name: 'Client approval',
              party: 'client',
              autoCompleteOn: 'quoting.quote.client_decided',
            },
            { key: 'po', name: 'Issue POs', dependsOn: ['approve'], autoCompleteOn: 'orders.po.issued' },
            { key: 'acks', name: 'Acknowledgements', dependsOn: ['po'] },
          ],
        },
        201,
      )
    ).json();
    const p = await createProject(app, a, { templateId: tpl.id, anchorDate: '2026-11-02' });
    const tasks = (await get(app, `/projects/${p.id}/tasks`, a.adminToken, 200)).json();
    const k = (key: string) => tasks.find((t: any) => t.key === key);
    const envelope = (type: string, data: Record<string, unknown>) => ({
      id: crypto.randomUUID(),
      type,
      version: 1,
      occurredAt: new Date().toISOString(),
      source: 'quoting',
      tenantId: a.tenantId,
      actor: null,
      data,
    });

    // rejected decisions do nothing
    await consume(
      'projects',
      envelope('quoting.quote.client_decided', {
        quoteId: crypto.randomUUID(),
        projectId: p.id,
        decision: 'rejected',
        decidedBy: 'GM',
        comment: null,
      }),
      subscriptions,
      log(),
    );
    expect((await get(app, `/tasks/${k('approve').id}`, a.adminToken, 200)).json().status).toBe('todo');

    const ev = envelope('quoting.quote.client_decided', {
      quoteId: crypto.randomUUID(),
      projectId: p.id,
      decision: 'approved',
      decidedBy: 'GM',
      comment: null,
    });
    expect(await consume('projects', ev, subscriptions, log())).toBe('processed');
    expect(await consume('projects', ev, subscriptions, log())).toBe('duplicate');
    const appr = (await get(app, `/tasks/${k('approve').id}`, a.adminToken, 200)).json();
    expect(appr).toMatchObject({ status: 'done', completedByName: 'Pro-Cure' });
    expect((await get(app, `/tasks/${k('po').id}`, a.adminToken, 200)).json().ready).toBe(true);

    // other tenant's event with same project id must not touch tenant A data
    await consume(
      'projects',
      {
        ...envelope('orders.po.issued', {
          poId: crypto.randomUUID(),
          projectId: p.id,
          vendorId: crypto.randomUUID(),
          number: 'PO-1',
          revision: 0,
          total: 1,
        }),
        tenantId: b.tenantId,
      },
      subscriptions,
      log(),
    );
    expect((await get(app, `/tasks/${k('po').id}`, a.adminToken, 200)).json().status).toBe('todo');

    await consume(
      'projects',
      envelope('orders.po.issued', {
        poId: crypto.randomUUID(),
        projectId: p.id,
        vendorId: crypto.randomUUID(),
        number: 'PO-26-0001',
        revision: 0,
        total: 1000,
      }),
      subscriptions,
      log(),
    );
    expect((await get(app, `/tasks/${k('po').id}`, a.adminToken, 200)).json().status).toBe('done');
    expect((await get(app, `/tasks/${k('acks').id}`, a.adminToken, 200)).json().ready).toBe(true);
    const completed = (await outbox(a.tenantId, 'projects.task.completed')).filter(
      (e) => e.data.projectId === p.id,
    );
    expect(completed).toHaveLength(2);
    expect(completed[0]!.actor).toMatchObject({ name: 'Pro-Cure' });
  });
});

describe('reports and internal', () => {
  it('renders a schedule report through documents', async () => {
    const tpl = (
      await post(app, '/task-templates', a.adminToken, { ...smallTemplate, name: 'S7' }, 201)
    ).json();
    const p = await createProject(app, a, { templateId: tpl.id, anchorDate: '2026-11-02' });
    const res = await post(app, `/projects/${p.id}/reports/schedule`, a.adminToken, { notes: 'Draft' }, 201);
    expect(res.json().contentType).toBe('application/pdf');
    const call = vi.mocked(clients.renderScheduleReport).mock.calls.at(-1)![0];
    expect(call.data.milestones.map((m) => m.name)).toEqual(['Client approval']);
    expect(call.data.headerFields.find((f) => f.label === 'Rooms')?.value).toBe('118');
    expect(call.visibility).toBe('internal');
  });

  it('serves the internal contract', async () => {
    const p = await createProject(app, a, {
      team: [{ userId: a.adminId, name: 'Alpha Admin', role: 'project_manager' }],
    });
    await post(
      app,
      `/projects/${p.id}/contacts`,
      a.adminToken,
      { name: 'Dock', role: 'warehouse', isDeliveryRecipient: true },
      201,
    );
    const headers = { 'x-procure-internal': 'local-internal-secret' };
    const one = await app.inject({
      method: 'GET',
      url: `/internal/projects/${p.id}?tenantId=${a.tenantId}`,
      headers,
    });
    expect(one.statusCode).toBe(200);
    expect(one.json()).toMatchObject({
      id: p.id,
      team: [{ role: 'project_manager' }],
      contacts: [{ isDeliveryRecipient: true }],
    });
    expect(one.json().budget).toBeUndefined();
    const wrong = await app.inject({
      method: 'GET',
      url: `/internal/projects/${p.id}?tenantId=${b.tenantId}`,
      headers,
    });
    expect(wrong.statusCode).toBe(404);
    const many = await app.inject({
      method: 'GET',
      url: `/internal/projects?tenantId=${a.tenantId}&ids=${p.id}`,
      headers,
    });
    expect(many.json()[0].contacts).toBeUndefined();
    const noSecret = await app.inject({
      method: 'GET',
      url: `/internal/projects/${p.id}?tenantId=${a.tenantId}`,
    });
    expect(noSecret.statusCode).toBe(403);
  });
});
