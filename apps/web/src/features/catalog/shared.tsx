import { useQuery } from '@tanstack/react-query';
import { Share2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { Badge, cx } from '@/components/ui';
import { ApiError, api, errorMessage, type Page } from '@/lib/api';
import { humanize } from '@/lib/format';

// ------------------------------------------------------------------ Enums (mirror @procure/domain)
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
export type SpecCategory = (typeof SPEC_CATEGORIES)[number];

const CATEGORY_LABEL: Record<string, string> = {
  ose: 'OS&E',
  soft_seating: 'Soft seating',
  window_treatments: 'Window treatments',
};
export const categoryLabel = (c: string | null | undefined) => (c ? (CATEGORY_LABEL[c] ?? humanize(c)) : '—');
export const categoryOptions = SPEC_CATEGORIES.map((c) => ({ value: c, label: categoryLabel(c) }));

// ------------------------------------------------------------------ Types (mirror services/catalog/src/schemas.ts)
export interface Brand {
  id: string;
  name: string;
  parentCompany: string | null;
  segment: string | null;
  logoUrl: string | null;
  standardCount?: number;
  createdAt: string;
}

export type StandardStatus = 'draft' | 'submitted' | 'published' | 'superseded';

export interface ApprovedVendor {
  vendorId?: string;
  name: string;
  model?: string;
}

export interface BrandStandardItem {
  id: string;
  standardId: string;
  code: string;
  area: string;
  category: SpecCategory;
  name: string;
  description: string | null;
  dimensions: string | null;
  finish: string | null;
  materials: string | null;
  attributes: Record<string, unknown>;
  approvedVendors: ApprovedVendor[];
  quantityBasis: string | null;
  sort: number;
  createdAt: string;
  updatedAt: string;
}

export interface BrandStandard {
  id: string;
  brandId: string;
  brandName: string;
  name: string;
  version: string;
  effectiveDate: string | null;
  sourceDocumentId: string | null;
  status: StandardStatus;
  contributedByTenantId: string | null;
  mine: boolean;
  notes: string | null;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
  submittedAt: string | null;
  publishedAt: string | null;
}
export interface BrandStandardDetail extends BrandStandard {
  items: BrandStandardItem[];
}

export interface Contact {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  role?: string | null;
}

export interface VendorProfile {
  id: string;
  vendorId: string;
  accountNumber: string | null;
  paymentTerms: string | null;
  depositPct: number | null;
  leadTimeWeeks: number | null;
  shipMethod: string | null;
  freightTerms: string | null;
  origin: 'domestic' | 'international' | null;
  transitDays: number | null;
  primaryContact: Contact | null;
  contacts: Contact[];
  rating: number | null;
  onTimeRate: number | null;
  preferred: boolean;
  notes: string | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Vendor {
  id: string;
  orgId: string | null;
  name: string;
  website: string | null;
  emailDomains: string[];
  categories: string[];
  hqCity: string | null;
  hqRegion: string | null;
  hqCountry: string | null;
  description: string | null;
  verified: boolean;
  createdAt: string;
  updatedAt: string;
  profile: VendorProfile | null;
  productCount?: number;
}

export interface VendorSuggestion {
  id: string;
  name: string;
  similarity: number;
}

export interface Product {
  id: string;
  vendorId: string;
  vendorName: string;
  sku: string;
  name: string;
  category: SpecCategory;
  description: string | null;
  dimensions: string | null;
  materials: string | null;
  finishes: string[];
  imageUrls: string[];
  attributes: Record<string, unknown>;
  typicalLeadTimeWeeks: number | null;
  brandStandardItemIds: string[];
  status: 'active' | 'discontinued';
  createdAt: string;
  updatedAt: string;
}

export interface SearchResult {
  brandStandardItems: {
    id: string;
    standardId: string;
    standardName: string;
    brandName: string;
    code: string;
    name: string;
    area: string;
    category: string;
    rank: number;
  }[];
  products: {
    id: string;
    vendorId: string;
    vendorName: string;
    sku: string;
    name: string;
    category: string;
  }[];
  vendors: {
    id: string;
    name: string;
    categories: string[];
    hqCity: string | null;
    hqRegion: string | null;
  }[];
}

export interface VendorPerformance {
  vendorId: string;
  sampleSize: number;
  onTimeRate: number | null;
  meanSlipDays: number | null;
  p90SlipDays: number | null;
  stdSlipDays: number | null;
  meanLeadTimeWeeks: number | null;
  shipDateChangeRate: number | null;
  updatedAt: string;
}

// ------------------------------------------------------------------ Queries
export const qk = {
  brands: ['catalog', 'brands'] as const,
  standards: (q: object) => ['catalog', 'standards', q] as const,
  standard: (id: string) => ['catalog', 'standard', id] as const,
  vendors: (q: object) => ['catalog', 'vendors', q] as const,
  vendor: (id: string) => ['catalog', 'vendor', id] as const,
  products: (q: object) => ['catalog', 'products', q] as const,
};

export const useBrands = () =>
  useQuery({
    queryKey: qk.brands,
    queryFn: () => api.get<Brand[]>('catalog', '/brands'),
    staleTime: 5 * 60_000,
  });

/** Every vendor in the network (for pickers); the network is small enough to load in one page. */
export const useVendorOptions = () =>
  useQuery({
    queryKey: qk.vendors({ all: true }),
    queryFn: () => api.get<Page<Vendor>>('catalog', '/vendors', { limit: 500 }),
    select: (d) => d.items,
    staleTime: 60_000,
  });

// ------------------------------------------------------------------ Display helpers
export const hq = (v: Pick<Vendor, 'hqCity' | 'hqRegion' | 'hqCountry'>) =>
  [v.hqCity, v.hqRegion, v.hqCountry && v.hqCountry !== 'US' ? v.hqCountry : null]
    .filter(Boolean)
    .join(', ') || null;

export const standardStatusLabel: Record<StandardStatus, string> = {
  draft: 'Draft',
  submitted: 'Submitted for review',
  published: 'Published',
  superseded: 'Superseded',
};

/** "Shared" = published shared intelligence curated by Pro-Cure; "Your draft" = contributed by this firm. */
export function SharingMark({ s }: { s: Pick<BrandStandard, 'mine' | 'status'> }) {
  if (s.status === 'published' || s.status === 'superseded')
    return (
      <Badge tone="lacquer">
        <Share2 className="size-3" />
        Shared
      </Badge>
    );
  return <Badge tone="brass">{s.mine ? 'Your firm’s draft' : 'Draft'}</Badge>;
}

/** 0–5 rating as a compact figure with a five-segment bar. */
export function Rating({ value }: { value: number | null | undefined }) {
  if (value === null || value === undefined) return <span className="text-ink-4">—</span>;
  return (
    <span className="inline-flex items-center gap-1.5" title={`${value.toFixed(1)} of 5`}>
      <span className="num">{value.toFixed(1)}</span>
      <span className="flex gap-px" aria-hidden>
        {[1, 2, 3, 4, 5].map((i) => (
          <span
            key={i}
            className={cx('h-2 w-1.5 rounded-[1px]', value >= i - 0.25 ? 'bg-brass' : 'bg-stone-2')}
          />
        ))}
      </span>
    </span>
  );
}

export const rate = (r: number | null | undefined) =>
  r === null || r === undefined ? null : `${Math.round(r * 100)}%`;

/** Back link above a record page title. */
export const Crumb = ({ to, children }: { to: string; children: ReactNode }) => (
  <Link to={to} className="text-[13px] font-[560] text-ink-3 hover:text-lacquer">
    {children}
  </Link>
);

/** The service behind a feature is unreachable (the gateway can't connect, or 502/503/504). */
export const isServiceDown = (e: unknown) =>
  e instanceof ApiError &&
  (e.status === 502 ||
    e.status === 503 ||
    e.status === 504 ||
    e.code === 'FST_REPLY_FROM_INTERNAL_SERVER_ERROR' ||
    /ECONNREFUSED/.test(String(e.detail ?? '')));

/** Error text that names the unavailable part of Pro-Cure instead of a bare "Internal Server Error". */
export const friendlyError = (e: unknown, what: string) =>
  isServiceDown(e)
    ? `${what} is unavailable right now. Try again in a few minutes; nothing was changed.`
    : errorMessage(e);

export const Muted = ({ children }: { children?: ReactNode }) =>
  children === null || children === undefined || children === '' ? (
    <span className="text-ink-4">—</span>
  ) : (
    children
  );
