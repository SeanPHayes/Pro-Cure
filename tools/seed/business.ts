import type { SeedIds } from './identity.js';
import { type Actor, actor, call, closeApps, day, drainEvents, loadAll } from './lib.js';
import { CLIENTS, STAFF, TENANT, VENDORS } from './people.js';
import { seedProjects } from './projects.js';

export interface Ctx {
  ids: SeedIds;
  staff: Record<(typeof STAFF)[number]['key'], Actor>;
  clients: Record<string, Actor>;
  vendors: Record<string, Actor>;
  call: typeof call;
  day: typeof day;
  /** Shared results between seed stages. */
  out: Record<string, any>;
}

export async function seedBusiness(ids: SeedIds, only?: string[]) {
  const staff = {} as Ctx['staff'];
  for (const s of STAFF)
    staff[s.key] = await actor(ids, {
      userId: ids.users[s.key]!,
      orgId: ids.tenantId,
      roles: [...s.roles] as never,
      name: s.name,
      email: s.email,
      orgName: TENANT.name,
    });
  const clients: Record<string, Actor> = {};
  for (const c of CLIENTS)
    for (const u of c.users)
      clients[u.email] = await actor(ids, {
        userId: ids.clientUsers[u.email]!,
        orgId: ids.clientOrgs[c.key]!,
        actor: 'client',
        roles: [...u.roles] as never,
        name: u.name,
        email: u.email,
        orgName: c.name,
      });
  const vendors: Record<string, Actor> = {};
  for (const v of VENDORS)
    if (v.portalUser)
      vendors[v.key] = await actor(ids, {
        userId: ids.vendorUsers[v.key]!,
        orgId: ids.vendorOrgs[v.key]!,
        actor: 'vendor',
        roles: ['vendor_admin'],
        name: v.portalUser.name,
        email: v.portalUser.email,
        orgName: v.name,
      });
  await loadAll();
  const ctx: Ctx = { ids, staff, clients, vendors, call, day, out: {} };

  const stages: [string, (c: Ctx) => Promise<void>][] = [['projects', seedProjects]];
  for (const extra of ['catalog', 'quoting', 'orders', 'finance', 'comms', 'ai'] as const) {
    try {
      const mod = await import(`./${extra}.js`);
      stages.push([extra, mod.seed]);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ERR_MODULE_NOT_FOUND') throw err;
    }
  }
  // catalog must run first (vendors/brands referenced by everything else)
  stages.sort((a, b) => (a[0] === 'catalog' ? -1 : b[0] === 'catalog' ? 1 : 0));
  if (only?.length) await hydrate(ctx);
  for (const [name, fn] of stages) {
    if (only?.length && !only.includes(name)) continue;
    console.log(`Seeding ${name}…`);
    await fn(ctx);
    await drainEvents();
  }
  await closeApps();
}

/** When running individual stages against an existing database, rebuild ctx.out from the APIs. */
async function hydrate(ctx: Ctx) {
  const m = ctx.staff.marcus;
  const vendors = await call<any>(m, 'catalog', 'GET', '/vendors?onlyMine=true&limit=200').catch(() => null);
  if (vendors) {
    const { VENDORS: list } = await import('./people.js');
    ctx.out.vendorIds = Object.fromEntries(
      list.map((v) => [v.key, (vendors.items ?? vendors).find((x: any) => x.name === v.name)?.id]),
    );
  }
  const stds = await call<any>(m, 'catalog', 'GET', '/brand-standards?limit=200').catch(() => null);
  if (stds) {
    ctx.out.standards = {};
    ctx.out.brands = {};
    for (const s of stds.items ?? stds) {
      const full = await call<any>(m, 'catalog', 'GET', `/brand-standards/${s.id}`);
      const [brand, pkg] = String(s.name).split(' – ');
      ctx.out.standards[`${brand}|${pkg}`] = { id: s.id, items: full.items };
      ctx.out.brands[brand!] = s.brandId;
    }
  }
  const projects = await call<any>(
    m,
    'projects',
    'GET',
    '/projects?limit=100&status=active,closed,won,on_hold',
  ).catch(() => null);
  if (projects) {
    const keyOf: Record<string, string> = {
      'Home2 Suites Raleigh-Durham Airport': 'home2',
      'Hampton Inn Wilmington Riverfront Renovation': 'hampton',
      'Tru by Hilton Cary': 'tru',
      'Home2 Suites Greensboro Coliseum': 'greensboro',
      'Courtyard Durham Downtown Refresh': 'durham',
    };
    ctx.out.projects = {};
    for (const p of projects.items ?? projects) if (keyOf[p.name]) ctx.out.projects[keyOf[p.name]!] = p;
    const quotes = await call<any>(m, 'quoting', 'GET', '/quotes?limit=100').catch(() => null);
    ctx.out.quotes = {};
    for (const [key, p] of Object.entries<any>(ctx.out.projects)) {
      const q = (quotes?.items ?? []).find((x: any) => x.projectId === p.id && !x.isTemplate);
      if (q) ctx.out.quotes[key] = { quote: q };
    }
  }
}
