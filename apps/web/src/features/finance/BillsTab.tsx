import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Truck } from 'lucide-react';
import { useState } from 'react';
import { Button, Chips, cx, EmptyState, ErrorNote, SearchInput, Select, StatusBadge } from '@/components/ui';
import { type Column, DataTable, Pagination } from '@/components/ui/DataTable';
import { api, type Page } from '@/lib/api';
import { hasPerm, useSession } from '@/lib/auth';
import { date, humanize, money } from '@/lib/format';
import { useListParams, useSearchParamInput } from '@/lib/hooks';
import {
  dueNote,
  dueTone,
  fk,
  Money,
  RecordPaymentSheet,
  SyncBadge,
  useProjectsLite,
  useVendorsLite,
} from './shared';
import type { VendorBill } from './types';

const DEFAULTS = {
  status: 'open',
  due: '',
  vendorId: '',
  projectId: '',
  q: '',
  sort: 'dueDate',
  limit: '50',
};
const OPEN = ['open', 'scheduled', 'partially_paid'];

const STATUS_QUERY: Record<string, string | undefined> = {
  all: undefined,
  open: OPEN.join(','),
  scheduled: 'scheduled',
  paid: 'paid',
  void: 'void',
};

export function BillsTab({ onNew }: { onNew?: () => void }) {
  const s = useSession();
  const canWrite = hasPerm(s, 'finance:write');
  const projects = useProjectsLite();
  const vendors = useVendorsLite();
  const projectNo = new Map(projects.data?.map((p) => [p.id, p]));
  const [p, set] = useListParams(DEFAULTS);
  const [text, setText] = useSearchParamInput(p.q, (q) => set({ q }));
  const [paying, setPaying] = useState<VendorBill | null>(null);
  const query = {
    status: STATUS_QUERY[p.status],
    dueWithinDays: p.due || undefined,
    vendorId: p.vendorId || undefined,
    projectId: p.projectId || undefined,
    q: p.q || undefined,
    sort: p.sort,
    limit: Number(p.limit),
    offset: Number(p.offset),
  };
  const list = useQuery({
    queryKey: fk.bills(query),
    queryFn: () => api.get<Page<VendorBill>>('finance', '/bills', query),
    placeholderData: keepPreviousData,
  });
  const filtered = !!(p.status !== 'open' || p.due || p.vendorId || p.projectId || p.q);
  const openOnPage = list.data?.items.reduce((sum, b) => sum + (OPEN.includes(b.status) ? b.balance : 0), 0);

  const columns: Column<VendorBill>[] = [
    {
      key: 'vendor',
      header: 'Vendor',
      sort: 'vendorName',
      cell: (r) => (
        <div className="min-w-[180px]">
          <div className="font-[560]">{r.vendorName}</div>
          <div className="num text-[12px] text-ink-3">
            {humanize(r.kind)} · {r.number}
            {r.poNumber ? ` · ${r.poNumber}` : ''}
          </div>
        </div>
      ),
    },
    {
      key: 'project',
      header: 'Project',
      cell: (r) => {
        const pr = projectNo.get(r.projectId);
        return pr ? (
          <div className="min-w-[140px] max-w-[200px]">
            <div className="num text-[13px]">{pr.number}</div>
            <div className="truncate text-[12px] text-ink-3">{pr.name}</div>
          </div>
        ) : (
          <span className="text-ink-4">—</span>
        );
      },
    },
    { key: 'status', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
    {
      key: 'bill',
      header: 'Bill date',
      sort: 'billDate',
      cell: (r) => <span className="num whitespace-nowrap text-ink-2">{date(r.billDate)}</span>,
    },
    {
      key: 'due',
      header: 'Due',
      sort: 'dueDate',
      cell: (r) => {
        const open = OPEN.includes(r.status);
        const note = dueNote(r.dueDate, open);
        return (
          <div className="whitespace-nowrap">
            <div className="num">{date(r.dueDate)}</div>
            {note && <div className={cx('num text-[12px]', dueTone(r.dueDate, open))}>{note}</div>}
          </div>
        );
      },
    },
    {
      key: 'amount',
      header: 'Amount',
      align: 'right',
      sort: 'amount',
      cell: (r) => <Money value={r.amount} />,
    },
    {
      key: 'balance',
      header: 'Balance',
      align: 'right',
      sort: 'balance',
      cell: (r) => <Money value={r.balance} muted0 />,
    },
    {
      key: 'qbo',
      header: 'QuickBooks',
      cell: (r) => <SyncBadge status={r.qboSyncStatus} error={r.qboError} />,
    },
    ...(canWrite
      ? [
          {
            key: 'pay',
            header: <span className="sr-only">Actions</span>,
            align: 'right' as const,
            cell: (r: VendorBill) =>
              OPEN.includes(r.status) ? (
                <Button
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    setPaying(r);
                  }}
                >
                  Record payment
                </Button>
              ) : null,
          },
        ]
      : []),
  ];

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-paper px-4 py-3 sm:px-6">
        <SearchInput value={text} onChange={setText} placeholder="Search bills" className="w-full sm:w-56" />
        <Chips
          value={p.status}
          onChange={(v) => set({ status: v })}
          options={[
            { value: 'open', label: 'Unpaid' },
            { value: 'scheduled', label: 'Scheduled' },
            { value: 'paid', label: 'Paid' },
            { value: 'void', label: 'Void' },
            { value: 'all', label: 'All' },
          ]}
        />
        <div className="w-[160px]">
          <Select
            aria-label="Due within"
            value={p.due}
            onChange={(e) => set({ due: e.target.value })}
            placeholder="Any due date"
            options={[
              { value: '0', label: 'Due now or late' },
              { value: '7', label: 'Due within 7 days' },
              { value: '14', label: 'Due within 14 days' },
              { value: '30', label: 'Due within 30 days' },
              { value: '60', label: 'Due within 60 days' },
            ]}
          />
        </div>
        <div className="w-[200px]">
          <Select
            aria-label="Vendor"
            value={p.vendorId}
            onChange={(e) => set({ vendorId: e.target.value })}
            placeholder="All vendors"
            options={(vendors.data ?? []).map((v) => ({ value: v.id, label: v.name }))}
          />
        </div>
        <div className="w-full sm:w-[240px]">
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
              set({ status: 'open', due: '', vendorId: '', projectId: '', q: '' });
            }}
          >
            Clear filters
          </Button>
        )}
        <span className="num ml-auto text-[13px] text-ink-3">
          {list.data
            ? `${list.data.total} ${list.data.total === 1 ? 'bill' : 'bills'}${
                openOnPage ? ` · ${money(openOnPage)} unpaid on this page` : ''
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
            sort={p.sort}
            onSort={(sort) => set({ sort })}
            rowClassName={(r) => (r.status === 'void' ? 'text-ink-3 [&_.num]:line-through' : undefined)}
            empty={
              filtered ? (
                <EmptyState icon={<Truck />} title="No bills match these filters">
                  Try a different due window or vendor, or clear the filters.
                </EmptyState>
              ) : (
                <EmptyState
                  icon={<Truck />}
                  title="No vendor bills yet"
                  action={
                    onNew && (
                      <Button variant="primary" onClick={onNew}>
                        Enter bill
                      </Button>
                    )
                  }
                >
                  Deposit bills appear automatically when purchase orders are issued. Enter balance and
                  freight bills as vendors send them.
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
      <RecordPaymentSheet
        open={!!paying}
        onClose={() => setPaying(null)}
        target={
          paying && {
            type: 'bill',
            id: paying.id,
            number: paying.number,
            balance: paying.balance,
            party: paying.vendorName,
          }
        }
      />
    </>
  );
}
