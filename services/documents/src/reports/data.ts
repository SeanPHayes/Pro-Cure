import { z } from '@procure/platform';

/**
 * Input data per report template (docs/service-contracts.md). Permissive on optional fields so callers
 * can send what they have: nullish → omitted, numbers may arrive as numeric strings, addresses may be
 * strings or Address objects. Unknown keys are ignored.
 */
const str = z.string().nullish();
const num = z.coerce.number().nullish();
const reqNum = z.coerce.number();
const address = z.union([z.string(), z.record(z.string(), z.unknown())]).nullish();
const contact = z.object({ name: str, email: str, phone: str }).partial().nullish();

export const Tenant = z.object({
  name: z.string().min(1),
  address,
  phone: str,
  email: str,
});

export const ProjectRef = z.object({
  number: str,
  name: z.string().min(1),
  propertyName: str,
  address,
});

const Totals = z.object({
  subtotal: reqNum,
  freight: num,
  tax: num,
  total: reqNum,
});

// ---------------------------------------------------------------------------------------------
export const QuoteData = z.object({
  tenant: Tenant,
  project: ProjectRef,
  quote: z.object({
    number: z.string().min(1),
    name: str,
    date: str,
    validUntil: str,
    notes: str,
    status: str,
  }),
  client: z.object({ name: str, address }).nullish(),
  contacts: z.array(z.object({ role: str, name: z.string(), email: str, phone: str })).default([]),
  sections: z
    .array(
      z.object({
        location: z.string().min(1),
        lines: z.array(
          z.object({
            code: str,
            name: z.string().min(1),
            description: str,
            finish: str,
            dimensions: str,
            qty: reqNum,
            unit: str,
            unitPrice: num,
            extended: num,
          }),
        ),
      }),
    )
    .min(1, 'A quote needs at least one section'),
  totals: Totals,
  terms: str,
});

// ---------------------------------------------------------------------------------------------
const Change = z.object({
  /** Header field ('requestedDelivery', 'shipTo', …) or line field ('qty', 'unitCost', …). */
  field: z.string().min(1),
  /** Set when the change is on a line; null/absent for PO header changes. 'added'/'removed' via field. */
  lineCode: str,
  from: z.unknown().optional(),
  to: z.unknown().optional(),
});
export type Change = z.infer<typeof Change>;

export const PurchaseOrderData = z.object({
  tenant: Tenant,
  vendor: z.object({ name: z.string().min(1), address, contact }),
  po: z.object({
    number: z.string().min(1),
    revision: z.coerce.number().int().min(0).default(0),
    date: str,
    paymentTerms: str,
    freightTerms: str,
    requestedDelivery: str,
    releaseBy: str,
    notes: str,
    shipTo: address,
    billTo: address,
    contact24h: z.union([z.string(), contact]).nullish(),
  }),
  project: z.object({ number: str, name: z.string().min(1) }),
  lines: z
    .array(
      z.object({
        code: z.string().min(1),
        name: z.string().min(1),
        description: str,
        finish: str,
        qty: reqNum,
        unitCost: num,
        extended: num,
      }),
    )
    .min(1, 'A purchase order needs at least one line'),
  totals: Totals,
  shipments: z
    .array(
      z.object({
        label: z.string().min(1),
        note: str,
        requestedDelivery: str,
        lines: z.array(z.object({ code: z.string(), qty: reqNum })).default([]),
      }),
    )
    .default([]),
  changes: z.array(Change).default([]),
});
export type PurchaseOrderData = z.infer<typeof PurchaseOrderData>;

export const PoRevisionData = PurchaseOrderData.extend({
  changes: z.array(Change).min(1, 'A PO revision needs at least one change'),
});

// ---------------------------------------------------------------------------------------------
export const SpecBookData = z.object({
  tenant: Tenant,
  project: ProjectRef,
  quote: z.object({ number: str, name: str }).nullish(),
  date: str,
  specs: z
    .array(
      z.object({
        code: z.string().min(1),
        name: z.string().min(1),
        category: str,
        vendor: str,
        description: str,
        dimensions: str,
        finish: str,
        materials: str,
        location: str,
        quantity: num,
        notes: str,
        documentIds: z.array(z.uuid()).default([]),
      }),
    )
    .min(1, 'A spec book needs at least one spec')
    .max(2000),
});
export type SpecBookData = z.infer<typeof SpecBookData>;

// ---------------------------------------------------------------------------------------------
export const ScheduleData = z.object({
  tenant: Tenant,
  project: ProjectRef,
  generatedAt: str,
  notes: str,
  headerFields: z.array(z.object({ label: z.string(), value: z.unknown() })).default([]),
  milestones: z.array(
    z.object({
      name: z.string().min(1),
      party: str,
      start: str,
      due: str,
      status: str,
      completedAt: str,
    }),
  ),
});

// ---------------------------------------------------------------------------------------------
export const CostRequestData = z.object({
  tenant: Tenant,
  vendor: z.object({ name: z.string().min(1), address, contact }),
  project: z.object({ number: str, name: str }).nullish(),
  request: z.object({ number: z.string().min(1), dueDate: str, message: str, date: str }),
  lines: z
    .array(
      z.object({
        code: z.string().min(1),
        name: z.string().min(1),
        description: str,
        finish: str,
        dimensions: str,
        qty: reqNum,
      }),
    )
    .min(1, 'A cost request needs at least one line'),
});

// ---------------------------------------------------------------------------------------------
export const InvoiceData = z.object({
  tenant: Tenant,
  client: z.object({ name: z.string().min(1), address }),
  invoice: z.object({
    number: z.string().min(1),
    kind: str,
    issueDate: str,
    dueDate: str,
    terms: str,
    notes: str,
    status: str,
  }),
  project: z.object({ number: str, name: str }).nullish(),
  lines: z
    .array(z.object({ description: z.string().min(1), qty: num, unitPrice: num, amount: reqNum }))
    .min(1, 'An invoice needs at least one line'),
  totals: z.object({ subtotal: reqNum, tax: num, total: reqNum, paid: num, balance: num }),
  remitTo: z.union([z.string(), z.record(z.string(), z.unknown())]).nullish(),
});

// ---------------------------------------------------------------------------------------------
export const ClaimData = z.object({
  tenant: Tenant,
  project: ProjectRef,
  claim: z.object({
    number: z.string().min(1),
    type: str,
    status: str,
    description: str,
    reportedBy: str,
    reportedAt: str,
    poNumber: str,
    vendor: str,
  }),
  items: z.array(z.object({ code: str, name: z.string().min(1), qty: num, note: str })).default([]),
});

export const TEMPLATE_DATA = {
  quote: QuoteData,
  purchase_order: PurchaseOrderData,
  po_revision: PoRevisionData,
  spec_book: SpecBookData,
  schedule: ScheduleData,
  cost_request: CostRequestData,
  invoice: InvoiceData,
  claim: ClaimData,
} as const;
