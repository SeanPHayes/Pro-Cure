import { differenceInCalendarDays, format, formatDistanceToNowStrict, parseISO } from 'date-fns';

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const num = new Intl.NumberFormat('en-US');

export const money = (n: number | null | undefined, whole = false) =>
  n === null || n === undefined || Number.isNaN(n) ? '—' : (whole ? usd0 : usd).format(n);

/** Compact money for dashboards: $1.24M, $86.4K */
export const moneyShort = (n: number | null | undefined) => {
  if (n === null || n === undefined) return '—';
  const a = Math.abs(n);
  if (a >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (a >= 10_000) return `$${(n / 1000).toFixed(1)}K`;
  return usd0.format(n);
};

export const count = (n: number | null | undefined) => (n === null || n === undefined ? '—' : num.format(n));
export const pct = (n: number | null | undefined, dp = 1) =>
  n === null || n === undefined || Number.isNaN(n) ? '—' : `${n.toFixed(dp)}%`;

const toDate = (d: string | Date) => (typeof d === 'string' ? parseISO(d) : d);

/** "Mar 14" this year, "Mar 14, 2027" otherwise */
export const date = (d: string | Date | null | undefined) => {
  if (!d) return '—';
  const x = toDate(d);
  return format(x, x.getFullYear() === new Date().getFullYear() ? 'MMM d' : 'MMM d, yyyy');
};
export const dateLong = (d: string | Date | null | undefined) =>
  d ? format(toDate(d), 'EEE, MMM d, yyyy') : '—';
export const dateTime = (d: string | Date | null | undefined) =>
  d ? format(toDate(d), "MMM d, yyyy 'at' h:mm a") : '—';
export const ago = (d: string | Date | null | undefined) =>
  d ? `${formatDistanceToNowStrict(toDate(d), { addSuffix: true })}` : '—';

/** Days from today (negative = past). */
export const daysFromToday = (d: string | null | undefined) =>
  d ? differenceInCalendarDays(toDate(d), new Date()) : null;

export const relativeDue = (d: string | null | undefined) => {
  const n = daysFromToday(d);
  if (n === null) return '—';
  if (n === 0) return 'Today';
  if (n === 1) return 'Tomorrow';
  if (n === -1) return 'Yesterday';
  return n < 0 ? `${-n} days overdue` : `In ${n} days`;
};

export const humanize = (s: string | null | undefined) =>
  s ? s.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) : '—';

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');

export const isoToday = () => format(new Date(), 'yyyy-MM-dd');
