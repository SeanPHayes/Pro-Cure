/**
 * Money helpers. Amounts are carried as JS numbers rounded to 2dp (currency) or 4dp (unit cost),
 * and stored as NUMERIC in Postgres. All arithmetic that feeds a total must go through these.
 */
export const round = (n: number, dp = 2): number => {
  const f = 10 ** dp;
  return Math.round((n + Number.EPSILON) * f) / f;
};
export const round2 = (n: number) => round(n, 2);
export const round4 = (n: number) => round(n, 4);

/** Sell price from cost and markup %, e.g. cost 100, markup 25 -> 125. */
export const priceFromMarkup = (cost: number, markupPct: number) => round4(cost * (1 + markupPct / 100));

/** Gross margin % from cost and price, e.g. cost 100, price 125 -> 20. */
export const marginPct = (cost: number, price: number) =>
  price === 0 ? 0 : round(((price - cost) / price) * 100, 2);

/** Markup % that yields a target margin %. */
export const markupForMargin = (targetMarginPct: number) =>
  round((targetMarginPct / (100 - targetMarginPct)) * 100, 4);

export const sum = (xs: number[]) => round2(xs.reduce((a, b) => a + b, 0));

export const formatUsd = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
