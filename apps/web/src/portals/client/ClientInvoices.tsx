import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ReceiptText } from 'lucide-react';
import { useNavigate } from 'react-router';
import { Chips, cx, EmptyState, ErrorNote, PageHeader, StatusBadge } from '@/components/ui';
import { type Column, DataTable, Pagination } from '@/components/ui/DataTable';
import type { ClientInvoice } from '@/features/finance/types';
import { api, type Page } from '@/lib/api';
import { useMe } from '@/lib/auth';
import { date, daysFromToday, money } from '@/lib/format';
import { useListParams } from '@/lib/hooks';

const DEFAULTS = { show: 'all', limit: '50' };
const OPEN = ['sent', 'partially_paid', 'overdue'];

/** Owner-facing labels: plainer than the internal ones. */
export const OWNER_STATUS_LABEL: Record<string, string> = {
  sent: 'Awaiting payment',
  partially_paid: 'Partly paid',
  overdue: 'Past due',
  paid: 'Paid',
  void: 'Cancelled',
};
export const OWNER_KIND_LABEL: Record<string, string> = {
  deposit: 'Deposit',
  progress: 'Progress billing',
  final: 'Final billing',
  credit_memo: 'Credit',
};

export function Component() {
  const s = useMe();
  const nav = useNavigate();
  const [p, set] = useListParams(DEFAULTS);
  const query = {
    status: p.show === 'open' ? OPEN.join(',') : p.show === 'paid' ? 'paid' : undefined,
    limit: Number(p.limit),
    offset: Number(p.offset),
  };
  const list = useQuery({
    queryKey: ['client-invoices', query],
    queryFn: () => api.get<Page<ClientInvoice>>('finance', '/client/invoices', query),
    placeholderData: keepPreviousData,
  });
  // A separate unfiltered tally keeps the "you owe" headline steady while filters change.
  const open = useQuery({
    queryKey: ['client-invoices', 'open-total'],
    queryFn: () =>
      api.get<Page<ClientInvoice>>('finance', '/client/invoices', { status: OPEN.join(','), limit: 500 }),
  });
  const owed = open.data?.items.reduce((sum, i) => sum + i.balance, 0) ?? 0;
  const pastDue =
    open.data?.items.filter((i) => i.status === 'overdue' || (daysFromToday(i.dueDate) ?? 0) < 0) ?? [];
  const nextDue = open.data?.items
    .filter((i) => (daysFromToday(i.dueDate) ?? -1) >= 0)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0];
  const tenantName =
    s.contexts.find((c) => c.tenantId === s.context.tenantId)?.tenantName ?? 'your procurement team';

  const columns: Column<ClientInvoice>[] = [
    {
      key: 'number',
      header: 'Invoice',
      cell: (r) => (
        <div className="whitespace-nowrap">
          <div className="num font-[560]">{r.number}</div>
          <div className="max-w-[130px] truncate text-[12px] text-ink-2 sm:hidden">{r.projectName}</div>
          <div className="text-[12px] text-ink-3">{OWNER_KIND_LABEL[r.kind]}</div>
          <div className="mt-1 sm:hidden">
            <StatusBadge status={r.status} label={OWNER_STATUS_LABEL[r.status]} />
          </div>
        </div>
      ),
    },
    {
      key: 'project',
      header: 'Project',
      className: 'max-sm:hidden',
      cell: (r) => (
        <div className="min-w-[200px]">
          <div>{r.projectName}</div>
          {r.poReference && <div className="text-[12px] text-ink-3">Your PO {r.poReference}</div>}
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      className: 'max-sm:hidden',
      cell: (r) => <StatusBadge status={r.status} label={OWNER_STATUS_LABEL[r.status]} />,
    },
    {
      key: 'due',
      header: 'Due',
      cell: (r) => {
        const isOpen = OPEN.includes(r.status);
        const d = daysFromToday(r.dueDate) ?? 0;
        return (
          <div className="whitespace-nowrap">
            <div className="num">{r.terms === 'Due on receipt' ? 'On receipt' : date(r.dueDate)}</div>
            {isOpen && d < 0 && (
              <div className="num text-[12px] whitespace-normal text-crit">{-d} days past due</div>
            )}
          </div>
        );
      },
    },
    {
      key: 'amount',
      header: 'Amount',
      align: 'right',
      className: 'max-sm:hidden',
      cell: (r) => money(r.total),
    },
    {
      key: 'balance',
      header: 'Balance',
      align: 'right',
      cell: (r) => (
        <span className={cx('font-[560]', !r.balance && 'font-[400] text-ink-4')}>
          {money(r.status === 'void' ? 0 : r.balance)}
        </span>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Invoices"
        description={`Invoices from ${tenantName} for your projects. Open one to see its lines, download the PDF or find payment instructions.`}
      />
      <div className="mx-auto max-w-[1200px] space-y-4 px-4 py-5 sm:px-6">
        {open.data && open.data.total > 0 && (
          <div className="grid grid-cols-1 gap-px overflow-hidden rounded-md border border-line bg-line-2 sm:grid-cols-3">
            <div className="bg-paper px-4 py-3.5">
              <div className="text-[12px] text-ink-3">Balance due</div>
              <div className="num mt-0.5 text-[22px] font-[620]">{money(owed)}</div>
              <div className="text-[12px] text-ink-3">
                Across {open.data.total} open {open.data.total === 1 ? 'invoice' : 'invoices'}
              </div>
            </div>
            <div className="bg-paper px-4 py-3.5">
              <div className="text-[12px] text-ink-3">Past due</div>
              <div className={cx('num mt-0.5 text-[22px] font-[620]', pastDue.length && 'text-crit')}>
                {money(pastDue.reduce((sum, i) => sum + i.balance, 0))}
              </div>
              <div className="text-[12px] text-ink-3">
                {pastDue.length
                  ? `${pastDue.length} ${pastDue.length === 1 ? 'invoice' : 'invoices'}`
                  : 'You’re all caught up'}
              </div>
            </div>
            <div className="bg-paper px-4 py-3.5">
              <div className="text-[12px] text-ink-3">Next due</div>
              <div className="num mt-0.5 text-[22px] font-[620]">{nextDue ? date(nextDue.dueDate) : '—'}</div>
              <div className="text-[12px] text-ink-3">
                {nextDue ? `${nextDue.number} · ${money(nextDue.balance)}` : 'Nothing coming due'}
              </div>
            </div>
          </div>
        )}

        <div className="overflow-hidden rounded-md border border-line bg-paper">
          <div className="flex items-center justify-between gap-3 border-b border-line-2 px-4 py-2.5">
            <Chips
              value={p.show}
              onChange={(v) => set({ show: v })}
              options={[
                { value: 'all', label: 'All' },
                { value: 'open', label: 'To pay' },
                { value: 'paid', label: 'Paid' },
              ]}
            />
            <span className="num text-[13px] text-ink-3">
              {list.data ? `${list.data.total} ${list.data.total === 1 ? 'invoice' : 'invoices'}` : ''}
            </span>
          </div>
          {list.isError ? (
            <ErrorNote error={list.error} />
          ) : (
            <div className="max-sm:[&_th:nth-child(2)]:hidden max-sm:[&_th:nth-child(3)]:hidden max-sm:[&_th:nth-child(5)]:hidden [&_td:first-child]:pl-4 [&_td:last-child]:pr-4 [&_th:first-child]:pl-4 [&_th:last-child]:pr-4">
              <DataTable
                columns={columns}
                rows={list.data?.items}
                loading={list.isLoading}
                onRowClick={(r) => nav(`/portal/invoices/${r.id}`)}
                rowClassName={(r) => (r.status === 'void' ? 'text-ink-3' : undefined)}
                empty={
                  p.show !== 'all' ? (
                    <EmptyState
                      icon={<ReceiptText />}
                      title={p.show === 'open' ? 'Nothing to pay right now' : 'No paid invoices yet'}
                    >
                      {p.show === 'open'
                        ? 'Every invoice we’ve sent you is paid. New invoices will show up here, and we’ll email you too.'
                        : 'Invoices move here once they’re paid in full.'}
                    </EmptyState>
                  ) : (
                    <EmptyState icon={<ReceiptText />} title="No invoices yet">
                      When {tenantName} bills a deposit or progress payment for one of your projects, it
                      appears here and you’ll get an email with the PDF.
                    </EmptyState>
                  )
                }
                footer={
                  list.data && (
                    <Pagination
                      total={list.data.total}
                      limit={list.data.limit}
                      offset={list.data.offset}
                      onChange={(o) => set({ offset: String(o) })}
                    />
                  )
                }
              />
            </div>
          )}
        </div>
      </div>
    </>
  );
}
