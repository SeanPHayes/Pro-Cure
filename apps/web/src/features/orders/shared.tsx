import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, ImageOff, Sparkles } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Badge, cx, type Tone } from '@/components/ui';
import { Tooltip } from '@/components/ui/Tooltip';
import { api, documentUrl, type Page } from '@/lib/api';
import { date, daysFromToday, humanize } from '@/lib/format';
import type {
  Address,
  ClaimStatus,
  ClaimType,
  Escalation,
  RequirementKind,
  RequirementStatus,
  Shipment,
  ShipmentStatus,
} from './types';

// ------------------------------------------------------------------ query keys
export const ok = {
  all: ['orders'] as const,
  pos: (q?: object) => ['orders', 'purchase-orders', q ?? {}] as const,
  po: (id: string) => ['orders', 'po', id] as const,
  shipments: (q?: object) => ['orders', 'shipments', q ?? {}] as const,
  claims: (q?: object) => ['orders', 'claims', q ?? {}] as const,
  claim: (id: string) => ['orders', 'claim', id] as const,
  storage: (q?: object) => ['orders', 'storage', q ?? {}] as const,
  locations: (q?: object) => ['orders', 'locations', q ?? {}] as const,
};

/** Every orders view shares the 'orders' key prefix: refresh them all after a write. */
export const useInvalidateOrders = () => {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['orders'] });
};

// ------------------------------------------------------------------ lookups
export interface ProjectLite {
  id: string;
  number: string;
  name: string;
  clientOrgId: string | null;
  status: string;
}
export const useProjectsLite = () =>
  useQuery({
    queryKey: ['orders-lookup', 'projects'],
    queryFn: () => api.get<Page<ProjectLite>>('projects', '/projects', { limit: 200, sort: 'number' }),
    select: (d) => d.items,
    staleTime: 60_000,
    meta: { silent: true },
  });
export const useVendorsLite = () =>
  useQuery({
    queryKey: ['orders-lookup', 'vendors'],
    queryFn: () => api.get<Page<{ id: string; name: string }>>('catalog', '/vendors', { limit: 200 }),
    select: (d) => d.items,
    staleTime: 60_000,
    meta: { silent: true },
  });

// ------------------------------------------------------------------ labels
export const REQ_SHORT: Record<RequirementKind, string> = {
  order_acknowledgement: 'Ack',
  deposit: 'Deposit',
  shop_drawing_approval: 'Shop dwgs',
  finish_sample_approval: 'Finishes',
  cfa: 'CFA',
  credit_approval: 'Credit',
  other: 'Other',
};
export const REQ_LABEL: Record<RequirementKind, string> = {
  order_acknowledgement: 'Order acknowledgement',
  deposit: 'Deposit payment',
  shop_drawing_approval: 'Shop drawing approval',
  finish_sample_approval: 'Finish sample approval',
  cfa: 'CFA (cutting for approval)',
  credit_approval: 'Credit approval',
  other: 'Other',
};
export const PARTY_LABEL: Record<string, string> = {
  internal: 'Our team',
  vendor: 'Vendor',
  client: 'Owner',
};
export const REQ_STATUS_LABEL: Record<RequirementStatus, string> = {
  pending: 'Pending',
  submitted: 'Submitted for review',
  approved: 'Done',
  rejected: 'Rejected',
  waived: 'Waived',
};
export const isPendingReq = (s: string) => s === 'pending' || s === 'submitted' || s === 'rejected';

export const CLAIM_TYPE_LABEL: Record<ClaimType, string> = {
  damage: 'Damaged on arrival',
  concealed_damage: 'Concealed damage',
  shortage: 'Missing items',
  wrong_item: 'Wrong item',
  defect: 'Defect',
  other: 'Other',
};
export const CLAIM_STATUS_LABEL: Record<ClaimStatus, string> = {
  open: 'Open',
  submitted_to_vendor: 'With vendor',
  vendor_acknowledged: 'Vendor acknowledged',
  replacement_ordered: 'Replacement ordered',
  credited: 'Credited',
  resolved: 'Resolved',
  rejected: 'Rejected',
};
export const CLAIM_TONE: Record<ClaimStatus, Tone> = {
  open: 'warn',
  submitted_to_vendor: 'info',
  vendor_acknowledged: 'lacquer',
  replacement_ordered: 'lacquer',
  credited: 'ok',
  resolved: 'ok',
  rejected: 'neutral',
};
export const isClosedClaim = (s: ClaimStatus) => s === 'resolved' || s === 'rejected' || s === 'credited';

export const SHIPMENT_STEPS: { key: ShipmentStatus; label: string }[] = [
  { key: 'planned', label: 'Planned' },
  { key: 'confirmed', label: 'Confirmed' },
  { key: 'shipped', label: 'Shipped' },
  { key: 'in_transit', label: 'In transit' },
  { key: 'delivered', label: 'Delivered' },
];
const STEP_INDEX: Record<ShipmentStatus, number> = {
  planned: 0,
  confirmed: 1,
  in_production: 1,
  ready: 1,
  shipped: 2,
  in_transit: 3,
  delivered: 4,
  exception: -1,
};
export const SHIPPED: ShipmentStatus[] = ['shipped', 'in_transit', 'delivered'];

export const ESCALATION_LABEL: Record<Escalation, string> = {
  none: 'On track',
  watch: 'Watch',
  at_risk: 'At risk',
  critical: 'Critical',
};
const ESC_TONE: Record<Escalation, Tone> = {
  none: 'neutral',
  watch: 'warn',
  at_risk: 'risk',
  critical: 'crit',
};

// ------------------------------------------------------------------ formatting
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** "in 6 days", "today", "3 days ago" */
export const relDays = (d: string | null | undefined) => {
  const n = daysFromToday(d);
  if (n === null) return '';
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n === -1) return 'yesterday';
  return n > 0 ? `in ${plural(n, 'day')}` : `${plural(-n, 'day')} ago`;
};

/** Days late against a target ("3 days late") or early; null when either date is missing. */
export const lateness = (actual: string | null | undefined, target: string | null | undefined) => {
  if (!actual || !target) return null;
  const a = Date.parse(actual.slice(0, 10));
  const t = Date.parse(target.slice(0, 10));
  return Math.round((a - t) / 86_400_000);
};

export const fmtAddress = (a: Address | null | undefined, withName = false) =>
  !a
    ? ''
    : [
        withName ? a.name : null,
        a.line1,
        a.line2,
        [a.city, [a.region, a.postalCode].filter(Boolean).join(' ')].filter(Boolean).join(', '),
      ]
        .filter(Boolean)
        .join('\n');

/** Effective (expected) delivery date for a shipment, mirroring the backend. */
export const etaOf = (s: Shipment, transitDays: number | null | undefined) => {
  if (s.deliveredAt) return s.deliveredAt.slice(0, 10);
  if (s.estimatedDeliveryDate) return s.estimatedDeliveryDate;
  if (s.estimatedShipDate) {
    const d = new Date(`${s.estimatedShipDate}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + (transitDays ?? 5));
    return d.toISOString().slice(0, 10);
  }
  return s.requestedDeliveryDate;
};

/**
 * Escalation reasons come from the rules engine and the risk model in data vocabulary
 * ("Release-by date 2026-08-01 …"). Present them in the product's words and date style.
 */
export const humanReason = (r: string) =>
  r
    .replace(/^Risk model: /, '')
    .replace(/[Rr]elease-by/g, (m) => (m[0] === 'R' ? 'Order-by' : 'order-by'))
    .replace(/\b(\d{4}-\d{2}-\d{2})\b/g, (d) => date(d));
export const isModelReason = (r: string) => r.startsWith('Risk model: ');

export const thumbUrl = (id: string) => documentUrl(id).replace('/download?', '/thumbnail?');

// ------------------------------------------------------------------ small components

/** Order-by date with days remaining. Red once it has passed while requirements are still open. */
export function OrderByDate({
  value,
  pending,
  compact,
}: {
  value: string | null;
  pending: number;
  compact?: boolean;
}) {
  if (!value) return <span className="text-ink-4">Not set</span>;
  const n = daysFromToday(value) ?? 0;
  const open = pending > 0;
  const tone = !open ? 'text-ink-3' : n < 0 ? 'text-crit' : n <= 14 ? 'text-warn' : 'text-ink-3';
  const note = !open
    ? 'all requirements done'
    : n < 0
      ? `${plural(-n, 'day')} passed`
      : n === 0
        ? 'today'
        : `${plural(n, 'day')} left`;
  if (compact)
    return (
      <span className="num whitespace-nowrap">
        <span className={cx(open && n < 0 && 'text-crit')}>{date(value)}</span>
        {open && <span className={cx('ml-1.5 text-[12px] font-[480]', tone)}>{note}</span>}
      </span>
    );
  return (
    <div className="num whitespace-nowrap">
      <div className={cx(open && n < 0 && 'font-[560] text-crit')}>{date(value)}</div>
      <div className={cx('text-[12px]', tone)}>{note}</div>
    </div>
  );
}

/** Compact chips for pending requirement kinds (Ack / Deposit / Shop dwgs / Finishes). */
export function RequirementChips({
  kinds,
  overdue,
  extra,
}: {
  kinds: RequirementKind[];
  overdue?: boolean;
  /** Additional non-requirement chips, e.g. "Ship date". */
  extra?: { label: string; title: string }[];
}) {
  if (!kinds.length && !extra?.length)
    return (
      <span className="inline-flex items-center gap-1 text-[12px] text-ok">
        <Check className="size-3.5" />
        Clear
      </span>
    );
  const order: RequirementKind[] = [
    'order_acknowledgement',
    'deposit',
    'shop_drawing_approval',
    'finish_sample_approval',
    'cfa',
    'credit_approval',
    'other',
  ];
  return (
    <div className="flex flex-wrap gap-1">
      {[...kinds]
        .sort((a, b) => order.indexOf(a) - order.indexOf(b))
        .map((k) => (
          <span
            key={k}
            title={`${REQ_LABEL[k]} pending`}
            className={cx(
              'inline-flex h-5 items-center rounded-xs border px-1.5 text-[11.5px] font-[560] whitespace-nowrap',
              overdue ? 'border-crit/25 bg-crit-50 text-crit' : 'border-line bg-paper text-ink-2',
            )}
          >
            {REQ_SHORT[k]}
          </span>
        ))}
      {extra?.map((x) => (
        <span
          key={x.label}
          title={x.title}
          className="inline-flex h-5 items-center rounded-xs border border-warn/30 bg-warn-50 px-1.5 text-[11.5px] font-[560] whitespace-nowrap text-warn"
        >
          {x.label}
        </span>
      ))}
    </div>
  );
}

/** Escalation/risk badge; hover or focus lists the reasons (rules first, then the risk model). */
export function RiskMark({
  level,
  reasons,
  score,
  showNone,
}: {
  level: Escalation | null | undefined;
  reasons?: string[];
  score?: number | null;
  showNone?: boolean;
}) {
  const l = level ?? 'none';
  if (l === 'none' && !showNone)
    return <span className="text-[12px] whitespace-nowrap text-ink-4">On track</span>;
  const badge = (
    <Badge tone={ESC_TONE[l]}>
      {l !== 'none' && <AlertTriangle className="size-3" />}
      {ESCALATION_LABEL[l]}
    </Badge>
  );
  if (!reasons?.length) return badge;
  return (
    <Tooltip
      content={
        <div className="space-y-1 py-0.5">
          {score !== null && score !== undefined && (
            <div className="text-white/70">Risk score {Math.round(score)}/100</div>
          )}
          <ul className="space-y-1">
            {reasons.slice(0, 6).map((r) => (
              <li key={r}>
                {isModelReason(r) ? 'Risk model: ' : ''}
                {humanReason(r)}
              </li>
            ))}
          </ul>
        </div>
      }
    >
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: focus reveals the reasons tooltip for keyboard users */}
      <span tabIndex={0} className="rounded-xs">
        {badge}
        <span className="sr-only">: {reasons.join('. ')}</span>
      </span>
    </Tooltip>
  );
}

/** Callout listing escalation reasons; model reasons get the AI mark. */
export function RiskReasons({
  level,
  reasons,
  scoredAt,
}: {
  level: Escalation;
  reasons: string[];
  scoredAt?: string | null;
}) {
  if (level === 'none' || !reasons.length) return null;
  const tone =
    level === 'critical'
      ? 'border-crit/30 bg-crit-50'
      : level === 'at_risk'
        ? 'border-risk/30 bg-risk-50'
        : 'border-warn/30 bg-warn-50';
  const text = level === 'critical' ? 'text-crit' : level === 'at_risk' ? 'text-risk' : 'text-warn';
  return (
    <div className={cx('rounded-md border px-4 py-3', tone)}>
      <div className={cx('flex items-center gap-2 font-[620]', text)}>
        <AlertTriangle className="size-4" />
        {ESCALATION_LABEL[level]}: why this order needs attention
      </div>
      <ul className="mt-1.5 space-y-1 text-ink">
        {reasons.map((r) => {
          const ai = isModelReason(r);
          return (
            <li key={r} className="flex gap-2">
              {ai ? (
                <Sparkles
                  className="mt-0.5 size-3.5 shrink-0 text-brass"
                  aria-label="From the delivery-risk model"
                />
              ) : (
                <span className="mt-[7px] size-1.5 shrink-0 rounded-full bg-ink-3" />
              )}
              <span>{humanReason(r)}</span>
            </li>
          );
        })}
      </ul>
      {scoredAt && (
        <p className="mt-1.5 text-[12px] text-ink-3">
          <Sparkles className="mr-1 inline size-3 text-brass" />
          marks reasons from the delivery-risk model (last run {date(scoredAt)}).
        </p>
      )}
    </div>
  );
}

/** Five-step shipment progress: planned → confirmed → shipped → in transit → delivered. */
export function ShipmentSteps({ status, compact }: { status: ShipmentStatus; compact?: boolean }) {
  const at = STEP_INDEX[status];
  if (status === 'exception')
    return (
      <Badge tone="crit">
        <AlertTriangle className="size-3" />
        Exception
      </Badge>
    );
  return (
    <ol className="flex items-center gap-1" aria-label={`Shipment status: ${humanize(status)}`}>
      {SHIPMENT_STEPS.map((s, i) => (
        <li key={s.key} className="flex items-center gap-1">
          {i > 0 && <span className={cx('h-px w-3 sm:w-5', i <= at ? 'bg-lacquer' : 'bg-line')} />}
          <span
            className={cx(
              'flex items-center gap-1 text-[12px] whitespace-nowrap',
              i === at ? 'font-[620] text-lacquer' : i < at ? 'text-ink-2' : 'text-ink-4',
            )}
          >
            <span
              className={cx(
                'grid size-3.5 place-items-center rounded-full border',
                i < at || (i === at && status === 'delivered')
                  ? 'border-lacquer bg-lacquer text-white'
                  : i === at
                    ? 'border-lacquer bg-lacquer-100'
                    : 'border-line bg-paper',
              )}
            >
              {(i < at || (i === at && status === 'delivered')) && (
                <Check className="size-2.5" strokeWidth={3} />
              )}
            </span>
            {(!compact || i === at) && s.label}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** Image thumbnails for document ids; non-images fall back to a file chip. */
export function PhotoGrid({ ids, empty }: { ids: string[]; empty?: ReactNode }) {
  if (!ids.length) return <>{empty ?? <p className="text-ink-3">No photos yet.</p>}</>;
  return (
    <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
      {ids.map((id) => (
        <li key={id}>
          <Thumb id={id} />
        </li>
      ))}
    </ul>
  );
}
function Thumb({ id }: { id: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <a
      href={documentUrl(id)}
      target="_blank"
      rel="noreferrer"
      className="block aspect-square overflow-hidden rounded-sm border border-line bg-stone hover:border-ink-4"
    >
      {failed ? (
        <span className="grid h-full place-items-center text-[12px] text-ink-3">
          <span className="flex flex-col items-center gap-1">
            <ImageOff className="size-5 text-ink-4" />
            Open file
          </span>
        </span>
      ) : (
        <img
          src={thumbUrl(id)}
          alt="Claim attachment"
          loading="lazy"
          onError={() => setFailed(true)}
          className="h-full w-full object-cover"
        />
      )}
    </a>
  );
}

/** Pick photos/files and preview them before upload (used by receiving and claims). */
export function FilePicker({
  files,
  onChange,
  accept = 'image/*,application/pdf',
  label = 'Add photos',
}: {
  files: File[];
  onChange: (f: File[]) => void;
  accept?: string;
  label?: string;
}) {
  return (
    <div>
      <label className="flex cursor-pointer items-center justify-center gap-2 rounded-sm border border-dashed border-line px-3 py-3 text-ink-2 hover:border-ink-4 focus-within:border-lacquer">
        <input
          type="file"
          multiple
          accept={accept}
          className="sr-only"
          onChange={(e) => {
            onChange([...files, ...(e.target.files ?? [])]);
            e.target.value = '';
          }}
        />
        <span className="font-[560] text-lacquer">{label}</span>
        <span className="text-[12px] text-ink-3">JPG, PNG or PDF</span>
      </label>
      {files.length > 0 && (
        <ul className="mt-2 grid grid-cols-4 gap-2">
          {files.map((f, i) => (
            <li key={`${f.name}-${f.size}-${f.lastModified}`} className="relative">
              {f.type.startsWith('image/') ? (
                <img
                  src={URL.createObjectURL(f)}
                  alt={f.name}
                  className="aspect-square w-full rounded-sm border border-line object-cover"
                />
              ) : (
                <div className="grid aspect-square place-items-center rounded-sm border border-line bg-stone p-1 text-center text-[11px] break-all text-ink-2">
                  {f.name}
                </div>
              )}
              <button
                type="button"
                aria-label={`Remove ${f.name}`}
                onClick={() => onChange(files.filter((_, j) => j !== i))}
                className="absolute -top-1.5 -right-1.5 grid size-5 place-items-center rounded-full bg-ink text-[12px] text-white"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Link-styled external tracking reference. */
export function TrackingLink({
  carrier,
  number,
  url,
}: {
  carrier: string | null;
  number: string | null;
  url: string | null;
}) {
  if (!number) return <span className="text-ink-4">No tracking yet</span>;
  return (
    <span>
      <span className="text-ink-2">{carrier}</span>{' '}
      {url ? (
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="num font-[560] whitespace-nowrap text-lacquer hover:underline"
        >
          {number}
        </a>
      ) : (
        <span className="num font-[560] whitespace-nowrap">{number}</span>
      )}
    </span>
  );
}

export const describeChange = (c: { field: string; lineCode?: string; from: unknown; to: unknown }) => {
  const show = (v: unknown) =>
    v === null || v === undefined || v === ''
      ? '—'
      : typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
        ? date(v)
        : typeof v === 'object'
          ? Object.values(v as Record<string, unknown>)
              .filter(Boolean)
              .join(', ')
          : String(v);
  if (c.field === 'line_added') return { what: `Added ${c.lineCode}`, from: null, to: show(c.to) };
  if (c.field === 'line_removed') return { what: `Removed ${c.lineCode}`, from: show(c.from), to: null };
  return {
    what: `${c.lineCode ? `${c.lineCode} ` : ''}${
      c.field === 'releaseByDate'
        ? 'Order-by date'
        : humanize(c.field.replace(/([A-Z])/g, '_$1').toLowerCase())
    }`,
    from: show(c.from),
    to: show(c.to),
  };
};
