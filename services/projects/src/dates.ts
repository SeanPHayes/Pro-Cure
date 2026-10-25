/**
 * Business-day arithmetic on ISO dates ('YYYY-MM-DD'), computed in UTC so no timezone drift.
 * Weekends (Sat/Sun) are skipped. Holidays are not modelled (yet).
 */
const DAY = 86_400_000;

const toMs = (d: string) => Date.parse(`${d}T00:00:00Z`);
const fromMs = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const dow = (d: string) => new Date(toMs(d)).getUTCDay();

export const isWeekend = (d: string) => {
  const w = dow(d);
  return w === 0 || w === 6;
};

/** Today's date (UTC) as YYYY-MM-DD. */
export const today = (now = new Date()) => now.toISOString().slice(0, 10);

export const addCalendarDays = (d: string, n: number) => fromMs(toMs(d) + n * DAY);

/** Roll forward to the next weekday if `d` falls on a weekend. */
export const nextBusinessDay = (d: string) => {
  let x = d;
  while (isWeekend(x)) x = addCalendarDays(x, 1);
  return x;
};

/** Roll back to the previous weekday if `d` falls on a weekend. */
export const prevBusinessDay = (d: string) => {
  let x = d;
  while (isWeekend(x)) x = addCalendarDays(x, -1);
  return x;
};

/**
 * Move `n` business days from `d`. The start is first normalised to a business day (forward for
 * n >= 0, backward for n < 0), so addBusinessDays(fri, 1) = mon and addBusinessDays(sat, 0) = mon.
 */
export const addBusinessDays = (d: string, n: number) => {
  let x = n >= 0 ? nextBusinessDay(d) : prevBusinessDay(d);
  const step = n >= 0 ? 1 : -1;
  let left = Math.abs(n);
  while (left > 0) {
    x = addCalendarDays(x, step);
    if (!isWeekend(x)) left--;
  }
  return x;
};

/** Signed number of business days to go from `a` to `b` (0 when equal after normalisation). */
export const businessDaysBetween = (a: string, b: string) => {
  const from = nextBusinessDay(a);
  const to = nextBusinessDay(b);
  if (from === to) return 0;
  const sign = to > from ? 1 : -1;
  let x = from;
  let n = 0;
  while (x !== to) {
    x = addBusinessDays(x, sign);
    n += sign;
  }
  return n;
};

/** Due date for a task that starts on `start` and takes `duration` business days (0 = same day). */
export const dueFor = (start: string, duration: number) => addBusinessDays(start, Math.max(0, duration - 1));

/** Earliest start for a successor of a task finishing on `due` (same day after a 0-day milestone). */
export const startAfter = (due: string, predecessorDuration: number) =>
  addBusinessDays(due, predecessorDuration === 0 ? 0 : 1);

export const maxDate = (...ds: (string | null | undefined)[]) =>
  ds.filter((d): d is string => !!d).reduce<string | null>((m, d) => (m === null || d > m ? d : m), null);

/** Monday..Sunday of the week containing `d`. */
export const weekBounds = (d: string) => {
  const w = dow(d);
  const monday = addCalendarDays(d, w === 0 ? -6 : 1 - w);
  return { start: monday, end: addCalendarDays(monday, 6) };
};
