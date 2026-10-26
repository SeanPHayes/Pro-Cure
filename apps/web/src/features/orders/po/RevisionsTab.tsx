import { useQuery } from '@tanstack/react-query';
import { FileText, History, Send } from 'lucide-react';
import { Button, EmptyState, Section } from '@/components/ui';
import { api, documentUrl } from '@/lib/api';
import { hasPerm, useSession } from '@/lib/auth';
import { dateTime } from '@/lib/format';
import { describeChange } from '../shared';
import type { Change, PoDetail } from '../types';

/** Field-level changes as a ruled list: what, from (struck), to (highlighted). */
export function ChangeList({ changes }: { changes: Change[] }) {
  if (!changes.length)
    return <p className="px-3 py-3 text-ink-3">No changes since the last issued revision.</p>;
  return (
    <ul className="divide-y divide-line-2 text-[13px]">
      {changes.map((c, i) => {
        const d = describeChange(c);
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: changes have no id and never reorder
          <li key={i} className="grid gap-1 px-3 py-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
            <span className="font-[560]">{d.what}</span>
            <span className="min-w-0">
              {d.from !== null && <s className="text-ink-3">{d.from}</s>}
              {d.from !== null && d.to !== null && <span className="mx-1.5 text-ink-4">→</span>}
              {d.to !== null && <mark className="rounded-xs bg-brass-100 px-1 text-ink">{d.to}</mark>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export function RevisionsTab({ po, onIssue }: { po: PoDetail; onIssue: () => void }) {
  const s = useSession();
  const next = po.revision + 1;
  const pending = useQuery({
    queryKey: ['orders', 'diff', po.id, next, po.version],
    queryFn: () =>
      api.get<{ changes: Change[] }>('orders', `/purchase-orders/${po.id}/revisions/${next}/diff`),
    enabled: po.status !== 'draft' && po.hasUnissuedChanges,
  });
  return (
    <div className="space-y-4">
      {po.hasUnissuedChanges && po.status !== 'draft' && (
        <Section
          title={`Unissued changes (will be revision ${next})`}
          bodyClassName=""
          className="border-brass/50"
          actions={
            hasPerm(s, 'orders:issue') && (
              <Button size="sm" variant="brass" icon={<Send className="size-3.5" />} onClick={onIssue}>
                Issue revision {next}
              </Button>
            )
          }
        >
          {pending.isLoading ? (
            <p className="px-4 py-3 text-ink-3">Comparing…</p>
          ) : (
            <ChangeList changes={pending.data?.changes ?? []} />
          )}
        </Section>
      )}
      <Section title="Issued revisions" bodyClassName="">
        {!po.revisions.length ? (
          <EmptyState icon={<History />} title="Not issued yet">
            Revision 0 is created when you issue the order to the vendor.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line-2">
            {po.revisions.map((r) => (
              <li key={r.id} className="px-4 py-3">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="font-[620]">
                    {r.revision === 0 ? 'Original order (rev 0)' : `Revision ${r.revision}`}
                  </span>
                  <span className="text-[13px] text-ink-3">
                    {dateTime(r.issuedAt)}
                    {r.issuedByName && ` by ${r.issuedByName}`}
                  </span>
                  {r.documentId && (
                    <a
                      href={documentUrl(r.documentId)}
                      target="_blank"
                      rel="noreferrer"
                      className="ml-auto inline-flex items-center gap-1 text-[13px] font-[560] text-lacquer hover:underline"
                    >
                      <FileText className="size-3.5" />
                      {r.revision === 0 ? 'PO PDF' : 'Revision PDF (changes highlighted)'}
                    </a>
                  )}
                </div>
                {r.message && <p className="mt-1 text-[13px] text-ink-2">“{r.message}”</p>}
                {r.changes.length > 0 && (
                  <div className="mt-2 rounded-sm border border-line-2">
                    <ChangeList changes={r.changes} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
