import { useQuery } from '@tanstack/react-query';
import { Cpu, FileSearch, Inbox, Scissors, ShieldAlert, Sparkles } from 'lucide-react';
import type { ReactNode } from 'react';
import { Badge, cx } from '@/components/ui';
import { api } from '@/lib/api';

// ------------------------------------------------------------------ Types (mirror services/ai/src/schemas.ts)
export const JOB_KINDS = [
  'brand_spec_extract',
  'vendor_quote_extract',
  'drawing_split',
  'inbox_route',
  'risk_score',
] as const;
export type JobKind = (typeof JOB_KINDS)[number];
export const JOB_STATUSES = ['queued', 'running', 'needs_review', 'completed', 'failed', 'applied'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const KIND_LABEL: Record<JobKind, string> = {
  brand_spec_extract: 'Brand-spec reading',
  vendor_quote_extract: 'Vendor quote reading',
  drawing_split: 'Drawing packet split',
  inbox_route: 'Inbox routing',
  risk_score: 'Delivery risk',
};

export const KIND_ICON: Record<JobKind, ReactNode> = {
  brand_spec_extract: <FileSearch className="size-4" />,
  vendor_quote_extract: <Sparkles className="size-4" />,
  drawing_split: <Scissors className="size-4" />,
  inbox_route: <Inbox className="size-4" />,
  risk_score: <ShieldAlert className="size-4" />,
};

export interface JobBase {
  id: string;
  kind: JobKind;
  status: JobStatus;
  title: string;
  input: Record<string, unknown>;
  error: string | null;
  provider: string | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  pages: number | null;
  durationMs: number | null;
  attempts: number;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  appliedAt: string | null;
  appliedByName: string | null;
  applyError: string | null;
  discardedAt: string | null;
  discardedByName: string | null;
  entityType: string | null;
  entityId: string | null;
  outputRedacted: boolean;
}
export interface JobSummary extends JobBase {
  summary: Record<string, unknown>;
}
export interface Job extends JobBase {
  output: Record<string, unknown> | null;
  review: Record<string, unknown> | null;
  applyResult: Record<string, unknown> | null;
}

export interface Capabilities {
  provider: string;
  model: string | null;
  mode: 'llm' | 'heuristic';
  label: string;
  ocr: { provider: string; scannedPages: boolean };
  features: { kind: JobKind; name: string; mode: 'llm' | 'heuristic'; applyTarget: string | null }[];
}

export interface RiskSummary {
  run: {
    id: string;
    runAt: string;
    shipmentsScored: number;
    vendorsProfiled: number;
    jobId: string | null;
  } | null;
  counts: { none: number; watch: number; at_risk: number; critical: number };
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

// ------------------------------------------------------------------ Per-kind outputs (services/ai/src/features/*)
export interface BrandSpecItem {
  code: string;
  area: string | null;
  category: string;
  name: string;
  description: string | null;
  dimensions: string | null;
  finish: string | null;
  materials: string | null;
  approvedVendors: { name: string; model: string | null }[];
  quantityBasis: string | null;
  sourcePage: number | null;
  confidence: number;
}
export interface BrandSpecOutput {
  standard: {
    name: string | null;
    brandGuess: string | null;
    version: string | null;
    effectiveDate: string | null;
  };
  items: BrandSpecItem[];
  warnings: string[];
  scannedPages: number[];
}

export interface QuoteLine {
  vendorSku: string | null;
  description: string;
  quantity: number | null;
  unitPrice: number | null;
  extended: number | null;
  leadTimeWeeks: number | null;
  expiresAt: string | null;
  notes: string | null;
  sourcePage: number | null;
  specCode: string | null;
}
export interface QuoteMatch {
  costRequestLineId: string;
  code: string | null;
  name: string;
  lineIndex: number;
  extractedLine: QuoteLine;
  unitCost: number | null;
  currentCost: number | null;
  requestedQuantity: number | null;
  expiresAt: string | null;
  leadTimeWeeks: number | null;
  confidence: number;
  reasons: string[];
  flags: string[];
}
export interface VendorQuoteOutput {
  costRequest: { id: string; number: string; vendorId: string };
  header: {
    vendorName: string | null;
    vendorQuoteNumber: string | null;
    quoteDate: string | null;
    validUntil: string | null;
    leadTime: string | null;
    leadTimeWeeks: number | null;
    freightTerms: string | null;
  };
  lines: QuoteLine[];
  matches: QuoteMatch[];
  unmatchedLines: { lineIndex: number; line: QuoteLine; reason: string }[];
  unquotedRequestLines: { costRequestLineId: string; code: string | null; name: string }[];
  totals: { subtotal: number | null; freight: number | null; total: number | null };
  warnings: string[];
}

export interface DrawingSplitOutput {
  filename: string;
  pageCount: number;
  groups: {
    specId: string;
    code: string;
    name: string;
    pages: number[];
    confidence: number;
    reasons: string[];
  }[];
  unassignedPages: number[];
  pageAssignments: {
    page: number;
    specId: string | null;
    score: number;
    reasons: string[];
    via: string | null;
  }[];
  candidates: { id: string; code: string; name: string }[];
  warnings: string[];
}

export interface InboxOutput {
  inboundEmailId: string;
  intent: string;
  target: { entityType: 'purchase_order'; entityId: string; poNumber: string } | null;
  vendor: { id: string; name: string; orgId: string | null } | null;
  confidence: number;
  reasons: string[];
  extracted: {
    poNumbers: string[];
    trackingNumber: string | null;
    carrier: string | null;
    shipDate: string | null;
    newShipDate: string | null;
    amount: number | null;
  };
  candidates: {
    poId: string;
    poNumber: string;
    vendorName: string | null;
    projectName: string | null;
    score: number;
    reasons: string[];
  }[];
  suggestions: { type: string; label: string; payload: Record<string, unknown> }[];
  routed: boolean;
  routeStatus: 'routed' | 'needs_review';
  routeError: string | null;
}

export interface RiskOutput {
  shipmentsScored: number;
  vendorsProfiled: number;
  counts: RiskSummary['counts'];
  narrative: string;
  postedToOrders: boolean;
  postError: string | null;
  scores: {
    shipmentId: string;
    score: number;
    probability: number;
    level: string;
    reasons: string[];
    poId: string | null;
    poNumber: string | null;
    projectName: string | null;
    vendorName: string | null;
    label: string;
  }[];
}

// ------------------------------------------------------------------ Queries
export const aiKeys = {
  capabilities: ['ai', 'capabilities'] as const,
  jobs: (q: object) => ['ai', 'jobs', q] as const,
  job: (id: string) => ['ai', 'job', id] as const,
  risk: ['ai', 'risk'] as const,
};

export const useCapabilities = () =>
  useQuery({
    queryKey: aiKeys.capabilities,
    queryFn: () => api.get<Capabilities>('ai', '/capabilities'),
    staleTime: 5 * 60_000,
  });

export const isActive = (s: JobStatus) => s === 'queued' || s === 'running';

/** The user-facing state of a job: discarded jobs are stored as completed with discardedAt. */
export const jobState = (j: Pick<JobBase, 'status' | 'discardedAt'>) =>
  j.discardedAt ? 'discarded' : j.status;

export const JOB_STATE_LABEL: Record<string, string> = {
  queued: 'Queued',
  running: 'Reading',
  needs_review: 'Ready for review',
  completed: 'Completed',
  failed: 'Failed',
  applied: 'Applied',
  discarded: 'Discarded',
};

const DEPENDS_ON: Partial<Record<JobKind, string>> = {
  risk_score: 'Purchase orders',
  inbox_route: 'The inbox',
  vendor_quote_extract: 'Quoting',
  drawing_split: 'Quoting',
};
const SERVICE_NAME: Record<string, string> = {
  orders: 'Purchase orders',
  comms: 'The inbox',
  quoting: 'Quoting',
  catalog: 'The catalog',
  documents: 'Document storage',
};

/** A job error in plain language: unreachable services are named instead of "fetch failed". */
export const jobErrorText = (j: Pick<JobBase, 'kind' | 'error'>, short = false) => {
  const e = j.error ?? '';
  const svc = e.match(/^(orders|comms|quoting|catalog|documents)\b/)?.[1];
  if (/fetch failed|is unavailable|ECONNREFUSED|ETIMEDOUT|TimeoutError/i.test(e)) {
    const who = (svc && SERVICE_NAME[svc]) ?? DEPENDS_ON[j.kind] ?? 'A connected service';
    return short
      ? `Couldn’t reach ${who.toLowerCase().replace(/^the /, 'the ')}`
      : `Couldn’t reach ${who.toLowerCase()} when this ran, so nothing was read or changed. Retry once it’s back.`;
  }
  return e || 'Failed';
};

export const duration = (ms: number | null | undefined) => {
  if (ms === null || ms === undefined) return null;
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
};

// ------------------------------------------------------------------ Bits
/** Provider / mode banner. Heuristic mode is stated plainly so nobody mistakes rules for a model. */
export function ModeBanner({ caps, compact }: { caps: Capabilities | undefined; compact?: boolean }) {
  if (!caps) return null;
  const heuristic = caps.mode === 'heuristic';
  return (
    <div
      className={cx(
        'flex items-start gap-2.5 rounded-sm border px-3 py-2',
        heuristic ? 'border-warn/25 bg-warn-50' : 'border-lacquer/20 bg-lacquer-50',
      )}
    >
      <Cpu className={cx('mt-0.5 size-4 shrink-0', heuristic ? 'text-warn' : 'text-lacquer')} />
      <div className="min-w-0 text-[13px]">
        <span className="font-[620]">
          {heuristic ? 'Heuristic mode' : `Claude${caps.model ? ` (${caps.model})` : ''}`}
        </span>
        <span className="text-ink-2">
          {heuristic
            ? compact
              ? ' — rule-based reading; review every result.'
              : ' — documents are read with rule-based parsers, not an AI model. Results are good on clean, text-based PDFs; connect Claude on Bedrock for higher accuracy on messy layouts.'
            : ` via ${caps.provider === 'bedrock' ? 'Amazon Bedrock' : caps.provider}. Every result is still reviewed before it changes anything.`}
          {!compact && !caps.ocr.scannedPages && ' Scanned (image-only) pages are not read.'}
        </span>
      </div>
    </div>
  );
}

/** Subtle confidence meter: thin bar with the percentage. */
export function Confidence({ value }: { value: number }) {
  const pctv = Math.round(value * 100);
  const tone = value >= 0.8 ? 'bg-ok' : value >= 0.55 ? 'bg-brass' : 'bg-risk';
  return (
    <span className="inline-flex items-center gap-1.5" title={`Confidence ${pctv}%`}>
      <span className="h-1 w-10 overflow-hidden rounded-full bg-stone-2" aria-hidden>
        <span className={cx('block h-full rounded-full', tone)} style={{ width: `${pctv}%` }} />
      </span>
      <span className="num text-[12px] text-ink-3">{pctv}%</span>
    </span>
  );
}

export const KindBadge = ({ kind }: { kind: JobKind }) => (
  <Badge tone="neutral" className="gap-1 [&>svg]:size-3.5">
    {KIND_ICON[kind]}
    {KIND_LABEL[kind]}
  </Badge>
);
