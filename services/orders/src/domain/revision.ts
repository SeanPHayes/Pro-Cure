/**
 * Revision diffs. When a PO is issued, a snapshot of everything printed on it is stored; editing an issued
 * PO only marks it as having unissued changes. Issuing a revision diffs the current state against that
 * snapshot and prints the changes on the revision PDF.
 */
export interface SnapshotLine {
  id: string;
  code: string;
  name: string;
  description: string | null;
  finish: string | null;
  quantity: number;
  unitCost: number;
  extended: number;
}

export interface PoSnapshot {
  header: Record<string, unknown>;
  lines: SnapshotLine[];
}

export interface Change {
  field: string;
  lineCode?: string;
  from: unknown;
  to: unknown;
}

/** Header fields printed on the PO and therefore part of a revision. */
export const SNAPSHOT_HEADER_FIELDS = [
  'requestedDeliveryDate',
  'releaseByDate',
  'shipTo',
  'billTo',
  'contact24h',
  'paymentTerms',
  'freightTerms',
  'shipMethod',
  'depositPct',
  'vendorNotes',
  'freight',
  'tax',
  'total',
] as const;

const LINE_FIELDS = ['name', 'description', 'finish', 'quantity', 'unitCost', 'extended'] as const;

const stable = (v: unknown): string => {
  if (v === undefined || v === null || v === '') return 'null';
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined && o[k] !== null && o[k] !== '')
      .sort()
      .map((k) => `${k}:${stable(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
};
const same = (a: unknown, b: unknown) => stable(a) === stable(b);
const nul = (v: unknown) => (v === undefined ? null : v);

export function diffSnapshots(prev: PoSnapshot, next: PoSnapshot): Change[] {
  const changes: Change[] = [];
  for (const f of SNAPSHOT_HEADER_FIELDS)
    if (!same(prev.header[f], next.header[f]))
      changes.push({ field: f, from: nul(prev.header[f]), to: nul(next.header[f]) });

  const before = new Map(prev.lines.map((l) => [l.id, l]));
  const after = new Map(next.lines.map((l) => [l.id, l]));
  for (const l of next.lines) {
    const p = before.get(l.id);
    if (!p) {
      changes.push({ field: 'line_added', lineCode: l.code, from: null, to: `${l.quantity} × ${l.name}` });
      continue;
    }
    for (const f of LINE_FIELDS)
      if (!same(p[f], l[f])) changes.push({ field: f, lineCode: l.code, from: nul(p[f]), to: nul(l[f]) });
  }
  for (const p of prev.lines)
    if (!after.has(p.id))
      changes.push({ field: 'line_removed', lineCode: p.code, from: `${p.quantity} × ${p.name}`, to: null });
  return changes;
}
