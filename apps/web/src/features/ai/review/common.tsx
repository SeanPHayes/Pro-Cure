import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import type { InputHTMLAttributes, ReactNode } from 'react';
import { cx } from '@/components/ui';
import { ApiError, errorMessage } from '@/lib/api';

/** Borderless inline-edit input for review tables: looks like text until hovered or focused. */
export function CellInput({
  value,
  onChange,
  className,
  changed,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & {
  value: string;
  onChange: (v: string) => void;
  changed?: boolean;
}) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      className={cx(
        'h-7 w-full min-w-0 rounded-xs border border-transparent bg-transparent px-1.5 -mx-1.5 text-ink placeholder:text-ink-4',
        'hover:border-line focus:border-lacquer focus:bg-paper focus:outline-none focus:ring-2 focus:ring-lacquer/15',
        changed && 'bg-brass-50',
        className,
      )}
      {...rest}
    />
  );
}

export function CellSelect({
  value,
  onChange,
  options,
  label,
  changed,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  label: string;
  changed?: boolean;
}) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      className={cx(
        'h-7 w-full min-w-0 appearance-none rounded-xs border border-transparent bg-transparent px-1.5 -mx-1.5 text-ink',
        'hover:border-line focus:border-lacquer focus:bg-paper focus:outline-none focus:ring-2 focus:ring-lacquer/15',
        changed && 'bg-brass-50',
      )}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Warnings({ items }: { items: string[] }) {
  if (!items.length) return null;
  return (
    <div className="rounded-sm border border-warn/25 bg-warn-50 px-3 py-2">
      <div className="flex items-center gap-2 text-[13px] font-[620] text-warn">
        <AlertTriangle className="size-4" />
        {items.length === 1
          ? 'Check this before applying'
          : `${items.length} things to check before applying`}
      </div>
      <ul className="mt-1 list-disc space-y-0.5 pl-6 text-[13px] text-ink-2">
        {items.map((w) => (
          <li key={w}>{w}</li>
        ))}
      </ul>
    </div>
  );
}

export function Banner({
  tone,
  icon,
  title,
  children,
  actions,
}: {
  tone: 'ok' | 'crit' | 'info' | 'neutral';
  icon?: ReactNode;
  title: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  const cls = {
    ok: 'border-ok/25 bg-ok-50 [&_.bi]:text-ok',
    crit: 'border-crit/25 bg-crit-50 [&_.bi]:text-crit',
    info: 'border-info/20 bg-info-50 [&_.bi]:text-info',
    neutral: 'border-line bg-stone-2 [&_.bi]:text-ink-3',
  }[tone];
  return (
    <div
      role={tone === 'crit' ? 'alert' : 'status'}
      className={cx('flex flex-wrap items-start gap-3 rounded-sm border px-3 py-2.5', cls)}
    >
      <span className="bi mt-0.5 shrink-0 [&>svg]:size-4">{icon ?? <CheckCircle2 />}</span>
      <div className="min-w-0 flex-1 text-[13px]">
        <div className="font-[620]">{title}</div>
        {children && <div className="mt-0.5 text-ink-2">{children}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

const SERVICE_LABEL: Record<string, string> = {
  quoting: 'Quoting (cost requests and the spec library)',
  catalog: 'The catalog',
  documents: 'Document storage',
  orders: 'Purchase orders',
  comms: 'The inbox',
};

/**
 * Turn an apply failure into something a reviewer can act on. Upstream failures come back as
 * "<service>: <message>" or connection errors; name the service and say nothing was changed.
 */
export function applyErrorText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e ?? '');
  const svc = msg.match(/^(quoting|catalog|documents|orders|comms)\b/i)?.[1]?.toLowerCase();
  const down =
    /ECONNREFUSED|fetch failed|unavailable|socket hang up|ETIMEDOUT|502|503|504/i.test(msg) ||
    (e instanceof ApiError && [502, 503, 504].includes(e.status));
  if (down)
    return `${svc ? SERVICE_LABEL[svc] : 'A service this job writes to'} is unavailable right now, so nothing was applied. Your review is saved — apply again in a few minutes.`;
  if (svc && /validation/i.test(msg))
    return `${SERVICE_LABEL[svc]} rejected some of the values. Check the edited fields and apply again.`;
  return e instanceof Error ? errorMessage(e) : msg || 'Apply failed';
}

/** Parse "Carolina Casegoods (HB-8056); Pacific Rim" into approved-vendor objects. */
export const parseVendors = (s: string) =>
  s
    .split(/;|\n/)
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const m = x.match(/^(.*?)\s*\((.+)\)\s*$/);
      return m ? { name: m[1]!.trim(), model: m[2]!.trim() } : { name: x, model: null };
    });
export const formatVendors = (v: { name: string; model: string | null }[]) =>
  v.map((x) => (x.model ? `${x.name} (${x.model})` : x.name)).join('; ');
