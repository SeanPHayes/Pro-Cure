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
  for (const [name, fn] of stages) {
    if (only?.length && !only.includes(name)) continue;
    console.log(`Seeding ${name}…`);
    await fn(ctx);
    await drainEvents();
  }
  await closeApps();
}
