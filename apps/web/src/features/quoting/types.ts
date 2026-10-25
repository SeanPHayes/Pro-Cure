/** Client-side mirrors of services/quoting/src/schemas.ts (response shapes). */

export type QuoteStatus =
  | 'draft'
  | 'costing'
  | 'merchandising'
  | 'pending_internal_approval'
  | 'sent'
  | 'client_approved'
  | 'client_rejected'
  | 'ordered'
  | 'archived';

export const QUOTE_STATUSES: QuoteStatus[] = [
  'draft',
  'costing',
  'merchandising',
  'pending_internal_approval',
  'sent',
  'client_approved',
  'client_rejected',
  'ordered',
  'archived',
];

export type LineFlag =
  | 'missing_cost'
  | 'missing_price'
  | 'below_cost'
  | 'cost_expired'
  | 'cost_expiring'
  | 'below_min_margin';

export const SPEC_CATEGORIES = [
  'casegoods',
  'seating',
  'soft_seating',
  'tables',
  'bedding',
  'lighting',
  'mirrors',
  'artwork',
  'window_treatments',
  'carpet',
  'flooring',
  'wallcovering',
  'millwork',
  'plumbing',
  'electronics',
  'signage',
  'outdoor',
  'ose',
  'other',
] as const;

export interface Totals {
  lineCount: number;
  selectedLineCount: number;
  costSubtotal: number | null;
  sellSubtotal: number;
  marginPct: number | null;
  freightIncluded: number | null;
  freight: number;
  tax: number;
  grandTotal: number;
  costTotal: number | null;
  flagCounts: Record<LineFlag, number>;
}

export interface Quote {
  id: string;
  projectId: string | null;
  clientOrgId: string | null;
  number: string;
  name: string;
  phase: string | null;
  status: QuoteStatus;
  isTemplate: boolean;
  templateName: string | null;
  sourceQuoteId: string | null;
  currency: string;
  taxRate: number;
  freightMode: 'per_line' | 'percent';
  freightPct: number;
  defaultMarkupPct: number;
  minMarginPct: number | null;
  validUntil: string | null;
  notes: string | null;
  clientNotes: string | null;
  internalApprovedAt: string | null;
  sentAt: string | null;
  sentByName: string | null;
  clientDocumentId: string | null;
  clientDecision: 'approved' | 'rejected' | null;
  clientDecidedAt: string | null;
  clientDecidedByName: string | null;
  clientSignatureName: string | null;
  clientComment: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface QuoteListItem extends Quote {
  totals: {
    lineCount: number;
    costSubtotal: number | null;
    sellSubtotal: number;
    grandTotal: number;
    marginPct: number | null;
  };
}

export interface RoomType {
  id: string;
  code: string;
  name: string;
  count: number;
  sort: number;
}

export interface Location {
  id: string;
  parentId: string | null;
  name: string;
  kind: 'area' | 'room' | 'category';
  sort: number;
  depth: number;
  path: string;
}

export interface MarkupRule {
  id?: string;
  category: string | null;
  locationId: string | null;
  markupPct: number;
}

export interface QuoteDetail extends Quote {
  roomTypes: RoomType[];
  locations: Location[];
  totals: Totals;
  pendingApprovals: number;
  markupRules: MarkupRule[];
}

export interface Handing {
  left: number;
  right: number;
}

export interface Line {
  id: string;
  quoteId: string;
  locationId: string | null;
  specId: string | null;
  masterSpecId: string | null;
  isSelected: boolean;
  code: string;
  name: string;
  description: string | null;
  category: string;
  vendorId: string | null;
  vendorName: string | null;
  vendorSku: string | null;
  finish: string | null;
  dimensions: string | null;
  materials: string | null;
  imageDocumentId: string | null;
  qtyMode: 'fixed' | 'per_room';
  qtyFixed: number;
  qtyPerRoom: Record<string, number>;
  handing: Handing | null;
  atticStockPct: number;
  quantity: number;
  unit: string;
  unitCost: number | null;
  costExpiresAt: string | null;
  leadTimeWeeks: number | null;
  freightUnit: number | null;
  markupPct: number | null;
  unitPrice: number | null;
  priceOverride: boolean;
  extendedCost: number | null;
  extendedPrice: number | null;
  marginPct: number | null;
  flags: LineFlag[];
  readyToOrder: boolean;
  poId: string | null;
  poNumber: string | null;
  notes: string | null;
  clientNotes: string | null;
  sort: number;
  createdAt: string;
  updatedAt: string;
}

export interface Bucket {
  key: string | null;
  label: string;
  lineCount: number;
  cost: number | null;
  sell: number;
  marginPct: number | null;
}

export interface Summary {
  totals: Totals;
  byLocation: Bucket[];
  byCategory: Bucket[];
  byVendor: Bucket[];
}

export interface PriceMatrixOption {
  lineId: string;
  specId: string | null;
  code: string;
  name: string;
  vendorId: string | null;
  vendorName: string | null;
  unitCost: number | null;
  leadTimeWeeks: number | null;
  costExpiresAt: string | null;
  quantity: number;
  extendedCost: number | null;
  deltaVsLowest: number | null;
  deltaPct: number | null;
  isLowest: boolean;
  isSelected: boolean;
  flags: LineFlag[];
}

export interface PriceMatrixSlot {
  masterSpecId: string;
  name: string;
  category: string | null;
  locationId: string | null;
  locationName: string | null;
  selectedLineId: string | null;
  lowestUnitCost: number | null;
  options: PriceMatrixOption[];
}

export type CostStatus = 'ok' | 'expiring' | 'expired' | 'missing';

export interface Spec {
  id: string;
  code: string;
  name: string;
  description: string | null;
  category: string;
  vendorId: string | null;
  vendorName: string | null;
  vendorSku: string | null;
  finish: string | null;
  dimensions: string | null;
  materials: string | null;
  unit: string;
  cost: number | null;
  costExpiresAt: string | null;
  costStatus: CostStatus;
  leadTimeWeeks: number | null;
  freightUnit: number | null;
  imageDocumentId: string | null;
  masterSpecId: string | null;
  brandStandardId: string | null;
  brandStandardItemId: string | null;
  notes: string | null;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SpecDetail extends Spec {
  costHistory: {
    id: string;
    cost: number | null;
    expiresAt: string | null;
    source: string;
    costRequestId: string | null;
    recordedAt: string;
    recordedByName: string | null;
  }[];
  masterSpec: { id: string; name: string } | null;
  usage: {
    quoteCount: number;
    lineCount: number;
    quotes: {
      quoteId: string;
      number: string;
      name: string;
      status: string;
      isTemplate: boolean;
      lineCount: number;
    }[];
  };
}

export interface MasterSpecDetail {
  id: string;
  name: string;
  category: string | null;
  description: string | null;
  notes: string | null;
  archived: boolean;
  specCount: number;
  specs: Spec[];
}

export type CostRequestStatus =
  | 'draft'
  | 'sent'
  | 'viewed'
  | 'responded'
  | 'partially_applied'
  | 'applied'
  | 'closed';

export interface CostRequest {
  id: string;
  number: string;
  quoteId: string;
  quoteNumber: string | null;
  quoteName: string | null;
  projectId: string | null;
  vendorId: string;
  vendorName: string | null;
  vendorOrgId: string | null;
  vendorEmail: string | null;
  status: CostRequestStatus;
  dueDate: string | null;
  message: string | null;
  sentAt: string | null;
  viewedAt: string | null;
  respondedAt: string | null;
  lastRemindedAt: string | null;
  documentId: string | null;
  createdByName: string | null;
  createdAt: string;
  lineCount: number;
  respondedLineCount: number;
  appliedLineCount: number;
}

export type SpecChanges = Partial<Record<string, { from: string | null; to: string | null }>>;

export interface CostRequestLine {
  id: string;
  quoteLineId: string | null;
  specId: string | null;
  code: string;
  name: string;
  description: string | null;
  vendorSku: string | null;
  finish: string | null;
  dimensions: string | null;
  quantity: number;
  currentCost: number | null;
  responseCost: number | null;
  responseExpiresAt: string | null;
  responseLeadTimeWeeks: number | null;
  responseNotes: string | null;
  responseSpecChanges: SpecChanges;
  responseSource: 'portal' | 'ai_pdf' | 'manual' | null;
  respondedAt: string | null;
  appliedAt: string | null;
  appliedToSpec: boolean;
}

export interface CostRequestDetail extends CostRequest {
  lines: CostRequestLine[];
}

export interface CompareRow {
  costRequestLineId: string;
  line: CostRequestLine;
  vendorResponse: {
    cost: number | null;
    expiresAt: string | null;
    leadTimeWeeks: number | null;
    notes: string | null;
    specChanges: SpecChanges;
    source: string | null;
    respondedAt: string | null;
  };
  librarySpec: {
    id: string;
    code: string;
    name: string;
    description: string | null;
    vendorSku: string | null;
    finish: string | null;
    dimensions: string | null;
    materials: string | null;
    cost: number | null;
    costExpiresAt: string | null;
    leadTimeWeeks: number | null;
  } | null;
  quoteLine: {
    id: string;
    code: string;
    name: string;
    description: string | null;
    vendorSku: string | null;
    finish: string | null;
    dimensions: string | null;
    materials: string | null;
    unitCost: number | null;
    costExpiresAt: string | null;
    leadTimeWeeks: number | null;
    unitPrice: number | null;
    marginPct: number | null;
    poId: string | null;
  } | null;
  differences: { field: string; vendor: unknown; library: unknown; quote: unknown }[];
  projectedMarginPct: number | null;
}

export interface ApprovalRequest {
  id: string;
  entityType: 'quote';
  entityId: string;
  quoteNumber: string | null;
  quoteName: string | null;
  policyId: string | null;
  policyName: string;
  reason: string;
  details: {
    lines?: { id: string; code: string; name: string; value?: number | string | null }[];
    value?: number;
    threshold?: number;
    warnings?: string[];
  };
  approverRole: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  requestedBy: string | null;
  requestedByName: string | null;
  decidedBy: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  comment: string | null;
  createdAt: string;
}

export interface ApprovalPolicy {
  id: string;
  name: string;
  active: boolean;
  condition: { type: string; pct?: number; amount?: number; category?: string };
  approverRole: string;
  description: string | null;
}

// ---------------------------------------------------------------- portals
export interface VendorCostRequestLine {
  id: string;
  code: string;
  name: string;
  description: string | null;
  vendorSku: string | null;
  finish: string | null;
  dimensions: string | null;
  quantity: number;
  responseCost: number | null;
  responseExpiresAt: string | null;
  responseLeadTimeWeeks: number | null;
  responseNotes: string | null;
  responseSpecChanges: SpecChanges;
  respondedAt: string | null;
}

export interface VendorCostRequest {
  id: string;
  number: string;
  status: CostRequestStatus;
  projectName: string | null;
  dueDate: string | null;
  message: string | null;
  sentAt: string | null;
  viewedAt: string | null;
  respondedAt: string | null;
  documentId: string | null;
  lineCount: number;
  respondedLineCount: number;
}

export interface VendorCostRequestDetail extends VendorCostRequest {
  lines: VendorCostRequestLine[];
}

export interface ClientLine {
  id: string;
  code: string;
  name: string;
  description: string | null;
  category: string;
  finish: string | null;
  dimensions: string | null;
  materials: string | null;
  imageDocumentId: string | null;
  quantity: number;
  unit: string;
  unitPrice: number | null;
  extendedPrice: number | null;
  clientNotes: string | null;
}

export interface ClientQuote {
  id: string;
  projectId: string | null;
  number: string;
  name: string;
  phase: string | null;
  status: QuoteStatus;
  validUntil: string | null;
  clientNotes: string | null;
  sentAt: string | null;
  documentId: string | null;
  clientDecision: 'approved' | 'rejected' | null;
  clientDecidedAt: string | null;
  clientDecidedByName: string | null;
  clientSignatureName: string | null;
  clientComment: string | null;
  total: number;
}

export interface ClientQuoteDetail extends ClientQuote {
  sections: { locationId: string | null; location: string; lines: ClientLine[]; subtotal: number }[];
  totals: { subtotal: number; freight: number; tax: number; total: number };
}
