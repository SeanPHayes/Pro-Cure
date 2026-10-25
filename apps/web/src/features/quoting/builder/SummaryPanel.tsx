import { useState } from 'react';
import { Chips, cx, Spinner } from '@/components/ui';
import { money, moneyShort, pct } from '@/lib/format';
import { categoryLabel, FLAG_META, FLAG_ORDER, MarginCell } from '../shared';
import type { LineFlag, QuoteDetail, Summary } from '../types';

/**
 * Totals and breakdowns for the quote. Flag counts act as filters for the grid. Designers (no cost
 * visibility) see sell-side figures only.
 */
export function SummaryPanel({
  quote,
  summary,
  costs,
  flag,
  onFlag,
  breakdownFilter,
  onBreakdown,
}: {
  quote: QuoteDetail;
  summary: Summary | undefined;
  costs: boolean;
  flag: LineFlag | null;
  onFlag: (f: LineFlag | null) => void;
  breakdownFilter?: { by: 'location' | 'category' | 'vendor'; key: string | null } | null;
  onBreakdown?: (f: { by: 'location' | 'category' | 'vendor'; key: string | null } | null) => void;
}) {
  const [by, setBy] = useState<'location' | 'category' | 'vendor'>('location');
  const t = summary?.totals ?? quote.totals;
  const buckets =
    summary &&
    (by === 'location' ? summary.byLocation : by === 'category' ? summary.byCategory : summary.byVendor);
  const maxSell = Math.max(1, ...(buckets ?? []).map((b) => b.sell));
  const flagList = FLAG_ORDER.filter((f) => (costs ? true : f === 'missing_price'));

  return (
    <div className="space-y-5 text-[13px]">
      <section>
        <h3 className="mb-2 text-[13px] font-[620]">Totals</h3>
        <dl className="space-y-1">
          <Row label="Sell subtotal" value={money(t.sellSubtotal)} />
          {quote.freightMode === 'percent' ? (
            <Row label={`Freight (${quote.freightPct}%)`} value={money(t.freight)} />
          ) : (
            costs && <Row label="Freight in landed cost" value={money(t.freightIncluded)} muted />
          )}
          <Row label={`Tax${quote.taxRate ? ` (${quote.taxRate}%)` : ''}`} value={money(t.tax)} />
          <div className="mt-1.5 flex items-baseline justify-between border-t border-ink pt-1.5">
            <dt className="font-[620]">Grand total</dt>
            <dd className="num text-[17px] font-[660]">{money(t.grandTotal)}</dd>
          </div>
          {costs && (
            <>
              <Row label="Cost" value={money(t.costTotal)} muted />
              <div className="flex items-baseline justify-between">
                <dt className="text-ink-2">Margin</dt>
                <dd className="text-[15px] font-[620]">
                  <MarginCell value={t.marginPct} floor={quote.minMarginPct} />
                </dd>
              </div>
              {quote.minMarginPct !== null && (
                <p className="text-[12px] text-ink-3">Minimum margin {pct(quote.minMarginPct, 0)}</p>
              )}
            </>
          )}
          <p className="num pt-1 text-[12px] text-ink-3">
            {t.selectedLineCount} of {t.lineCount} lines counted
            {t.lineCount > t.selectedLineCount ? ' (alternates excluded)' : ''}
          </p>
        </dl>
      </section>

      <section>
        <h3 className="mb-2 text-[13px] font-[620]">Needs attention</h3>
        <ul className="space-y-0.5">
          {flagList.map((f) => {
            const n = t.flagCounts[f] ?? 0;
            const on = flag === f;
            return (
              <li key={f}>
                <button
                  type="button"
                  disabled={!n && !on}
                  onClick={() => onFlag(on ? null : f)}
                  aria-pressed={on}
                  className={cx(
                    'flex h-7 w-full items-center gap-2 rounded-xs px-1.5 text-left',
                    on ? 'bg-brass-50 font-[600]' : n ? 'hover:bg-stone' : 'text-ink-4',
                  )}
                >
                  <span className={cx(n ? TONE_TEXT[FLAG_META[f].tone] : 'text-ink-4')}>
                    {FLAG_META[f].icon}
                  </span>
                  <span className="flex-1">{FLAG_META[f].label}</span>
                  <span className={cx('num', n ? 'font-[600]' : '')}>{n}</span>
                </button>
              </li>
            );
          })}
        </ul>
        {flag && (
          <button
            type="button"
            onClick={() => onFlag(null)}
            className="mt-1 text-[12px] font-[560] text-lacquer hover:underline"
          >
            Show all lines
          </button>
        )}
      </section>

      <section>
        <div className="mb-2 flex flex-col gap-1.5">
          <h3 className="text-[13px] font-[620]">Breakdown</h3>
          <Chips
            value={by}
            onChange={(v) => {
              setBy(v);
              onBreakdown?.(null);
            }}
            options={[
              { value: 'location', label: 'Location' },
              { value: 'category', label: 'Category' },
              { value: 'vendor', label: 'Vendor' },
            ]}
          />
        </div>
        {!buckets ? (
          <div className="flex justify-center py-4">
            <Spinner />
          </div>
        ) : !buckets.length ? (
          <p className="text-ink-3">No lines yet.</p>
        ) : (
          <ul className="space-y-1">
            {[...buckets]
              .sort((a, b) => b.sell - a.sell)
              .map((b) => {
                const on = breakdownFilter?.by === by && breakdownFilter.key === b.key;
                return (
                  <li key={b.key ?? 'none'}>
                    <button
                      type="button"
                      onClick={() => onBreakdown?.(on ? null : { by, key: b.key })}
                      className={cx(
                        'block w-full rounded-xs px-1.5 py-1 text-left',
                        on ? 'bg-brass-50' : 'hover:bg-stone',
                      )}
                    >
                      <span className="flex items-baseline justify-between gap-2">
                        <span className={cx('truncate', on && 'font-[600]')}>
                          {by === 'category' ? categoryLabel(b.label) : b.label}
                        </span>
                        <span className="num shrink-0 font-[560]">{moneyShort(b.sell)}</span>
                      </span>
                      <span className="mt-0.5 flex items-center gap-2">
                        <span className="h-1 flex-1 overflow-hidden rounded-full bg-stone-2">
                          <span
                            className="block h-full rounded-full bg-lacquer/70"
                            style={{ width: `${(b.sell / maxSell) * 100}%` }}
                          />
                        </span>
                        {costs && (
                          <span className="num w-12 text-right text-[12px] text-ink-3">
                            {b.marginPct === null ? '—' : `${b.marginPct.toFixed(1)}%`}
                          </span>
                        )}
                      </span>
                    </button>
                  </li>
                );
              })}
          </ul>
        )}
      </section>
    </div>
  );
}

const TONE_TEXT: Record<string, string> = {
  warn: 'text-warn',
  risk: 'text-risk',
  crit: 'text-crit',
  info: 'text-info',
  ok: 'text-ok',
  neutral: 'text-ink-3',
  brass: 'text-brass',
  lacquer: 'text-lacquer',
};

const Row = ({ label, value, muted }: { label: string; value: string; muted?: boolean }) => (
  <div className="flex items-baseline justify-between gap-2">
    <dt className="text-ink-2">{label}</dt>
    <dd className={cx('num', muted ? 'text-ink-2' : 'font-[560]')}>{value}</dd>
  </div>
);
