export type ClaimStatus =
  | 'open'
  | 'submitted_to_vendor'
  | 'vendor_acknowledged'
  | 'replacement_ordered'
  | 'credited'
  | 'resolved'
  | 'rejected';

const INTERNAL: Record<ClaimStatus, ClaimStatus[]> = {
  open: ['submitted_to_vendor', 'resolved', 'rejected'],
  submitted_to_vendor: ['vendor_acknowledged', 'replacement_ordered', 'credited', 'resolved', 'rejected'],
  vendor_acknowledged: ['replacement_ordered', 'credited', 'resolved', 'rejected'],
  replacement_ordered: ['credited', 'resolved'],
  credited: ['resolved'],
  resolved: ['open'],
  rejected: ['open'],
};
const VENDOR: Partial<Record<ClaimStatus, ClaimStatus[]>> = {
  open: ['vendor_acknowledged', 'replacement_ordered'],
  submitted_to_vendor: ['vendor_acknowledged', 'replacement_ordered'],
  vendor_acknowledged: ['replacement_ordered'],
};

export const canTransitionClaim = (
  from: ClaimStatus,
  to: ClaimStatus,
  actor: 'internal' | 'vendor' = 'internal',
) => from === to || ((actor === 'vendor' ? VENDOR[from] : INTERNAL[from]) ?? []).includes(to);

export const isClosedClaim = (s: ClaimStatus) => s === 'resolved' || s === 'rejected' || s === 'credited';
