import { useQuery } from '@tanstack/react-query';
import { History } from 'lucide-react';
import type { ServiceName } from '@procure/domain';
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

const SKIP = new Set([
  'id',
  'tenant_id',
  'version',
  'search',
  'updated_at',
  'created_at',
  'last_issued_snapshot',
]);
const show = (v: unknown) =>
  v === null || v === undefined || v === ''
    ? 'empty'
    : typeof v === 'object'
      ? JSON.stringify(v).slice(0, 60)
      : String(v);

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
      {q.data.map((e) => {
        const fields = Object.entries(e.changes).filter(([k]) => !SKIP.has(k));
        return (
          <li key={e.id} className="relative">
            <span className="absolute top-1.5 -left-[25px] size-2.5 rounded-full border-2 border-paper bg-brass" />
            <div className="text-[13px]">
              <span className="font-[560]">
                {e.actorName ??
                  (e.actorType === 'system' || e.actorType === 'service' ? 'Pro-Cure' : 'Someone')}
              </span>{' '}
              <span className="text-ink-2">
                {e.action === 'insert' ? 'created' : e.action === 'delete' ? 'deleted' : 'changed'}{' '}
                {humanize(e.entityType).toLowerCase()}
              </span>{' '}
              <time className="text-ink-3" title={dateTime(e.occurredAt)}>
                {ago(e.occurredAt)}
              </time>
            </div>
            {e.action === 'update' && fields.length > 0 && (
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
