import {
  ApprovalStatus,
  CostRequestStatus,
  CostResponseSource,
  IsoDate,
  LineFlag,
  PageQuery,
  page,
  patchOf,
  QuantityMode,
  QuoteStatus,
  SpecCategory,
} from '@procure/domain';
import { z } from '@procure/platform';
import { ApprovalCondition } from './domain/approvals.js';
import { SPEC_CHANGE_FIELDS } from './domain/compare.js';

/**
 * Request/response contracts for the quoting API. Portal routes (/vendor, /client) use their own
 * response schemas so sell-side / cost-side fields can never be serialized to the wrong audience.
 */

const money = z.number().nullable();
const pct = z.number().min(-1000).max(1000);
const str = z.string().nullable();
const optStr = z.string().trim().max(4000).nullable().optional();

export const IdParams = z.object({ id: z.uuid() });
export const LineParams = z.object({ id: z.uuid(), lineId: z.uuid() });
export const ChildParams = z.object({ id: z.uuid(), childId: z.uuid() });
export const Ok = z.object({ ok: z.literal(true) });
export { ApprovalCondition };

// ---------------------------------------------------------------- specs
export const CostStatus = z.enum(['ok', 'expiring', 'expired', 'missing']);

export const Spec = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  description: str,
  category: z.string(),
  vendorId: str,
  vendorName: str,
  vendorSku: str,
  finish: str,
  dimensions: str,
  materials: str,
  unit: z.string(),
  cost: money,
  costExpiresAt: str,
  costStatus: CostStatus,
  leadTimeWeeks: z.number().nullable(),
  freightUnit: money,
  imageDocumentId: str,
  masterSpecId: str,
  brandStandardId: str,
  brandStandardItemId: str,
  notes: str,
  archived: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Spec = z.infer<typeof Spec>;

export const SpecInput = z.object({
  code: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(300),
  description: optStr,
  category: SpecCategory.default('other'),
  vendorId: z.uuid().nullable().optional(),
  vendorName: optStr,
  vendorSku: optStr,
  finish: optStr,
  dimensions: optStr,
  materials: optStr,
  unit: z.string().trim().min(1).max(16).default('ea'),
  cost: z.number().min(0).nullable().optional(),
  costExpiresAt: IsoDate.nullable().optional(),
  leadTimeWeeks: z.number().min(0).max(260).nullable().optional(),
  freightUnit: z.number().min(0).nullable().optional(),
  imageDocumentId: z.uuid().nullable().optional(),
  masterSpecId: z.uuid().nullable().optional(),
  brandStandardId: z.uuid().nullable().optional(),
  brandStandardItemId: z.uuid().nullable().optional(),
  notes: optStr,
});
export const SpecPatch = patchOf(SpecInput).extend({ archived: z.boolean().optional() });

export const SpecListQuery = PageQuery.extend({
  category: z.string().optional(),
  vendorId: z.uuid().optional(),
  masterSpecId: z.uuid().optional(),
  brandStandardItemId: z.uuid().optional(),
  costStatus: z.enum(['expired', 'expiring', 'missing']).optional(),
  includeArchived: z.coerce.boolean().default(false),
});

export const CostHistoryEntry = z.object({
  id: z.string(),
  cost: money,
  expiresAt: str,
  source: z.string(),
  costRequestId: str,
  recordedAt: z.string(),
  recordedByName: str,
});

export const SpecDetail = Spec.extend({
  costHistory: z.array(CostHistoryEntry),
  masterSpec: z.object({ id: z.string(), name: z.string() }).nullable(),
  usage: z.object({
    quoteCount: z.number().int(),
    lineCount: z.number().int(),
    quotes: z.array(
      z.object({
        quoteId: z.string(),
        number: z.string(),
        name: z.string(),
        status: z.string(),
        isTemplate: z.boolean(),
        lineCount: z.number().int(),
      }),
    ),
  }),
});

export const SpecImportRow = z.object({
  code: z.string(),
  name: z.string(),
  category: z.string().optional(),
  vendorId: z.string().nullable().optional(),
  vendorName: z.string().nullable().optional(),
  vendorSku: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  dimensions: z.string().nullable().optional(),
  finish: z.string().nullable().optional(),
  materials: z.string().nullable().optional(),
  unit: z.string().nullable().optional(),
  cost: z.union([z.number(), z.string()]).nullable().optional(),
  costExpiresAt: z.string().nullable().optional(),
  leadTimeWeeks: z.union([z.number(), z.string()]).nullable().optional(),
  brandStandardItemId: z.string().nullable().optional(),
});
export const SpecImportBody = z.object({ rows: z.array(z.record(z.string(), z.unknown())).min(1).max(5000) });
export const SpecImportResult = z.object({
  created: z.number().int(),
  updated: z.number().int(),
  errors: z.array(
    z.object({ row: z.number().int(), code: z.string().nullable(), errors: z.array(z.string()) }),
  ),
});

export const FromBrandStandardBody = z.object({
  standardId: z.uuid(),
  itemIds: z.array(z.uuid()).optional(),
  vendorAssignments: z.record(z.string(), z.uuid()).optional(),
});

// ---------------------------------------------------------------- master specs
export const MasterSpec = z.object({
  id: z.string(),
  name: z.string(),
  category: str,
  description: str,
  notes: str,
  archived: z.boolean(),
  specCount: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const MasterSpecDetail = MasterSpec.extend({ specs: z.array(Spec) });
export const MasterSpecInput = z.object({
  name: z.string().trim().min(1).max(300),
  category: SpecCategory.nullable().optional(),
  description: optStr,
  notes: optStr,
});
export const MasterSpecPatch = patchOf(MasterSpecInput).extend({ archived: z.boolean().optional() });

// ---------------------------------------------------------------- quotes
export const FlagCounts = z.object(
  Object.fromEntries(LineFlag.options.map((f) => [f, z.number().int()])) as Record<LineFlag, z.ZodNumber>,
);

export const Totals = z.object({
  lineCount: z.number().int(),
  selectedLineCount: z.number().int(),
  costSubtotal: z.number().nullable(),
  sellSubtotal: z.number(),
  marginPct: z.number().nullable(),
  freightIncluded: z.number().nullable(),
  freight: z.number(),
  tax: z.number(),
  grandTotal: z.number(),
  costTotal: z.number().nullable(),
  flagCounts: FlagCounts,
});

export const Quote = z.object({
  id: z.string(),
  projectId: str,
  clientOrgId: str,
  number: z.string(),
  name: z.string(),
  phase: str,
  status: QuoteStatus,
  isTemplate: z.boolean(),
  templateName: str,
  sourceQuoteId: str,
  currency: z.string(),
  taxRate: z.number(),
  freightMode: z.enum(['per_line', 'percent']),
  freightPct: z.number(),
  defaultMarkupPct: z.number(),
  minMarginPct: z.number().nullable(),
  validUntil: str,
  notes: str,
  clientNotes: str,
  internalApprovedAt: str,
  sentAt: str,
  sentByName: str,
  clientDocumentId: str,
  clientDecision: z.enum(['approved', 'rejected']).nullable(),
  clientDecidedAt: str,
  clientDecidedByName: str,
  clientSignatureName: str,
  clientComment: str,
  createdBy: str,
  createdAt: z.string(),
  updatedAt: z.string(),
  version: z.number().int(),
});
export const QuoteListItem = Quote.extend({
  totals: z.object({
    lineCount: z.number().int(),
    costSubtotal: z.number().nullable(),
    sellSubtotal: z.number(),
    grandTotal: z.number(),
    marginPct: z.number().nullable(),
  }),
});

export const RoomType = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  count: z.number().int(),
  sort: z.number().int(),
});
export const Location = z.object({
  id: z.string(),
  parentId: str,
  name: z.string(),
  kind: z.enum(['area', 'room', 'category']),
  sort: z.number().int(),
  depth: z.number().int(),
  path: z.string(),
});

export const QuoteDetail = Quote.extend({
  roomTypes: z.array(RoomType),
  locations: z.array(Location),
  totals: Totals,
  pendingApprovals: z.number().int(),
  markupRules: z.array(z.object({ id: z.string(), category: str, locationId: str, markupPct: z.number() })),
});

export const QuoteListQuery = PageQuery.extend({
  projectId: z.uuid().optional(),
  status: QuoteStatus.optional(),
  isTemplate: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});

export const QuoteCreate = z.object({
  projectId: z.uuid().nullable().optional(),
  name: z.string().trim().min(1).max(300),
  phase: optStr,
  templateId: z.uuid().optional(),
  isTemplate: z.boolean().default(false),
  templateName: optStr,
  taxRate: z.number().min(0).max(100).optional(),
  freightMode: z.enum(['per_line', 'percent']).optional(),
  freightPct: z.number().min(0).max(100).optional(),
  defaultMarkupPct: pct.optional(),
  minMarginPct: z.number().min(-100).max(100).nullable().optional(),
  validUntil: IsoDate.nullable().optional(),
  notes: optStr,
  clientNotes: optStr,
});
export const QuotePatch = z.object({
  name: z.string().trim().min(1).max(300).optional(),
  phase: optStr,
  status: z.enum(['draft', 'costing', 'merchandising', 'archived']).optional(),
  templateName: optStr,
  taxRate: z.number().min(0).max(100).optional(),
  freightMode: z.enum(['per_line', 'percent']).optional(),
  freightPct: z.number().min(0).max(100).optional(),
  defaultMarkupPct: pct.optional(),
  minMarginPct: z.number().min(-100).max(100).nullable().optional(),
  validUntil: IsoDate.nullable().optional(),
  notes: optStr,
  clientNotes: optStr,
});
export const QuoteCopy = z.object({
  projectId: z.uuid().nullable().optional(),
  name: z.string().trim().min(1).max(300),
  phase: optStr,
  asTemplate: z.boolean().default(false),
  templateName: optStr,
});
export const IfMatchHeaders = z.object({ 'if-match': z.string().optional() });

export const RoomTypeInput = z.object({
  code: z.string().trim().min(1).max(32),
  name: z.string().trim().min(1).max(200),
  count: z.number().int().min(0).max(100_000),
  sort: z.number().int().optional(),
});
export const RoomTypePatch = patchOf(RoomTypeInput);

export const LocationInput = z.object({
  name: z.string().trim().min(1).max(200),
  parentId: z.uuid().nullable().optional(),
  kind: z.enum(['area', 'room', 'category']).default('area'),
  sort: z.number().int().optional(),
});
export const LocationPatch = patchOf(LocationInput);
export const LocationDeleteQuery = z.object({
  /** Move lines in the deleted subtree here (otherwise they become unassigned). */
  moveLinesTo: z.uuid().optional(),
});

export interface TemplateNode {
  name: string;
  kind?: 'area' | 'room' | 'category';
  children?: TemplateNode[];
}
const TemplateNodeSchema: z.ZodType<TemplateNode> = z.lazy(() =>
  z.object({
    name: z.string().trim().min(1).max(200),
    kind: z.enum(['area', 'room', 'category']).optional(),
    children: z.array(TemplateNodeSchema).max(200).optional(),
  }),
);
export const LocationTemplate = z.object({
  id: z.string(),
  name: z.string(),
  description: str,
  tree: z.array(z.any()),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const LocationTemplateInput = z.object({
  name: z.string().trim().min(1).max(200),
  description: optStr,
  tree: z.array(TemplateNodeSchema).max(200),
});
export const LocationTemplateFromQuote = z.object({
  name: z.string().trim().min(1).max(200),
  description: optStr,
  quoteId: z.uuid(),
});

// ---------------------------------------------------------------- lines
export const Handing = z.object({ left: z.number().min(0), right: z.number().min(0) });

export const Line = z.object({
  id: z.string(),
  quoteId: z.string(),
  locationId: str,
  specId: str,
  masterSpecId: str,
  isSelected: z.boolean(),
  code: z.string(),
  name: z.string(),
  description: str,
  category: z.string(),
  vendorId: str,
  vendorName: str,
  vendorSku: str,
  finish: str,
  dimensions: str,
  materials: str,
  imageDocumentId: str,
  qtyMode: QuantityMode,
  qtyFixed: z.number(),
  qtyPerRoom: z.record(z.string(), z.number()),
  handing: Handing.nullable(),
  atticStockPct: z.number(),
  quantity: z.number(),
  unit: z.string(),
  unitCost: money,
  costExpiresAt: str,
  leadTimeWeeks: z.number().nullable(),
  freightUnit: money,
  markupPct: z.number().nullable(),
  unitPrice: money,
  priceOverride: z.boolean(),
  extendedCost: money,
  extendedPrice: money,
  marginPct: z.number().nullable(),
  flags: z.array(z.string()),
  readyToOrder: z.boolean(),
  poId: str,
  poNumber: str,
  notes: str,
  clientNotes: str,
  sort: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Line = z.infer<typeof Line>;

export const LineListQuery = PageQuery.extend({
  limit: z.coerce.number().int().min(1).max(2000).default(500),
  locationId: z.uuid().optional(),
  category: z.string().optional(),
  vendorId: z.uuid().optional(),
  masterSpecId: z.uuid().optional(),
  flag: LineFlag.optional(),
  selectedOnly: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  /** Include lines of the location's sub-locations. */
  includeChildren: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .default(true),
});

export const LinesCreate = z.object({
  locationId: z.uuid().nullable().optional(),
  specIds: z.array(z.uuid()).min(1).max(500),
  qtyMode: QuantityMode.optional(),
  qtyFixed: z.number().min(0).optional(),
  qtyPerRoom: z.record(z.uuid(), z.number().min(0)).optional(),
  atticStockPct: z.number().min(0).max(100).optional(),
  markupPct: pct.optional(),
});

export const LinePatch = z.object({
  locationId: z.uuid().nullable().optional(),
  qtyMode: QuantityMode.optional(),
  qtyFixed: z.number().min(0).optional(),
  qtyPerRoom: z.record(z.uuid(), z.number().min(0)).optional(),
  handing: Handing.nullable().optional(),
  atticStockPct: z.number().min(0).max(100).optional(),
  unit: z.string().trim().min(1).max(16).optional(),
  unitCost: z.number().min(0).nullable().optional(),
  costExpiresAt: IsoDate.nullable().optional(),
  leadTimeWeeks: z.number().min(0).max(260).nullable().optional(),
  freightUnit: z.number().min(0).nullable().optional(),
  markupPct: pct.optional(),
  /** Setting a price sets price_override; null clears the override (price from markup). */
  unitPrice: z.number().min(0).nullable().optional(),
  name: z.string().trim().min(1).max(300).optional(),
  description: optStr,
  finish: optStr,
  dimensions: optStr,
  materials: optStr,
  notes: optStr,
  clientNotes: optStr,
  readyToOrder: z.boolean().optional(),
  isSelected: z.boolean().optional(),
  sort: z.number().int().optional(),
});
export const BulkLinePatch = z.object({
  lineIds: z.array(z.uuid()).min(1).max(2000),
  patch: LinePatch.pick({
    locationId: true,
    markupPct: true,
    atticStockPct: true,
    readyToOrder: true,
    freightUnit: true,
    notes: true,
    isSelected: true,
  }).extend({ clearPriceOverride: z.boolean().optional() }),
});
export const LineDeleteBody = z.object({ lineIds: z.array(z.uuid()).min(1).max(2000) });

// ---------------------------------------------------------------- pricing
export const RefreshCostsResult = z.object({
  changed: z.array(
    z.object({
      lineId: z.string(),
      code: z.string(),
      from: z.object({ unitCost: money, costExpiresAt: str }),
      to: z.object({ unitCost: money, costExpiresAt: str }),
    }),
  ),
  totals: Totals,
});
export const MerchandiseBody = z.object({
  rules: z
    .array(
      z.object({
        category: z.string().nullable().optional(),
        locationId: z.uuid().nullable().optional(),
        markupPct: pct,
      }),
    )
    .max(200)
    .default([]),
  targetMarginPct: z.number().min(0).max(95).nullable().optional(),
  respectOverrides: z.boolean().default(true),
  /** Persist rules on the quote (replacing existing) so they can be re-applied later. */
  saveRules: z.boolean().default(true),
});
export const MerchandiseResult = z.object({
  updatedLines: z.number().int(),
  solvedMarkupPct: z.number().nullable(),
  totals: Totals,
});

export const Bucket = z.object({
  key: str,
  label: z.string(),
  lineCount: z.number().int(),
  cost: z.number().nullable(),
  sell: z.number(),
  marginPct: z.number().nullable(),
});
export const Summary = z.object({
  totals: Totals,
  byLocation: z.array(Bucket),
  byCategory: z.array(Bucket),
  byVendor: z.array(Bucket),
});

export const PriceMatrix = z.object({
  slots: z.array(
    z.object({
      masterSpecId: z.string(),
      name: z.string(),
      category: str,
      locationId: str,
      locationName: str,
      selectedLineId: str,
      lowestUnitCost: money,
      options: z.array(
        z.object({
          lineId: z.string(),
          specId: str,
          code: z.string(),
          name: z.string(),
          vendorId: str,
          vendorName: str,
          unitCost: money,
          leadTimeWeeks: z.number().nullable(),
          costExpiresAt: str,
          quantity: z.number(),
          extendedCost: money,
          deltaVsLowest: money,
          deltaPct: z.number().nullable(),
          isLowest: z.boolean(),
          isSelected: z.boolean(),
          flags: z.array(z.string()),
        }),
      ),
    }),
  ),
});
export const PriceMatrixSelect = z.object({
  selections: z.record(z.uuid(), z.uuid()),
  deleteOthers: z.boolean().default(false),
});
export const AddAlternatesBody = z.object({
  /** Existing line to compete against (its master spec is used; created from the line's spec if needed). */
  lineId: z.uuid(),
  specIds: z.array(z.uuid()).min(1).max(20),
});

// ---------------------------------------------------------------- cost requests
export const SpecChanges = z.partialRecord(
  z.enum(SPEC_CHANGE_FIELDS),
  z.object({ from: z.string().nullable(), to: z.string().nullable() }),
);

export const CostRequest = z.object({
  id: z.string(),
  number: z.string(),
  quoteId: z.string(),
  quoteNumber: str,
  quoteName: str,
  projectId: str,
  vendorId: z.string(),
  vendorName: str,
  vendorOrgId: str,
  vendorEmail: str,
  status: CostRequestStatus,
  dueDate: str,
  message: str,
  sentAt: str,
  viewedAt: str,
  respondedAt: str,
  lastRemindedAt: str,
  documentId: str,
  createdByName: str,
  createdAt: z.string(),
  lineCount: z.number().int(),
  respondedLineCount: z.number().int(),
  appliedLineCount: z.number().int(),
});
export const CostRequestLine = z.object({
  id: z.string(),
  quoteLineId: str,
  specId: str,
  code: z.string(),
  name: z.string(),
  description: str,
  vendorSku: str,
  finish: str,
  dimensions: str,
  quantity: z.number(),
  currentCost: money,
  responseCost: money,
  responseExpiresAt: str,
  responseLeadTimeWeeks: z.number().nullable(),
  responseNotes: str,
  responseSpecChanges: z.record(z.string(), z.any()),
  responseSource: CostResponseSource.nullable(),
  respondedAt: str,
  appliedAt: str,
  appliedToSpec: z.boolean(),
});
export const CostRequestDetail = CostRequest.extend({ lines: z.array(CostRequestLine) });
export const CostRequestCreate = z.object({
  lineIds: z.array(z.uuid()).max(2000).optional(),
  onlyExpiredOrMissing: z.boolean().default(false),
  dueDate: IsoDate.nullable().optional(),
  message: optStr,
});
export const CostRequestCreateResult = z.object({
  requests: z.array(CostRequest),
  skipped: z.array(z.object({ lineId: z.string(), code: z.string(), reason: z.string() })),
  warnings: z.array(z.string()),
});
export const CostRequestListQuery = PageQuery.extend({
  quoteId: z.uuid().optional(),
  vendorId: z.uuid().optional(),
  status: CostRequestStatus.optional(),
});
export const CostResponseInput = z.object({
  cost: z.number().min(0).nullable(),
  expiresAt: IsoDate.nullable().optional(),
  leadTimeWeeks: z.number().min(0).max(260).nullable().optional(),
  notes: optStr,
  specChanges: SpecChanges.optional(),
});
export const CompareResult = z.object({
  rows: z.array(
    z.object({
      costRequestLineId: z.string(),
      line: CostRequestLine,
      vendorResponse: z.object({
        cost: money,
        expiresAt: str,
        leadTimeWeeks: z.number().nullable(),
        notes: str,
        specChanges: z.record(z.string(), z.any()),
        source: str,
        respondedAt: str,
      }),
      librarySpec: z
        .object({
          id: z.string(),
          code: z.string(),
          name: z.string(),
          description: str,
          vendorSku: str,
          finish: str,
          dimensions: str,
          materials: str,
          cost: money,
          costExpiresAt: str,
          leadTimeWeeks: z.number().nullable(),
        })
        .nullable(),
      quoteLine: z
        .object({
          id: z.string(),
          code: z.string(),
          name: z.string(),
          description: str,
          vendorSku: str,
          finish: str,
          dimensions: str,
          materials: str,
          unitCost: money,
          costExpiresAt: str,
          leadTimeWeeks: z.number().nullable(),
          unitPrice: money,
          marginPct: z.number().nullable(),
          poId: str,
        })
        .nullable(),
      differences: z.array(
        z.object({ field: z.string(), vendor: z.any(), library: z.any(), quote: z.any() }),
      ),
      /** Margin at the current markup if the vendor cost is applied. */
      projectedMarginPct: z.number().nullable(),
    }),
  ),
});
export const CostRequestApply = z.object({
  /** cost_request_lines ids; default = every responded, unapplied line. */
  lineIds: z.array(z.uuid()).optional(),
  applyToSpec: z.boolean().default(false),
  applySpecChanges: z.boolean().default(false),
});
export const CostRequestApplyResult = z.object({
  applied: z.number().int(),
  skipped: z.array(z.object({ lineId: z.string(), reason: z.string() })),
  specsUpdated: z.number().int(),
  status: CostRequestStatus,
});

// Vendor portal: no sell price, markup, margin, internal notes, other vendors.
export const VendorCostRequestLine = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  description: str,
  vendorSku: str,
  finish: str,
  dimensions: str,
  quantity: z.number(),
  responseCost: money,
  responseExpiresAt: str,
  responseLeadTimeWeeks: z.number().nullable(),
  responseNotes: str,
  responseSpecChanges: z.record(z.string(), z.any()),
  respondedAt: str,
});
export const VendorCostRequest = z.object({
  id: z.string(),
  number: z.string(),
  status: CostRequestStatus,
  projectName: str,
  dueDate: str,
  message: str,
  sentAt: str,
  viewedAt: str,
  respondedAt: str,
  documentId: str,
  lineCount: z.number().int(),
  respondedLineCount: z.number().int(),
});
export const VendorCostRequestDetail = VendorCostRequest.extend({ lines: z.array(VendorCostRequestLine) });

// ---------------------------------------------------------------- approvals
export const ApprovalPolicy = z.object({
  id: z.string(),
  name: z.string(),
  active: z.boolean(),
  appliesTo: z.literal('quote'),
  condition: ApprovalCondition,
  approverRole: z.string(),
  description: str,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const ApprovalPolicyInput = z.object({
  name: z.string().trim().min(1).max(200),
  active: z.boolean().default(true),
  condition: ApprovalCondition,
  approverRole: z.string().trim().min(1).max(64),
  description: optStr,
});
export const ApprovalPolicyPatch = patchOf(ApprovalPolicyInput);

export const ApprovalRequest = z.object({
  id: z.string(),
  entityType: z.literal('quote'),
  entityId: z.string(),
  quoteNumber: str,
  quoteName: str,
  policyId: str,
  policyName: z.string(),
  reason: z.string(),
  details: z.record(z.string(), z.any()),
  approverRole: z.string(),
  status: ApprovalStatus,
  requestedBy: str,
  requestedByName: str,
  decidedBy: str,
  decidedByName: str,
  decidedAt: str,
  comment: str,
  createdAt: z.string(),
});
export const ApprovalListQuery = PageQuery.extend({
  status: ApprovalStatus.optional(),
  quoteId: z.uuid().optional(),
  mine: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});
export const ApprovalDecide = z.object({
  decision: z.enum(['approved', 'rejected']),
  comment: optStr,
});
export const SubmitForApprovalResult = z.object({
  status: QuoteStatus,
  approved: z.boolean(),
  requests: z.array(ApprovalRequest),
  warnings: z.array(z.string()),
});

// ---------------------------------------------------------------- client flow
export const SendToClient = z.object({
  message: optStr,
  contacts: z
    .array(z.object({ name: z.string().optional(), email: z.email() }))
    .max(50)
    .optional(),
});
export const SendToClientResult = z.object({
  status: QuoteStatus,
  documentId: str,
  sentTo: z.array(z.string()),
  warnings: z.array(z.string()),
});
export const ReportBody = z.object({
  variant: z.enum(['client', 'internal']).default('client'),
  locationIds: z.array(z.uuid()).optional(),
});
export const DocumentRef = z.object({ documentId: z.string(), filename: z.string() });
export const SpecBookBody = z.object({
  locationIds: z.array(z.uuid()).optional(),
  includeDocuments: z.boolean().default(true),
});
export const SpecBookResult = DocumentRef.extend({
  specCount: z.number().int(),
  warnings: z.array(z.string()),
});

export const ClientLine = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  description: str,
  category: z.string(),
  finish: str,
  dimensions: str,
  materials: str,
  imageDocumentId: str,
  quantity: z.number(),
  unit: z.string(),
  unitPrice: money,
  extendedPrice: money,
  clientNotes: str,
});
export const ClientQuote = z.object({
  id: z.string(),
  projectId: str,
  number: z.string(),
  name: z.string(),
  phase: str,
  status: QuoteStatus,
  validUntil: str,
  clientNotes: str,
  sentAt: str,
  documentId: str,
  clientDecision: z.enum(['approved', 'rejected']).nullable(),
  clientDecidedAt: str,
  clientDecidedByName: str,
  clientSignatureName: str,
  clientComment: str,
  total: z.number(),
});
export const ClientQuoteDetail = ClientQuote.extend({
  sections: z.array(
    z.object({ locationId: str, location: z.string(), lines: z.array(ClientLine), subtotal: z.number() }),
  ),
  totals: z.object({ subtotal: z.number(), freight: z.number(), tax: z.number(), total: z.number() }),
});
export const ClientDecision = z.object({
  decision: z.enum(['approved', 'rejected']),
  signatureName: z.string().trim().min(2).max(200),
  comment: optStr,
});

// ---------------------------------------------------------------- internal
export const TenantQuery = z.object({ tenantId: z.uuid() });

export const pageOf = page;
export const ActivityQuery = z.object({ limit: z.coerce.number().int().min(1).max(1000).default(200) });

export type MasterSpec = z.infer<typeof MasterSpec>;
export type RoomType = z.infer<typeof RoomType>;
export type Location = z.infer<typeof Location>;
