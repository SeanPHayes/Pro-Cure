import { SpecCategory } from '@procure/domain';
import { z } from '@procure/platform';

export const ApprovedVendor = z.object({ name: z.string(), model: z.string().nullable() });

export const BrandSpecItem = z.object({
  code: z.string(),
  area: z.string().nullable(),
  category: SpecCategory,
  name: z.string(),
  description: z.string().nullable(),
  dimensions: z.string().nullable(),
  finish: z.string().nullable(),
  materials: z.string().nullable(),
  approvedVendors: z.array(ApprovedVendor),
  quantityBasis: z.string().nullable(),
  sourcePage: z.number().int().nullable(),
  confidence: z.number().min(0).max(1),
});
export type BrandSpecItem = z.infer<typeof BrandSpecItem>;

export const BrandSpecStandard = z.object({
  name: z.string().nullable(),
  brandGuess: z.string().nullable(),
  version: z.string().nullable(),
  effectiveDate: z.string().nullable(),
});
export type BrandSpecStandard = z.infer<typeof BrandSpecStandard>;

export const BrandSpecOutput = z.object({
  standard: BrandSpecStandard,
  items: z.array(BrandSpecItem),
  warnings: z.array(z.string()),
  scannedPages: z.array(z.number().int()).default([]),
});
export type BrandSpecOutput = z.infer<typeof BrandSpecOutput>;
