/** Calendar-date helpers on ISO `YYYY-MM-DD` strings (UTC, no time-of-day). */
const DAY = 86_400_000;

export const toIsoDate = (d: Date): string => d.toISOString().slice(0, 10);
export const today = (now: Date = new Date()): string => toIsoDate(now);
const parse = (iso: string): number => Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);

export const addDays = (iso: string, days: number): string => toIsoDate(new Date(parse(iso) + days * DAY));

/** Whole days from `a` to `b` (positive when b is later). */
export const daysBetween = (a: string, b: string): number => Math.round((parse(b) - parse(a)) / DAY);

/** Days elapsed since an instant (ISO timestamp), as of `now`. */
export const daysSince = (instant: string, now: Date = new Date()): number =>
  Math.floor((now.getTime() - Date.parse(instant)) / DAY);

export const minDate = (xs: (string | null | undefined)[]): string | null =>
  xs.filter((x): x is string => !!x).sort()[0] ?? null;
