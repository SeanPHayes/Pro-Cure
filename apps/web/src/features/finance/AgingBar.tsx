import { cx } from '@/components/ui';
import { money, moneyShort } from '@/lib/format';
import { AGING_BUCKETS, AGING_LABEL, type AgingBucket } from './types';

/** Calm → alarming: lacquer for current, brass as it ages, then risk and critical. */
export const AGING_FILL: Record<AgingBucket, string> = {
  current: 'bg-lacquer',
  '1-30': 'bg-brass-400',
  '31-60': 'bg-brass',
  '61-90': 'bg-risk',
  '90+': 'bg-crit',
};

/**
 * Accounts receivable aging as one horizontal stacked bar with a legend underneath. Each legend
 * entry is a button that filters the invoice list to that bucket.
 */
export function AgingBar({
  aging,
  onSelect,
}: {
  aging: Record<AgingBucket, number>;
  onSelect?: (b: AgingBucket) => void;
}) {
  const total = AGING_BUCKETS.reduce((s, b) => s + aging[b], 0);
  return (
    <div>
      <div
        className="flex h-3.5 w-full gap-px overflow-hidden rounded-xs bg-stone-2"
        role="img"
        aria-label={`Open receivables ${money(total)}: ${AGING_BUCKETS.map((b) => `${AGING_LABEL[b]} ${money(aging[b])}`).join(', ')}`}
      >
        {total > 0 &&
          AGING_BUCKETS.filter((b) => aging[b] > 0).map((b) => (
            <div
              key={b}
              className={cx('h-full', AGING_FILL[b])}
              style={{ width: `${(aging[b] / total) * 100}%`, minWidth: 3 }}
              title={`${AGING_LABEL[b]}: ${money(aging[b])}`}
            />
          ))}
      </div>
      <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-5">
        {AGING_BUCKETS.map((b) => {
          const share = total > 0 ? Math.round((aging[b] / total) * 100) : 0;
          const body = (
            <>
              <span className="flex items-center gap-1.5 text-[12px] text-ink-3">
                <span className={cx('size-2 rounded-[2px]', AGING_FILL[b])} />
                {AGING_LABEL[b]}
              </span>
              <span className="num mt-0.5 block text-[15px] font-[600]">
                {moneyShort(aging[b])}
                {aging[b] > 0 && <span className="ml-1.5 text-[12px] font-[500] text-ink-3">{share}%</span>}
              </span>
            </>
          );
          return (
            <li key={b}>
              {onSelect && aging[b] > 0 ? (
                <button
                  type="button"
                  onClick={() => onSelect(b)}
                  className="-mx-1.5 block rounded-xs px-1.5 py-0.5 text-left hover:bg-stone"
                  title={`Show invoices ${AGING_LABEL[b].toLowerCase()}${b === 'current' ? '' : ' past due'}`}
                >
                  {body}
                </button>
              ) : (
                <div className="py-0.5">{body}</div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
