/** Fields a vendor may correct on a spec in a cost-request response. */
export const SPEC_CHANGE_FIELDS = [
  'name',
  'description',
  'vendorSku',
  'finish',
  'dimensions',
  'materials',
] as const;
export type SpecChangeField = (typeof SPEC_CHANGE_FIELDS)[number];

export type SpecChanges = Partial<Record<SpecChangeField, { from: string | null; to: string | null }>>;

export interface Difference {
  field: string;
  vendor: unknown;
  library: unknown;
  quote: unknown;
}

const norm = (v: unknown) => (v === undefined || v === '' ? null : v);

/**
 * Compare vendor response vs. the library spec vs. the quote line, field by field. A field differs
 * when any of the three disagree (missing sides are ignored).
 */
export function diffCompare(
  vendor: Record<string, unknown>,
  library: Record<string, unknown> | null,
  quote: Record<string, unknown> | null,
  fields: string[],
): Difference[] {
  const out: Difference[] = [];
  for (const f of fields) {
    const v = norm(vendor[f]);
    const lib = library ? norm(library[f]) : undefined;
    const q = quote ? norm(quote[f]) : undefined;
    if (v === null) continue; // vendor didn't speak to this field
    // A side that exists differs when its value is not the vendor's (a vendor filling a blank counts).
    if ((library && lib !== v) || (quote && q !== v))
      out.push({ field: f, vendor: v, library: lib ?? null, quote: q ?? null });
  }
  return out;
}
