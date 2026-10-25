import { useQuery } from '@tanstack/react-query';
import { format, isThisYear, isToday, parseISO } from 'date-fns';
import { cx } from '@/components/ui';
import { api } from '@/lib/api';

// ------------------------------------------------------------------ API shapes (services/comms)
export type InboundStatus = 'pending' | 'routed' | 'needs_review' | 'ignored';
export interface Routing {
  confidence: number;
  reasons: string[];
  method: 'alias' | 'ai' | 'manual';
}
export interface Suggestion {
  type: string;
  label: string;
  payload: Record<string, unknown>;
  appliedAt?: string;
  result?: unknown;
  error?: string;
}
export interface InboundAttachment {
  documentId: string;
  filename: string;
  contentType: string;
  size: number;
}
export interface InboundListItem {
  id: string;
  fromAddress: string;
  fromName: string | null;
  toAddresses: string[];
  subject: string;
  preview: string;
  receivedAt: string;
  status: InboundStatus;
  attachmentCount: number;
  routedThreadId: string | null;
  routedEntityType: string | null;
  routedEntityId: string | null;
  routing: Routing | null;
  suggestionCount: number;
}
export interface InboundEmail {
  id: string;
  messageId: string | null;
  fromAddress: string;
  fromName: string | null;
  toAddresses: string[];
  cc: string[];
  subject: string;
  textBody: string | null;
  strippedText: string;
  htmlBody: string | null;
  receivedAt: string;
  rawDocumentId: string | null;
  attachments: InboundAttachment[];
  status: InboundStatus;
  routedThreadId: string | null;
  routedEntityType: string | null;
  routedEntityId: string | null;
  routing: Routing | null;
  suggestions: Suggestion[];
  triagedByName: string | null;
  triagedAt: string | null;
  source: string;
}
export interface InboundCounts {
  pending: number;
  needs_review: number;
  routed: number;
  ignored: number;
  total: number;
}
export interface InboundConfig {
  inboundDomain: string;
  forwardingAddress: string;
  simulatorEnabled: boolean;
}

/** ai service: inbox_route job (list summary + full output). */
export interface RouteJobSummary {
  id: string;
  status: 'queued' | 'running' | 'needs_review' | 'completed' | 'failed' | 'applied';
  error: string | null;
  provider: string | null;
  entityId: string | null;
  createdAt: string;
  completedAt: string | null;
  summary: { intent?: string; routed?: boolean; poNumber?: string | null; confidence?: number };
}
export interface RouteJob extends RouteJobSummary {
  output: {
    intent: string;
    target: { entityType: string; entityId: string; poNumber: string } | null;
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
    routeError: string | null;
  } | null;
}

export const inboxKeys = {
  all: ['inbox'] as const,
  list: (q: object) => ['inbox', 'list', q] as const,
  counts: ['inbox', 'counts'] as const,
  email: (id: string) => ['inbox', 'email', id] as const,
  jobs: ['inbox', 'jobs'] as const,
  job: (emailId: string) => ['inbox', 'job', emailId] as const,
  config: ['inbox', 'config'] as const,
};

export const useInboundConfig = () =>
  useQuery({
    queryKey: inboxKeys.config,
    queryFn: () => api.get<InboundConfig>('comms', '/inbound/config'),
    staleTime: 10 * 60_000,
    meta: { silent: true },
  });

// ------------------------------------------------------------------ Labels
export const INTENT_LABEL: Record<string, string> = {
  order_acknowledgement: 'Order acknowledgement',
  proforma_deposit_invoice: 'Pro-forma deposit invoice',
  shipping_notification: 'Shipping notice',
  ship_date_change: 'Ship-date change',
  line_drawings_submittal: 'Drawings for approval',
  invoice: 'Invoice',
  general: 'General message',
};
export const intentLabel = (i: string | null | undefined) => (i ? (INTENT_LABEL[i] ?? i) : null);

export const ENTITY_LABEL: Record<string, string> = {
  purchase_order: 'Purchase order',
  project: 'Project',
  quote: 'Quote',
  cost_request: 'Cost request',
  claim: 'Claim',
  invoice: 'Invoice',
  shipment: 'Shipment',
  vendor_bill: 'Vendor bill',
  spec: 'Spec',
  task: 'Task',
};

/** Internal workspace page for an entity a thread can hang off, when there is one. */
export const entityPath = (type: string | null, id: string | null): string | null => {
  if (!type || !id) return null;
  const base: Record<string, string> = {
    purchase_order: '/app/orders/',
    project: '/app/projects/',
    quote: '/app/quotes/',
    cost_request: '/app/cost-requests/',
    claim: '/app/claims/',
    invoice: '/app/invoices/',
    spec: '/app/specs/',
  };
  return base[type] ? `${base[type]}${id}` : null;
};

export const STATUS_LABEL: Record<InboundStatus, string> = {
  pending: 'Waiting for AI',
  needs_review: 'Needs review',
  routed: 'Filed',
  ignored: 'Ignored',
};

export const METHOD_LABEL: Record<Routing['method'], string> = {
  alias: 'Reply address',
  ai: 'AI agent',
  manual: 'Filed by hand',
};

export const senderName = (e: { fromName: string | null; fromAddress: string }) =>
  e.fromName?.trim() || e.fromAddress;

/** "2:14 PM" today, "Oct 21" this year, "Oct 21, 2025" otherwise. */
export const shortTime = (iso: string) => {
  const d = parseISO(iso);
  return format(d, isToday(d) ? 'h:mm a' : isThisYear(d) ? 'MMM d' : 'MMM d, yyyy');
};

export const fileSize = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${Math.round(bytes / 1024)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export const isRouteSuggestion = (s: Suggestion) =>
  s.type === 'route_to_po' || s.type === 'route_to_thread' || s.type === 'route';

/**
 * What the AI agent is doing with an email, from the email status and its latest inbox_route job.
 * A pending email whose job failed (e.g. the orders service was unreachable) is not "reading".
 */
export type AiState = 'reading' | 'failed' | 'done' | 'none';
export const aiState = (
  email: { status: InboundStatus; receivedAt: string; routing?: Routing | null },
  job: Pick<RouteJobSummary, 'status'> | null | undefined,
): AiState => {
  if (job?.status === 'queued' || job?.status === 'running') return 'reading';
  // A routing result on the email means the agent finished (possibly on an earlier or later run).
  if (email.routing && email.status !== 'pending') return 'done';
  if (job?.status === 'failed') return 'failed';
  if (email.status === 'pending') {
    // No job seen (yet, or AI not visible to this user): assume it is queued for a few minutes.
    return job === undefined || Date.now() - Date.parse(email.receivedAt) < 3 * 60_000 ? 'reading' : 'failed';
  }
  return job ? 'done' : 'none';
};

// ------------------------------------------------------------------ Bits
/** Confidence as a labelled bar; tone follows the auto-route threshold (85%). */
export function ConfidenceBar({ value, wide }: { value: number; wide?: boolean }) {
  const pct = Math.round(value * 100);
  const tone = value >= 0.85 ? 'bg-ok' : value >= 0.55 ? 'bg-brass' : 'bg-risk';
  const word = value >= 0.85 ? 'High' : value >= 0.55 ? 'Medium' : 'Low';
  return (
    <span className="inline-flex items-center gap-2" title={`Confidence ${pct}%`}>
      {/* biome-ignore lint/a11y/useSemanticElements: styled meter bar */}
      <span
        className={cx('h-1.5 overflow-hidden rounded-full bg-stone-2', wide ? 'w-28' : 'w-10')}
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-label="Confidence"
      >
        <span className={cx('block h-full rounded-full', tone)} style={{ width: `${pct}%` }} />
      </span>
      <span className="num text-[12px] text-ink-3">{wide ? `${word} · ${pct}%` : `${pct}%`}</span>
    </span>
  );
}
