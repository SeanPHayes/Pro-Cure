import { IsoDate, Origin, PageQuery, page, SpecCategory } from '@procure/domain';
import { z } from '@procure/platform';

/** Query-string boolean: accepts true/false/1/0. */
export const QBool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1')
  .optional();

export const IdParams = z.object({ id: z.uuid() });

// ---------------------------------------------------------------------------------------------
// Brands
// ---------------------------------------------------------------------------------------------
export const Brand = z.object({
  id: z.string(),
  name: z.string(),
  parentCompany: z.string().nullable(),
  segment: z.string().nullable(),
  logoUrl: z.string().nullable(),
  standardCount: z.number().int().optional(),
  createdAt: z.string(),
});
export const BrandInput = z.object({
  name: z.string().trim().min(2).max(200),
  parentCompany: z.string().trim().max(200).nullable().optional(),
  segment: z.string().trim().max(100).nullable().optional(),
  logoUrl: z.string().max(2000).nullable().optional(),
});

// ---------------------------------------------------------------------------------------------
// Brand standards
// ---------------------------------------------------------------------------------------------
export const StandardStatus = z.enum(['draft', 'submitted', 'published', 'superseded']);

export const ApprovedVendor = z.object({
  vendorId: z.uuid().optional(),
  name: z.string().min(1),
  model: z.string().optional(),
});

export const BrandStandardItem = z.object({
  id: z.string(),
  standardId: z.string(),
  code: z.string(),
  area: z.string(),
  category: SpecCategory,
  name: z.string(),
  description: z.string().nullable(),
  dimensions: z.string().nullable(),
  finish: z.string().nullable(),
  materials: z.string().nullable(),
  attributes: z.record(z.string(), z.unknown()),
  approvedVendors: z.array(ApprovedVendor),
  quantityBasis: z.string().nullable(),
  sort: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const BrandStandardItemInput = z.object({
  code: z.string().trim().min(1).max(50),
  area: z.string().trim().min(1).max(120).default('General'),
  category: SpecCategory.default('other'),
  name: z.string().trim().min(1).max(300),
  description: z.string().nullable().optional(),
  dimensions: z.string().nullable().optional(),
  finish: z.string().nullable().optional(),
  materials: z.string().nullable().optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
  approvedVendors: z.array(ApprovedVendor).optional(),
  quantityBasis: z.string().nullable().optional(),
  sort: z.number().int().optional(),
});
export type BrandStandardItemInput = z.infer<typeof BrandStandardItemInput>;

export const BrandStandardItemPatch = BrandStandardItemInput.partial().extend({
  area: z.string().trim().min(1).max(120).optional(),
  category: SpecCategory.optional(),
});

export const BrandStandard = z.object({
  id: z.string(),
  brandId: z.string(),
  brandName: z.string(),
  name: z.string(),
  version: z.string(),
  effectiveDate: z.string().nullable(),
  sourceDocumentId: z.string().nullable(),
  status: StandardStatus,
  contributedByTenantId: z.string().nullable(),
  /** True when the caller's tenant contributed the package. */
  mine: z.boolean(),
  notes: z.string().nullable(),
  itemCount: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
  submittedAt: z.string().nullable(),
  publishedAt: z.string().nullable(),
});

export const BrandStandardDetail = BrandStandard.extend({ items: z.array(BrandStandardItem) });

export const BrandDetail = Brand.extend({ standards: z.array(BrandStandard) });

export const BrandStandardInput = z.object({
  brandId: z.uuid(),
  name: z.string().trim().min(2).max(300),
  version: z.string().trim().min(1).max(40).default('1'),
  effectiveDate: IsoDate.nullable().optional(),
  sourceDocumentId: z.uuid().nullable().optional(),
  notes: z.string().nullable().optional(),
  items: z.array(BrandStandardItemInput).max(2000).optional(),
});

export const BrandStandardPatch = z.object({
  name: z.string().trim().min(2).max(300).optional(),
  version: z.string().trim().min(1).max(40).optional(),
  effectiveDate: IsoDate.nullable().optional(),
  sourceDocumentId: z.uuid().nullable().optional(),
  notes: z.string().nullable().optional(),
});

export const BrandStandardListQuery = PageQuery.extend({
  brandId: z.uuid().optional(),
  status: StandardStatus.optional(),
  mine: QBool,
});

export const BrandStandardDetailQuery = z.object({
  area: z.string().optional(),
  category: SpecCategory.optional(),
  q: z.string().trim().min(1).optional(),
});

export const UpsertItemsBody = z.object({ items: z.array(BrandStandardItemInput).min(1).max(2000) });
export const UpsertItemsResult = z.object({
  created: z.number().int(),
  updated: z.number().int(),
  items: z.array(BrandStandardItem),
});

export const AreaCount = z.object({ area: z.string(), count: z.number().int() });

// ---------------------------------------------------------------------------------------------
// Vendors
// ---------------------------------------------------------------------------------------------
export const Contact = z.object({
  name: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  role: z.string().nullable().optional(),
});

export const VendorProfile = z.object({
  id: z.string(),
  vendorId: z.string(),
  accountNumber: z.string().nullable(),
  paymentTerms: z.string().nullable(),
  depositPct: z.number().nullable(),
  leadTimeWeeks: z.number().int().nullable(),
  shipMethod: z.string().nullable(),
  freightTerms: z.string().nullable(),
  origin: Origin.nullable(),
  transitDays: z.number().int().nullable(),
  primaryContact: Contact.nullable(),
  contacts: z.array(Contact),
  rating: z.number().nullable(),
  onTimeRate: z.number().nullable(),
  preferred: z.boolean(),
  notes: z.string().nullable(),
  tags: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const VendorProfileInput = z.object({
  accountNumber: z.string().max(100).nullable().optional(),
  paymentTerms: z.string().max(300).nullable().optional(),
  depositPct: z.number().min(0).max(100).nullable().optional(),
  leadTimeWeeks: z.number().int().min(0).max(260).nullable().optional(),
  shipMethod: z.string().max(100).nullable().optional(),
  freightTerms: z.string().max(100).nullable().optional(),
  origin: Origin.nullable().optional(),
  transitDays: z.number().int().min(0).max(365).nullable().optional(),
  primaryContact: Contact.nullable().optional(),
  contacts: z.array(Contact).max(50).optional(),
  rating: z.number().min(0).max(5).nullable().optional(),
  /** Normally written by the risk model; accepted here for imports. */
  onTimeRate: z.number().min(0).max(1).nullable().optional(),
  preferred: z.boolean().optional(),
  notes: z.string().nullable().optional(),
  tags: z.array(z.string().max(50)).max(50).optional(),
});

const VendorNetworkFields = {
  id: z.string(),
  orgId: z.string().nullable(),
  name: z.string(),
  website: z.string().nullable(),
  emailDomains: z.array(z.string()),
  categories: z.array(z.string()),
  hqCity: z.string().nullable(),
  hqRegion: z.string().nullable(),
  hqCountry: z.string().nullable(),
  description: z.string().nullable(),
  verified: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
};

export const Vendor = z.object({
  ...VendorNetworkFields,
  /** The caller's tenant-private relationship, if any. */
  profile: VendorProfile.nullable(),
  productCount: z.number().int().optional(),
});

/** What a vendor portal user sees about their own network listing — no tenant data. */
export const VendorSelf = z.object(VendorNetworkFields);

export const VendorSelfPatch = z.object({
  website: z.string().max(500).nullable().optional(),
  description: z.string().max(5000).nullable().optional(),
  categories: z.array(SpecCategory).max(30).optional(),
  hqCity: z.string().max(120).nullable().optional(),
  hqRegion: z.string().max(120).nullable().optional(),
  hqCountry: z.string().max(120).nullable().optional(),
});

export const VendorInput = z.object({
  name: z.string().trim().min(2).max(200),
  orgId: z.uuid().nullable().optional(),
  website: z.string().max(500).nullable().optional(),
  emailDomains: z.array(z.string().trim().toLowerCase().min(3).max(200)).max(20).optional(),
  categories: z.array(SpecCategory).max(30).optional(),
  hqCity: z.string().max(120).nullable().optional(),
  hqRegion: z.string().max(120).nullable().optional(),
  hqCountry: z.string().max(120).nullable().optional(),
  description: z.string().max(5000).nullable().optional(),
  /** Tenant-private profile to create alongside the network record. */
  profile: VendorProfileInput.optional(),
  /** Create even if a similarly named vendor already exists. */
  force: z.boolean().optional(),
});

export const VendorListQuery = PageQuery.extend({
  category: SpecCategory.optional(),
  preferred: QBool,
  onlyMine: QBool,
});

export const VendorSuggestion = z.object({ id: z.string(), name: z.string(), similarity: z.number() });

// ---------------------------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------------------------
export const ProductStatus = z.enum(['active', 'discontinued']);

export const Product = z.object({
  id: z.string(),
  vendorId: z.string(),
  vendorName: z.string(),
  sku: z.string(),
  name: z.string(),
  category: SpecCategory,
  description: z.string().nullable(),
  dimensions: z.string().nullable(),
  materials: z.string().nullable(),
  finishes: z.array(z.string()),
  imageUrls: z.array(z.string()),
  attributes: z.record(z.string(), z.unknown()),
  typicalLeadTimeWeeks: z.number().int().nullable(),
  brandStandardItemIds: z.array(z.string()),
  status: ProductStatus,
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const ProductInput = z.object({
  vendorId: z.uuid(),
  sku: z.string().trim().min(1).max(100),
  name: z.string().trim().min(1).max(300),
  category: SpecCategory.default('other'),
  description: z.string().nullable().optional(),
  dimensions: z.string().nullable().optional(),
  materials: z.string().nullable().optional(),
  finishes: z.array(z.string()).max(100).optional(),
  imageUrls: z.array(z.string().max(2000)).max(50).optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
  typicalLeadTimeWeeks: z.number().int().min(0).max(260).nullable().optional(),
  brandStandardItemIds: z.array(z.uuid()).max(500).optional(),
  status: ProductStatus.optional(),
});
export const ProductPatch = ProductInput.omit({ vendorId: true }).partial();

export const ProductListQuery = PageQuery.extend({
  vendorId: z.uuid().optional(),
  category: SpecCategory.optional(),
  brandStandardItemId: z.uuid().optional(),
  status: ProductStatus.optional(),
});

// ---------------------------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------------------------
export const SearchResult = z.object({
  brandStandardItems: z.array(
    z.object({
      id: z.string(),
      standardId: z.string(),
      standardName: z.string(),
      brandName: z.string(),
      code: z.string(),
      name: z.string(),
      area: z.string(),
      category: z.string(),
      rank: z.number(),
    }),
  ),
  products: z.array(
    z.object({
      id: z.string(),
      vendorId: z.string(),
      vendorName: z.string(),
      sku: z.string(),
      name: z.string(),
      category: z.string(),
      rank: z.number(),
    }),
  ),
  vendors: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      categories: z.array(z.string()),
      hqCity: z.string().nullable(),
      hqRegion: z.string().nullable(),
      hasProfile: z.boolean(),
      rank: z.number(),
    }),
  ),
});

// ---------------------------------------------------------------------------------------------
// Internal contract (docs/service-contracts.md)
// ---------------------------------------------------------------------------------------------
export const InternalVendor = z.object({
  id: z.string(),
  name: z.string(),
  orgId: z.string().nullable(),
  website: z.string().nullable(),
  categories: z.array(z.string()),
  profile: z.object({
    leadTimeWeeks: z.number().nullable(),
    shipMethod: z.string().nullable(),
    freightTerms: z.string().nullable(),
    paymentTerms: z.string().nullable(),
    depositPct: z.number().nullable(),
    primaryContact: z
      .object({ name: z.string().nullable(), email: z.string().nullable(), phone: z.string().nullable() })
      .nullable(),
    rating: z.number().nullable(),
    onTimeRate: z.number().nullable(),
    preferred: z.boolean(),
    accountNumber: z.string().nullable(),
  }),
});

export const InternalBrandStandard = z.object({
  id: z.string(),
  brandId: z.string(),
  brandName: z.string(),
  name: z.string(),
  version: z.string(),
  status: StandardStatus,
  items: z.array(BrandStandardItem),
});

export { page };
