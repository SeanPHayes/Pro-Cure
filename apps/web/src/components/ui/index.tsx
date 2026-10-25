import { clsx } from 'clsx';
import { ChevronDown, Loader2, Search, X } from 'lucide-react';
import {
  type ButtonHTMLAttributes,
  createContext,
  forwardRef,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { humanize, initials } from '@/lib/format';

export const cx = clsx;

// ------------------------------------------------------------------ Button
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'brass';
type Size = 'sm' | 'md';
const variants: Record<Variant, string> = {
  primary: 'bg-lacquer text-white hover:bg-lacquer-700 disabled:bg-lacquer/50',
  brass: 'bg-brass text-white hover:bg-[#8a6a2a] disabled:opacity-50',
  secondary: 'bg-paper text-ink border border-line hover:border-ink-4 hover:bg-stone disabled:opacity-50',
  ghost: 'text-ink-2 hover:bg-stone-2 hover:text-ink disabled:opacity-40',
  danger: 'bg-paper text-crit border border-crit/30 hover:bg-crit-50 disabled:opacity-50',
};
const sizes: Record<Size, string> = { sm: 'h-7 px-2.5 text-[13px] gap-1.5', md: 'h-9 px-3.5 gap-2' };

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: Variant;
    size?: Size;
    loading?: boolean;
    icon?: ReactNode;
  }
>(({ variant = 'secondary', size = 'md', loading, icon, className, children, disabled, ...rest }, ref) => (
  <button
    ref={ref}
    type="button"
    disabled={disabled || loading}
    className={cx(
      'inline-flex items-center justify-center rounded-sm font-[560] whitespace-nowrap transition-colors disabled:cursor-not-allowed',
      variants[variant],
      sizes[size],
      className,
    )}
    {...rest}
  >
    {loading ? <Loader2 className="size-4 animate-spin" /> : icon}
    {children}
  </button>
));
Button.displayName = 'Button';

export const IconButton = ({
  label,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) => (
  <button
    type="button"
    aria-label={label}
    title={label}
    className={cx(
      'inline-grid size-8 place-items-center rounded-sm text-ink-2 hover:bg-stone-2 hover:text-ink disabled:opacity-40',
      className,
    )}
    {...rest}
  >
    {children}
  </button>
);

// ------------------------------------------------------------------ Form fields
const fieldBase =
  'w-full rounded-sm border border-line bg-paper px-2.5 text-ink placeholder:text-ink-4 hover:border-ink-4 focus:border-lacquer focus:outline-none focus:ring-2 focus:ring-lacquer/15 disabled:bg-stone disabled:text-ink-3';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...rest }, ref) => <input ref={ref} className={cx(fieldBase, 'h-9', className)} {...rest} />,
);
Input.displayName = 'Input';

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...rest }, ref) => (
    <textarea ref={ref} className={cx(fieldBase, 'py-2 min-h-20', className)} {...rest} />
  ),
);
Textarea.displayName = 'Textarea';

export const Select = forwardRef<
  HTMLSelectElement,
  SelectHTMLAttributes<HTMLSelectElement> & {
    options?: { value: string; label: string }[];
    placeholder?: string;
  }
>(({ className, options, placeholder, children, ...rest }, ref) => (
  <div className="relative">
    <select ref={ref} className={cx(fieldBase, 'h-9 appearance-none pr-8', className)} {...rest}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options?.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
      {children}
    </select>
    <ChevronDown className="pointer-events-none absolute top-2.5 right-2.5 size-4 text-ink-3" />
  </div>
));
Select.displayName = 'Select';

export const enumOptions = (values: readonly string[]) =>
  values.map((v) => ({ value: v, label: humanize(v) }));

export function Field({
  label,
  hint,
  error,
  children,
  className,
}: {
  label: string;
  hint?: ReactNode;
  error?: string;
  children: (id: string) => ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={cx('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="text-[13px] font-[560] text-ink-2">
        {label}
      </label>
      {children(id)}
      {error ? (
        <p className="text-[12px] text-crit">{error}</p>
      ) : hint ? (
        <p className="text-[12px] text-ink-3">{hint}</p>
      ) : null}
    </div>
  );
}

export function SearchInput({
  value,
  onChange,
  placeholder = 'Search',
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <div className={cx('relative', className)}>
      <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-ink-3" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={cx(fieldBase, 'h-9 pl-8')}
      />
    </div>
  );
}

export function Checkbox({
  checked,
  onChange,
  label,
  indeterminate,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
  indeterminate?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !!indeterminate;
  }, [indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      aria-label={label}
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
      onClick={(e) => e.stopPropagation()}
      className="size-4 cursor-pointer rounded-xs accent-lacquer"
    />
  );
}

// ------------------------------------------------------------------ Status
export type Tone = 'neutral' | 'ok' | 'warn' | 'risk' | 'crit' | 'info' | 'brass' | 'lacquer';
const tones: Record<Tone, string> = {
  neutral: 'bg-stone-2 text-ink-2',
  ok: 'bg-ok-50 text-ok',
  warn: 'bg-warn-50 text-warn',
  risk: 'bg-risk-50 text-risk',
  crit: 'bg-crit-50 text-crit',
  info: 'bg-info-50 text-info',
  brass: 'bg-brass-50 text-brass',
  lacquer: 'bg-lacquer-50 text-lacquer',
};
const dots: Record<Tone, string> = {
  neutral: 'bg-ink-4',
  ok: 'bg-ok',
  warn: 'bg-warn',
  risk: 'bg-risk',
  crit: 'bg-crit',
  info: 'bg-info',
  brass: 'bg-brass',
  lacquer: 'bg-lacquer',
};

export const Badge = ({
  tone = 'neutral',
  children,
  className,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
}) => (
  <span
    className={cx(
      'inline-flex h-[22px] items-center gap-1.5 rounded-xs px-1.5 text-[12px] font-[560] whitespace-nowrap',
      tones[tone],
      className,
    )}
  >
    {children}
  </span>
);

/** Maps the many status enums of the platform onto a small set of tones. */
const STATUS_TONES: Record<string, Tone> = {
  draft: 'neutral',
  todo: 'neutral',
  planned: 'neutral',
  open: 'info',
  queued: 'neutral',
  pending: 'warn',
  in_progress: 'info',
  costing: 'info',
  merchandising: 'info',
  running: 'info',
  sent: 'info',
  issued: 'info',
  submitted: 'info',
  viewed: 'info',
  confirmed: 'lacquer',
  acknowledged: 'lacquer',
  in_production: 'lacquer',
  ready: 'lacquer',
  shipped: 'lacquer',
  in_transit: 'lacquer',
  partially_shipped: 'lacquer',
  partially_delivered: 'lacquer',
  partially_paid: 'lacquer',
  partially_applied: 'lacquer',
  responded: 'brass',
  needs_review: 'brass',
  pending_internal_approval: 'brass',
  approved: 'ok',
  client_approved: 'ok',
  delivered: 'ok',
  received: 'ok',
  paid: 'ok',
  done: 'ok',
  completed: 'ok',
  applied: 'ok',
  resolved: 'ok',
  credited: 'ok',
  routed: 'ok',
  synced: 'ok',
  active: 'ok',
  ordered: 'ok',
  closed: 'neutral',
  archived: 'neutral',
  skipped: 'neutral',
  waived: 'neutral',
  ignored: 'neutral',
  on_hold: 'warn',
  blocked: 'risk',
  overdue: 'crit',
  rejected: 'crit',
  client_rejected: 'crit',
  failed: 'crit',
  error: 'crit',
  exception: 'crit',
  cancelled: 'neutral',
  void: 'neutral',
  // escalation & risk levels
  none: 'neutral',
  watch: 'warn',
  at_risk: 'risk',
  critical: 'crit',
};

export const StatusBadge = ({ status, label }: { status: string | null | undefined; label?: string }) => {
  if (!status) return <span className="text-ink-4">—</span>;
  const tone = STATUS_TONES[status] ?? 'neutral';
  return (
    <Badge tone={tone}>
      <span className={cx('size-1.5 rounded-full', dots[tone])} />
      {label ?? humanize(status)}
    </Badge>
  );
};

export const EscalationMark = ({ level }: { level: string | null | undefined }) =>
  !level || level === 'none' ? null : <StatusBadge status={level} />;

// ------------------------------------------------------------------ Layout bits
export function PageHeader({
  title,
  description,
  actions,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="border-b border-line bg-paper px-6 pt-5 pb-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[22px] font-[620] leading-tight">{title}</h1>
          {description && <p className="mt-1 max-w-[70ch] text-ink-2">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </div>
  );
}

export function Section({
  title,
  actions,
  children,
  className,
  bodyClassName,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={cx('rounded-md border border-line bg-paper', className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 border-b border-line-2 px-4 py-2.5">
          <h2 className="text-[14px] font-[620]">{title}</h2>
          {actions && <div className="flex items-center gap-1.5">{actions}</div>}
        </header>
      )}
      <div className={cx(bodyClassName ?? 'p-4')}>{children}</div>
    </section>
  );
}

export function TitleBlock({
  title,
  subtitle,
  fields,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  fields: { label: string; value: ReactNode }[];
}) {
  return (
    <div className="title-block rounded-xs" style={{ ['--tb-cols' as string]: fields.length }}>
      <div>
        <div className="text-[19px] font-[640] leading-snug">{title}</div>
        {subtitle && <div className="mt-0.5 text-ink-2">{subtitle}</div>}
      </div>
      {fields.map((f) => (
        <div key={f.label}>
          <div className="tb-label">{f.label}</div>
          <div className="tb-value">{f.value}</div>
        </div>
      ))}
    </div>
  );
}

export const EmptyState = ({
  icon,
  title,
  children,
  action,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) => (
  <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
    {icon && <div className="mb-3 text-ink-4 [&>svg]:size-8">{icon}</div>}
    <p className="font-[620]">{title}</p>
    {children && <p className="mt-1 max-w-[52ch] text-ink-2">{children}</p>}
    {action && <div className="mt-4">{action}</div>}
  </div>
);

export const Spinner = ({ className }: { className?: string }) => (
  <Loader2 className={cx('size-5 animate-spin text-ink-3', className)} />
);

export const Loading = ({ label = 'Loading' }: { label?: string }) => (
  <div className="flex items-center justify-center gap-2 py-16 text-ink-3">
    <Spinner />
    {label}
  </div>
);

export const ErrorNote = ({ error }: { error: unknown }) => (
  <div className="m-4 rounded-sm border border-crit/25 bg-crit-50 px-3 py-2 text-crit">
    {error instanceof Error ? error.message : 'Something went wrong loading this.'}
  </div>
);

export const Avatar = ({
  name,
  size = 28,
  tone = 'lacquer',
}: {
  name: string;
  size?: number;
  tone?: 'lacquer' | 'brass';
}) => (
  <span
    className={cx(
      'inline-grid shrink-0 place-items-center rounded-full font-[620]',
      tone === 'lacquer' ? 'bg-lacquer-100 text-lacquer' : 'bg-brass-100 text-brass',
    )}
    style={{ width: size, height: size, fontSize: size * 0.4 }}
    title={name}
  >
    {initials(name)}
  </span>
);

const toneText: Record<Tone, string> = {
  neutral: 'text-ink',
  ok: 'text-ok',
  warn: 'text-warn',
  risk: 'text-risk',
  crit: 'text-crit',
  info: 'text-info',
  brass: 'text-brass',
  lacquer: 'text-lacquer',
};

export function Stat({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
  tone?: Tone;
}) {
  return (
    <div className="min-w-0">
      <div className="text-[12px] text-ink-3">{label}</div>
      <div className={cx('num mt-0.5 text-[22px] font-[620] leading-tight', tone && toneText[tone])}>
        {value}
      </div>
      {note && <div className="mt-0.5 text-[12px] text-ink-3">{note}</div>}
    </div>
  );
}

// ------------------------------------------------------------------ Tabs
const TabsCtx = createContext<{ value: string; set: (v: string) => void }>({ value: '', set: () => {} });
export function Tabs({
  value,
  onChange,
  items,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  items: { value: string; label: ReactNode; count?: number }[];
  className?: string;
}) {
  return (
    <TabsCtx.Provider value={{ value, set: onChange }}>
      <div role="tablist" className={cx('flex gap-5 overflow-x-auto', className)}>
        {items.map((t) => (
          <button
            key={t.value}
            role="tab"
            type="button"
            aria-selected={value === t.value}
            onClick={() => onChange(t.value)}
            className={cx(
              '-mb-px flex items-center gap-1.5 border-b-2 pt-1 pb-2 font-[560] whitespace-nowrap transition-colors',
              value === t.value ? 'border-brass text-ink' : 'border-transparent text-ink-3 hover:text-ink',
            )}
          >
            {t.label}
            {t.count !== undefined && <span className="num text-[12px] text-ink-3">{t.count}</span>}
          </button>
        ))}
      </div>
    </TabsCtx.Provider>
  );
}
export const useTabs = () => useContext(TabsCtx);

/** Pill filters: a single-select row of choices (e.g. Due: All / Overdue / This week). */
export function Chips<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string; count?: number }[];
}) {
  return (
    <div className="inline-flex rounded-sm border border-line bg-paper p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cx(
            'h-7 rounded-xs px-2.5 text-[13px] font-[560] whitespace-nowrap',
            value === o.value ? 'bg-lacquer text-white' : 'text-ink-2 hover:bg-stone',
          )}
        >
          {o.label}
          {o.count !== undefined && <span className="num ml-1.5 opacity-70">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ Overlays
function useEscape(open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);
}

/** Side sheet for create/edit forms and record previews. */
export function Sheet({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  width = 520,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  useEscape(open, onClose);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-ink/25" onClick={onClose} />
      <aside
        role="dialog"
        aria-modal="true"
        className="relative flex h-full w-full flex-col bg-paper shadow-[var(--shadow-sheet)] animate-[sheet_160ms_ease-out]"
        style={{ maxWidth: width }}
      >
        <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div>
            <h2 className="text-[17px] font-[640]">{title}</h2>
            {description && <p className="mt-0.5 text-ink-2">{description}</p>}
          </div>
          <IconButton label="Close" onClick={onClose}>
            <X className="size-4" />
          </IconButton>
        </header>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && (
          <footer className="flex justify-end gap-2 border-t border-line bg-stone px-5 py-3">{footer}</footer>
        )}
      </aside>
      <style>
        {'@keyframes sheet{from{transform:translateX(24px);opacity:.6}to{transform:none;opacity:1}}'}
      </style>
    </div>,
    document.body,
  );
}

export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  width = 460,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  useEscape(open, onClose);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 grid place-items-center p-4">
      <div className="absolute inset-0 bg-ink/30" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        className="relative w-full rounded-md bg-paper shadow-[var(--shadow-pop)]"
        style={{ maxWidth: width }}
      >
        <header className="px-5 pt-4 pb-2">
          <h2 className="text-[16px] font-[640]">{title}</h2>
        </header>
        <div className="px-5 pb-4">{children}</div>
        {footer && (
          <footer className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</footer>
        )}
      </div>
    </div>,
    document.body,
  );
}

/** Small click-to-open menu anchored to its trigger. */
export function Menu({
  trigger,
  items,
  align = 'right',
}: {
  trigger: (open: () => void) => ReactNode;
  items: (
    | { label: string; onSelect: () => void; danger?: boolean; icon?: ReactNode; disabled?: boolean }
    | 'divider'
  )[];
  align?: 'left' | 'right';
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('mousedown', h);
    return () => window.removeEventListener('mousedown', h);
  }, [open]);
  useEscape(open, () => setOpen(false));
  return (
    <div ref={ref} className="relative inline-block">
      {trigger(() => setOpen((o) => !o))}
      {open && (
        <div
          role="menu"
          className={cx(
            'absolute z-40 mt-1 min-w-48 rounded-sm border border-line bg-paper py-1 shadow-[var(--shadow-pop)]',
            align === 'right' ? 'right-0' : 'left-0',
          )}
        >
          {items.map((it, i) =>
            it === 'divider' ? (
              <div key={`d${i}`} className="my-1 h-px bg-line-2" />
            ) : (
              <button
                key={it.label}
                type="button"
                role="menuitem"
                disabled={it.disabled}
                onClick={() => {
                  setOpen(false);
                  it.onSelect();
                }}
                className={cx(
                  'flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-stone disabled:opacity-40',
                  it.danger && 'text-crit',
                )}
              >
                {it.icon}
                {it.label}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

/** Key/value list for record sidebars. */
export const Facts = ({
  items,
  cols = 1,
}: {
  items: { label: string; value: ReactNode }[];
  cols?: 1 | 2 | 3;
}) => (
  <dl className={cx('grid gap-x-6 gap-y-3', cols === 2 && 'sm:grid-cols-2', cols === 3 && 'sm:grid-cols-3')}>
    {items.map((i) => (
      <div key={i.label} className="min-w-0">
        <dt className="text-[12px] text-ink-3">{i.label}</dt>
        <dd className="mt-0.5 break-words">{i.value ?? '—'}</dd>
      </div>
    ))}
  </dl>
);

export function ProgressBar({
  value,
  tone = 'lacquer',
}: {
  value: number;
  tone?: 'lacquer' | 'brass' | 'ok';
}) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-stone-2">
      <div
        className={cx(
          'h-full rounded-full',
          tone === 'lacquer' ? 'bg-lacquer' : tone === 'brass' ? 'bg-brass' : 'bg-ok',
        )}
        style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
      />
    </div>
  );
}
