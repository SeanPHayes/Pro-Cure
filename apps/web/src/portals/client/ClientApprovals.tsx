import { useQuery } from '@tanstack/react-query';
import { BadgeCheck, ChevronRight, FileSpreadsheet, Palette } from 'lucide-react';
import { Link } from 'react-router';
import { EmptyState, Loading, PageHeader, Section } from '@/components/ui';
import type { ClientQuote } from '@/features/quoting/types';
import { api, type Page } from '@/lib/api';
import { useMe } from '@/lib/auth';
import { date, money, relativeDue } from '@/lib/format';

interface Requirement {
  id: string;
  kind: string;
  status: string;
  poId?: string;
  poNumber?: string | null;
  projectId?: string | null;
  projectName?: string | null;
  itemName?: string | null;
  title?: string | null;
  dueDate?: string | null;
  documentId?: string | null;
}

const KIND: Record<string, string> = {
  shop_drawing: 'Shop drawing',
  finish_sample: 'Finish sample',
  cfa: 'Cutting for approval',
  strike_off: 'Strike-off',
};

export function Component() {
  const s = useMe();
  const firm = s.contexts.find((c) => c.tenantId === s.context.tenantId)?.tenantName ?? 'your project team';
  const quotes = useQuery({
    queryKey: ['client', 'quotes'],
    queryFn: () => api.get<Page<ClientQuote>>('quoting', '/client/quotes', { limit: 200 }),
  });
  const reqs = useQuery({
    queryKey: ['client', 'requirements'],
    queryFn: () => api.get<Page<Requirement> | Requirement[]>('orders', '/client/requirements'),
    select: (d) => (Array.isArray(d) ? d : d.items),
    retry: false,
    meta: { silent: true },
  });
  const waiting = (quotes.data?.items ?? []).filter((q) => q.status === 'sent');
  const decided = (quotes.data?.items ?? []).filter((q) => q.status !== 'sent').slice(0, 6);
  const openReqs = (reqs.data ?? []).filter((r) =>
    ['pending', 'submitted', 'open', 'needs_review'].includes(r.status),
  );

  return (
    <>
      <PageHeader
        title="Approvals"
        description={`Everything ${firm} needs you to decide on. Nothing is ordered until you approve it.`}
      />
      <div className="mx-auto max-w-[920px] space-y-4 px-4 py-5 sm:px-6">
        <Section
          title={`Quotes waiting for your approval${waiting.length ? ` (${waiting.length})` : ''}`}
          bodyClassName=""
        >
          {quotes.isLoading ? (
            <Loading />
          ) : !waiting.length ? (
            <EmptyState icon={<BadgeCheck />} title="No quotes waiting for you">
              When {firm} sends a quote, it appears here with a link to review and approve it.
            </EmptyState>
          ) : (
            <ul className="divide-y divide-line-2">
              {waiting.map((q) => (
                <li key={q.id}>
                  <Link
                    to={`/portal/quotes/${q.id}`}
                    className="flex flex-wrap items-center gap-4 px-4 py-3.5 hover:bg-stone"
                  >
                    <FileSpreadsheet className="size-5 shrink-0 text-ink-3" />
                    <div className="min-w-0 flex-1">
                      <div className="font-[620]">{q.name}</div>
                      <div className="num text-[13px] text-ink-2">
                        {q.number}
                        {q.phase ? ` · ${q.phase}` : ''} · sent {date(q.sentAt)}
                        {q.validUntil ? ` · prices valid ${relativeDue(q.validUntil).toLowerCase()}` : ''}
                      </div>
                    </div>
                    <div className="num text-[17px] font-[640]">{money(q.total)}</div>
                    <span className="inline-flex items-center gap-1 rounded-sm bg-lacquer px-3 py-1.5 text-[13px] font-[560] text-white">
                      Review and approve
                      <ChevronRight className="size-4" />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Section>

        {reqs.isSuccess && (
          <Section
            title={`Drawings and samples to approve${openReqs.length ? ` (${openReqs.length})` : ''}`}
            bodyClassName=""
          >
            {!openReqs.length ? (
              <EmptyState icon={<Palette />} title="Nothing to review">
                Shop drawings and finish samples from manufacturers show up here when they need your sign-off.
              </EmptyState>
            ) : (
              <ul className="divide-y divide-line-2">
                {openReqs.map((r) => (
                  <li key={r.id}>
                    <Link
                      to={r.projectId ? `/portal/projects/${r.projectId}` : '/portal'}
                      className="flex flex-wrap items-center gap-4 px-4 py-3 hover:bg-stone"
                    >
                      <Palette className="size-5 shrink-0 text-ink-3" />
                      <div className="min-w-0 flex-1">
                        <div className="font-[600]">
                          {KIND[r.kind] ?? r.kind.replace(/_/g, ' ')}
                          {r.itemName || r.title ? `: ${r.itemName ?? r.title}` : ''}
                        </div>
                        <div className="text-[13px] text-ink-2">
                          {[r.projectName, r.poNumber].filter(Boolean).join(' · ')}
                          {r.dueDate ? ` · due ${date(r.dueDate)}` : ''}
                        </div>
                      </div>
                      <span className="inline-flex items-center gap-1 text-[13px] font-[560] text-lacquer">
                        Review
                        <ChevronRight className="size-4" />
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        )}

        {decided.length > 0 && (
          <Section title="Recently decided" bodyClassName="">
            <ul className="divide-y divide-line-2">
              {decided.map((q) => (
                <li key={q.id}>
                  <Link
                    to={`/portal/quotes/${q.id}`}
                    className="flex items-center gap-3 px-4 py-2.5 hover:bg-stone"
                  >
                    <span className="num text-[13px] text-ink-3">{q.number}</span>
                    <span className="min-w-0 flex-1 truncate">{q.name}</span>
                    <span className="text-[13px] text-ink-2">
                      {q.clientDecision === 'approved'
                        ? 'Approved'
                        : q.clientDecision === 'rejected'
                          ? 'Changes requested'
                          : ''}{' '}
                      {date(q.clientDecidedAt)}
                    </span>
                    <span className="num font-[560]">{money(q.total)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </Section>
        )}
      </div>
    </>
  );
}
