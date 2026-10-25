import type { Ctx } from './business.js';
import { drainEvents } from './lib.js';

/** Run the delivery-risk model once so the dashboard shows scores, and let inbox routing finish. */
export async function seed(ctx: Ctx) {
  const { call, staff } = ctx;
  await drainEvents();
  const job = await call<any>(staff.tomas, 'ai', 'POST', '/jobs/risk-score', {});
  const deadline = Date.now() + 60_000;
  for (;;) {
    const jobs = await call<any>(staff.tomas, 'ai', 'GET', '/jobs?status=queued,running&limit=50');
    if (!(jobs.items ?? []).length || Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  await drainEvents();
  const done = await call<any>(staff.tomas, 'ai', 'GET', `/jobs/${job.id}`);
  console.log(`  risk model: ${done.status}; inbox routing complete`);
}
