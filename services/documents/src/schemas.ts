import { PageQuery, page, SpecDocumentKind } from '@procure/domain';
import { z } from '@procure/platform';

export const DocumentKind = z.enum([
  ...SpecDocumentKind.options,
  'report',
  'photo',
  'email',
  'email_attachment',
  'invoice',
  'contract',
]);
export type DocumentKind = z.infer<typeof DocumentKind>;

export const Visibility = z.enum(['internal', 'vendor', 'client']);
export type Visibility = z.infer<typeof Visibility>;

/** Entity types are owned by other services; accept any snake_case name (e.g. 'purchase_order'). */
export const EntityTypeName = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_]{1,62}$/, 'entityType must be a snake_case entity name');

export const IdParams = z.object({ id: z.uuid() });

/** Public document shape (docs/service-contracts.md). */
export const Document = z.object({
  id: z.string(),
  filename: z.string(),
  contentType: z.string(),
  size: z.number(),
  sha256: z.string(),
  kind: DocumentKind,
  template: z.string().nullable(),
  entityType: z.string().nullable(),
  entityId: z.string().nullable(),
  visibility: Visibility,
  vendorOrgId: z.string().nullable(),
  clientOrgId: z.string().nullable(),
  includeInSpecBook: z.boolean(),
  pageCount: z.number().int().nullable(),
  global: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  uploadedByName: z.string().nullable(),
  downloadUrl: z.string(),
  links: z.array(z.object({ entityType: z.string(), entityId: z.string() })),
});
export type DocumentOut = z.infer<typeof Document>;

export const DocumentListQuery = PageQuery.extend({
  entityType: EntityTypeName.optional(),
  entityId: z.uuid().optional(),
  kind: DocumentKind.optional(),
  visibility: Visibility.optional(),
  includeInSpecBook: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});

export const DocumentPatch = z.object({
  filename: z.string().trim().min(1).max(250).optional(),
  kind: DocumentKind.optional(),
  visibility: Visibility.optional(),
  vendorOrgId: z.uuid().nullable().optional(),
  clientOrgId: z.uuid().nullable().optional(),
  includeInSpecBook: z.boolean().optional(),
  entityType: EntityTypeName.nullable().optional(),
  entityId: z.uuid().nullable().optional(),
});

export const LinkBody = z.object({ entityType: EntityTypeName, entityId: z.uuid() });

/** Multipart form fields accompanying the `file` part of POST /documents. */
export const UploadFields = z.object({
  entityType: EntityTypeName.optional(),
  entityId: z.uuid().optional(),
  kind: DocumentKind.default('other'),
  /** Defaults to internal for staff; vendor/client uploads are always shared with their own org. */
  visibility: Visibility.optional(),
  vendorOrgId: z.uuid().optional(),
  clientOrgId: z.uuid().optional(),
  includeInSpecBook: z
    .enum(['true', 'false', '1', '0', 'on'])
    .transform((v) => v === 'true' || v === '1' || v === 'on')
    .optional(),
});

export const InternalCreateBody = z.object({
  /** Null creates a global document (visible to every authenticated actor). */
  tenantId: z.uuid().nullable(),
  filename: z.string().trim().min(1).max(250),
  contentType: z.string().min(3).max(200),
  base64: z.string().min(1),
  entityType: EntityTypeName.nullable().optional(),
  entityId: z.uuid().nullable().optional(),
  kind: DocumentKind.default('other'),
  visibility: Visibility.default('internal'),
  vendorOrgId: z.uuid().nullable().optional(),
  clientOrgId: z.uuid().nullable().optional(),
  includeInSpecBook: z.boolean().optional(),
  uploadedByName: z.string().max(200).nullable().optional(),
});

export const ReportTemplate = z.enum([
  'quote',
  'purchase_order',
  'po_revision',
  'spec_book',
  'schedule',
  'cost_request',
  'invoice',
  'claim',
]);
export type ReportTemplate = z.infer<typeof ReportTemplate>;

const RenderFields = {
  template: ReportTemplate,
  /** Validated per template (see src/reports/data.ts). */
  data: z.record(z.string(), z.unknown()),
  filename: z.string().trim().min(1).max(250),
  entityType: EntityTypeName.nullable().optional(),
  entityId: z.uuid().nullable().optional(),
  visibility: Visibility.default('internal'),
  vendorOrgId: z.uuid().nullable().optional(),
  clientOrgId: z.uuid().nullable().optional(),
  includeInSpecBook: z.boolean().optional(),
};
export const RenderBody = z.object(RenderFields);
export const InternalRenderBody = z.object({ tenantId: z.uuid(), ...RenderFields });
export type RenderRequest = z.infer<typeof RenderBody>;

export { page };
