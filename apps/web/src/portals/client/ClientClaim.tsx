import { useQuery } from '@tanstack/react-query';
import { Check, ChevronLeft } from 'lucide-react';
import { Link, useParams } from 'react-router';
import { ThreadPanel } from '@/components/shared/ThreadPanel';
import { Badge, cx, EmptyState, ErrorNote, Loading, Section } from '@/components/ui';
import { PhotoGrid } from '@/features/orders/shared';
import type { ClientClaim } from '@/features/orders/types';
import { ApiError, api } from '@/lib/api';
import { useMe } from '@/lib/auth';
import { dateLong, dateTime } from '@/lib/format';
import { OWNER_CLAIM_STATUS, OWNER_CLAIM_TYPE } from './ClientClaims';

const STEPS = [
  { key: 'open', label: 'Reported' },
  { key: 'submitted_to_vendor', label: 'With the vendor' },
  { key: 'replacement_ordered', label: 'Being fixed' },
  { key: 'resolved', label: 'Resolved' },
];
const STEP_AT: Record<string, number> = {
  open: 0,
  submitted_to_vendor: 1,
  vendor_acknowledged: 1,
  replacement_ordered: 2,
  credited: 2,
  resolved: 3,
  rejected: 3,
};

export function Component() {
  const { id = '' } = useParams();
  const s = useMe();
  const firm = s.contexts.find((c) => c.tenantId === s.context.tenantId)?.tenantName ?? 'your project team';
  const q = useQuery({
    queryKey: ['client', 'claim', id],
    queryFn: () => api.get<ClientClaim>('orders', `/client/claims/${id}`),
  });
  if (q.isLoading) return <Loading label="Loading claim" />;
  if (q.isError)
    return q.error instanceof ApiError && q.error.status === 404 ? (
      <EmptyState
        title="We couldn’t find this claim"
        action={
          <Link to="/portal/claims" className="font-[560] text-lacquer hover:underline">
            Back to claims
          </Link>
        }
      />
    ) : (
      <ErrorNote error={q.error} />
    );
  const c = q.data!;
  const st = OWNER_CLAIM_STATUS[c.status];
  const at = STEP_AT[c.status] ?? 0;
  const closedNoAction = c.status === 'rejected';

  return (
    <div className="mx-auto max-w-[980px] px-4 py-6 sm:px-6 sm:py-8">
      <Link
        to="/portal/claims"
        className="inline-flex items-center gap-1 text-[13px] text-ink-2 hover:text-ink"
      >
        <ChevronLeft className="size-4" />
        Claims
      </Link>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <h1 className="text-[24px] leading-tight font-[640]">{OWNER_CLAIM_TYPE[c.type]}</h1>
        <Badge tone={st?.tone}>{st?.label}</Badge>
      </div>
      <p className="mt-1 text-ink-2">
        <span className="num">{c.number}</span> · reported {dateLong(c.reportedAt)}
        {c.reportedByName && ` by ${c.reportedByName}`}
        {c.vendorName && ` · ${c.vendorName}`}
        {c.poNumber && <span className="num"> · order {c.poNumber}</span>}
      </p>

      <section className="mt-5 rounded-md border border-line bg-paper p-5">
        <ol className="grid grid-cols-4 gap-2" aria-label="Claim progress">
          {STEPS.map((step, i) => {
            const done = i < at || (i === at && i === STEPS.length - 1);
            const current = i === at && !done;
            return (
              <li key={step.key} className="min-w-0">
                <div
                  className={cx(
                    'h-1.5 rounded-full',
                    i <= at ? (closedNoAction && i === 3 ? 'bg-ink-4' : 'bg-lacquer') : 'bg-stone-2',
                  )}
                />
                <div
                  className={cx(
                    'mt-2 flex items-center gap-1 text-[12.5px]',
                    current ? 'font-[620] text-lacquer' : done ? 'text-ink' : 'text-ink-4',
                  )}
                >
                  {done && <Check className="size-3.5 shrink-0" />}
                  <span className="truncate">{closedNoAction && i === 3 ? 'Closed' : step.label}</span>
                </div>
              </li>
            );
          })}
        </ol>
        <p className="mt-4">
          <span className="font-[620]">What happens next: </span>
          <span className="text-ink-2">{st?.next}</span>
        </p>
        {c.resolution && (
          <div className="mt-3 rounded-sm bg-stone px-3 py-2">
            <div className="text-[12px] text-ink-3">Update from {firm}</div>
            <p className="whitespace-pre-wrap">{c.resolution}</p>
          </div>
        )}
        {c.resolvedAt && <p className="mt-2 text-[12.5px] text-ink-3">Closed {dateTime(c.resolvedAt)}</p>}
      </section>

      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-4">
          <Section title="What you reported">
            <p className="whitespace-pre-wrap">{c.description}</p>
            {!!c.items?.length && (
              <ul className="mt-3 divide-y divide-line-2 rounded-sm border border-line-2 text-[13px]">
                {c.items.map((i, n) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: owner view of items carries no id
                  <li key={n} className="flex gap-3 px-3 py-1.5">
                    <span className="min-w-0 flex-1">{i.name}</span>
                    <span className="num font-[560]">×{i.quantity}</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
          <Section title="Photos">
            <PhotoGrid
              ids={c.photoDocumentIds}
              empty={<p className="text-ink-3">No photos attached. You can send more photos in a message.</p>}
            />
          </Section>
        </div>
        <Section title={`Messages with ${firm}`} className="min-w-0">
          <ThreadPanel
            entityType="claim"
            entityId={c.id}
            visibility="client"
            clientOrgId={s.context.orgId}
            emptyHint="Questions, extra photos or updates about this claim go here. Your project team is notified."
          />
        </Section>
      </div>
    </div>
  );
}
