import { round2, round4, sum } from '@procure/domain';

export const extended = (quantity: number, unitCost: number) => round2(round4(quantity) * round4(unitCost));

/** subtotal = Σ extended; total = subtotal + freight + tax. */
export function poTotals(lines: { extended: number }[], freight = 0, tax = 0) {
  const subtotal = sum(lines.map((l) => l.extended));
  return { subtotal, freight: round2(freight), tax: round2(tax), total: sum([subtotal, freight, tax]) };
}
