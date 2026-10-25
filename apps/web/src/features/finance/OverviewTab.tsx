import { useQuery } from '@tanstack/react-query';
import { CalendarClock, Landmark } from 'lucide-react';
import { Link, useNavigate } from 'react-router';
import { cx, EmptyState, ErrorNote, Loading, Section, Stat } from '@/components/ui';
import { type Column, DataTable } from '@/components/ui/DataTable';
import { api, type Page } from '@/lib/api';
import { date, moneyShort, pct } from '@/lib/format';
import { AgingBar } from './AgingBar';
import { dueNote, dueTone, fk, Money, Warnings } from './shared';
import type { Invoice, Portfolio, PortfolioRow } from './types';

const TOTAL = '__total';

const marginTone = (m: number | null) =>
  m === null ? 'text-ink-4' : m < 10 ? 'text-crit' : m < 18 ? 'text-warn' : 'text-ink';

export function OverviewTab({ go }: { go: (tab: string, extra?: Record<string, string>) => void }) {
  const q = useQuery({
    queryKey: fk.portfolio,
    queryFn: () => api.get<Portfolio>('finance', '/financials/portfolio'),
  });
  if (q.isLoading) return <Loading label="Adding up the portfolio" />;
  if (q.isError) return <ErrorNote error={q.error} />;
  const p = q.data!;
  const t = p.totals;
  const projectName = new Map(p.rows.map((r) => [r.projectId, r]));
  const arTotal = Object.values(p.arAging).reduce((s, v) => s + v, 0);

  const columns: Column<PortfolioRow & { id: string }>[] = [
    {
      key: 'project',
      header: 'Project',
      cell: (r) =>
        r.id === TOTAL ? (
          <span>Portfolio total</span>
        ) : (
          <div className="min-w-[220px]">
            <Link
              to={`/app/projects/${r.projectId}`}
              onClick={(e) => e.stopPropagation()}
              className="font-[560] hover:underline"
            >
              {r.projectName || 'Untitled project'}
            </Link>
            <div className="num text-[12px] text-ink-3">{r.projectNumber}</div>
          </div>
        ),
    },
    {
      key: 'contract',
      header: 'Contract value',
      align: 'right',
      cell: (r) => <Money value={r.contractValue} muted0 />,
    },
    {
      key: 'committed',
      header: 'Committed cost',
      align: 'right',
      cell: (r) => <Money value={r.committedCost} muted0 />,
    },
    { key: 'invoiced', header: 'Invoiced', align: 'right', cell: (r) => <Money value={r.invoiced} muted0 /> },
    {
      key: 'collected',
      header: 'Collected',
      align: 'right',
      cell: (r) => <Money value={r.collected} muted0 />,
    },
    {
      key: 'ar',
      header: 'AR balance',
      align: 'right',
      cell: (r) => (
        <div>
          <Money value={r.arBalance} muted0 />
          {r.overdueAr > 0 && (
            <div className="num text-[12px] text-crit">{moneyShort(r.overdueAr)} overdue</div>
          )}
        </div>
      ),
    },
    {
      key: 'margin',
      header: 'Projected margin',
      align: 'right',
      cell: (r) => <span className={marginTone(r.projectedMarginPct)}>{pct(r.projectedMarginPct)}</span>,
    },
  ];

  return (
    <div className="mx-auto max-w-[1360px] space-y-4 px-4 py-5 sm:px-6">
      <Warnings warnings={p.warnings} />
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-line bg-line-2 md:grid-cols-3 xl:grid-cols-6">
        {[
          <Stat
            key="c"
            label="Contract value"
            value={moneyShort(t.contractValue)}
            note="Client-approved quotes"
          />,
          <Stat
            key="i"
            label="Invoiced"
            value={moneyShort(t.invoiced)}
            note={`${moneyShort(t.collected)} collected`}
          />,
          <Stat
            key="ar"
            label="Open receivables"
            value={moneyShort(t.arBalance)}
            tone={t.overdueAr > 0 ? 'crit' : undefined}
            note={t.overdueAr > 0 ? `${moneyShort(t.overdueAr)} overdue` : 'Nothing overdue'}
          />,
          <Stat
            key="ap"
            label="Open payables"
            value={moneyShort(t.apOpen)}
            note={`${moneyShort(t.apPaid)} paid to vendors`}
          />,
          <Stat
            key="cm"
            label="Committed cost"
            value={moneyShort(t.committedCost)}
            note="Issued purchase orders"
          />,
          <Stat
            key="m"
            label="Projected margin"
            value={pct(t.projectedMarginPct)}
            note={`${moneyShort(t.actualMarginToDate)} cash margin to date`}
          />,
        ].map((stat) => (
          <div key={stat.key} className="bg-paper px-4 py-3.5">
            {stat}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <Section
          className="min-w-0"
          title="Receivables aging"
          actions={
            <button
              type="button"
              onClick={() => go('invoices', { status: 'open' })}
              className="text-[13px] font-[560] text-lacquer hover:underline"
            >
              Open invoices
            </button>
          }
        >
          {arTotal > 0 ? (
            <>
              <p className="mb-3 text-ink-2">
                <span className="num text-[20px] font-[620] text-ink">{moneyShort(arTotal)}</span> outstanding
                from owners as of {date(p.asOf)}.
              </p>
              <AgingBar aging={p.arAging} onSelect={(b) => go('invoices', { aging: b })} />
              <LargestOverdue onAll={() => go('invoices', { overdue: 'true', sort: '-balance' })} />
            </>
          ) : (
            <EmptyState icon={<Landmark />} title="No open receivables">
              Sent invoices with a balance show up here, grouped by how far past due they are.
            </EmptyState>
          )}
        </Section>

        <Section
          className="min-w-0"
          title="Payables due in the next 30 days"
          bodyClassName=""
          actions={
            <button
              type="button"
              onClick={() => go('bills', { due: '30' })}
              className="text-[13px] font-[560] text-lacquer hover:underline"
            >
              All bills
            </button>
          }
        >
          {p.apDueNext30.count === 0 ? (
            <EmptyState icon={<CalendarClock />} title="Nothing due to vendors">
              Open vendor bills due within 30 days will be listed here.
            </EmptyState>
          ) : (
            <>
              <div className="flex items-baseline justify-between border-b border-line-2 px-4 py-2 text-[13px] text-ink-2">
                <span>
                  {p.apDueNext30.count} {p.apDueNext30.count === 1 ? 'bill' : 'bills'}
                </span>
                <Money value={p.apDueNext30.total} className="font-[620] text-ink" />
              </div>
              <ul className="max-h-[320px] divide-y divide-line-2 overflow-y-auto">
                {p.apDueNext30.items.map((b) => {
                  const note = dueNote(b.dueDate, true);
                  return (
                    <li key={b.id}>
                      <button
                        type="button"
                        onClick={() => go('bills', { q: b.number })}
                        className="flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-stone"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-[560]">{b.vendorName}</div>
                          <div className="truncate text-[12px] text-ink-3">
                            {b.number}
                            {b.poNumber ? ` · ${b.poNumber}` : ''}
                            {projectName.get(b.projectId)
                              ? ` · ${projectName.get(b.projectId)!.projectNumber}`
                              : ''}
                          </div>
                        </div>
                        <div className="shrink-0 text-right">
                          <Money value={b.balance} className="font-[560]" />
                          <div className={cx('num text-[12px]', dueTone(b.dueDate, true))}>
                            {note ?? date(b.dueDate)}
                          </div>
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </Section>
      </div>

      <Section title="Projects" bodyClassName="" className="overflow-hidden">
        <div className="[&_td:first-child]:pl-4 [&_td:last-child]:pr-4 [&_th:first-child]:pl-4 [&_th:last-child]:pr-4">
          <DataTable
            columns={columns}
            rows={
              p.rows.length
                ? [
                    ...p.rows.map((r) => ({ ...r, id: r.projectId })),
                    ...(p.rows.length > 1
                      ? [
                          {
                            ...t,
                            id: TOTAL,
                            projectId: TOTAL,
                            projectNumber: '',
                            projectName: '',
                            status: null,
                          },
                        ]
                      : []),
                  ]
                : []
            }
            onRowClick={(r) => r.id !== TOTAL && go('invoices', { projectId: r.projectId })}
            rowClassName={(r) =>
              r.id === TOTAL ? 'font-[620] [&_td]:border-t [&_td]:border-line [&_td]:!bg-stone' : undefined
            }
            empty={
              <EmptyState icon={<Landmark />} title="No project financials yet">
                Projects appear here once they have an invoice or a vendor bill.
              </EmptyState>
            }
          />
        </div>
      </Section>
    </div>
  );
}

/** The handful of overdue invoices worth a phone call today. */
function LargestOverdue({ onAll }: { onAll: () => void }) {
  const nav = useNavigate();
  const q = useQuery({
    queryKey: fk.invoices({ overdue: true, sort: '-balance', limit: 5 }),
    queryFn: () =>
      api.get<Page<Invoice>>('finance', '/invoices', { overdue: true, sort: '-balance', limit: 5 }),
  });
  if (!q.data?.items.length) return null;
  return (
    <div className="mt-5 border-t border-line-2 pt-3">
      <div className="mb-1 flex items-baseline justify-between">
        <h3 className="text-[13px] font-[600]">Largest overdue</h3>
        {q.data.total > q.data.items.length && (
          <button
            type="button"
            onClick={onAll}
            className="text-[13px] font-[560] text-lacquer hover:underline"
          >
            All {q.data.total} overdue
          </button>
        )}
      </div>
      <ul className="-mx-4 divide-y divide-line-2">
        {q.data.items.map((i) => (
          <li key={i.id}>
            <button
              type="button"
              onClick={() => nav(`/app/invoices/${i.id}`)}
              className="flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-stone"
            >
              <span className="num w-[92px] shrink-0 font-[560]">{i.number}</span>
              <span className="min-w-0 flex-1 truncate text-ink-2">
                {i.clientName}
                <span className="text-ink-3"> · {i.projectNumber}</span>
              </span>
              <span className="num hidden shrink-0 text-[12px] text-crit sm:inline">
                {i.daysOverdue}d late
              </span>
              <Money value={i.balance} className="w-[96px] shrink-0 text-right font-[560]" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
