import type { ServiceName } from '@procure/domain';
import { useQuery } from '@tanstack/react-query';
import { History } from 'lucide-react';
import { EmptyState, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { ago, dateTime, humanize } from '@/lib/format';

interface Entry {
  id: number;
  entityType: string;
  entityId: string;
  action: 'insert' | 'update' | 'delete';
  changes: Record<string, unknown>;
  actorName: string | null;
  actorType: string | null;
  occurredAt: string;
}

/** Bookkeeping columns that never mean anything to a reader. */
const SKIP = new Set(['id', 'tenant_id', 'version', 'search', 'updated_at', 'created_at', 'last_issued_snapshot', 'sort']);
/** Foreign keys and actor ids are noise in a human history ("PublishedBy: 26a2…"). */
const isNoise = (k: string) => SKIP.has(k) || /(_id|_ids|_by|^id)$/.test(k) || k.endsWith('_document_id');

const show = (v: unknown) => {
  if (v === null || v === undefined || v === '') return 'empty';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) return dateTime(v);
  if (typeof v === 'object') return JSON.stringify(v).slice(0, 60);
  return String(v);
};

const actorOf = (e: Entry) =>
  e.actorName ?? (e.actorType === 'system' || e.actorType === 'service' ? 'Pro-Cure' : 'Someone');

/** Collapse runs like "created 22 brand standard items" into one line. */
interface Group {
  key: string;
  entries: Entry[];
}
function groupEntries(list: Entry[]): Group[] {
  const out: Group[] = [];
  for (const e of list) {
    const last = out.at(-1);
    const head = last?.entries[0];
    const sameRun =
      head &&
      e.action !== 'update' &&
      head.action === e.action &&
      head.entityType === e.entityType &&
      actorOf(head) === actorOf(e) &&
      Math.abs(new Date(head.occurredAt).getTime() - new Date(e.occurredAt).getTime()) < 5 * 60_000;
    if (sameRun) last!.entries.push(e);
    else out.push({ key: String(e.id), entries: [e] });
  }
  return out;
}

const plural = (s: string, n: number) => (n === 1 ? s : `${n} ${s.endsWith('y') ? `${s.slice(0, -1)}ies` : `${s}s`}`);

/** Field-level change history from the platform audit log. */
export function ActivityFeed({ service, path }: { service: ServiceName; path: string }) {
  const q = useQuery({
    queryKey: ['activity', service, path],
    queryFn: () => api.get<Entry[] | { items: Entry[] }>(service, path),
    select: (d) => (Array.isArray(d) ? d : d.items),
  });
  if (q.isLoading)
    return (
      <div className="flex justify-center py-8">
        <Spinner />
      </div>
    );
  if (!q.data?.length) return <EmptyState icon={<History />} title="No changes recorded yet" />;
  return (
    <ol className="relative space-y-4 border-l border-line pl-5">
      {groupEntries(q.data).map(({ key, entries }) => {
        const e = entries[0]!;
        const fields = Object.entries(e.changes).filter(([k]) => !isNoise(k));
        const noun = humanize(e.entityType).toLowerCase();
        const verb = e.action === 'insert' ? 'created' : e.action === 'delete' ? 'deleted' : 'changed';
        return (
          <li key={key} className="relative">
            <span className="absolute top-1.5 -left-[25px] size-2.5 rounded-full border-2 border-paper bg-brass" />
            <div className="text-[13px]">
              <span className="font-[560]">{actorOf(e)}</span>{' '}
              <span className="text-ink-2">
                {verb} {entries.length > 1 ? plural(noun, entries.length) : noun}
              </span>{' '}
              <time className="text-ink-3" title={dateTime(e.occurredAt)}>
                {ago(e.occurredAt)}
              </time>
            </div>
            {entries.length === 1 && e.action === 'update' && fields.length > 0 && (
              <ul className="mt-1 space-y-0.5 text-[13px] text-ink-2">
                {fields.slice(0, 8).map(([k, v]) => {
                  const c = v as { from: unknown; to: unknown };
                  return (
                    <li key={k}>
                      {humanize(k)}: <s className="text-ink-3">{show(c?.from)}</s> →{' '}
                      <span className="text-ink">{show(c?.to)}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </li>
        );
      })}
    </ol>
  );
}
