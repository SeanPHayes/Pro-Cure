import type { Tx } from '@procure/platform';

/**
 * Run `fn` inside the caller's transaction with the RLS actor temporarily switched to `service` for
 * the given tenant, then restore the caller's context. Used for fan-out work that must see rows the
 * caller cannot (other users' notification preferences, notifications for other recipients) while
 * staying atomic with the caller's write. Never pass caller-controlled tenant ids.
 */
export async function asService<T>(tx: Tx, tenantId: string, fn: () => Promise<T>): Promise<T> {
  const [prev] = await tx<{ tenant: string; actor: string; org: string }[]>`
    select current_setting('app.tenant_id', true) as tenant,
           current_setting('app.actor_type', true) as actor,
           current_setting('app.org_id', true) as org`;
  await tx`select set_config('app.tenant_id', ${tenantId}, true), set_config('app.actor_type', 'service', true),
                  set_config('app.org_id', '', true)`;
  try {
    return await fn();
  } finally {
    await tx`select set_config('app.tenant_id', ${prev?.tenant ?? ''}, true),
                    set_config('app.actor_type', ${prev?.actor ?? ''}, true),
                    set_config('app.org_id', ${prev?.org ?? ''}, true)`;
  }
}
