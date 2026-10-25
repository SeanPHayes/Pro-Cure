import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ReceiptText } from 'lucide-react';
import { useMemo } from 'react';
import { Link, useNavigate } from 'react-router';
import {
  Chips,
  EmptyState,
  ErrorNote,
  PageHeader,
  ProgressBar,
  SearchInput,
  StatusBadge,
} from '@/components/ui';
import { type Column, DataTable } from '@/components/ui/DataTable';
import { api, type Page } from '@/lib/api';
import { ago, date, daysFromToday, relativeDue } from '@/lib/format';
import { useListParams, useSearchParamInput } from '@/lib/hooks';
import { qk } from './shared';
import type { CostRequest } from './types';

const DEFAULTS = { status: 'open', q: '' };
const RANK: Record<string, number> = {
  responded: 0,
  partially_applied: 1,
  viewed: 2,
  sent: 3,
  applied: 4,
  closed: 5,
  draft: 6,
};
const OPEN = new Set(['sent', 'viewed', 'responded', 'partially_applied']);

export function Component() {
  const nav = useNavigate();
  const [p, set] = useListParams(DEFAULTS);
  const [text, setText] = useSearchParamInput(p.q, (q) => set({ q }));
  const list = useQuery({
    queryKey: qk.costRequests({ q: p.q }),
    queryFn: () =>
      api.get<Page<CostRequest>>('quoting', '/cost-requests', { q: p.q || undefined, limit: 500 }),
    placeholderData: keepPreviousData,
  });
  const all = list.data?.items ?? [];
  const counts = {
    open: all.filter((r) => OPEN.has(r.status)).length,
    responded: all.filter((r) => r.status === 'responded' || r.status === 'partially_applied').length,
    waiting: all.filter((r) => r.status === 'sent' || r.status === 'viewed').length,
    done: all.filter((r) => r.status === 'applied' || r.status === 'closed').length,
  };
  const rows = useMemo(
    () =>
      all
        .filter((r) =>
          p.status === 'open'
            ? OPEN.has(r.status)
            : p.status === 'responded'
              ? r.status === 'responded' || r.status === 'partially_applied'
              : p.status === 'waiting'
                ? r.status === 'sent' || r.status === 'viewed'
                : p.status === 'done'
                  ? r.status === 'applied' || r.status === 'closed'
                  : true,
        )
        .sort(
          (a, b) =>
            (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9) ||
            (a.dueDate ?? '9').localeCompare(b.dueDate ?? '9'),
        ),
    [all, p.status],
  );

  const cols: Column<CostRequest>[] = [
    {
      key: 'n',
      header: 'Request',
      width: 110,
      cell: (r) => <span className="num font-[560] whitespace-nowrap">{r.number}</span>,
    },
    { key: 'v', header: 'Vendor', cell: (r) => <span className="font-[560]">{r.vendorName ?? '—'}</span> },
    {
      key: 'q',
      header: 'Quote',
      cell: (r) => (
        <Link
          to={`/app/quotes/${r.quoteId}`}
          onClick={(e) => e.stopPropagation()}
          className="whitespace-nowrap hover:text-lacquer hover:underline"
        >
          <span className="num mr-1.5 text-ink-2">{r.quoteNumber}</span>
          {r.quoteName}
        </Link>
      ),
    },
    {
      key: 's',
      header: 'Status',
      cell: (r) => (
        <StatusBadge status={r.status} label={r.status === 'responded' ? 'Responded — review' : undefined} />
      ),
    },
    {
      key: 'p',
      header: 'Progress',
      cell: (r) => (
        <div className="w-40">
          <div className="num mb-1 text-[12px] text-ink-2">
            {r.respondedLineCount}/{r.lineCount} answered · {r.appliedLineCount} applied
          </div>
          <ProgressBar
            value={(r.respondedLineCount / Math.max(1, r.lineCount)) * 100}
            tone={r.appliedLineCount === r.lineCount ? 'ok' : 'brass'}
          />
        </div>
      ),
    },
    {
      key: 'd',
      header: 'Due',
      cell: (r) => {
        const d = daysFromToday(r.dueDate);
        const late = d !== null && d < 0 && (r.status === 'sent' || r.status === 'viewed');
        return (
          <div className="whitespace-nowrap">
            <div className="num">{date(r.dueDate)}</div>
            {(r.status === 'sent' || r.status === 'viewed') && r.dueDate && (
              <div className={`text-[12px] ${late ? 'text-crit' : 'text-ink-3'}`}>
                {relativeDue(r.dueDate)}
              </div>
            )}
          </div>
        );
      },
    },
    {
      key: 'act',
      header: 'Last activity',
      cell: (r) => (
        <span className="whitespace-nowrap text-ink-2">
          {r.respondedAt
            ? `Responded ${ago(r.respondedAt)}`
            : r.viewedAt
              ? `Viewed ${ago(r.viewedAt)}`
              : `Sent ${ago(r.sentAt)}`}
        </span>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Cost requests"
        description="Pricing requests sent to vendors. Responses come back here to compare against the library and apply to quotes."
      >
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <SearchInput
            value={text}
            onChange={setText}
            placeholder="Search number or vendor"
            className="w-full sm:w-64"
          />
          <div className="max-w-full overflow-x-auto">
            <Chips
              value={p.status}
              onChange={(v) => set({ status: v })}
              options={[
                { value: 'open', label: 'Open', count: counts.open },
                { value: 'responded', label: 'Needs review', count: counts.responded },
                { value: 'waiting', label: 'Waiting on vendor', count: counts.waiting },
                { value: 'done', label: 'Applied or closed', count: counts.done },
                { value: 'all', label: 'All', count: all.length },
              ]}
            />
          </div>
        </div>
      </PageHeader>
      {list.isError ? (
        <ErrorNote error={list.error} />
      ) : (
        <div className="bg-paper [&_td:first-child]:pl-6 [&_td:last-child]:pr-6 [&_th:first-child]:pl-6 [&_th:last-child]:pr-6">
          <DataTable
            columns={cols}
            rows={list.isLoading ? undefined : rows}
            loading={list.isLoading}
            onRowClick={(r) => nav(`/app/cost-requests/${r.id}`)}
            empty={
              <EmptyState
                icon={<ReceiptText />}
                title={p.status === 'responded' ? 'Nothing to review' : 'No cost requests here'}
              >
                Request pricing from a quote: lines are packaged into one request per vendor and sent to their
                portal.
              </EmptyState>
            }
          />
        </div>
      )}
    </>
  );
}
