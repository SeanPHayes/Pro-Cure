import type { EventData, EventType, Permission } from '@procure/domain';
import { forbidden, type Principal, type Tx } from '@procure/platform';
import type { Emitter } from '../engine.js';

/** Internal staff only (portal actors never reach workspace routes even with a crafted role list). */
export const requireStaff = (p: Principal, ...perms: Permission[]) => {
  p.requireInternal();
  p.require(...perms);
};

export const requireAny = (p: Principal, ...perms: Permission[]) => {
  if (!perms.some((x) => p.can(x))) throw forbidden(`Requires one of: ${perms.join(', ')}`);
};

/** Bind req.emit as an engine Emitter. */
interface CanEmit {
  emit<T extends EventType>(tx: Tx, type: T, data: EventData<T>): Promise<string>;
}
export const emitter =
  (req: CanEmit): Emitter =>
  (tx, type, data) =>
    req.emit(tx, type, data);

export const total = (rows: { totalCount?: number }[]) => rows[0]?.totalCount ?? 0;

/** Trigram-friendly ILIKE pattern with wildcards escaped. */
export const like = (q: string) => `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;

export const nn = <T>(v: T | undefined): T | null => (v === undefined ? null : v);

/** Build a SET fragment from defined keys only (keys are camelCase; postgres.js maps to snake_case). */
export const setFrom = (tx: Tx, obj: Record<string, unknown>, json: string[] = []) => {
  const entries = Object.entries(obj).filter(([, v]) => v !== undefined);
  const out: Record<string, unknown> = {};
  for (const [k, v] of entries) out[k] = json.includes(k) ? tx.json(v as never) : v;
  return { keys: Object.keys(out), frag: Object.keys(out).length ? tx(out, Object.keys(out)) : null };
};
