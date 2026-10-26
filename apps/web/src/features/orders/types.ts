/** Shapes returned by the orders service (services/orders/src/schemas.ts). */

export type PoStatus =
  | 'draft'
  | 'issued'
  | 'acknowledged'
  | 'in_production'
  | 'partially_shipped'
  | 'shipped'
  | 'partially_delivered'
  | 'delivered'
  | 'closed'
  | 'cancelled';
export type ShipmentStatus =
  | 'planned'
  | 'confirmed'
  | 'in_production'
  | 'ready'
  | 'shipped'
  | 'in_transit'
  | 'delivered'
  | 'exception';
export type Escalation = 'none' | 'watch' | 'at_risk' | 'critical';
export type RequirementKind =
  | 'order_acknowledgement'
  | 'deposit'
  | 'shop_drawing_approval'
  | 'finish_sample_approval'
  | 'cfa'
  | 'credit_approval'
  | 'other';
export type RequirementStatus = 'pending' | 'submitted' | 'approved' | 'rejected' | 'waived';
export type Party = 'internal' | 'vendor' | 'client';
export type ClaimStatus =
  | 'open'
  | 'submitted_to_vendor'
  | 'vendor_acknowledged'
  | 'replacement_ordered'
  | 'credited'
  | 'resolved'
  | 'rejected';
export type ClaimType = 'damage' | 'shortage' | 'wrong_item' | 'defect' | 'concealed_damage' | 'other';
export type StorageItemStatus = 'in_transit' | 'stored' | 'staged' | 'installed' | 'damaged';
export type StorageLocationKind = 'warehouse' | 'on_site' | 'staging';

export interface Contact {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
}
export type Address = Record<string, unknown> & {
  name?: string;
  line1?: string;
  line2?: string;
  city?: string;
  region?: string;
  postalCode?: string;
  country?: string;
  phone?: string;
  email?: string;
};

export interface PoLine {
  id: string;
  poId: string;
  quoteLineId: string | null;
  specId: string | null;
  code: string;
  name: string;
  description: string | null;
  category: string | null;
  vendorSku: string | null;
  finish: string | null;
  dimensions: string | null;
  locationName: string | null;
  quantity: number;
  unitCost: number;
  extended: number;
  receivedQty: number;
  allocatedQty?: number;
  sort: number;
}

export interface ShipmentLine {
  id: string;
  poLineId: string;
  code: string;
  name: string;
  quantity: number;
}

export interface Shipment {
  id: string;
  poId: string;
  projectId: string;
  label: string;
  note: string | null;
  status: ShipmentStatus;
  requestedDeliveryDate: string | null;
  estimatedShipDate: string | null;
  originalShipDate: string | null;
  actualShipDate: string | null;
  estimatedDeliveryDate: string | null;
  deliveredAt: string | null;
  origin: string | null;
  originLocation: string | null;
  carrier: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  trackingStatus: string | null;
  trackingEvents: Record<string, unknown>[];
  shipMethod: string | null;
  destination: 'site' | 'warehouse';
  storageLocationId: string | null;
  shipDateChanges: number;
  lastConfirmedAt: string | null;
  lastConfirmationRequestedAt: string | null;
  escalation: Escalation;
  escalationReasons: string[];
  riskScore: number | null;
  riskLevel: string | null;
  riskReasons: string[];
  createdAt: string;
  updatedAt: string;
  lines?: ShipmentLine[];
}

export interface ShipmentRow extends Shipment {
  poNumber: string;
  poStatus: PoStatus;
  projectName: string | null;
  projectNumber: string | null;
  vendorId: string;
  vendorName: string;
  releaseByDate: string | null;
  effectiveDeliveryDate: string | null;
  trackingMissing: boolean;
}

export interface Requirement {
  id: string;
  poId: string;
  kind: RequirementKind;
  label: string;
  status: RequirementStatus;
  party: Party;
  dueDate: string | null;
  documentId: string | null;
  submittedAt: string | null;
  decidedAt: string | null;
  decidedByName: string | null;
  note: string | null;
  sort: number;
  overdue?: boolean;
}

export interface RequirementRow extends Requirement {
  poNumber: string;
  projectId: string;
  projectName: string | null;
  vendorId: string;
  vendorName: string;
  releaseByDate: string | null;
}

export interface Change {
  field: string;
  lineCode?: string;
  from: unknown;
  to: unknown;
}

export interface Revision {
  id: string;
  revision: number;
  changes: Change[];
  documentId: string | null;
  message: string | null;
  issuedAt: string;
  issuedByName: string | null;
}

export interface Recipient {
  id: string;
  projectId: string;
  poId: string | null;
  name: string;
  email: string | null;
  phone: string | null;
}

export interface PoHeader {
  id: string;
  projectId: string;
  projectNumber: string | null;
  projectName: string | null;
  clientOrgId: string | null;
  quoteId: string | null;
  vendorId: string;
  vendorName: string;
  vendorOrgId: string | null;
  vendorContact: Contact | null;
  number: string;
  revision: number;
  status: PoStatus;
  orderDate: string | null;
  issuedAt: string | null;
  issuedByName: string | null;
  acknowledgedAt: string | null;
  shipTo: Address;
  billTo: Address;
  contact24h: Contact | null;
  paymentTerms: string | null;
  freightTerms: string | null;
  shipMethod: string | null;
  depositPct: number;
  notes: string | null;
  vendorNotes: string | null;
  subtotal: number;
  freight: number;
  tax: number;
  total: number;
  requestedDeliveryDate: string | null;
  leadTimeWeeks: number | null;
  transitDays: number | null;
  origin: 'domestic' | 'international';
  releaseByDate: string | null;
  escalation: Escalation;
  escalationReasons: string[];
  riskScore: number | null;
  riskLevel: string | null;
  riskReasons: string[];
  riskScoredAt: string | null;
  hasUnissuedChanges: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface PoDetail extends PoHeader {
  lines: PoLine[];
  shipments: Shipment[];
  requirements: Requirement[];
  revisions: Revision[];
  recipients: Recipient[];
}

export interface PoGridRow extends PoHeader {
  counts: {
    pendingRequirements: number;
    pendingRequirementKinds: RequirementKind[];
    shipments: number;
    nextShipDate: string | null;
    nextDeliveryDate: string | null;
    trackingMissing: number;
    unconfirmedShipments: number;
  };
}

export interface Confirmation {
  id: string;
  shipmentId: string;
  requestedAt: string;
  respondedAt: string | null;
  response: string | null;
  previousDate: string | null;
  newDate: string | null;
  note: string | null;
  channel: string;
  respondedByName: string | null;
}

export interface StorageLocation {
  id: string;
  projectId: string | null;
  name: string;
  kind: StorageLocationKind;
  address: Address;
  notes: string | null;
  active: boolean;
  itemCount?: number;
  createdAt: string;
}

export interface StorageItem {
  id: string;
  projectId: string;
  poId: string;
  poNumber: string;
  vendorName: string;
  poLineId: string;
  code: string;
  name: string;
  storageLocationId: string | null;
  locationName: string | null;
  quantity: number;
  status: StorageItemStatus;
  areaNote: string | null;
  updatedByName: string | null;
  updatedAt: string;
}

export interface ClaimItem {
  id?: string;
  poLineId?: string | null;
  code: string | null;
  name: string | null;
  quantity: number;
  note: string | null;
}

export interface Claim {
  id: string;
  projectId: string;
  poId: string | null;
  poNumber: string | null;
  shipmentId: string | null;
  vendorId: string | null;
  vendorName: string | null;
  number: string;
  type: ClaimType;
  status: ClaimStatus;
  description: string;
  resolution: string | null;
  creditAmount: number | null;
  reportedByName: string | null;
  reportedByActor: 'internal' | 'client' | 'vendor';
  reportedAt: string;
  resolvedAt: string | null;
  photoDocumentIds: string[];
  items?: ClaimItem[];
  createdAt: string;
  updatedAt: string;
}

export interface CalendarEvent {
  date: string;
  kind: 'delivery' | 'delivered' | 'ship' | 'release_by';
  title: string;
  poId: string;
  poNumber: string;
  shipmentId: string | null;
  shipmentLabel: string | null;
  projectId: string;
  projectName: string | null;
  vendorName: string;
  escalation: Escalation;
  status: string;
}

export interface RiskSummary {
  run: {
    id: string;
    runAt: string;
    shipmentsScored: number;
    vendorsProfiled: number;
    jobId: string | null;
  } | null;
  counts: Record<Escalation, number>;
  narrative: string | null;
  top: {
    shipmentId: string;
    score: number;
    level: string;
    reasons: string[];
    label: string;
    poId: string | null;
    poNumber: string | null;
    projectName: string | null;
    vendorId: string;
    vendorName: string | null;
  }[];
}

// ---------------------------------------------------------------- vendor portal
export interface VendorShipment {
  id: string;
  label: string;
  note: string | null;
  status: ShipmentStatus;
  requestedDeliveryDate: string | null;
  estimatedShipDate: string | null;
  actualShipDate: string | null;
  estimatedDeliveryDate: string | null;
  deliveredAt: string | null;
  carrier: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  shipMethod: string | null;
  lastConfirmedAt: string | null;
  lastConfirmationRequestedAt: string | null;
  confirmationPending: boolean;
  lines: { poLineId: string; code: string; name: string; quantity: number }[];
}
export interface VendorRequirement {
  id: string;
  kind: RequirementKind;
  label: string;
  status: RequirementStatus;
  dueDate: string | null;
  documentId: string | null;
  submittedAt: string | null;
  note: string | null;
}
export interface VendorPoSummary {
  id: string;
  number: string;
  revision: number;
  status: PoStatus;
  projectNumber: string | null;
  projectName: string | null;
  orderDate: string | null;
  issuedAt: string | null;
  acknowledgedAt: string | null;
  requestedDeliveryDate: string | null;
  total: number;
  nextShipDate: string | null;
  openActions: number;
}
export interface VendorPo {
  id: string;
  number: string;
  revision: number;
  status: PoStatus;
  projectNumber: string | null;
  projectName: string | null;
  orderDate: string | null;
  issuedAt: string | null;
  acknowledgedAt: string | null;
  shipTo: Address;
  billTo: Address;
  contact24h: Contact | null;
  paymentTerms: string | null;
  freightTerms: string | null;
  shipMethod: string | null;
  depositPct: number;
  vendorNotes: string | null;
  requestedDeliveryDate: string | null;
  releaseByDate: string | null;
  subtotal: number;
  freight: number;
  tax: number;
  total: number;
  lines: {
    id: string;
    code: string;
    name: string;
    description: string | null;
    vendorSku: string | null;
    finish: string | null;
    dimensions: string | null;
    locationName: string | null;
    quantity: number;
    unitCost: number;
    extended: number;
  }[];
  shipments: VendorShipment[];
  requirements: VendorRequirement[];
  revisions: { revision: number; changes: Change[]; documentId: string | null; issuedAt: string }[];
}
export interface VendorClaim {
  id: string;
  number: string;
  poId: string | null;
  poNumber: string | null;
  type: ClaimType;
  status: ClaimStatus;
  description: string;
  resolution: string | null;
  reportedAt: string;
  resolvedAt: string | null;
  photoDocumentIds: string[];
  items: { code: string | null; name: string | null; quantity: number; note: string | null }[];
}

// ---------------------------------------------------------------- client portal
export interface ClientOrder {
  id: string;
  number: string;
  vendorName: string;
  status: PoStatus;
  orderDate: string | null;
  requestedDeliveryDate: string | null;
  items: {
    id: string;
    code: string;
    name: string;
    description: string | null;
    finish: string | null;
    dimensions: string | null;
    locationName: string | null;
    quantity: number;
    receivedQty: number;
  }[];
  shipments: {
    id: string;
    label: string;
    note: string | null;
    status: ShipmentStatus;
    requestedDeliveryDate: string | null;
    estimatedShipDate: string | null;
    estimatedDeliveryDate: string | null;
    deliveredAt: string | null;
    carrier: string | null;
    trackingNumber: string | null;
    trackingUrl: string | null;
    trackingStatus: string | null;
    items: { code: string; name: string; quantity: number }[];
  }[];
  deliveredCount: number;
  receivedCount: number;
  orderedCount: number;
  pendingApprovals: number;
}
export interface ClientClaim {
  id: string;
  projectId: string;
  number: string;
  poNumber: string | null;
  vendorName: string | null;
  type: ClaimType;
  status: ClaimStatus;
  description: string;
  resolution: string | null;
  reportedByName: string | null;
  reportedAt: string;
  resolvedAt: string | null;
  photoDocumentIds: string[];
  items?: { code: string | null; name: string | null; quantity: number; note: string | null }[];
}
