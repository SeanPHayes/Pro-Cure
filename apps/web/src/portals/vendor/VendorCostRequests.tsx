import { ReceiptText } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Chips, EmptyState, ErrorNote, PageHeader, ProgressBar, StatusBadge } from '@/components/ui';
import { type Column, DataTable } from '@/components/ui/DataTable';
import type { VendorCostRequest } from '@/features/quoting/types';
import { DueLabel, needsResponse, useVendorRequests, VENDOR_STATUS } from '@/features/quoting/vendorShared';
import { ago } from '@/lib/format';

export function Component() {
  const nav = useNavigate();
  const [filter, setFilter] = useState<'open' | 'all'>('open');
  const q = useVendorRequests();
  const all = q.data?.items ?? [];
  const rows = filter === 'open' ? all.filter(needsResponse) : all;
  const cols: Column<VendorCostRequest>[] = [
    {
      key: 'n',
      header: 'Request',
      width: 120,
      cell: (r) => <span className="num font-[560] whitespace-nowrap">{r.number}</span>,
    },
    {
      key: 'p',
      header: 'Project',
      cell: (r) => <span className="font-[560]">{r.projectName ?? 'Hotel project'}</span>,
    },
    {
      key: 's',
      header: 'Status',
      cell: (r) => (
        <StatusBadge status={r.status === 'sent' ? 'open' : r.status} label={VENDOR_STATUS[r.status]} />
      ),
    },
    {
      key: 'pr',
      header: 'Your progress',
      cell: (r) => (
        <div className="w-40">
          <div className="num mb-1 text-[12px] text-ink-2">
            {r.respondedLineCount} of {r.lineCount} items priced
          </div>
          <ProgressBar
            value={(r.respondedLineCount / Math.max(1, r.lineCount)) * 100}
            tone={r.respondedLineCount === r.lineCount ? 'ok' : 'brass'}
          />
        </div>
      ),
    },
    { key: 'd', header: 'Due', cell: (r) => <DueLabel r={r} /> },
    {
      key: 'sent',
      header: 'Received',
      cell: (r) => <span className="whitespace-nowrap text-ink-2">{ago(r.sentAt)}</span>,
    },
  ];
  return (
    <>
      <PageHeader
        title="Pricing requests"
        description="Each request lists the items a buyer wants priced. Enter your cost, how long it’s valid, and lead time — your answers save as you go."
      >
        <div className="mt-4">
          <Chips
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'open', label: 'Needs your response', count: all.filter(needsResponse).length },
              { value: 'all', label: 'All requests', count: all.length },
            ]}
          />
        </div>
      </PageHeader>
      {q.isError ? (
        <ErrorNote error={q.error} />
      ) : (
        <div className="bg-paper [&_td:first-child]:pl-6 [&_td:last-child]:pr-6 [&_th:first-child]:pl-6 [&_th:last-child]:pr-6">
          <DataTable
            columns={cols}
            rows={q.isLoading ? undefined : rows}
            loading={q.isLoading}
            onRowClick={(r) => nav(`/vendor/cost-requests/${r.id}`)}
            empty={
              <EmptyState
                icon={<ReceiptText />}
                title={filter === 'open' ? 'You’re all caught up' : 'No pricing requests yet'}
              >
                {filter === 'open'
                  ? 'There are no requests waiting for your prices. We’ll email you when a new one arrives.'
                  : 'When a buyer asks you to price items, the request appears here and you’ll get an email.'}
              </EmptyState>
            }
          />
        </div>
      )}
    </>
  );
}
