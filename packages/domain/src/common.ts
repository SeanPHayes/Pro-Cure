import { z } from 'zod';

export const Uuid = z.uuid();
export const IsoDate = z.iso.date();
export const IsoDateTime = z.iso.datetime({ offset: true });

export const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  q: z.string().trim().min(1).optional(),
  sort: z.string().optional(),
});
export type PageQuery = z.infer<typeof PageQuery>;

export const page = <T extends z.ZodType>(item: T) =>
  z.object({
    items: z.array(item),
    total: z.number().int(),
    limit: z.number().int(),
    offset: z.number().int(),
  });

export const Address = z.object({
  line1: z.string().default(''),
  line2: z.string().optional(),
  city: z.string().default(''),
  region: z.string().default(''),
  postalCode: z.string().default(''),
  country: z.string().default('US'),
});
export type Address = z.infer<typeof Address>;

export const ProblemDetails = z.object({
  type: z.string().default('about:blank'),
  title: z.string(),
  status: z.number().int(),
  detail: z.string().optional(),
  code: z.string().optional(),
  errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  traceId: z.string().optional(),
});
export type ProblemDetails = z.infer<typeof ProblemDetails>;

/** Entity types that documents, threads, activity and approvals can attach to. */
export const EntityType = z.enum([
  'project',
  'task',
  'quote',
  'quote_line',
  'spec',
  'master_spec',
  'brand_standard',
  'product',
  'vendor',
  'cost_request',
  'purchase_order',
  'shipment',
  'claim',
  'invoice',
  'vendor_bill',
  'organization',
  'user',
]);
export type EntityType = z.infer<typeof EntityType>;

/**
 * PATCH body from a create schema: every field optional and **no defaults**. Zod's `.partial()` keeps
 * `.default()` values, so a patch that omits a defaulted field would silently reset it.
 */
export const patchOf = <T extends z.ZodObject>(schema: T) =>
  z.object(
    Object.fromEntries(
      Object.entries(schema.shape).map(([k, v]) => [
        k,
        (v instanceof z.ZodDefault ? (v.unwrap() as z.ZodType) : (v as z.ZodType)).optional(),
      ]),
    ) as { [K in keyof T['shape']]: z.ZodOptional<z.ZodType<Exclude<z.output<T['shape'][K]>, undefined>>> },
  );
