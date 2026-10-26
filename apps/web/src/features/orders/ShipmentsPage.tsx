import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  addMonths,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isSameMonth,
  isToday,
  parseISO,
  startOfMonth,
  startOfWeek,
} from 'date-fns';
import { CalendarDays, ChevronLeft, ChevronRight, Sparkles, Truck } from 'lucide-react';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';
import {
  Button,
  Chips,
  cx,
  EmptyState,
  ErrorNote,
  PageHeader,
  SearchInput,
  Select,
  Spinner,
  StatusBadge,
} from '@/components/ui';
import { type Column, DataTable, Pagination } from '@/components/ui/DataTable';
import { Tooltip } from '@/components/ui/Tooltip';
import { api, type Page } from '@/lib/api';
import { hasPerm, useSession } from '@/lib/auth';
import { ago, date } from '@/lib/format';
import { useListParams, useSearchParamInput } from '@/lib/hooks';
import {
  ESCALATION_LABEL,
  humanReason,
  lateness,
  ok,
  RiskMark,
  relDays,
  TrackingLink,
  useProjectsLite,
} from './shared';
import type { CalendarEvent, Escalation, RiskSummary, ShipmentRow } from './types';

const VIEWS = ['ships', 'delivers', 'tracking', 'exceptions', 'all'] as const;
type View = (typeof VIEWS)[number];
const VIEW_QUERY: Record<View, Record<string, string | number | boolean>> = {
  ships: { shipsWithinDays: 14, sort: 'estimatedShipDate' },
  delivers: { deliversWithinDays: 14, sort: 'effectiveDeliveryDate' },
  tracking: { trackingMissing: true },
  exceptions: { escalation: 'at_risk,critical', sort: '-escalation' },
  all: { sort: 'estimatedShipDate' },
};
const EMPTY: Record<View, string> = {
  ships: 'Nothing is due to ship in the next 14 days.',
  delivers: 'Nothing is due to deliver in the next 14 days.',
  tracking: 'Every shipment past its ship date has tracking. Nice.',
  exceptions: 'No shipments are at risk right now.',
  all: 'No open shipments. Shipments appear once purchase orders are issued.',
};

const DEFAULTS = { view: 'ships', mode: 'table', projectId: '', q: '', month: '', limit: '100' };

export function Component() {
  const [p, set] = useListParams(DEFAULTS);
  const [text, setText] = useSearchParamInput(p.q, (q) => set({ q }));
  const view = (VIEWS as readonly string[]).includes(p.view) ? (p.view as View) : 'ships';
  const projects = useProjectsLite();
  const s = useSession();
  return (
    <>
      <PageHeader
        title="Shipments"
        description="What ships and delivers in the next two weeks across every project, and what’s slipping."
        actions={
          <Chips
            value={p.mode as 'table' | 'calendar'}
            onChange={(mode) => set({ mode })}
            options={[
              { value: 'table', label: 'List' },
              { value: 'calendar', label: 'Calendar' },
            ]}
          />
        }
      >
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {p.mode !== 'calendar' && (
            <div className="max-w-full overflow-x-auto">
              <Chips
                value={view}
                onChange={(v) => set({ view: v })}
                options={[
                  { value: 'ships', label: 'Shipping in 14 days' },
                  { value: 'delivers', label: 'Delivering in 14 days' },
                  { value: 'tracking', label: 'Tracking missing' },
                  { value: 'exceptions', label: 'Exceptions' },
                  { value: 'all', label: 'All open' },
                ]}
              />
            </div>
          )}
          <div className="w-full sm:w-[240px]">
            <Select
              aria-label="Project"
              value={p.projectId}
              onChange={(e) => set({ projectId: e.target.value })}
              placeholder="All projects"
              options={(projects.data ?? []).map((x) => ({ value: x.id, label: `${x.number} ${x.name}` }))}
            />
          </div>
          {p.mode !== 'calendar' && (
            <SearchInput
              value={text}
              onChange={setText}
              placeholder="PO, vendor, tracking #"
              className="w-full sm:w-56"
            />
          )}
        </div>
      </PageHeader>
      <div className="space-y-4 px-4 py-4 sm:px-6">
        {hasPerm(s, 'ai:use') && <RiskStrip />}
        {p.mode === 'calendar' ? (
          <CalendarView
            month={p.month}
            onMonth={(month) => set({ month })}
            projectId={p.projectId || undefined}
          />
        ) : (
          <ShipmentTable
            view={view}
            projectId={p.projectId}
            q={p.q}
            offset={p.offset}
            limit={p.limit}
            set={set}
          />
        )}
      </div>
    </>
  );
}

// ------------------------------------------------------------------ risk strip
const LEVEL_TONE: Record<Escalation, string> = {
  none: 'text-ink-2',
  watch: 'text-warn',
  at_risk: 'text-risk',
  critical: 'text-crit',
};

function RiskStrip() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['ai', 'risk-summary'],
    queryFn: () => api.get<RiskSummary>('ai', '/risk/summary'),
    retry: false,
    meta: { silent: true },
  });
  const run = useMutation({
    mutationFn: () => api.post<{ id: string; status: string }>('ai', '/jobs/risk-score', {}),
    onSuccess: (j) => {
      toast.success('Risk model started', {
        description: 'Scores and reasons update on every open shipment in a few seconds.',
      });
      const poll = (n: number) =>
        setTimeout(async () => {
          const job = await api.get<{ status: string }>('ai', `/jobs/${j.id}`).catch(() => null);
          if (job && ['queued', 'running'].includes(job.status) && n < 20) poll(n + 1);
          else {
            qc.invalidateQueries({ queryKey: ['ai', 'risk-summary'] });
            qc.invalidateQueries({ queryKey: ['orders'] });
            if (job?.status === 'failed') toast.error('The risk model run failed. Try again in a minute.');
          }
        }, 1500);
      poll(0);
    },
  });
  if (q.isLoading)
    return (
      <div className="flex h-[92px] items-center justify-center rounded-md border border-line bg-paper">
        <Spinner />
      </div>
    );
  if (q.isError || !q.data) return null;
  const d = q.data;
  const levels: Escalation[] = ['critical', 'at_risk', 'watch', 'none'];
  return (
    <section className="rounded-md border border-line bg-paper">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line-2 px-4 py-2.5">
        <h2 className="flex flex-wrap items-center gap-x-2 text-[14px] font-[620]">
          <Sparkles className="size-4 text-brass" />
          <span className="whitespace-nowrap">Delivery risk</span>
          <span className="text-[12.5px] font-[480] text-ink-3">
            {d.run ? `${d.run.shipmentsScored} open shipments scored ${ago(d.run.runAt)}` : 'Not run yet'}
          </span>
        </h2>
        <Button
          size="sm"
          icon={<Sparkles className="size-3.5" />}
          loading={run.isPending}
          onClick={() => run.mutate()}
        >
          Run risk model
        </Button>
      </header>
      <div className="grid gap-4 p-4 lg:grid-cols-[auto_minmax(0,1fr)]">
        <dl className="grid grid-cols-4 gap-4 lg:w-[360px]">
          {levels.map((l) => (
            <div key={l}>
              <dt className="text-[12px] text-ink-3">{ESCALATION_LABEL[l]}</dt>
              <dd
                className={cx('num text-[22px] leading-tight font-[620]', d.counts[l] > 0 && LEVEL_TONE[l])}
              >
                {d.counts[l]}
              </dd>
            </div>
          ))}
        </dl>
        {d.top.filter((t) => t.level !== 'none' && t.level !== 'low').length > 0 ? (
          <ul className="min-w-0 divide-y divide-line-2 rounded-sm border border-line-2">
            {d.top
              .filter((t) => t.level !== 'none' && t.level !== 'low')
              .slice(0, 3)
              .map((t) => (
                <li key={t.shipmentId}>
                  <Link
                    to={t.poId ? `/app/orders/${t.poId}?tab=shipments` : '#'}
                    className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-3 px-3 py-2 hover:bg-stone sm:grid-cols-[auto_minmax(0,220px)_minmax(0,1fr)]"
                  >
                    <span
                      className="num mt-0.5 w-9 text-right font-[640] text-risk"
                      title="Risk score out of 100"
                    >
                      {Math.round(t.score)}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate font-[560]">{t.label}</span>
                      <span className="block truncate text-[12px] text-ink-3">{t.projectName}</span>
                    </span>
                    <span className="col-span-2 line-clamp-2 text-[13px] text-ink-2 sm:col-span-1">
                      {humanReason(t.reasons[0] ?? '')}
                    </span>
                  </Link>
                </li>
              ))}
          </ul>
        ) : (
          d.narrative && <p className="text-ink-2">{d.narrative}</p>
        )}
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ table
function ShipmentTable({
  view,
  projectId,
  q,
  offset,
  limit,
  set,
}: {
  view: View;
  projectId: string;
  q: string;
  offset: string;
  limit: string;
  set: (p: Record<string, string>) => void;
}) {
  const nav = useNavigate();
  const query = {
    ...VIEW_QUERY[view],
    projectId: projectId || undefined,
    q: q || undefined,
    limit: Number(limit),
    offset: Number(offset),
  };
  const list = useQuery({
    queryKey: ok.shipments(query),
    queryFn: () => api.get<Page<ShipmentRow>>('orders', '/shipments', query),
    placeholderData: keepPreviousData,
  });
  const cols: Column<ShipmentRow>[] = [
    {
      key: 'po',
      header: 'Shipment',
      cell: (r) => (
        <div className="whitespace-nowrap">
          <Link
            to={`/app/orders/${r.poId}?tab=shipments`}
            onClick={(e) => e.stopPropagation()}
            className="num font-[620] hover:text-lacquer hover:underline"
          >
            {r.poNumber}-{r.label}
          </Link>
          {r.note && <div className="text-[12px] text-ink-2">{r.note}</div>}
        </div>
      ),
    },
    {
      key: 'vendor',
      header: 'Vendor · project',
      cell: (r) => (
        <div className="max-w-[220px] min-w-[150px]">
          <div className="truncate font-[560]">{r.vendorName}</div>
          <div className="truncate text-[12px] text-ink-3">{r.projectName}</div>
        </div>
      ),
    },
    { key: 'status', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
    {
      key: 'risk',
      header: 'Risk',
      cell: (r) => <RiskMark level={r.escalation} reasons={r.escalationReasons} score={r.riskScore} />,
    },
    {
      key: 'ship',
      header: 'Ship date',
      cell: (r) => {
        const d = r.actualShipDate ?? r.estimatedShipDate;
        const unconfirmed =
          !r.actualShipDate &&
          (!r.lastConfirmedAt || (r.lastConfirmationRequestedAt ?? '') > r.lastConfirmedAt);
        return d ? (
          <div className="num whitespace-nowrap">
            <div>{date(d)}</div>
            <div className={cx('text-[12px]', unconfirmed ? 'text-warn' : 'text-ink-3')}>
              {r.actualShipDate ? 'shipped' : relDays(d)}
              {unconfirmed && ' · unconfirmed'}
              {r.shipDateChanges > 0 && ` · moved ${r.shipDateChanges}×`}
            </div>
          </div>
        ) : (
          <span className="text-ink-4">Not set</span>
        );
      },
    },
    {
      key: 'delivery',
      header: 'Delivery',
      cell: (r) => {
        const late = lateness(r.effectiveDeliveryDate, r.requestedDeliveryDate);
        return (
          <div className="num whitespace-nowrap">
            <div>{date(r.effectiveDeliveryDate)}</div>
            <div className={cx('text-[12px]', late && late > 0 ? 'font-[560] text-crit' : 'text-ink-3')}>
              {late && late > 0 ? `${late} days after requested` : relDays(r.effectiveDeliveryDate)}
            </div>
          </div>
        );
      },
    },
    {
      key: 'tracking',
      header: 'Tracking',
      cell: (r) =>
        r.trackingMissing ? (
          <span className="text-[12.5px] font-[560] text-crit">Missing, ship date passed</span>
        ) : (
          <TrackingLink carrier={r.carrier} number={r.trackingNumber} url={r.trackingUrl} />
        ),
    },
    {
      key: 'dest',
      header: 'To',
      cell: (r) => (
        <span className="text-[13px] text-ink-2">{r.destination === 'warehouse' ? 'Warehouse' : 'Site'}</span>
      ),
    },
  ];
  if (list.isError) return <ErrorNote error={list.error} />;
  return (
    <div className="overflow-hidden rounded-md border border-line bg-paper">
      <DataTable
        columns={cols}
        rows={list.data?.items}
        loading={list.isLoading}
        onRowClick={(r) => nav(`/app/orders/${r.poId}?tab=shipments`)}
        empty={
          <EmptyState icon={<Truck />} title={q || projectId ? 'No shipments match' : 'All clear'}>
            {q || projectId ? 'Try another project or search.' : EMPTY[view]}
          </EmptyState>
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
  );
}

// ------------------------------------------------------------------ calendar
const KIND_STYLE: Record<CalendarEvent['kind'], { label: string; chip: string; dot: string }> = {
  delivery: { label: 'Delivery', chip: 'bg-lacquer-50 text-lacquer border-lacquer/25', dot: 'bg-lacquer' },
  delivered: { label: 'Delivered', chip: 'bg-ok-50 text-ok border-ok/25', dot: 'bg-ok' },
  ship: { label: 'Ships', chip: 'bg-info-50 text-info border-info/25', dot: 'bg-info' },
  release_by: { label: 'Order-by', chip: 'bg-brass-50 text-brass border-brass/30', dot: 'bg-brass' },
};

function CalendarView({
  month,
  onMonth,
  projectId,
}: {
  month: string;
  onMonth: (m: string) => void;
  projectId?: string;
}) {
  const nav = useNavigate();
  const anchor = month ? parseISO(`${month}-01`) : startOfMonth(new Date());
  const from = startOfWeek(startOfMonth(anchor), { weekStartsOn: 1 });
  const to = endOfWeek(endOfMonth(anchor), { weekStartsOn: 1 });
  const range = { from: format(from, 'yyyy-MM-dd'), to: format(to, 'yyyy-MM-dd'), projectId };
  const q = useQuery({
    queryKey: ['orders', 'calendar', range],
    queryFn: () => api.get<{ events: CalendarEvent[] }>('orders', '/calendar', range),
    placeholderData: keepPreviousData,
  });
  const byDay = new Map<string, CalendarEvent[]>();
  for (const e of q.data?.events ?? []) byDay.set(e.date, [...(byDay.get(e.date) ?? []), e]);
  const days = eachDayOfInterval({ start: from, end: to });
  const go = (n: number) => onMonth(format(addMonths(anchor, n), 'yyyy-MM'));

  return (
    <section className="rounded-md border border-line bg-paper">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line-2 px-4 py-2.5">
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label="Previous month"
            onClick={() => go(-1)}
            className="grid size-8 place-items-center rounded-sm hover:bg-stone"
          >
            <ChevronLeft className="size-4" />
          </button>
          <h2 className="min-w-[140px] text-center text-[15px] font-[620]">{format(anchor, 'MMMM yyyy')}</h2>
          <button
            type="button"
            aria-label="Next month"
            onClick={() => go(1)}
            className="grid size-8 place-items-center rounded-sm hover:bg-stone"
          >
            <ChevronRight className="size-4" />
          </button>
          <Button size="sm" variant="ghost" onClick={() => onMonth('')}>
            Today
          </Button>
          {q.isFetching && <Spinner className="size-4" />}
        </div>
        <ul className="flex flex-wrap gap-3 text-[12px] text-ink-2">
          {(Object.keys(KIND_STYLE) as CalendarEvent['kind'][]).map((k) => (
            <li key={k} className="flex items-center gap-1.5">
              <span className={cx('size-2 rounded-full', KIND_STYLE[k].dot)} />
              {KIND_STYLE[k].label}
            </li>
          ))}
        </ul>
      </header>
      {/* Desktop month grid */}
      <div className="hidden md:block">
        <div className="grid grid-cols-7 border-b border-line-2 bg-stone text-[12px] font-[560] text-ink-2">
          {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
            <div key={d} className="px-2 py-1.5">
              {d}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {days.map((d) => {
            const key = format(d, 'yyyy-MM-dd');
            const evs = byDay.get(key) ?? [];
            const inMonth = isSameMonth(d, anchor);
            return (
              <div
                key={key}
                className={cx(
                  'min-h-[112px] border-r border-b border-line-2 p-1.5 [&:nth-child(7n)]:border-r-0',
                  !inMonth && 'bg-stone/50',
                )}
              >
                <div
                  className={cx(
                    'num mb-1 inline-grid size-6 place-items-center rounded-full text-[12px]',
                    isToday(d) ? 'bg-lacquer font-[620] text-white' : inMonth ? 'text-ink-2' : 'text-ink-4',
                  )}
                >
                  {format(d, 'd')}
                </div>
                <ul className="space-y-1">
                  {evs.slice(0, 4).map((e) => (
                    <li key={`${e.kind}${e.poId}${e.shipmentId}`}>
                      <EventChip
                        e={e}
                        onOpen={() =>
                          nav(`/app/orders/${e.poId}${e.kind === 'release_by' ? '' : '?tab=shipments'}`)
                        }
                      />
                    </li>
                  ))}
                  {evs.length > 4 && (
                    <li className="px-1 text-[11.5px] text-ink-3">+{evs.length - 4} more</li>
                  )}
                </ul>
              </div>
            );
          })}
        </div>
      </div>
      {/* Mobile agenda */}
      <div className="md:hidden">
        {![...byDay.keys()].some((k) => k.startsWith(format(anchor, 'yyyy-MM'))) ? (
          <EmptyState icon={<CalendarDays />} title="Nothing scheduled this month" />
        ) : (
          <ol className="divide-y divide-line-2">
            {[...byDay.entries()]
              .filter(([k]) => k.startsWith(format(anchor, 'yyyy-MM')))
              .map(([k, evs]) => (
                <li key={k} className="px-4 py-2.5">
                  <div
                    className={cx(
                      'mb-1 text-[12.5px] font-[620]',
                      isToday(parseISO(k)) ? 'text-lacquer' : 'text-ink-2',
                    )}
                  >
                    {format(parseISO(k), 'EEE, MMM d')}
                  </div>
                  <ul className="space-y-1">
                    {evs.map((e) => (
                      <li key={`${e.kind}${e.poId}${e.shipmentId}`}>
                        <EventChip e={e} wide onOpen={() => nav(`/app/orders/${e.poId}`)} />
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
          </ol>
        )}
      </div>
    </section>
  );
}

function EventChip({ e, onOpen, wide }: { e: CalendarEvent; onOpen: () => void; wide?: boolean }) {
  const st = KIND_STYLE[e.kind];
  const label = `${st.label} ${e.poNumber}${e.shipmentLabel ? `-${e.shipmentLabel}` : ''}`;
  const risky = e.escalation === 'at_risk' || e.escalation === 'critical';
  return (
    <Tooltip
      content={
        <span>
          {e.title.replace(/^(Release-by|Order-by)/, 'Order-by date')}
          <br />
          {e.projectName}
          {e.escalation !== 'none' && ` · ${ESCALATION_LABEL[e.escalation]}`}
        </span>
      }
      className="w-full"
    >
      <button
        type="button"
        onClick={onOpen}
        className={cx(
          'flex w-full items-center gap-1 truncate rounded-xs border px-1.5 py-0.5 text-left text-[11.5px] font-[560] hover:brightness-95',
          st.chip,
          risky && 'ring-1 ring-risk/60',
        )}
      >
        {risky && (
          <>
            <span className="size-1.5 shrink-0 rounded-full bg-risk" />
            <span className="sr-only">At risk:</span>
          </>
        )}
        <span className="truncate">
          {label}
          {wide && <span className="font-[480] text-ink-2"> · {e.vendorName}</span>}
        </span>
      </button>
    </Tooltip>
  );
}
