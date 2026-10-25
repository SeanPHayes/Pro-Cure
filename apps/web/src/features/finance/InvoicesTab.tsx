import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ReceiptText } from 'lucide-react';
import { useNavigate } from 'react-router';
import { Button, Chips, cx, EmptyState, ErrorNote, SearchInput, Select, StatusBadge } from '@/components/ui';
import { type Column, DataTable, Pagination } from '@/components/ui/DataTable';
import { api, type Page } from '@/lib/api';
import { date, money } from '@/lib/format';
import { useListParams, useSearchParamInput } from '@/lib/hooks';
import { dueNote, dueTone, fk, Money, SyncBadge, useProjectsLite } from './shared';
import { AGING_BUCKETS, AGING_LABEL, type Invoice, KIND_LABEL, OPEN_AR } from './types';

const DEFAULTS = {
  status: '',
  aging: '',
  overdue: '',
  projectId: '',
  q: '',
  sort: '-issueDate',
  limit: '50',
};

const STATUS_QUERY: Record<string, string | undefined> = {
  '': undefined,
  open: OPEN_AR.join(','),
  draft: 'draft',
  paid: 'paid',
  void: 'void',
};

export function InvoicesTab({ onNew }: { onNew?: () => void }) {
  const nav = useNavigate();
  const projects = useProjectsLite();
  const [p, set] = useListParams(DEFAULTS);
  const [text, setText] = useSearchParamInput(p.q, (q) => set({ q }));
  const query = {
    status: STATUS_QUERY[p.status],
    aging: p.aging || undefined,
    overdue: p.overdue === 'true' ? true : undefined,
    projectId: p.projectId || undefined,
    q: p.q || undefined,
    sort: p.sort,
    limit: Number(p.limit),
    offset: Number(p.offset),
  };
  const list = useQuery({
    queryKey: fk.invoices(query),
    queryFn: () => api.get<Page<Invoice>>('finance', '/invoices', query),
    placeholderData: keepPreviousData,
  });
  const filtered = !!(p.status || p.aging || p.overdue || p.projectId || p.q);
  const totalBalance = list.data?.items.reduce((s, i) => s + (OPEN_AR.includes(i.status) ? i.balance : 0), 0);

  const columns: Column<Invoice>[] = [
    {
      key: 'number',
      header: 'Invoice',
      sort: 'number',
      cell: (r) => (
        <div className="whitespace-nowrap">
          <div className="num font-[560]">{r.number}</div>
          <div className="text-[12px] text-ink-3">{KIND_LABEL[r.kind]}</div>
        </div>
      ),
    },
    {
      key: 'client',
      header: 'Owner & project',
      sort: 'clientName',
      cell: (r) => (
        <div className="min-w-[220px] max-w-[340px]">
          <div className="truncate">{r.clientName}</div>
          <div className="truncate text-[12px] text-ink-3">
            {r.projectNumber} · {r.projectName}
          </div>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      sort: 'status',
      cell: (r) => <StatusBadge status={r.status} />,
    },
    {
      key: 'issue',
      header: 'Issued',
      sort: 'issueDate',
      cell: (r) => <span className="num whitespace-nowrap text-ink-2">{date(r.issueDate)}</span>,
    },
    {
      key: 'due',
      header: 'Due',
      sort: 'dueDate',
      cell: (r) => {
        const open = OPEN_AR.includes(r.status) && r.balance > 0;
        const note = r.daysOverdue > 0 ? `${r.daysOverdue} days late` : dueNote(r.dueDate, open);
        return (
          <div className="whitespace-nowrap">
            <div className="num">
              {r.terms === 'Due on receipt' && !open ? 'On receipt' : date(r.dueDate)}
            </div>
            {note && <div className={cx('num text-[12px]', dueTone(r.dueDate, open))}>{note}</div>}
          </div>
        );
      },
    },
    { key: 'total', header: 'Total', align: 'right', sort: 'total', cell: (r) => <Money value={r.total} /> },
    {
      key: 'balance',
      header: 'Balance',
      align: 'right',
      sort: 'balance',
      cell: (r) => (
        <Money
          value={r.status === 'void' ? 0 : r.balance}
          muted0
          className={r.daysOverdue > 0 ? 'text-crit' : ''}
        />
      ),
    },
    {
      key: 'qbo',
      header: 'QuickBooks',
      cell: (r) =>
        r.status === 'draft' ? (
          <span className="text-ink-4">—</span>
        ) : (
          <SyncBadge status={r.qboSyncStatus} error={r.qboError} />
        ),
    },
  ];

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-paper px-4 py-3 sm:px-6">
        <SearchInput
          value={text}
          onChange={setText}
          placeholder="Search invoices"
          className="w-full sm:w-56"
        />
        <Chips
          value={p.status}
          onChange={(v) => set({ status: v, overdue: '', aging: '' })}
          options={[
            { value: '', label: 'All' },
            { value: 'open', label: 'Open' },
            { value: 'draft', label: 'Draft' },
            { value: 'paid', label: 'Paid' },
            { value: 'void', label: 'Void' },
          ]}
        />
        <div className="w-[160px]">
          <Select
            aria-label="Aging"
            value={p.overdue === 'true' ? 'overdue' : p.aging}
            onChange={(e) =>
              e.target.value === 'overdue'
                ? set({ overdue: 'true', aging: '' })
                : set({ aging: e.target.value, overdue: '' })
            }
            placeholder="Any aging"
            options={[
              { value: 'overdue', label: 'Any overdue' },
              ...AGING_BUCKETS.map((b) => ({
                value: b,
                label: b === 'current' ? 'Not yet due' : `${AGING_LABEL[b]} late`,
              })),
            ]}
          />
        </div>
        <div className="w-full sm:w-[260px]">
          <Select
            aria-label="Project"
            value={p.projectId}
            onChange={(e) => set({ projectId: e.target.value })}
            placeholder="All projects"
            options={(projects.data ?? []).map((pr) => ({
              value: pr.id,
              label: `${pr.number} · ${pr.name}`,
            }))}
          />
        </div>
        {filtered && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setText('');
              set({ status: '', aging: '', overdue: '', projectId: '', q: '' });
            }}
          >
            Clear filters
          </Button>
        )}
        <span className="num ml-auto text-[13px] text-ink-3">
          {list.data
            ? `${list.data.total} ${list.data.total === 1 ? 'invoice' : 'invoices'}${
                totalBalance ? ` · ${money(totalBalance)} open on this page` : ''
              }`
            : ''}
        </span>
      </div>
      {list.isError ? (
        <ErrorNote error={list.error} />
      ) : (
        <div className="bg-paper [&_td:first-child]:pl-6 [&_td:last-child]:pr-6 [&_th:first-child]:pl-6 [&_th:last-child]:pr-6">
          <DataTable
            columns={columns}
            rows={list.data?.items}
            loading={list.isLoading}
            onRowClick={(r) => nav(`/app/invoices/${r.id}`)}
            rowClassName={(r) => (r.status === 'void' ? 'text-ink-3 [&_.num]:line-through' : undefined)}
            sort={p.sort}
            onSort={(sort) => set({ sort })}
            empty={
              filtered ? (
                <EmptyState icon={<ReceiptText />} title="No invoices match these filters">
                  Try a different status or aging bucket, or clear the filters.
                </EmptyState>
              ) : (
                <EmptyState
                  icon={<ReceiptText />}
                  title="No invoices yet"
                  action={
                    onNew && (
                      <Button variant="primary" onClick={onNew}>
                        New invoice
                      </Button>
                    )
                  }
                >
                  Bill an owner’s deposit from an approved quote, or enter progress lines by hand.
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
    </>
  );
}
