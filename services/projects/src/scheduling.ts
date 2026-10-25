import { unprocessable } from '@procure/platform';
import { addBusinessDays, dueFor, maxDate, startAfter } from './dates.js';

/** A schedulable node: a template task (keyed by slug) or a project task (keyed by id). */
export interface PlanNode {
  key: string;
  durationDays: number;
  offsetDays: number;
  dependsOn: string[];
}

/**
 * Kahn topological sort. Rejects unknown dependency keys and cycles with 422 so a broken template can
 * never generate an unschedulable project. Ties keep input order (template `sort`).
 */
export function topoSort<T extends PlanNode>(nodes: T[]): T[] {
  const byKey = new Map<string, T>();
  for (const n of nodes) {
    if (byKey.has(n.key)) throw unprocessable(`Duplicate task key "${n.key}"`, { key: n.key });
    byKey.set(n.key, n);
  }
  const indeg = new Map<string, number>();
  const out = new Map<string, string[]>();
  for (const n of nodes) {
    const deps = [...new Set(n.dependsOn)];
    for (const d of deps) {
      if (!byKey.has(d))
        throw unprocessable(`Task "${n.key}" depends on unknown task "${d}"`, { key: n.key, dep: d });
      if (d === n.key) throw unprocessable(`Task "${n.key}" depends on itself`, { cycle: [n.key] });
      out.set(d, [...(out.get(d) ?? []), n.key]);
    }
    indeg.set(n.key, deps.length);
  }
  const queue = nodes.filter((n) => indeg.get(n.key) === 0).map((n) => n.key);
  const order: T[] = [];
  while (queue.length) {
    const k = queue.shift()!;
    order.push(byKey.get(k)!);
    for (const m of out.get(k) ?? []) {
      const v = indeg.get(m)! - 1;
      indeg.set(m, v);
      if (v === 0) queue.push(m);
    }
  }
  if (order.length !== nodes.length) {
    const cycle = findCycle(nodes);
    throw unprocessable(`Task dependencies contain a cycle: ${cycle.join(' → ')}`, { cycle });
  }
  return order;
}

function findCycle(nodes: PlanNode[]): string[] {
  const deps = new Map(nodes.map((n) => [n.key, n.dependsOn]));
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const visit = (k: string): string[] | null => {
    state.set(k, 1);
    stack.push(k);
    for (const d of deps.get(k) ?? []) {
      if (state.get(d) === 1) return [...stack.slice(stack.indexOf(d)), d];
      if (!state.has(d)) {
        const c = visit(d);
        if (c) return c;
      }
    }
    stack.pop();
    state.set(k, 2);
    return null;
  };
  for (const n of nodes) {
    if (!state.has(n.key)) {
      const c = visit(n.key);
      if (c) return c.reverse();
    }
  }
  return [];
}

/**
 * Forward-schedule nodes from `anchor` in business days:
 *  - no dependencies: start = anchor + offset
 *  - otherwise: start = (latest predecessor finish, next business day) + offset
 *  - due = start + duration - 1 (a 0-day milestone finishes the day it starts)
 */
export function schedule<T extends PlanNode>(nodes: T[], anchor: string) {
  const order = topoSort(nodes);
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const dates = new Map<string, { start: string; due: string }>();
  for (const n of order) {
    let base = anchor;
    if (n.dependsOn.length) {
      base = maxDate(...n.dependsOn.map((d) => startAfter(dates.get(d)!.due, byKey.get(d)!.durationDays)))!;
    }
    const start = addBusinessDays(base, n.offsetDays);
    dates.set(n.key, { start, due: dueFor(start, n.durationDays) });
  }
  return { order, dates };
}

/** All transitive successors of `rootId` in a task graph (id → dependsOn ids). */
export function downstream(tasks: { id: string; dependsOn: string[] }[], rootId: string): Set<string> {
  const succ = new Map<string, string[]>();
  for (const t of tasks) for (const d of t.dependsOn) succ.set(d, [...(succ.get(d) ?? []), t.id]);
  const seen = new Set<string>();
  const queue = [...(succ.get(rootId) ?? [])];
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id) || id === rootId) continue;
    seen.add(id);
    queue.push(...(succ.get(id) ?? []));
  }
  return seen;
}

/**
 * Critical (driving) path of the remaining work: start at the latest not-done milestone (or the latest
 * not-done task when there are no open milestones) and walk back through the not-done predecessor
 * that finishes last. Any slip on these tasks moves the end date.
 */
export function criticalPath(
  tasks: { id: string; dependsOn: string[]; dueDate: string | null; isMilestone: boolean; open: boolean }[],
): Set<string> {
  const open = tasks.filter((t) => t.open && t.dueDate);
  const byId = new Map(open.map((t) => [t.id, t]));
  const latest = (xs: typeof open) =>
    xs.reduce<(typeof open)[number] | undefined>(
      (m, t) => (!m || t.dueDate! > m.dueDate! ? t : m),
      undefined,
    );
  let cur = latest(open.filter((t) => t.isMilestone)) ?? latest(open);
  const path = new Set<string>();
  while (cur && !path.has(cur.id)) {
    path.add(cur.id);
    const preds = cur.dependsOn.map((d) => byId.get(d)).filter((t): t is (typeof open)[number] => !!t);
    cur = latest(preds);
  }
  return path;
}
