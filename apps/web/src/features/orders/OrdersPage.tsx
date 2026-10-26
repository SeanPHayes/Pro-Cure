import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { CheckCheck, Package, Plus, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';
import {
  Button,
  Chips,
  cx,
  Dialog,
  EmptyState,
  ErrorNote,
  Field,
  Input,
  PageHeader,
  SearchInput,
  Select,
  Sheet,
  StatusBadge,
} from '@/components/ui';
import { type Column, DataTable, Pagination } from '@/components/ui/DataTable';
import { api, type Page } from '@/lib/api';
import { hasPerm, useSession } from '@/lib/auth';
import { date, daysFromToday, humanize, money } from '@/lib/format';
import { useListParams, useSearchParamInput } from '@/lib/hooks';
import {
  OrderByDate,
  ok,
  REQ_LABEL,
  RequirementChips,
  RiskMark,
  relDays,
  useInvalidateOrders,
  useProjectsLite,
  useVendorsLite,
} from './shared';
import type { PoDetail, PoGridRow, RequirementKind, RequirementRow } from './types';

const VIEWS = ['action', 'risk', 'shipping', 'delivering', 'unissued', 'all'] as const;
type View = (typeof VIEWS)[number];
const VIEW_QUERY: Record<View, Record<string, string | number | boolean>> = {
  action: { needsAction: true, sort: 'releaseByDate' },
  risk: { escalation: 'at_risk,critical' },
  shipping: { shipsWithinDays: 14, sort: 'nextShipDate' },
  delivering: { deliversWithinDays: 14 },
  unissued: { hasUnissuedChanges: true },
  all: {},
};
const VIEW_EMPTY: Record<View, { title: string; text: string }> = {
  action: {
    title: 'Nothing needs you this week',
    text: 'Every order has its requirements in hand, is acknowledged and has a confirmed ship date.',
  },
  risk: { title: 'No orders at risk', text: 'Escalated orders appear here with the reasons why.' },
  shipping: {
    title: 'Nothing ships in the next 14 days',
    text: 'Check the shipments calendar for later dates.',
  },
  delivering: { title: 'Nothing delivers in the next 14 days', text: 'Upcoming deliveries appear here.' },
  unissued: {
    title: 'No unissued changes',
    text: 'When you edit an issued order, it waits here until you issue the revision to the vendor.',
  },
  all: { title: 'No purchase orders yet', text: 'Create purchase orders from an owner-approved quote.' },
};

const STATUSES = [
  'draft',
  'issued',
  'acknowledged',
  'in_production',
  'partially_shipped',
  'shipped',
  'partially_delivered',
  'delivered',
  'closed',
  'cancelled',
];
const KINDS: RequirementKind[] = [
  'order_acknowledgement',
  'deposit',
  'shop_drawing_approval',
  'finish_sample_approval',
  'cfa',
  'credit_approval',
];

const DEFAULTS = {
  view: 'action',
  projectId: '',
  vendorId: '',
  status: '',
  escalation: '',
  kind: '',
  q: '',
  sort: '',
  limit: '100',
};

export function Component() {
  const s = useSession();
  const nav = useNavigate();
  const canWrite = hasPerm(s, 'orders:write');
  const [p, set] = useListParams(DEFAULTS);
  const [text, setText] = useSearchParamInput(p.q, (q) => set({ q }));
  const view = (VIEWS as readonly string[]).includes(p.view) ? (p.view as View) : 'action';
  const projects = useProjectsLite();
  const vendors = useVendorsLite();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const [creating, setCreating] = useState(false);

  const query = {
    ...VIEW_QUERY[view],
    projectId: p.projectId || undefined,
    vendorId: p.vendorId || undefined,
    status: p.status || undefined,
    escalation: p.escalation || (VIEW_QUERY[view].escalation as string | undefined),
    requirementKind: p.kind || undefined,
    includeClosed: view === 'all' && !p.status ? false : undefined,
    q: p.q || undefined,
    sort: p.sort || (VIEW_QUERY[view].sort as string | undefined),
    limit: Number(p.limit),
    offset: Number(p.offset),
  };
  const list = useQuery({
    queryKey: ok.pos(query),
    queryFn: () => api.get<Page<PoGridRow>>('orders', '/purchase-orders', query),
    placeholderData: keepPreviousData,
  });
  // Counts for the saved views (cheap: limit 1, total only).
  const counts = useQuery({
    queryKey: ok.pos({ counts: true, projectId: p.projectId, vendorId: p.vendorId }),
    queryFn: async () => {
      const base = { projectId: p.projectId || undefined, vendorId: p.vendorId || undefined, limit: 1 };
      const entries = await Promise.all(
        VIEWS.map(
          async (v) =>
            [
              v,
              (await api.get<Page<PoGridRow>>('orders', '/purchase-orders', { ...base, ...VIEW_QUERY[v] }))
                .total,
            ] as const,
        ),
      );
      return Object.fromEntries(entries) as Record<View, number>;
    },
    meta: { silent: true },
    staleTime: 30_000,
  });

  const rows = list.data?.items ?? [];
  const filtered = !!(p.projectId || p.vendorId || p.status || p.escalation || p.kind || p.q);

  const columns: Column<PoGridRow>[] = [
    {
      key: 'number',
      header: 'PO',
      sort: 'number',
      cell: (r) => (
        <div className="whitespace-nowrap">
          <Link
            to={`/app/orders/${r.id}`}
            onClick={(e) => e.stopPropagation()}
            className="num font-[620] hover:text-lacquer hover:underline"
          >
            {r.number}
          </Link>
          {r.revision > 0 && <span className="num ml-1 text-[12px] text-ink-3">R{r.revision}</span>}
          {r.hasUnissuedChanges && (
            <div className="text-[11.5px] font-[560] text-brass">Unissued changes</div>
          )}
        </div>
      ),
    },
    {
      key: 'vendor',
      header: 'Vendor · project',
      sort: 'vendorName',
      cell: (r) => (
        <div className="max-w-[180px] min-w-[150px]">
          <div className="truncate font-[560]">{r.vendorName}</div>
          <div className="truncate text-[12px] text-ink-3" title={r.projectName ?? undefined}>
            <span className="num">{r.projectNumber}</span> {r.projectName}
          </div>
        </div>
      ),
    },
    { key: 'status', header: 'Status', sort: 'status', cell: (r) => <StatusBadge status={r.status} /> },
    {
      key: 'risk',
      header: 'Risk',
      sort: 'escalation',
      cell: (r) => <RiskMark level={r.escalation} reasons={r.escalationReasons} score={r.riskScore} />,
    },
    {
      key: 'orderBy',
      header: 'Order-by date',
      sort: 'releaseByDate',
      cell: (r) => <OrderByDate value={r.releaseByDate} pending={r.counts.pendingRequirements} />,
    },
    {
      key: 'reqs',
      header: 'Pending',
      cell: (r) => (
        <div className="min-w-[120px] max-w-[170px]">
          <RequirementChips
            kinds={r.counts.pendingRequirementKinds}
            overdue={(daysFromToday(r.releaseByDate) ?? 1) < 0}
            extra={
              r.counts.unconfirmedShipments > 0 && r.status !== 'draft'
                ? [
                    {
                      label: 'Ship date',
                      title:
                        r.counts.unconfirmedShipments === 1
                          ? 'The vendor has not confirmed the ship date'
                          : `${r.counts.unconfirmedShipments} ship dates not confirmed by the vendor`,
                    },
                  ]
                : undefined
            }
          />
        </div>
      ),
    },
    {
      key: 'ship',
      header: 'Next ship',
      sort: 'nextShipDate',
      cell: (r) => <DateCell value={r.counts.nextShipDate} />,
    },
    {
      key: 'delivery',
      header: 'Next delivery',
      cell: (r) => <DateCell value={r.counts.nextDeliveryDate} target={r.requestedDeliveryDate} />,
    },
    { key: 'total', header: 'Total', sort: 'total', align: 'right', cell: (r) => money(r.total, true) },
  ];

  const selectedRows = rows.filter((r) => selected.has(r.id));

  return (
    <>
      <PageHeader
        title="Purchase orders"
        description="Every order across your projects: what has to happen this week to keep each one on schedule."
        actions={
          canWrite && (
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
              Create purchase orders
            </Button>
          )
        }
      >
        <div className="mt-4 max-w-full overflow-x-auto">
          <Chips
            value={view}
            onChange={(v) => {
              setSelected(new Set());
              set({ view: v, sort: '' });
            }}
            options={[
              { value: 'action', label: 'Needs action this week', count: counts.data?.action },
              { value: 'risk', label: 'At risk', count: counts.data?.risk },
              { value: 'shipping', label: 'Shipping soon', count: counts.data?.shipping },
              { value: 'delivering', label: 'Delivering soon', count: counts.data?.delivering },
              { value: 'unissued', label: 'Unissued changes', count: counts.data?.unissued },
              { value: 'all', label: 'All open', count: counts.data?.all },
            ]}
          />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <div className="w-full sm:w-[220px]">
            <Select
              aria-label="Project"
              value={p.projectId}
              onChange={(e) => set({ projectId: e.target.value })}
              placeholder="All projects"
              options={(projects.data ?? []).map((x) => ({ value: x.id, label: `${x.number} ${x.name}` }))}
            />
          </div>
          <div className="w-[calc(50%-4px)] sm:w-[180px]">
            <Select
              aria-label="Vendor"
              value={p.vendorId}
              onChange={(e) => set({ vendorId: e.target.value })}
              placeholder="All vendors"
              options={(vendors.data ?? []).map((x) => ({ value: x.id, label: x.name }))}
            />
          </div>
          <div className="w-[calc(50%-4px)] sm:w-[150px]">
            <Select
              aria-label="Status"
              value={p.status}
              onChange={(e) => set({ status: e.target.value })}
              placeholder="Any status"
              options={STATUSES.map((x) => ({ value: x, label: humanize(x) }))}
            />
          </div>
          <div className="w-[calc(50%-4px)] sm:w-[140px]">
            <Select
              aria-label="Escalation"
              value={p.escalation}
              onChange={(e) => set({ escalation: e.target.value })}
              placeholder="Any risk"
              options={[
                { value: 'critical', label: 'Critical' },
                { value: 'at_risk,critical', label: 'At risk or worse' },
                { value: 'watch,at_risk,critical', label: 'Watch or worse' },
                { value: 'none', label: 'On track' },
              ]}
            />
          </div>
          <div className="w-[calc(50%-4px)] sm:w-[190px]">
            <Select
              aria-label="Pending requirement"
              value={p.kind}
              onChange={(e) => set({ kind: e.target.value })}
              placeholder="Any requirement"
              options={KINDS.map((k) => ({ value: k, label: `${REQ_LABEL[k]} pending` }))}
            />
          </div>
          <SearchInput
            value={text}
            onChange={setText}
            placeholder="PO, vendor or project"
            className="w-full sm:w-56"
          />
          {filtered && (
            <Button
              variant="ghost"
              size="sm"
              icon={<X className="size-3.5" />}
              onClick={() =>
                set({ projectId: '', vendorId: '', status: '', escalation: '', kind: '', q: '' })
              }
            >
              Clear filters
            </Button>
          )}
        </div>
      </PageHeader>

      <div className="px-4 py-4 sm:px-6">
        {selectedRows.length > 0 && (
          <div className="sticky top-0 z-10 mb-3 flex flex-wrap items-center gap-3 rounded-sm border border-brass/40 bg-brass-50 px-3 py-2">
            <span className="font-[560]">
              {selectedRows.length} {selectedRows.length === 1 ? 'order' : 'orders'} selected
            </span>
            <Button
              size="sm"
              variant="primary"
              icon={<CheckCheck className="size-3.5" />}
              onClick={() => setBulkOpen(true)}
            >
              Mark requirements complete
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
              Clear selection
            </Button>
          </div>
        )}
        <div className="overflow-hidden rounded-md border border-line bg-paper">
          {list.isError ? (
            <ErrorNote error={list.error} />
          ) : (
            <DataTable
              columns={columns}
              rows={list.data?.items}
              loading={list.isLoading}
              onRowClick={(r) => nav(`/app/orders/${r.id}`)}
              selected={canWrite ? selected : undefined}
              onSelect={canWrite ? setSelected : undefined}
              sort={query.sort}
              onSort={(sort) => set({ sort })}
              rowClassName={(r) =>
                r.escalation === 'critical'
                  ? '[&>td:first-child]:shadow-[inset_3px_0_0_var(--color-crit)]'
                  : undefined
              }
              empty={
                <EmptyState
                  icon={<Package />}
                  title={filtered ? 'No orders match these filters' : VIEW_EMPTY[view].title}
                >
                  {filtered ? 'Clear a filter or pick another view.' : VIEW_EMPTY[view].text}
                </EmptyState>
              }
              footer={
                list.data && (
                  <Pagination
                    total={list.data.total}
                    limit={list.data.limit}
                    offset={list.data.offset}
                    onChange={(offset) => set({ offset: String(offset) })}
                  />
                )
              }
            />
          )}
        </div>
        {list.data && (
          <p className="num mt-2 text-[13px] text-ink-3">
            {list.data.total} {list.data.total === 1 ? 'order' : 'orders'} ·{' '}
            {money(
              rows.reduce((a, r) => a + r.total, 0),
              true,
            )}{' '}
            on this page
          </p>
        )}
      </div>

      <BulkRequirementsDialog
        open={bulkOpen}
        rows={selectedRows}
        onClose={() => setBulkOpen(false)}
        onDone={() => {
          setBulkOpen(false);
          setSelected(new Set());
        }}
      />
      <CreateFromQuoteSheet open={creating} onClose={() => setCreating(false)} />
    </>
  );
}

function DateCell({ value, target }: { value: string | null; target?: string | null }) {
  if (!value) return <span className="text-ink-4">—</span>;
  const late = target && value > target;
  return (
    <div className="num whitespace-nowrap">
      <div>{date(value)}</div>
      <div className={cx('text-[12px]', late ? 'font-[560] text-crit' : 'text-ink-3')}>
        {late ? `after requested ${date(target)}` : relDays(value)}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ bulk: mark requirements complete
function BulkRequirementsDialog({
  open,
  rows,
  onClose,
  onDone,
}: {
  open: boolean;
  rows: PoGridRow[];
  onClose: () => void;
  onDone: () => void;
}) {
  const invalidate = useInvalidateOrders();
  const poIds = rows.map((r) => r.id);
  const reqs = useQuery({
    queryKey: ['orders', 'bulk-reqs', poIds],
    enabled: open && poIds.length > 0,
    queryFn: async () => {
      const pages = await Promise.all(
        poIds.map((poId) =>
          api.get<Page<RequirementRow>>('orders', '/requirements', {
            poId,
            status: 'pending,submitted,rejected',
            limit: 100,
          }),
        ),
      );
      return pages.flatMap((p) => p.items);
    },
  });
  const kinds = useMemo(() => [...new Set((reqs.data ?? []).map((r) => r.kind))], [reqs.data]);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<'approved' | 'waived'>('approved');
  const [note, setNote] = useState('');
  const effective = chosen.size ? chosen : new Set(kinds.filter((k) => k === 'deposit'));
  const ids = (reqs.data ?? []).filter((r) => effective.has(r.kind)).map((r) => r.id);

  const m = useMutation({
    mutationFn: () =>
      api.post<{ updated: number }>('orders', '/requirements/bulk', {
        ids,
        status,
        note: note.trim() || undefined,
      }),
    onSuccess: (r) => {
      toast.success(
        `${r.updated} ${r.updated === 1 ? 'requirement' : 'requirements'} ${status === 'waived' ? 'waived' : 'marked complete'}`,
      );
      invalidate();
      setChosen(new Set());
      setNote('');
      onDone();
    },
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Mark requirements complete on ${rows.length} ${rows.length === 1 ? 'order' : 'orders'}`}
      width={520}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={m.isPending} disabled={!ids.length} onClick={() => m.mutate()}>
            {status === 'waived' ? `Waive ${ids.length}` : `Mark ${ids.length} complete`}
          </Button>
        </>
      }
    >
      {reqs.isLoading ? (
        <p className="py-4 text-ink-3">Loading requirements…</p>
      ) : !kinds.length ? (
        <p className="py-2 text-ink-2">The selected orders have no open requirements.</p>
      ) : (
        <div className="space-y-4">
          <fieldset>
            <legend className="mb-1.5 text-[13px] font-[560] text-ink-2">Which requirements</legend>
            <div className="space-y-1">
              {kinds.map((k) => {
                const n = (reqs.data ?? []).filter((r) => r.kind === k).length;
                return (
                  <label key={k} className="flex items-center gap-2 rounded-xs px-1 py-1 hover:bg-stone">
                    <input
                      type="checkbox"
                      className="size-4 accent-lacquer"
                      checked={effective.has(k)}
                      onChange={(e) => {
                        const next = new Set(effective);
                        if (e.target.checked) next.add(k);
                        else next.delete(k);
                        setChosen(next);
                      }}
                    />
                    <span className="flex-1">{REQ_LABEL[k]}</span>
                    <span className="num text-[12px] text-ink-3">{n} open</span>
                  </label>
                );
              })}
            </div>
          </fieldset>
          <Field label="Mark as">
            {(id) => (
              <Select
                id={id}
                value={status}
                onChange={(e) => setStatus(e.target.value as 'approved' | 'waived')}
                options={[
                  { value: 'approved', label: 'Complete (done or approved)' },
                  { value: 'waived', label: 'Waived (not needed)' },
                ]}
              />
            )}
          </Field>
          <Field label="Note" hint="Saved on each requirement, e.g. “Deposit wired 10/24, ref 88213”.">
            {(id) => <Input id={id} value={note} onChange={(e) => setNote(e.target.value)} />}
          </Field>
        </div>
      )}
    </Dialog>
  );
}

// ------------------------------------------------------------------ create from an approved quote
interface QuoteRow {
  id: string;
  number: string;
  name: string;
  projectId: string;
  clientDecidedAt: string | null;
  totals?: { lineCount: number; grandTotal: number };
}

function CreateFromQuoteSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const nav = useNavigate();
  const invalidate = useInvalidateOrders();
  const projects = useProjectsLite();
  const quotes = useQuery({
    queryKey: ['quoting', 'quotes', { status: 'client_approved' }],
    queryFn: () => api.get<Page<QuoteRow>>('quoting', '/quotes', { status: 'client_approved', limit: 100 }),
    enabled: open,
  });
  const [quoteId, setQuoteId] = useState('');
  const [rdd, setRdd] = useState('');
  const project = (id: string) => projects.data?.find((x) => x.id === id);

  const m = useMutation({
    mutationFn: () =>
      api.post<{ items: PoDetail[] }>('orders', '/purchase-orders/from-quote', {
        quoteId,
        requestedDeliveryDate: rdd || undefined,
      }),
    onSuccess: (r) => {
      invalidate();
      onClose();
      setQuoteId('');
      setRdd('');
      toast.success('Purchase orders created', {
        description: (
          <span className="flex flex-wrap gap-x-3 gap-y-1">
            {r.items.map((po) => (
              <a
                key={po.id}
                href={`/app/orders/${po.id}`}
                onClick={(e) => {
                  e.preventDefault();
                  nav(`/app/orders/${po.id}`);
                }}
                className="font-[560] text-lacquer underline"
              >
                {po.number} {po.vendorName}
              </a>
            ))}
          </span>
        ),
        duration: 12_000,
      });
    },
  });

  const items = quotes.data?.items ?? [];
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Create purchase orders"
      description="One draft PO per vendor, from the ready-to-order lines of an owner-approved quote."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!quoteId} loading={m.isPending} onClick={() => m.mutate()}>
            Create purchase orders
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <fieldset className="min-w-0">
          <legend className="mb-2 text-[13px] font-[560] text-ink-2">Approved quote</legend>
          {quotes.isLoading ? (
            <p className="text-ink-3">Loading quotes…</p>
          ) : !items.length ? (
            <p className="rounded-sm border border-line bg-stone px-3 py-3 text-ink-2">
              No quotes are approved by an owner yet. Once an owner approves a quote in their portal, it shows
              up here ready to order.
            </p>
          ) : (
            <ul className="divide-y divide-line-2 rounded-sm border border-line">
              {items.map((q) => {
                const pr = project(q.projectId);
                return (
                  <li key={q.id}>
                    <label
                      className={cx(
                        'flex cursor-pointer items-start gap-3 px-3 py-2.5 hover:bg-stone',
                        quoteId === q.id && 'bg-brass-50',
                      )}
                    >
                      <input
                        type="radio"
                        name="quote"
                        className="mt-1 accent-lacquer"
                        checked={quoteId === q.id}
                        onChange={() => setQuoteId(q.id)}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block font-[560]">
                          <span className="num">{q.number}</span> {q.name}
                        </span>
                        <span className="block truncate text-[12px] text-ink-3">
                          {pr ? `${pr.number} ${pr.name}` : 'Project'}
                          {q.clientDecidedAt ? ` · approved ${date(q.clientDecidedAt)}` : ''}
                        </span>
                      </span>
                      {q.totals && (
                        <span className="num shrink-0 text-right text-[13px] text-ink-2">
                          {money(q.totals.grandTotal, true)}
                          <span className="block text-[12px] text-ink-3">{q.totals.lineCount} lines</span>
                        </span>
                      )}
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </fieldset>
        <Field
          label="Requested delivery date"
          hint="Leave empty to use the project’s target opening. Order-by dates are worked back from this: requested delivery − vendor lead time − transit."
        >
          {(id) => <Input id={id} type="date" value={rdd} onChange={(e) => setRdd(e.target.value)} />}
        </Field>
        <p className="text-[13px] text-ink-3">
          Lines already on a purchase order, or not marked ready to order, are skipped. Drafts are not sent to
          vendors until you issue them.
        </p>
      </div>
    </Sheet>
  );
}
