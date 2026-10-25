import type { Ctx } from './business.js';
import { CLIENTS, STAFF } from './people.js';

const team = (ctx: Ctx, list: [key: (typeof STAFF)[number]['key'], role: string, lead?: boolean][]) =>
  list.map(([key, role, isLead]) => {
    const s = STAFF.find((x) => x.key === key)!;
    return { userId: ctx.ids.users[key]!, name: s.name, email: s.email, role, isLead: !!isLead };
  });

/**
 * The demo portfolio. Schedules are anchored relative to today; tasks whose due date is comfortably
 * in the past are completed (in dependency order) so each project sits at a believable point.
 */
export async function seedProjects(ctx: Ctx) {
  const { call, day, staff } = ctx;
  const dana = staff.dana;
  const template = await call(dana, 'projects', 'POST', '/task-templates/default', {});
  const blueRidge = ctx.ids.clientOrgs.blueridge!;
  const coastal = ctx.ids.clientOrgs.coastal!;
  const brands = ctx.out.brands ?? {};

  const defs = [
    {
      key: 'home2',
      name: 'Home2 Suites Raleigh-Durham Airport',
      propertyName: 'Home2 Suites by Hilton RDU Airport',
      brand: 'Home2 Suites by Hilton',
      clientOrgId: blueRidge,
      type: 'new_construction',
      stage: 'procurement',
      keys: 120,
      floors: 5,
      address: {
        line1: '2001 Airgate Dr',
        city: 'Morrisville',
        region: 'NC',
        postalCode: '27560',
        country: 'US',
      },
      targetOpenDate: day(170),
      startDate: day(-120),
      budget: 1_840_000,
      anchor: day(-118),
      completeBefore: day(-6),
      team: team(ctx, [
        ['dana', 'project_manager', true],
        ['priya', 'designer'],
        ['marcus', 'procurement'],
        ['tomas', 'logistics'],
        ['ray', 'sales'],
        ['ellen', 'accounting'],
      ]),
      contacts: [
        {
          name: 'Hannah Moore',
          company: CLIENTS[0].name,
          role: 'owner_rep',
          email: 'hannah@blueridgehg.example',
          phone: '(919) 555-0177',
          visibleToClient: true,
        },
        {
          name: 'Luis Ferreira',
          company: CLIENTS[0].name,
          role: 'gm',
          email: 'luis@blueridgehg.example',
          phone: '(919) 555-0191',
          isDeliveryRecipient: true,
          visibleToClient: true,
        },
        {
          name: 'Brent Kowalski',
          company: 'Summit Builders',
          role: 'gc',
          email: 'brent@summitbuilders.example',
          phone: '(919) 555-0150',
          isDeliveryRecipient: true,
        },
        {
          name: 'Rosa Dimas',
          company: 'Precision Install Group',
          role: 'installer',
          email: 'rosa@precisioninstall.example',
          phone: '(984) 555-0118',
        },
      ],
    },
    {
      key: 'hampton',
      name: 'Hampton Inn Wilmington Riverfront Renovation',
      propertyName: 'Hampton Inn & Suites Wilmington Riverfront',
      brand: 'Hampton by Hilton',
      clientOrgId: coastal,
      type: 'renovation',
      stage: 'logistics',
      keys: 98,
      floors: 4,
      address: {
        line1: '30 N Water St',
        city: 'Wilmington',
        region: 'NC',
        postalCode: '28401',
        country: 'US',
      },
      targetOpenDate: day(62),
      startDate: day(-190),
      budget: 1_120_000,
      anchor: day(-188),
      completeBefore: day(-2),
      team: team(ctx, [
        ['dana', 'project_manager', true],
        ['priya', 'designer'],
        ['marcus', 'procurement'],
        ['tomas', 'logistics', true],
        ['ellen', 'accounting'],
      ]),
      contacts: [
        {
          name: 'Beth Ainsley',
          company: CLIENTS[1].name,
          role: 'owner_rep',
          email: 'beth@coastallodging.example',
          phone: '(910) 555-0102',
          visibleToClient: true,
        },
        {
          name: 'Carl Mendes',
          company: 'Riverfront Hospitality Mgmt',
          role: 'gm',
          email: 'carl@riverfronthm.example',
          phone: '(910) 555-0166',
          isDeliveryRecipient: true,
          visibleToClient: true,
        },
        {
          name: 'Port City Warehousing',
          company: 'Port City Warehousing',
          role: 'warehouse',
          email: 'receiving@portcitywh.example',
          phone: '(910) 555-0190',
          isDeliveryRecipient: true,
        },
      ],
    },
    {
      key: 'tru',
      name: 'Tru by Hilton Cary',
      propertyName: 'Tru by Hilton Cary',
      brand: 'Tru by Hilton',
      clientOrgId: blueRidge,
      type: 'new_construction',
      stage: 'quoting',
      keys: 92,
      floors: 4,
      address: {
        line1: '1500 Kildaire Farm Rd',
        city: 'Cary',
        region: 'NC',
        postalCode: '27511',
        country: 'US',
      },
      targetOpenDate: day(290),
      startDate: day(-35),
      budget: 1_260_000,
      anchor: day(-34),
      completeBefore: day(-4),
      team: team(ctx, [
        ['dana', 'project_manager', true],
        ['priya', 'designer', true],
        ['marcus', 'procurement'],
        ['ray', 'sales'],
      ]),
      contacts: [
        {
          name: 'Hannah Moore',
          company: CLIENTS[0].name,
          role: 'owner_rep',
          email: 'hannah@blueridgehg.example',
          phone: '(919) 555-0177',
          visibleToClient: true,
        },
      ],
    },
    {
      key: 'greensboro',
      name: 'Home2 Suites Greensboro Coliseum',
      propertyName: 'Home2 Suites Greensboro Coliseum',
      brand: 'Home2 Suites by Hilton',
      clientOrgId: blueRidge,
      type: 'new_construction',
      stage: 'complete',
      status: 'closed',
      keys: 104,
      floors: 4,
      address: {
        line1: '1800 W Lee St',
        city: 'Greensboro',
        region: 'NC',
        postalCode: '27403',
        country: 'US',
      },
      targetOpenDate: day(-150),
      startDate: day(-420),
      budget: 1_520_000,
      team: team(ctx, [
        ['dana', 'project_manager', true],
        ['marcus', 'procurement'],
      ]),
      contacts: [],
    },
    {
      key: 'durham',
      name: 'Courtyard Durham Downtown Refresh',
      propertyName: 'Courtyard by Marriott Durham Downtown',
      brand: 'Courtyard by Marriott',
      clientOrgId: null,
      type: 'refresh',
      stage: 'proposal',
      keys: 140,
      floors: 7,
      address: { line1: '201 W Morgan St', city: 'Durham', region: 'NC', postalCode: '27701', country: 'US' },
      targetOpenDate: day(360),
      budget: 980_000,
      team: team(ctx, [['ray', 'sales', true]]),
      contacts: [],
    },
  ];

  ctx.out.projects = {};
  for (const d of defs) {
    const { key, brand, contacts, anchor, completeBefore, ...body } = d as any;
    const p = await call(dana, 'projects', 'POST', '/projects', {
      ...body,
      brandId: brands[brand] ?? null,
      tags: [brand],
      ...(anchor ? { templateId: template.id, anchorDate: anchor } : {}),
    });
    ctx.out.projects[key] = p;
    for (const c of contacts) await call(dana, 'projects', 'POST', `/projects/${p.id}/contacts`, c);

    if (completeBefore) {
      // Complete everything due before the cut-off, earliest first (dependencies finish first).
      const tasks = await call<any>(dana, 'projects', 'GET', `/projects/${p.id}/tasks`);
      const list = (Array.isArray(tasks) ? tasks : tasks.items) as any[];
      const due = list
        .filter((t) => t.dueDate && t.dueDate < completeBefore)
        .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
      for (const t of due) {
        try {
          await call(dana, 'projects', 'POST', `/tasks/${t.id}/complete`, {});
        } catch {
          /* blocked by an unfinished dependency — leave it open, it reads as overdue */
        }
      }
    }
  }

  // A few notes so project pages aren't empty.
  const home2 = ctx.out.projects.home2;
  await call(dana, 'projects', 'POST', `/projects/${home2.id}/notes`, {
    body: 'Owner confirmed the lobby will use the Home2 "Spin" package; breakfast area casegoods to match lobby walnut.',
    visibility: 'internal',
    pinned: true,
  });
  await call(dana, 'projects', 'POST', `/projects/${home2.id}/notes`, {
    body: 'Guestroom FF&E deliveries can start the week of the 4th-floor turnover. Dock access is 7am–3pm weekdays.',
    visibility: 'client',
  });
  console.log(`  ${defs.length} projects`);
}
