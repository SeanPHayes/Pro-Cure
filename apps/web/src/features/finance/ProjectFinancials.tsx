import { useQuery } from '@tanstack/react-query';
import { format, parseISO } from 'date-fns';
import { Link } from 'react-router';
import { cx, ErrorNote, Section, Spinner, Stat } from '@/components/ui';
import { api } from '@/lib/api';
import { hasPerm, useSession } from '@/lib/auth';
import { money, moneyShort, pct } from '@/lib/format';
import { fk, Warnings } from './shared';
import type { MonthCash, ProjectFinancialsData } from './types';

/**
 * Financial summary for one project: contract, cost commitments, billing and collections, AR/AP,
 * projected vs actual margin, and a 12-month cash in/out chart. Drop into a project page tab.
 */
export function ProjectFinancials({ projectId }: { projectId: string }) {
  const s = useSession();
  const allowed = hasPerm(s, 'finance:read');
  const q = useQuery({
    queryKey: fk.projectFin(projectId),
    queryFn: () => api.get<ProjectFinancialsData>('finance', `/projects/${projectId}/financials`),
    enabled: allowed && !!projectId,
  });
  if (!allowed) return null;
  if (q.isLoading)
    return (
      <div className="flex justify-center py-10">
        <Spinner />
      </div>
    );
  if (q.isError) return <ErrorNote error={q.error} />;
  const f = q.data!;
  const billedPct = f.contractValue > 0 ? (f.invoiced / f.contractValue) * 100 : null;
  const collectedPct = f.invoiced > 0 ? (f.collected / f.invoiced) * 100 : null;
  const actualPct = f.collected > 0 ? (f.actualMarginToDate / f.collected) * 100 : null;

  const stats = [
    <Stat
      key="cv"
      label="Contract value"
      value={moneyShort(f.contractValue)}
      note={
        f.uninvoicedContract > 0 ? `${moneyShort(f.uninvoicedContract)} not yet invoiced` : 'Fully invoiced'
      }
    />,
    <Stat
      key="cc"
      label="Committed cost"
      value={moneyShort(f.committedCost)}
      note={f.estimatedCost > 0 ? `of ${moneyShort(f.estimatedCost)} estimated` : 'Issued purchase orders'}
    />,
    <Stat
      key="inv"
      label="Invoiced"
      value={moneyShort(f.invoiced)}
      note={
        billedPct !== null
          ? `${pct(billedPct, 0)} of contract`
          : `${moneyShort(f.depositsCollected)} deposits in`
      }
    />,
    <Stat
      key="col"
      label="Collected"
      value={moneyShort(f.collected)}
      note={collectedPct !== null ? `${pct(collectedPct, 0)} of invoiced` : 'Nothing invoiced yet'}
    />,
    <Stat
      key="ar"
      label="Owner owes (AR)"
      value={moneyShort(f.arBalance)}
      tone={f.overdueAr > 0 ? 'crit' : undefined}
      note={f.overdueAr > 0 ? `${moneyShort(f.overdueAr)} overdue` : 'Nothing overdue'}
    />,
    <Stat
      key="ap"
      label="We owe vendors (AP)"
      value={moneyShort(f.apOpen)}
      note={`${moneyShort(f.apPaid)} paid of ${moneyShort(f.apBilled)} billed`}
    />,
    <Stat key="pm" label="Projected margin" value={pct(f.projectedMarginPct)} note="From approved quotes" />,
    <Stat
      key="am"
      label="Cash margin to date"
      value={moneyShort(f.actualMarginToDate)}
      tone={f.actualMarginToDate < 0 ? 'crit' : undefined}
      note={actualPct !== null ? `${pct(actualPct)} of collections` : 'Collected less paid to vendors'}
    />,
  ];

  return (
    <div className="space-y-4">
      <Warnings warnings={f.warnings} />
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-line bg-line-2 md:grid-cols-4">
        {stats.map((st) => (
          <div key={st.key} className="bg-paper px-4 py-3.5">
            {st}
          </div>
        ))}
      </div>
      <Section
        title="Cash in and out, last 12 months"
        actions={
          <Link
            to={`/app/finance?tab=invoices&projectId=${projectId}`}
            className="text-[13px] font-[560] text-lacquer hover:underline"
          >
            Project invoices
          </Link>
        }
      >
        <CashChart months={f.byMonth} />
      </Section>
    </div>
  );
}

/** Paired monthly bars: cash in (owner payments, lacquer) and cash out (vendor payments, brass). */
export function CashChart({ months }: { months: MonthCash[] }) {
  const max = Math.max(1, ...months.flatMap((m) => [m.cashIn, m.cashOut]));
  const totalIn = months.reduce((s, m) => s + m.cashIn, 0);
  const totalOut = months.reduce((s, m) => s + m.cashOut, 0);
  const W = 720;
  const PLOT_H = 140;
  const top = 14;
  const H = PLOT_H + top;
  const base = H;
  const slot = W / months.length;
  const bw = slot * 0.28;
  const y = (v: number) => base - ((base - top) * v) / max;
  const label = (m: string) => format(parseISO(`${m}-01`), 'MMM');
  const summary = months
    .filter((m) => m.cashIn || m.cashOut)
    .map((m) => `${label(m.month)}: in ${money(m.cashIn, true)}, out ${money(m.cashOut, true)}`)
    .join('; ');
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-[12px] text-ink-2">
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2 rounded-[2px] bg-lacquer" />
          Cash in <span className="num font-[600] text-ink">{moneyShort(totalIn)}</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2 rounded-[2px] bg-brass-400" />
          Cash out <span className="num font-[600] text-ink">{moneyShort(totalOut)}</span>
        </span>
        <span className={cx('num', totalIn - totalOut < 0 ? 'text-crit' : 'text-ink-3')}>
          Net {moneyShort(totalIn - totalOut)}
        </span>
      </div>
      <div className="relative">
        {/* Gridline labels sit in HTML so type stays a constant size while the bars stretch to fit. */}
        {[1, 0.5].map((t) => (
          <span
            key={t}
            className="num pointer-events-none absolute left-0 text-[11px] leading-none text-ink-4"
            style={{ top: `calc(${(1 - t) * 100}% * ${PLOT_H / H} + ${(top / H) * 100}% - 13px)` }}
          >
            {moneyShort(max * t)}
          </span>
        ))}
        <svg
          viewBox={`0 0 ${W} ${PLOT_H + top}`}
          preserveAspectRatio="none"
          className="block h-[150px] w-full"
          role="img"
          aria-label={summary ? `Monthly cash flow. ${summary}` : 'No cash movement in the last 12 months'}
        >
          {[0.5, 1].map((t) => (
            <line
              key={t}
              x1={0}
              x2={W}
              y1={y(max * t)}
              y2={y(max * t)}
              className="stroke-line"
              strokeDasharray="2 4"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          <line
            x1={0}
            x2={W}
            y1={base}
            y2={base}
            className="stroke-ink-4"
            vectorEffect="non-scaling-stroke"
          />
          {months.map((m, i) => {
            const c = slot * i + slot / 2;
            return (
              <g key={m.month}>
                <title>{`${format(parseISO(`${m.month}-01`), 'MMMM yyyy')}: in ${money(m.cashIn)}, out ${money(m.cashOut)}`}</title>
                <rect x={c - slot / 2} y={0} width={slot} height={base} fill="transparent" />
                {m.cashIn > 0 && (
                  <rect
                    x={c - bw - 1}
                    y={y(m.cashIn)}
                    width={bw}
                    height={base - y(m.cashIn)}
                    className="fill-lacquer"
                  />
                )}
                {m.cashOut > 0 && (
                  <rect
                    x={c + 1}
                    y={y(m.cashOut)}
                    width={bw}
                    height={base - y(m.cashOut)}
                    className="fill-brass-400"
                  />
                )}
              </g>
            );
          })}
        </svg>
        <div
          className="mt-1.5 grid"
          style={{ gridTemplateColumns: `repeat(${months.length}, minmax(0, 1fr))` }}
        >
          {months.map((m, i) => (
            <span
              key={m.month}
              className={cx('text-center text-[11px] text-ink-3', i % 2 === 1 && 'max-sm:invisible')}
            >
              {label(m.month)}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
