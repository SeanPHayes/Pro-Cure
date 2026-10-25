import {
  ClaimStatus,
  ClaimType,
  Escalation,
  IsoDate,
  Origin,
  PageQuery,
  PoStatus,
  PreOrderKind,
  page,
  RequirementStatus,
  ShipmentStatus,
  StorageItemStatus,
  StorageLocationKind,
} from '@procure/domain';
import { z } from '@procure/platform';

/**
 * Request/response contract for the orders service. Portal routes (/vendor/*, /client/*) use their own
 * response schemas: zod strips unknown keys on serialization, so a query that over-selects can never leak
 * cost (to clients), sell price / client data (to vendors), or internal notes and risk (to either).
 */

// ---------------------------------------------------------------- shared helpers
const s = z.string();
const ns = z.string().nullable();
const nn = z.number().nullable();
const json = z.record(z.string(), z.unknown());

/** Multi-value query param: `?status=a,b` or `?status=a&status=b`. */
// biome-ignore lint/suspicious/noExplicitAny: any enum of string values
export const csv = <T extends z.ZodEnum<any>>(item: T) =>
  z
    .union([z.string(), z.array(z.string())])
    .transform((v) => (Array.isArray(v) ? v : v.split(',')).map((x) => x.trim()).filter(Boolean))
    .pipe(z.array(item));
const boolQ = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => v === true || v === 'true' || v === '1');

export const Contact = z.object({ name: ns.optional(), email: ns.optional(), phone: ns.optional() });
export const ContactOrNull = Contact.nullable();
export const IdParams = z.object({ id: z.uuid() });
export const PoReqParams = z.object({ id: z.uuid(), reqId: z.uuid() });
export const LineParams = z.object({ id: z.uuid(), lineId: z.uuid() });
export const ProjectParams = z.object({ projectId: z.uuid() });
export const Party = z.enum(['internal', 'vendor', 'client']);
export const Destination = z.enum(['site', 'warehouse']);
export const Ok = z.object({ ok: z.boolean() });

// ---------------------------------------------------------------- purchase orders (internal)
export const PoLine = z.object({
  id: s,
  poId: s,
  quoteLineId: ns,
  specId: ns,
  code: s,
  name: s,
  description: ns,
  category: ns,
  vendorSku: ns,
  finish: ns,
  dimensions: ns,
  locationName: ns,
  quantity: z.number(),
  unitCost: z.number(),
  extended: z.number(),
  receivedQty: z.number(),
  allocatedQty: z.number().optional(),
  sort: z.number(),
});

export const ShipmentLine = z.object({
  id: s,
  poLineId: s,
  code: s,
  name: s,
  quantity: z.number(),
});

export const Shipment = z.object({
  id: s,
  poId: s,
  projectId: s,
  label: s,
  note: ns,
  status: ShipmentStatus,
  requestedDeliveryDate: ns,
  estimatedShipDate: ns,
  originalShipDate: ns,
  actualShipDate: ns,
  estimatedDeliveryDate: ns,
  deliveredAt: ns,
  origin: ns,
  originLocation: ns,
  carrier: ns,
  trackingNumber: ns,
  trackingUrl: ns,
  trackingStatus: ns,
  trackingEvents: z.array(json),
  shipMethod: ns,
  destination: Destination,
  storageLocationId: ns,
  shipDateChanges: z.number(),
  lastConfirmedAt: ns,
  lastConfirmationRequestedAt: ns,
  escalation: Escalation,
  escalationReasons: z.array(s),
  riskScore: nn,
  riskLevel: ns,
  riskReasons: z.array(s),
  createdAt: s,
  updatedAt: s,
  lines: z.array(ShipmentLine).optional(),
});

export const Requirement = z.object({
  id: s,
  poId: s,
  kind: PreOrderKind,
  label: s,
  status: RequirementStatus,
  party: Party,
  dueDate: ns,
  documentId: ns,
  submittedAt: ns,
  decidedAt: ns,
  decidedByName: ns,
  note: ns,
  sort: z.number(),
  overdue: z.boolean().optional(),
});

export const RequirementRow = Requirement.extend({
  poNumber: s,
  projectId: s,
  projectName: ns,
  vendorId: s,
  vendorName: s,
  releaseByDate: ns,
});

export const Change = z.object({
  field: s,
  lineCode: s.optional(),
  from: z.unknown(),
  to: z.unknown(),
});

export const Revision = z.object({
  id: s,
  revision: z.number(),
  changes: z.array(Change),
  documentId: ns,
  message: ns,
  issuedAt: s,
  issuedByName: ns,
});

export const Recipient = z.object({
  id: s,
  projectId: s,
  poId: ns,
  name: s,
  email: ns,
  phone: ns,
});

export const PoHeader = z.object({
  id: s,
  projectId: s,
  projectNumber: ns,
  projectName: ns,
  clientOrgId: ns,
  quoteId: ns,
  vendorId: s,
  vendorName: s,
  vendorOrgId: ns,
  vendorContact: ContactOrNull,
  number: s,
  revision: z.number(),
  status: PoStatus,
  orderDate: ns,
  issuedAt: ns,
  issuedByName: ns,
  acknowledgedAt: ns,
  shipTo: json,
  billTo: json,
  contact24h: ContactOrNull,
  paymentTerms: ns,
  freightTerms: ns,
  shipMethod: ns,
  depositPct: z.number(),
  notes: ns,
  vendorNotes: ns,
  subtotal: z.number(),
  freight: z.number(),
  tax: z.number(),
  total: z.number(),
  requestedDeliveryDate: ns,
  leadTimeWeeks: nn,
  transitDays: nn,
  origin: Origin,
  releaseByDate: ns,
  escalation: Escalation,
  escalationReasons: z.array(s),
  riskScore: nn,
  riskLevel: ns,
  riskReasons: z.array(s),
  riskScoredAt: ns,
  hasUnissuedChanges: z.boolean(),
  version: z.number(),
  createdAt: s,
  updatedAt: s,
});

export const PoDetail = PoHeader.extend({
  lines: z.array(PoLine),
  shipments: z.array(Shipment),
  requirements: z.array(Requirement),
  revisions: z.array(Revision),
  recipients: z.array(Recipient),
});

export const PoGridRow = PoHeader.extend({
  counts: z.object({
    pendingRequirements: z.number(),
    pendingRequirementKinds: z.array(s),
    shipments: z.number(),
    nextShipDate: ns,
    nextDeliveryDate: ns,
    trackingMissing: z.number(),
  }),
});

export const PoSort = z
  .enum([
    'number',
    '-number',
    'releaseByDate',
    '-releaseByDate',
    'requestedDeliveryDate',
    '-requestedDeliveryDate',
    'nextShipDate',
    '-nextShipDate',
    'total',
    '-total',
    'vendorName',
    '-vendorName',
    'projectName',
    '-projectName',
    'escalation',
    '-escalation',
    'status',
    '-status',
    'createdAt',
    '-createdAt',
  ])
  .optional();

export const PoListQuery = PageQuery.extend({
  projectId: z.uuid().optional(),
  vendorId: z.uuid().optional(),
  status: csv(PoStatus).optional(),
  escalation: csv(Escalation).optional(),
  pendingRequirements: boolQ.optional(),
  requirementKind: PreOrderKind.optional(),
  releaseByBefore: IsoDate.optional(),
  shipsWithinDays: z.coerce.number().int().min(0).max(3650).optional(),
  deliversWithinDays: z.coerce.number().int().min(0).max(3650).optional(),
  hasUnissuedChanges: boolQ.optional(),
  includeClosed: boolQ.optional(),
  sort: PoSort,
});

export const FromQuoteBody = z.object({
  quoteId: z.uuid(),
  lineIds: z.array(z.uuid()).min(1).optional(),
  requestedDeliveryDate: IsoDate.optional(),
});

export const PoPatchBody = z
  .object({
    vendorContact: Contact.nullable(),
    shipTo: json,
    billTo: json,
    contact24h: Contact.nullable(),
    paymentTerms: ns,
    freightTerms: ns,
    shipMethod: ns,
    depositPct: z.number().min(0).max(100),
    notes: ns,
    vendorNotes: ns,
    freight: z.number().min(0),
    tax: z.number().min(0),
    requestedDeliveryDate: IsoDate.nullable(),
    leadTimeWeeks: z.number().int().min(0).max(260).nullable(),
    transitDays: z.number().int().min(0).max(365).nullable(),
    origin: Origin,
  })
  .partial();

export const LineBody = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  description: ns.optional(),
  category: ns.optional(),
  vendorSku: ns.optional(),
  finish: ns.optional(),
  dimensions: ns.optional(),
  locationName: ns.optional(),
  quantity: z.number().positive(),
  unitCost: z.number().min(0),
  sort: z.number().int().optional(),
});
export const LinePatchBody = LineBody.partial();

export const IssueBody = z.object({ message: z.string().max(5000).optional() }).optional();
export const CancelBody = z.object({
  reason: z.string().max(2000).optional(),
  notifyVendor: z.boolean().default(true),
});
export const IssueResult = z.object({
  po: PoDetail,
  documentId: s,
  emailed: z.boolean(),
  changes: z.array(Change).optional(),
});
export const DiffResult = z.object({
  revision: z.number(),
  pending: z.boolean(),
  issuedAt: ns,
  changes: z.array(Change),
});
export const DocumentResult = z.object({
  id: s,
  filename: s,
  contentType: s.optional(),
  downloadUrl: s.optional(),
});

// ---------------------------------------------------------------- requirements
export const RequirementsQuery = PageQuery.extend({
  status: csv(RequirementStatus).optional(),
  kind: csv(PreOrderKind).optional(),
  party: Party.optional(),
  overdue: boolQ.optional(),
  projectId: z.uuid().optional(),
  poId: z.uuid().optional(),
  dueBefore: IsoDate.optional(),
});
export const RequirementCreateBody = z.object({
  kind: PreOrderKind,
  label: z.string().min(1).optional(),
  party: Party.optional(),
  dueDate: IsoDate.nullable().optional(),
  note: ns.optional(),
  documentId: z.uuid().nullable().optional(),
});
export const RequirementPatchBody = z.object({
  status: RequirementStatus.optional(),
  label: z.string().min(1).optional(),
  documentId: z.uuid().nullable().optional(),
  dueDate: IsoDate.nullable().optional(),
  note: ns.optional(),
});
export const RequirementBulkBody = z.object({
  ids: z.array(z.uuid()).min(1).max(500),
  status: RequirementStatus,
  note: z.string().optional(),
});

// ---------------------------------------------------------------- shipments
export const ShipmentRow = Shipment.extend({
  poNumber: s,
  poStatus: PoStatus,
  projectName: ns,
  projectNumber: ns,
  vendorId: s,
  vendorName: s,
  releaseByDate: ns,
  effectiveDeliveryDate: ns,
  trackingMissing: z.boolean(),
});
export const ShipmentsQuery = PageQuery.extend({
  status: csv(ShipmentStatus).optional(),
  shipsWithinDays: z.coerce.number().int().min(0).max(3650).optional(),
  deliversWithinDays: z.coerce.number().int().min(0).max(3650).optional(),
  trackingMissing: boolQ.optional(),
  escalation: csv(Escalation).optional(),
  projectId: z.uuid().optional(),
  vendorId: z.uuid().optional(),
  poId: z.uuid().optional(),
  includeDelivered: boolQ.optional(),
  sort: z
    .enum([
      'estimatedShipDate',
      '-estimatedShipDate',
      'effectiveDeliveryDate',
      '-effectiveDeliveryDate',
      'escalation',
      '-escalation',
      'poNumber',
      '-poNumber',
    ])
    .optional(),
});
const AllocationInput = z.object({ poLineId: z.uuid(), quantity: z.number().positive() });
export const ShipmentCreateBody = z.object({
  label: z
    .string()
    .regex(/^[A-Z0-9-]{1,8}$/)
    .optional(),
  note: ns.optional(),
  requestedDeliveryDate: IsoDate.nullable().optional(),
  estimatedShipDate: IsoDate.nullable().optional(),
  destination: Destination.optional(),
  storageLocationId: z.uuid().nullable().optional(),
  allocations: z.array(AllocationInput).default([]),
});
export const ShipmentPatchBody = z.object({
  note: ns.optional(),
  status: ShipmentStatus.optional(),
  requestedDeliveryDate: IsoDate.nullable().optional(),
  estimatedShipDate: IsoDate.nullable().optional(),
  estimatedDeliveryDate: IsoDate.nullable().optional(),
  actualShipDate: IsoDate.nullable().optional(),
  destination: Destination.optional(),
  storageLocationId: z.uuid().nullable().optional(),
  originLocation: ns.optional(),
  shipMethod: ns.optional(),
  carrier: z.string().min(1).optional(),
  trackingNumber: z.string().min(1).optional(),
  trackingUrl: ns.optional(),
  allocations: z.array(AllocationInput).optional(),
});
export const SplitBody = z.object({
  label: z
    .string()
    .regex(/^[A-Z0-9-]{1,8}$/)
    .optional(),
  note: ns.optional(),
  requestedDeliveryDate: IsoDate.nullable().optional(),
  estimatedShipDate: IsoDate.nullable().optional(),
  destination: Destination.optional(),
  lines: z.array(AllocationInput).min(1),
});
export const SplitResult = z.object({ source: Shipment, created: Shipment });
export const DeliverBody = z.object({ deliveredAt: z.iso.datetime({ offset: true }).optional() }).optional();
export const RequestConfirmationBody = z.object({ message: z.string().max(2000).optional() }).optional();
export const Confirmation = z.object({
  id: s,
  shipmentId: s,
  requestedAt: s,
  respondedAt: ns,
  response: ns,
  previousDate: ns,
  newDate: ns,
  note: ns,
  channel: s,
  respondedByName: ns,
});
export const ReceiveBody = z.object({
  receivedAt: z.iso.datetime({ offset: true }).optional(),
  storageLocationId: z.uuid().nullable().optional(),
  lines: z
    .array(
      z.object({
        poLineId: z.uuid(),
        qtyReceived: z.number().min(0),
        qtyDamaged: z.number().min(0).default(0),
      }),
    )
    .min(1),
  condition: z.enum(['good', 'damaged', 'partial']).optional(),
  notes: ns.optional(),
  photoDocumentIds: z.array(z.uuid()).default([]),
});
export const Receipt = z.object({
  id: s,
  shipmentId: s,
  poId: s,
  receivedAt: s,
  receivedByName: ns,
  storageLocationId: ns,
  condition: s,
  notes: ns,
  photoDocumentIds: z.array(s),
  lines: z.array(
    z.object({ poLineId: s, code: s, name: s, quantityReceived: z.number(), quantityDamaged: z.number() }),
  ),
});
export const ReceiveResult = z.object({
  receipt: Receipt,
  claimId: ns,
  shipment: Shipment,
  poStatus: PoStatus,
});

// ---------------------------------------------------------------- delivery recipients
export const RecipientInput = z.object({
  name: z.string().min(1),
  email: z.email().nullable().optional(),
  phone: ns.optional(),
  poId: z.uuid().nullable().optional(),
});
export const RecipientPatch = RecipientInput.partial();
export const RecipientParams = z.object({ projectId: z.uuid(), id: z.uuid() });
export const RecipientsQuery = z.object({ poId: z.uuid().optional() });
export const BulkApplyBody = z.object({
  recipients: z
    .array(RecipientInput.omit({ poId: true }))
    .min(1)
    .max(100),
  /** Remove existing recipients (project-wide and PO-specific) first. */
  replaceExisting: z.boolean().default(false),
});

// ---------------------------------------------------------------- storage
export const StorageLocation = z.object({
  id: s,
  projectId: ns,
  name: s,
  kind: StorageLocationKind,
  address: json,
  notes: ns,
  active: z.boolean(),
  itemCount: z.number().optional(),
  createdAt: s,
});
export const StorageLocationBody = z.object({
  projectId: z.uuid().nullable().optional(),
  name: z.string().min(1),
  kind: StorageLocationKind,
  address: json.optional(),
  notes: ns.optional(),
  active: z.boolean().optional(),
});
export const StorageLocationsQuery = z.object({
  projectId: z.uuid().optional(),
  includeInactive: boolQ.optional(),
});
export const StorageItem = z.object({
  id: s,
  projectId: s,
  poId: s,
  poNumber: s,
  vendorName: s,
  poLineId: s,
  code: s,
  name: s,
  storageLocationId: ns,
  locationName: ns,
  quantity: z.number(),
  status: StorageItemStatus,
  areaNote: ns,
  updatedByName: ns,
  updatedAt: s,
});
export const StorageItemsQuery = PageQuery.extend({
  projectId: z.uuid().optional(),
  locationId: z.uuid().optional(),
  poId: z.uuid().optional(),
  status: csv(StorageItemStatus).optional(),
});
export const StorageItemPatch = z.object({
  status: StorageItemStatus.optional(),
  storageLocationId: z.uuid().nullable().optional(),
  areaNote: ns.optional(),
  /** Apply the change to only this many units (the rest stay as they are). */
  quantity: z.number().positive().optional(),
});

// ---------------------------------------------------------------- claims
export const ClaimItem = z.object({
  id: s,
  poLineId: ns,
  code: ns,
  name: ns,
  quantity: z.number(),
  note: ns,
});
export const Claim = z.object({
  id: s,
  projectId: s,
  poId: ns,
  poNumber: ns,
  shipmentId: ns,
  vendorId: ns,
  vendorName: ns,
  number: s,
  type: ClaimType,
  status: ClaimStatus,
  description: s,
  resolution: ns,
  creditAmount: nn,
  reportedByName: ns,
  reportedByActor: s,
  reportedAt: s,
  resolvedAt: ns,
  photoDocumentIds: z.array(s),
  items: z.array(ClaimItem).optional(),
  createdAt: s,
  updatedAt: s,
});
export const ClaimsQuery = PageQuery.extend({
  status: csv(ClaimStatus).optional(),
  projectId: z.uuid().optional(),
  vendorId: z.uuid().optional(),
  poId: z.uuid().optional(),
});
const ClaimItemInput = z.object({
  poLineId: z.uuid(),
  quantity: z.number().positive(),
  note: z.string().optional(),
});
export const ClaimCreateBody = z.object({
  projectId: z.uuid().optional(),
  poId: z.uuid().optional(),
  shipmentId: z.uuid().optional(),
  type: ClaimType,
  description: z.string().min(1),
  items: z.array(ClaimItemInput).default([]),
  photoDocumentIds: z.array(z.uuid()).default([]),
  creditAmount: z.number().min(0).optional(),
});
export const ClaimPatchBody = z.object({
  status: ClaimStatus.optional(),
  resolution: ns.optional(),
  creditAmount: z.number().min(0).nullable().optional(),
  description: z.string().min(1).optional(),
});

// ---------------------------------------------------------------- calendar
export const CalendarQuery = z.object({
  from: IsoDate,
  to: IsoDate,
  projectId: z.uuid().optional(),
  vendorId: z.uuid().optional(),
});
export const CalendarEvent = z.object({
  date: s,
  kind: z.enum(['delivery', 'delivered', 'ship', 'release_by']),
  title: s,
  poId: s,
  poNumber: s,
  shipmentId: ns,
  shipmentLabel: ns,
  projectId: s,
  projectName: ns,
  vendorName: s,
  escalation: Escalation,
  status: s,
});
export const CalendarResult = z.object({ from: s, to: s, events: z.array(CalendarEvent) });

// ---------------------------------------------------------------- vendor portal (no sell price, no client data
// beyond ship-to, no internal notes / risk, nothing of other vendors)
export const VendorLine = z.object({
  id: s,
  code: s,
  name: s,
  description: ns,
  vendorSku: ns,
  finish: ns,
  dimensions: ns,
  locationName: ns,
  quantity: z.number(),
  unitCost: z.number(),
  extended: z.number(),
});
export const VendorShipment = z.object({
  id: s,
  label: s,
  note: ns,
  status: ShipmentStatus,
  requestedDeliveryDate: ns,
  estimatedShipDate: ns,
  actualShipDate: ns,
  estimatedDeliveryDate: ns,
  deliveredAt: ns,
  carrier: ns,
  trackingNumber: ns,
  trackingUrl: ns,
  shipMethod: ns,
  lastConfirmedAt: ns,
  lastConfirmationRequestedAt: ns,
  confirmationPending: z.boolean(),
  lines: z.array(z.object({ poLineId: s, code: s, name: s, quantity: z.number() })),
});
export const VendorRequirement = z.object({
  id: s,
  kind: PreOrderKind,
  label: s,
  status: RequirementStatus,
  dueDate: ns,
  documentId: ns,
  submittedAt: ns,
  note: ns,
});
export const VendorPoSummary = z.object({
  id: s,
  number: s,
  revision: z.number(),
  status: PoStatus,
  projectNumber: ns,
  projectName: ns,
  orderDate: ns,
  issuedAt: ns,
  acknowledgedAt: ns,
  requestedDeliveryDate: ns,
  total: z.number(),
  nextShipDate: ns,
  openActions: z.number(),
});
export const VendorPo = z.object({
  id: s,
  number: s,
  revision: z.number(),
  status: PoStatus,
  projectNumber: ns,
  projectName: ns,
  orderDate: ns,
  issuedAt: ns,
  acknowledgedAt: ns,
  shipTo: json,
  billTo: json,
  contact24h: ContactOrNull,
  paymentTerms: ns,
  freightTerms: ns,
  shipMethod: ns,
  depositPct: z.number(),
  vendorNotes: ns,
  requestedDeliveryDate: ns,
  releaseByDate: ns,
  subtotal: z.number(),
  freight: z.number(),
  tax: z.number(),
  total: z.number(),
  lines: z.array(VendorLine),
  shipments: z.array(VendorShipment),
  requirements: z.array(VendorRequirement),
  revisions: z.array(
    z.object({ revision: z.number(), changes: z.array(Change), documentId: ns, issuedAt: s }),
  ),
});
export const VendorPoQuery = PageQuery.extend({ status: csv(PoStatus).optional() });
export const AcknowledgeBody = z.object({
  estimatedShipDate: IsoDate.optional(),
  /** Per-shipment ship dates for phased orders. */
  shipments: z.array(z.object({ shipmentId: z.uuid(), estimatedShipDate: IsoDate })).optional(),
  note: z.string().max(5000).optional(),
  documentId: z.uuid().optional(),
});
export const ConfirmBody = z.object({
  onTrack: z.boolean(),
  newShipDate: IsoDate.optional(),
  note: z.string().max(5000).optional(),
});
export const TrackingBody = z.object({
  carrier: z.string().min(1),
  trackingNumber: z.string().min(1),
  shipDate: IsoDate.nullable().optional(),
  trackingUrl: z.string().optional(),
});
export const SubmitBody = z.object({ documentId: z.uuid(), note: z.string().max(5000).optional() });
export const VendorClaim = z.object({
  id: s,
  number: s,
  poId: ns,
  poNumber: ns,
  type: ClaimType,
  status: ClaimStatus,
  description: s,
  resolution: ns,
  reportedAt: s,
  resolvedAt: ns,
  photoDocumentIds: z.array(s),
  items: z.array(z.object({ code: ns, name: ns, quantity: z.number(), note: ns })),
});
export const VendorClaimPatch = z.object({
  status: z.enum(['vendor_acknowledged', 'replacement_ordered']).optional(),
  resolution: z.string().max(5000).optional(),
});

// ---------------------------------------------------------------- client portal (no cost, unit cost, totals,
// vendor terms, internal notes or risk)
export const ClientOrder = z.object({
  id: s,
  number: s,
  vendorName: s,
  status: PoStatus,
  orderDate: ns,
  requestedDeliveryDate: ns,
  items: z.array(
    z.object({
      id: s,
      code: s,
      name: s,
      description: ns,
      finish: ns,
      dimensions: ns,
      locationName: ns,
      quantity: z.number(),
      receivedQty: z.number(),
    }),
  ),
  shipments: z.array(
    z.object({
      id: s,
      label: s,
      note: ns,
      status: ShipmentStatus,
      requestedDeliveryDate: ns,
      estimatedShipDate: ns,
      estimatedDeliveryDate: ns,
      deliveredAt: ns,
      carrier: ns,
      trackingNumber: ns,
      trackingUrl: ns,
      trackingStatus: ns,
      items: z.array(z.object({ code: s, name: s, quantity: z.number() })),
    }),
  ),
  deliveredCount: z.number(),
  receivedCount: z.number(),
  orderedCount: z.number(),
  pendingApprovals: z.number(),
});
export const ClientOrders = z.object({ projectId: s, items: z.array(ClientOrder) });
export const ClientRequirement = z.object({
  id: s,
  poId: s,
  poNumber: s,
  projectId: s,
  projectName: ns,
  vendorName: s,
  kind: PreOrderKind,
  label: s,
  status: RequirementStatus,
  dueDate: ns,
  documentId: ns,
  submittedAt: ns,
  decidedAt: ns,
  decidedByName: ns,
  note: ns,
  items: z.array(z.object({ code: s, name: s, quantity: z.number() })),
});
export const ClientRequirementsQuery = z.object({
  projectId: z.uuid().optional(),
  status: csv(RequirementStatus).optional(),
});
export const DecisionBody = z.object({
  decision: z.enum(['approved', 'rejected']),
  note: z.string().max(5000).optional(),
});
export const ClientStorageItem = z.object({
  id: s,
  poNumber: s,
  vendorName: s,
  code: s,
  name: s,
  quantity: z.number(),
  status: StorageItemStatus,
  areaNote: ns,
  storageLocationId: ns,
  updatedAt: s,
});
export const ClientStorage = z.object({
  projectId: s,
  locations: z.array(z.object({ id: ns, name: s, kind: ns, items: z.array(ClientStorageItem) })),
  totals: z.record(z.string(), z.number()),
});
export const ClientStoragePatch = z.object({
  status: z.enum(['staged', 'installed']).optional(),
  areaNote: ns.optional(),
  quantity: z.number().positive().optional(),
});
export const ClientClaim = z.object({
  id: s,
  projectId: s,
  number: s,
  poNumber: ns,
  vendorName: ns,
  type: ClaimType,
  status: ClaimStatus,
  description: s,
  resolution: ns,
  reportedByName: ns,
  reportedAt: s,
  resolvedAt: ns,
  photoDocumentIds: z.array(s),
  items: z.array(z.object({ code: ns, name: ns, quantity: z.number(), note: ns })).optional(),
});
export const ClientClaimBody = z.object({
  projectId: z.uuid(),
  poId: z.uuid().optional(),
  type: ClaimType,
  description: z.string().min(1).max(10000),
  items: z.array(ClaimItemInput).default([]),
  photoDocumentIds: z.array(z.uuid()).default([]),
});
export const ClientClaimsQuery = z.object({
  projectId: z.uuid().optional(),
  status: csv(ClaimStatus).optional(),
});

// ---------------------------------------------------------------- internal
export const TenantQuery = z.object({ tenantId: z.uuid() });
export const RiskScoresBody = z.object({
  scores: z
    .array(
      z.object({
        shipmentId: z.uuid(),
        score: z.number().min(0).max(100),
        level: z.string(),
        reasons: z.array(z.string()).default([]),
      }),
    )
    .max(5000),
});
export const InternalRequirementBody = z.object({
  kind: PreOrderKind,
  status: RequirementStatus,
  documentId: z.uuid().nullable().optional(),
  note: z.string().nullable().optional(),
});

export { PageQuery, page };
export type PoHeaderT = z.infer<typeof PoHeader>;
export type ShipmentT = z.infer<typeof Shipment>;
