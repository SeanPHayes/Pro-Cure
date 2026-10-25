import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  ChevronLeft,
  CircleDollarSign,
  Clock,
  TrendingDown,
  TriangleAlert,
  XCircle,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { Badge, cx, EmptyState, ErrorNote, type Tone } from '@/components/ui';
import { Tooltip } from '@/components/ui/Tooltip';
import { ApiError, api, type Page } from '@/lib/api';
import { hasPerm, useSession } from '@/lib/auth';
import { date, daysFromToday, humanize } from '@/lib/format';
import { type CostStatus, type LineFlag, type QuoteDetail, SPEC_CATEGORIES } from './types';

// ---------------------------------------------------------------- query keys
export const qk = {
  quotes: (q?: unknown) => ['quoting', 'quotes', q ?? {}] as const,
  quote: (id: string) => ['quoting', 'quote', id] as const,
  lines: (id: string) => ['quoting', 'quote', id, 'lines'] as const,
  summary: (id: string) => ['quoting', 'quote', id, 'summary'] as const,
  matrix: (id: string) => ['quoting', 'quote', id, 'matrix'] as const,
  specs: (q?: unknown) => ['quoting', 'specs', q ?? {}] as const,
  spec: (id: string) => ['quoting', 'spec', id] as const,
  costRequests: (q?: unknown) => ['quoting', 'cost-requests', q ?? {}] as const,
  costRequest: (id: string) => ['quoting', 'cost-request', id] as const,
  compare: (id: string) => ['quoting', 'cost-request', id, 'compare'] as const,
  approvals: (q?: unknown) => ['quoting', 'approvals', q ?? {}] as const,
};

/** Can this user see cost, markup and margin (designers cannot)? */
export const useCostsVisible = () => hasPerm(useSession(), 'quotes:costs:read');

export const useQuote = (id: string) =>
  useQuery({
    queryKey: qk.quote(id),
    queryFn: () => api.get<QuoteDetail>('quoting', `/quotes/${id}`),
    enabled: !!id,
  });

export interface ProjectLite {
  id: string;
  number: string;
  name: string;
  propertyName: string | null;
  clientOrgId: string | null;
  status: string;
}

export const useProjects = () =>
  useQuery({
    queryKey: ['projects', 'lite'],
    queryFn: () => api.get<Page<ProjectLite>>('projects', '/projects', { limit: 200, status: undefined }),
    select: (d) => d.items,
    staleTime: 5 * 60_000,
    meta: { silent: true },
  });

export interface VendorLite {
  id: string;
  name: string;
  orgId: string | null;
  categories: string[];
}
export const useVendors = () =>
  useQuery({
    queryKey: ['catalog', 'vendors', 'lite'],
    queryFn: () => api.get<Page<VendorLite>>('catalog', '/vendors', { limit: 200 }),
    select: (d) => d.items,
    staleTime: 5 * 60_000,
    meta: { silent: true },
  });

export const isConflict = (e: unknown) => e instanceof ApiError && e.status === 409;

// ---------------------------------------------------------------- statuses
/** Statuses in which quote content (lines, pricing, structure) may change — mirrors the API. */
export const EDITABLE = ['draft', 'costing', 'merchandising', 'pending_internal_approval', 'client_rejected'];

export const QUOTE_STATUS_LABEL: Record<string, string> = {
  draft: 'Draft',
  costing: 'Costing',
  merchandising: 'Merchandising',
  pending_internal_approval: 'Awaiting approval',
  sent: 'Sent to owner',
  client_approved: 'Owner approved',
  client_rejected: 'Changes requested',
  ordered: 'Ordered',
  archived: 'Archived',
};

// ---------------------------------------------------------------- flags
export const FLAG_META: Record<LineFlag, { label: string; help: string; tone: Tone; icon: ReactNode }> = {
  missing_cost: {
    label: 'Missing cost',
    help: 'No vendor cost yet. Request pricing from the vendor or enter it.',
    tone: 'risk',
    icon: <CircleDollarSign className="size-3.5" />,
  },
  missing_price: {
    label: 'Missing price',
    help: 'No sell price: add a cost or set a price.',
    tone: 'risk',
    icon: <XCircle className="size-3.5" />,
  },
  below_cost: {
    label: 'Below cost',
    help: 'Sell price is lower than the landed cost. The quote cannot be sent like this.',
    tone: 'crit',
    icon: <TrendingDown className="size-3.5" />,
  },
  cost_expired: {
    label: 'Cost expired',
    help: 'The vendor’s quoted cost has expired. Request fresh pricing.',
    tone: 'crit',
    icon: <AlertTriangle className="size-3.5" />,
  },
  cost_expiring: {
    label: 'Cost expiring',
    help: 'The vendor’s cost expires within 14 days.',
    tone: 'warn',
    icon: <Clock className="size-3.5" />,
  },
  below_min_margin: {
    label: 'Below min margin',
    help: 'Margin is under the quote minimum or a margin policy. Needs approval to send.',
    tone: 'warn',
    icon: <TriangleAlert className="size-3.5" />,
  },
};
export const FLAG_ORDER: LineFlag[] = [
  'below_cost',
  'cost_expired',
  'missing_cost',
  'missing_price',
  'below_min_margin',
  'cost_expiring',
];

const flagTone: Record<Tone, string> = {
  neutral: 'text-ink-3 bg-stone-2',
  ok: 'text-ok bg-ok-50',
  warn: 'text-warn bg-warn-50',
  risk: 'text-risk bg-risk-50',
  crit: 'text-crit bg-crit-50',
  info: 'text-info bg-info-50',
  brass: 'text-brass bg-brass-50',
  lacquer: 'text-lacquer bg-lacquer-50',
};

/** Compact icon chips for a line's flags, each with an explanatory tooltip. */
export function FlagChips({ flags, hideCostFlags }: { flags: string[]; hideCostFlags?: boolean }) {
  const list = FLAG_ORDER.filter((f) => flags.includes(f)).filter(
    (f) => !hideCostFlags || f === 'missing_price',
  );
  if (!list.length) return null;
  return (
    <span className="inline-flex gap-1">
      {list.map((f) => (
        <Tooltip
          key={f}
          content={
            <span>
              <b className="font-[620]">{FLAG_META[f].label}.</b> {FLAG_META[f].help}
            </span>
          }
        >
          <span
            role="img"
            aria-label={FLAG_META[f].label}
            className={cx(
              'inline-grid size-[22px] place-items-center rounded-xs',
              flagTone[FLAG_META[f].tone],
            )}
          >
            {FLAG_META[f].icon}
          </span>
        </Tooltip>
      ))}
    </span>
  );
}

/** Expiry of a vendor cost, as a small badge (expired / expiring) or a quiet date. */
export function ExpiryBadge({ expiresAt, compact }: { expiresAt: string | null; compact?: boolean }) {
  if (!expiresAt) return null;
  const d = daysFromToday(expiresAt) ?? 0;
  if (d < 0)
    return (
      <Tooltip content={`Vendor cost expired ${date(expiresAt)}`}>
        <Badge tone="crit" className="!h-[18px] !px-1 !text-[11px]">
          {compact ? 'Expired' : `Expired ${date(expiresAt)}`}
        </Badge>
      </Tooltip>
    );
  if (d <= 14)
    return (
      <Tooltip content={`Vendor cost expires ${date(expiresAt)}`}>
        <Badge tone="warn" className="!h-[18px] !px-1 !text-[11px]">
          {compact ? `${d}d left` : `Expires ${date(expiresAt)}`}
        </Badge>
      </Tooltip>
    );
  return compact ? null : <span className="num text-[12px] text-ink-3">Valid to {date(expiresAt)}</span>;
}

export function CostStatusBadge({ status, expiresAt }: { status: CostStatus; expiresAt?: string | null }) {
  if (status === 'missing') return <Badge tone="risk">No cost</Badge>;
  if (status === 'expired') return <Badge tone="crit">Expired {expiresAt ? date(expiresAt) : ''}</Badge>;
  if (status === 'expiring') return <Badge tone="warn">Expires {expiresAt ? date(expiresAt) : 'soon'}</Badge>;
  return expiresAt ? (
    <span className="num text-ink-2">{date(expiresAt)}</span>
  ) : (
    <span className="text-ink-4">No expiry</span>
  );
}

export const categoryLabel = (c: string | null | undefined) =>
  c === 'ose' ? 'OS&E' : c === 'other' ? 'Other' : humanize(c);
export const SPEC_CATEGORY_OPTIONS = SPEC_CATEGORIES.map((c) => ({ value: c, label: categoryLabel(c) }));

/** Margin with tone: red under zero, amber under the floor. */
export function MarginCell({ value, floor }: { value: number | null; floor?: number | null }) {
  if (value === null || value === undefined) return <span className="text-ink-4">—</span>;
  const tone =
    value < 0 ? 'text-crit' : floor !== null && floor !== undefined && value < floor ? 'text-warn' : '';
  return <span className={cx('num', tone)}>{value.toFixed(1)}%</span>;
}

/** Number parse for money/percent inputs: "$1,234.50" → 1234.5; '' → null; garbage → NaN. */
export const parseNum = (s: string): number | null => {
  const t = s.replace(/[$,%\s]/g, '');
  if (!t) return null;
  return Number(t);
};

/** Sentence for a count: plural('line', 3) → "3 lines". */
export const plural = (word: string, n: number, pluralWord?: string) =>
  `${n.toLocaleString()} ${n === 1 ? word : (pluralWord ?? `${word}s`)}`;

export const priceFromMarkup = (cost: number, markup: number) =>
  Math.round(cost * (1 + markup / 100) * 10000) / 10000;
export const marginOf = (cost: number, price: number) =>
  price === 0 ? 0 : Math.round(((price - cost) / price) * 10000) / 100;
export const markupForMargin = (m: number) => (m / (100 - m)) * 100;

/** Back link at the top of record pages. */
export function BackLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="inline-flex items-center gap-1 text-[13px] text-ink-2 hover:text-ink">
      <ChevronLeft className="size-4" />
      {children}
    </Link>
  );
}

/** Not-found / error screen for record pages. */
export function RecordError({
  error,
  what,
  back,
}: {
  error: unknown;
  what: string;
  back: { to: string; label: string };
}) {
  const notFound = error instanceof ApiError && (error.status === 404 || error.status === 400);
  return notFound ? (
    <EmptyState
      title={`This ${what} doesn’t exist`}
      action={
        <Link to={back.to} className="font-[560] text-lacquer hover:underline">
          {back.label}
        </Link>
      }
    >
      It may have been removed, or the link is wrong.
    </EmptyState>
  ) : (
    <ErrorNote error={error} />
  );
}
