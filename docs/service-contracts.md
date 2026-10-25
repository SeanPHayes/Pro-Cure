# Service contracts

Routes are mounted at the service root (the gateway / API Gateway adds `/api/<service>`). Public routes
take a bearer token. `/internal/*` routes are service-to-service only (header `x-procure-internal`,
added by `callService`), take `tenantId` as a query parameter, and run with `withTenant(tenantId, …)`.

Web-app URLs used in emails and notifications (`PUBLIC_WEB_URL` + path):

| Audience | Path |
|---|---|
| Internal | `/app/projects/:id`, `/app/quotes/:id`, `/app/orders/:id`, `/app/cost-requests/:id`, `/app/inbox`, `/app/approvals`, `/app/claims/:id`, `/app/invoices/:id` |
| Vendor | `/vendor/cost-requests/:id`, `/vendor/orders/:id` |
| Client (owner) | `/portal/projects/:id`, `/portal/quotes/:id`, `/portal/approvals`, `/portal/claims/:id`, `/portal/invoices/:id` |

## identity (exists)

- `GET /internal/users?tenantId&roles=a,b&ids=a,b&orgId` → `[{ id, email, name, orgId, orgType, roles }]`
- `GET /orgs/:id` → organization (name, type, address, phone, email, website)

## catalog

- `GET /internal/vendors/:vendorId?tenantId` →
  `{ id, name, orgId|null, website, categories[], profile: { leadTimeWeeks|null, shipMethod|null, freightTerms|null,
  paymentTerms|null, depositPct|null, primaryContact: {name,email,phone}|null, rating|null, onTimeRate|null,
  preferred, accountNumber|null } }`
- `GET /internal/vendors?tenantId&q&domain` → same shape, list (domain = email domain match on website/contact)
- `GET /internal/brand-standards/:id` → `{ id, brandId, brandName, name, version, items: [...] }`
- `POST /internal/brand-standards/:id/items` `{ items: BrandStandardItemInput[] }` → upsert by `code`

## documents

Document shape: `{ id, filename, contentType, size, kind, entityType, entityId, visibility, vendorOrgId,
clientOrgId, includeInSpecBook, pageCount, createdAt, uploadedByName, downloadUrl }` where `downloadUrl` is
`/api/documents/documents/:id/download`.

- `POST /documents` multipart: `file` + fields `entityType, entityId, kind, visibility (internal|vendor|client),
  vendorOrgId?, clientOrgId?, includeInSpecBook?`
- `GET /documents?entityType&entityId`, `GET /documents/:id`, `PATCH /documents/:id`, `DELETE /documents/:id`
- `GET /documents/:id/download`
- `POST /internal/documents` `{ tenantId, filename, contentType, base64, entityType?, entityId?, kind, visibility,
  vendorOrgId?, clientOrgId?, includeInSpecBook?, uploadedByName? }` → Document
- `GET /internal/documents/:id/content?tenantId` → `{ filename, contentType, base64 }`
- `GET /internal/documents?tenantId&entityType&entityId` → Document[]
- `POST /internal/reports/render` `{ tenantId, template, data, filename, entityType?, entityId?, visibility,
  vendorOrgId?, clientOrgId? }` → Document (a generated PDF). Templates and their `data`:
  - `quote`: `{ tenant: {name,address,phone,email}, project: {number,name,propertyName,address}, quote: {number,name,date,
    validUntil,notes}, contacts: [{role,name,email,phone}], sections: [{location, lines: [{code,name,description,finish,
    dimensions,qty,unit,unitPrice,extended}]}], totals: {subtotal,freight,tax,total} }`
  - `purchase_order` / `po_revision`: `{ tenant, vendor: {name,address,contact:{name,email,phone}}, po: {number,revision,
    date,paymentTerms,freightTerms,requestedDelivery,releaseBy,notes,shipTo,billTo,contact24h}, project: {number,name},
    lines: [{code,name,description,finish,qty,unitCost,extended}], totals: {subtotal,freight,tax,total},
    shipments: [{label,note,requestedDelivery,lines:[{code,qty}]}], changes?: [{field,lineCode,from,to}] }`
  - `spec_book`: `{ tenant, project, quote?: {number,name}, specs: [{code,name,category,vendor,description,dimensions,
    finish,materials,location,documentIds: string[]}] }` — cover, contents, one page per spec followed by the
    spec's attached PDF documents merged in order.
  - `schedule`: `{ tenant, project, generatedAt, notes, headerFields: [{label,value}], milestones: [{name,party,start,due,
    status,completedAt}] }`
  - `cost_request`: `{ tenant, vendor, request: {number,dueDate,message}, lines: [{code,name,description,qty}] }`
  - `invoice`: `{ tenant, client: {name,address}, invoice: {number,kind,issueDate,dueDate,terms,notes}, project,
    lines: [{description,qty,unitPrice,amount}], totals: {subtotal,tax,total,paid,balance}, remitTo }`
  - `claim`: `{ tenant, project, claim: {number,type,status,description,reportedBy,reportedAt,poNumber,vendor}, items:
    [{code,name,qty,note}] }`

## projects

- `GET /internal/projects/:id?tenantId` → `{ id, number, name, propertyName, brandId, clientOrgId, address,
  shipToAddress, targetOpenDate, stage, status, team: [{userId,name,email,role}], contacts: [{name,email,phone,company,
  role,isDeliveryRecipient}] }`
- `GET /internal/projects?tenantId&ids=a,b` → list of the same (without contacts)

## quoting

- `GET /internal/quotes/:id/order-lines?tenantId&lineIds=a,b` → `{ quote: {id,number,name,projectId,status},
  lines: [{ id, specId, code, name, description, category, vendorId, vendorSku, finish, dimensions, locationName,
  quantity, unitCost, unitPrice, readyToOrder, poId|null }] }`
- `GET /internal/quotes/summary?tenantId&projectId` → `{ quotes: [{id,number,name,status,costTotal,sellTotal,approvedAt}] }`
- `GET /internal/cost-requests/:id?tenantId` → `{ id, number, quoteId, vendorId, status, lines: [{ id, quoteLineId,
  specId, code, name, description, vendorSku, quantity, currentCost }] }`
- `POST /internal/cost-requests/:id/responses?tenantId` `{ source: 'ai_pdf'|'manual', lines: [{ costRequestLineId,
  cost, expiresAt?, leadTimeWeeks?, notes? }] }`
- `POST /internal/specs/import?tenantId` `{ rows: [{ code, name, category, vendorId?, description?, dimensions?, finish?,
  materials?, cost?, brandStandardItemId? }] }` → `{ created, updated }`
- `GET /internal/specs?tenantId&quoteId|ids` → `[{ id, code, name, category, vendorId, vendorSku, description }]`

## orders

- `GET /internal/purchase-orders/summary?tenantId&projectId` → `{ pos: [{id,number,vendorId,status,total,issuedAt}] }`
- `GET /internal/purchase-orders/open?tenantId&vendorId` → `[{ id, number, projectId, projectName, vendorId, vendorName,
  status, revision }]`
- `GET /internal/shipments/open?tenantId` → open shipments with risk features (see orders README)
- `GET /internal/shipments/history?tenantId` → delivered shipments: `{ vendorId, origin, plannedShipDate,
  actualShipDate, requestedDeliveryDate, deliveredAt, shipDateChanges }[]`
- `POST /internal/risk-scores?tenantId` `{ scores: [{ shipmentId, score, level, reasons }] }`
- `POST /internal/shipments/:id/tracking?tenantId` `{ carrier, trackingNumber, shipDate? }`
- `POST /internal/purchase-orders/:id/requirements?tenantId` `{ kind, status, documentId?, note? }` (sets the PO's
  requirement of that kind)

## comms

- `GET /threads/for?entityType&entityId` → thread (created on first access)
- `POST /internal/threads` `{ tenantId, entityType, entityId, subject, visibility, vendorOrgId?, clientOrgId? }` → thread
  (idempotent on entity + visibility)
- `POST /internal/messages` `{ tenantId, threadId, authorName, authorEmail?, direction, channel, bodyText,
  attachments: documentId[] }`
- `GET /internal/inbound/:id?tenantId` → `{ id, from, to, subject, text, receivedAt, attachments: [{documentId,
  filename, contentType}] }`
- `POST /internal/inbound/:id/route?tenantId` `{ status: 'routed'|'needs_review', threadId?, entityType?, entityId?,
  confidence, reasons: string[], suggestions: [{ type, label, payload }] }`
- Consumes `cmd.email.send` and `cmd.notify` (see `packages/domain/src/events.ts`).
