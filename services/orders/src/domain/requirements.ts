export type RequirementKind =
  | 'order_acknowledgement'
  | 'deposit'
  | 'shop_drawing_approval'
  | 'finish_sample_approval'
  | 'cfa'
  | 'credit_approval'
  | 'other';
export type Party = 'internal' | 'vendor' | 'client';

export interface RequirementTemplate {
  kind: RequirementKind;
  label: string;
  party: Party;
}

const SHOP_DRAWING_CATEGORIES = new Set(['casegoods', 'millwork', 'soft_seating']);
const FINISH_SAMPLE_CATEGORIES = new Set(['soft_seating', 'window_treatments', 'carpet']);

export const REQUIREMENT_LABELS: Record<RequirementKind, string> = {
  order_acknowledgement: 'Order acknowledgement',
  deposit: 'Deposit payment',
  shop_drawing_approval: 'Shop drawing approval',
  finish_sample_approval: 'Finish sample approval',
  cfa: 'CFA (cutting for approval)',
  credit_approval: 'Credit approval',
  other: 'Other',
};

export const DEFAULT_PARTY: Record<RequirementKind, Party> = {
  order_acknowledgement: 'vendor',
  deposit: 'internal',
  shop_drawing_approval: 'client',
  finish_sample_approval: 'client',
  cfa: 'client',
  credit_approval: 'internal',
  other: 'internal',
};

/**
 * Pre-order requirements a new PO starts with: the vendor's acknowledgement always; a deposit when the
 * vendor's terms require one; shop drawings for fabricated goods; finish samples for textiles/finishes.
 */
export function defaultRequirements(input: { depositPct: number; categories: (string | null)[] }) {
  const cats = new Set(input.categories.filter(Boolean) as string[]);
  const out: RequirementTemplate[] = [
    { kind: 'order_acknowledgement', label: REQUIREMENT_LABELS.order_acknowledgement, party: 'vendor' },
  ];
  if (input.depositPct > 0)
    out.push({ kind: 'deposit', label: `Deposit payment (${input.depositPct}%)`, party: 'internal' });
  if ([...cats].some((c) => SHOP_DRAWING_CATEGORIES.has(c)))
    out.push({
      kind: 'shop_drawing_approval',
      label: REQUIREMENT_LABELS.shop_drawing_approval,
      party: 'client',
    });
  if ([...cats].some((c) => FINISH_SAMPLE_CATEGORIES.has(c)))
    out.push({
      kind: 'finish_sample_approval',
      label: REQUIREMENT_LABELS.finish_sample_approval,
      party: 'client',
    });
  return out;
}

/** Requirement statuses that still block production. */
export const isPending = (status: string) =>
  status === 'pending' || status === 'submitted' || status === 'rejected';
