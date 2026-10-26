import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ArrowRight, PackageCheck } from 'lucide-react';
import { Link } from 'react-router';
import { Chips, cx, EmptyState, ErrorNote, Loading, SearchInput, StatusBadge } from '@/components/ui';
import { Pagination } from '@/components/ui/DataTable';
import type { VendorPoSummary } from '@/features/orders/types';
import { api, type Page } from '@/lib/api';
import { useMe } from '@/lib/auth';
import { date, money } from '@/lib/format';
import { useListParams, useSearchParamInput } from '@/lib/hooks';

type VendorAction = 'acknowledge' | 'confirm_ship_date' | 'add_tracking' | 'submit_documents';
type Row = VendorPoSummary & { shipToCity?: string | null; actions?: VendorAction[] };

export const VENDOR_ACTION_LABEL: Record<VendorAction, string> = {
  acknowledge: 'Acknowledge the order',
  confirm_ship_date: 'Confirm ship date',
  add_tracking: 'Add tracking',
  submit_documents: 'Send drawings or samples',
};

/** Vendor-facing status names: plain, from their side of the order. */
export const VENDOR_STATUS_LABEL: Record<string, string> = {
  issued: 'New order',
  acknowledged: 'Acknowledged',
  in_production: 'In production',
  partially_shipped: 'Partly shipped',
  shipped: 'Shipped',
  partially_delivered: 'Partly delivered',
  delivered: 'Delivered',
  closed: 'Closed',
  cancelled: 'Cancelled',
};

const DEFAULTS = { show: 'open', q: '', limit: '50' };
const OPEN = 'issued,acknowledged,in_production,partially_shipped,shipped,partially_delivered';

export function Component() {
  const s = useMe();
  const firm = s.contexts.find((c) => c.tenantId === s.context.tenantId)?.tenantName ?? 'your client';
  const [p, set] = useListParams(DEFAULTS);
  const [text, setText] = useSearchParamInput(p.q, (q) => set({ q }));
  const query = {
    status: p.show === 'open' ? OPEN : p.show === 'done' ? 'delivered,closed,cancelled' : undefined,
    q: p.q || undefined,
    limit: Number(p.limit),
    offset: Number(p.offset),
  };
  const list = useQuery({
    queryKey: ['vendor', 'pos', query],
    queryFn: () => api.get<Page<Row>>('orders', '/vendor/purchase-orders', query),
    placeholderData: keepPreviousData,
  });
  const rows = list.data?.items ?? [];
  const needing = rows.filter((r) => r.actions?.length || r.openActions > 0).length;

  return (
    <div className="mx-auto max-w-[1080px] px-4 py-6 sm:px-6">
      <h1 className="text-[24px] leading-tight font-[640]">Purchase orders</h1>
      <p className="mt-1 max-w-[66ch] text-ink-2">
        Orders from {firm}. Open one to acknowledge it, confirm or update your ship date, add tracking when it
        ships, and send shop drawings or finish samples for approval.
      </p>

      {needing > 0 && p.show === 'open' && (
        <p className="mt-4 rounded-md border border-brass/40 bg-brass-50 px-4 py-3">
          <span className="font-[620]">
            {needing === 1 ? 'One order needs' : `${needing} orders need`} something from you.
          </span>{' '}
          <span className="text-ink-2">They’re listed first.</span>
        </p>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <Chips
          value={p.show as 'open' | 'done' | 'all'}
          onChange={(show) => set({ show })}
          options={[
            { value: 'open', label: 'Open' },
            { value: 'done', label: 'Delivered & closed' },
            { value: 'all', label: 'All' },
          ]}
        />
        <SearchInput
          value={text}
          onChange={setText}
          placeholder="PO number or project"
          className="w-full sm:w-60"
        />
      </div>

      <div className="mt-3 overflow-hidden rounded-md border border-line bg-paper">
        {list.isError ? (
          <ErrorNote error={list.error} />
        ) : list.isLoading ? (
          <Loading label="Loading your orders" />
        ) : !rows.length ? (
          <EmptyState icon={<PackageCheck />} title={p.show === 'open' ? 'No open orders' : 'No orders here'}>
            When {firm} issues you a purchase order, it appears here and you get an email with the PDF.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line-2">
            {rows.map((r) => {
              const actions = r.actions ?? [];
              return (
                <li key={r.id}>
                  <Link
                    to={`/vendor/orders/${r.id}`}
                    className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 px-4 py-3 hover:bg-stone md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_140px_auto]"
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="num font-[620]">{r.number}</span>
                        {r.revision > 0 && (
                          <span className="num text-[12px] text-ink-3">Revision {r.revision}</span>
                        )}
                        <StatusBadge status={r.status} label={VENDOR_STATUS_LABEL[r.status]} />
                      </div>
                      <div className="truncate text-[13px] text-ink-2">
                        {r.projectName}
                        {r.shipToCity && <span className="text-ink-3"> · ships to {r.shipToCity}</span>}
                      </div>
                    </div>
                    <div className="col-span-2 row-start-2 min-w-0 md:col-span-1 md:row-start-auto">
                      {actions.length ? (
                        <ul className="flex flex-wrap gap-1.5">
                          {actions.map((a) => (
                            <li
                              key={a}
                              className="rounded-xs bg-brass-50 px-1.5 py-0.5 text-[12px] font-[620] text-brass"
                            >
                              {VENDOR_ACTION_LABEL[a]}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <span className="text-[13px] text-ink-3">Nothing needed right now</span>
                      )}
                    </div>
                    <div className="num hidden text-[13px] md:block">
                      <div className="text-[12px] text-ink-3">Requested delivery</div>
                      {date(r.requestedDeliveryDate)}
                    </div>
                    <div className="flex items-center gap-3 text-right">
                      <div className="num">
                        <div className="font-[560]">{money(r.total, true)}</div>
                        <div className={cx('text-[12px] text-ink-3', !r.nextShipDate && 'invisible')}>
                          ships {date(r.nextShipDate)}
                        </div>
                      </div>
                      <ArrowRight className="hidden size-4 text-ink-4 sm:block" />
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
        {list.data && (
          <Pagination
            total={list.data.total}
            limit={list.data.limit}
            offset={list.data.offset}
            onChange={(o) => set({ offset: String(o) })}
          />
        )}
      </div>
    </div>
  );
}
