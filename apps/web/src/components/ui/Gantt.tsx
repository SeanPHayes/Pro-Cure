import { ChevronDown, ChevronRight } from 'lucide-react';
import { type CSSProperties, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { cx } from './index';

/**
 * Schedule chart. Rows are grouped (e.g. by phase); bars span start → due (inclusive), milestones are
 * diamonds on their due date. The critical path is drawn in brass, completed work is muted, today and
 * the target date are vertical rules. Labels stay pinned on the left while the timeline scrolls.
 */
export interface GanttItem {
  id: string;
  name: string;
  group: string;
  start: string | null;
  end: string | null;
  milestone?: boolean;
  critical?: boolean;
  done?: boolean;
  inProgress?: boolean;
  overdue?: boolean;
  /** Draws the bar hatched — used for work the owner or a vendor does. */
  external?: boolean;
  dependsOn?: string[];
  sub?: ReactNode;
}

const DAY = 86_400_000;
const dn = (d: string) => Math.round(Date.parse(`${d}T00:00:00Z`) / DAY);
const fromDn = (n: number) => new Date(n * DAY);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ROW = 30;
const HEAD = 44;

export type GanttZoom = 'week' | 'month' | 'quarter';
const PPD: Record<GanttZoom, number> = { week: 18, month: 5, quarter: 2.2 };

export function Gantt({
  items,
  today,
  target,
  targetLabel = 'Target open',
  zoom = 'month',
  showDependencies,
  selectedId,
  onSelect,
  labelWidth = 300,
  maxHeight = '72vh',
}: {
  items: GanttItem[];
  today: string;
  target?: string | null;
  targetLabel?: string;
  zoom?: GanttZoom;
  showDependencies?: boolean;
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  labelWidth?: number;
  maxHeight?: string;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [hover, setHover] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const ppd = PPD[zoom];

  const { from, to } = useMemo(() => {
    const ds = items.flatMap((i) => [i.start, i.end]).filter(Boolean) as string[];
    if (target) ds.push(target);
    ds.push(today);
    const nums = ds.map(dn);
    const lo = Math.min(...nums) - 10;
    const hi = Math.max(...nums) + 21;
    // snap to the first of the month for tidy headers
    const d = fromDn(lo);
    return { from: dn(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`), to: hi };
  }, [items, target, today]);
  const width = Math.ceil((to - from) * ppd);
  const x = (d: string) => (dn(d) - from) * ppd;

  // Rows: group header + its items (unless collapsed)
  const groups = useMemo(() => {
    const m = new Map<string, GanttItem[]>();
    for (const i of items) {
      const g = m.get(i.group) ?? [];
      g.push(i);
      m.set(i.group, g);
    }
    return [...m.entries()];
  }, [items]);
  type Row = { kind: 'group'; group: string; items: GanttItem[] } | { kind: 'item'; item: GanttItem };
  const rows: Row[] = [];
  for (const [g, list] of groups) {
    rows.push({ kind: 'group', group: g, items: list });
    if (!collapsed.has(g)) for (const it of list) rows.push({ kind: 'item', item: it });
  }
  const rowIndex = new Map<string, number>();
  rows.forEach((r, i) => {
    if (r.kind === 'item') rowIndex.set(r.item.id, i);
  });
  const height = rows.length * ROW;

  // Month + week ticks
  const months: { x: number; label: string; w: number }[] = [];
  {
    const d = fromDn(from);
    let y = d.getUTCFullYear();
    let mo = d.getUTCMonth();
    for (;;) {
      const start = Date.UTC(y, mo, 1) / DAY;
      if (start > to) break;
      const next = Date.UTC(mo === 11 ? y + 1 : y, (mo + 1) % 12, 1) / DAY;
      months.push({
        x: (start - from) * ppd,
        w: (Math.min(next, to) - start) * ppd,
        label: zoom === 'quarter' && mo !== 0 ? MONTHS[mo]! : `${MONTHS[mo]} ’${String(y).slice(2)}`,
      });
      mo = (mo + 1) % 12;
      if (mo === 0) y++;
    }
  }
  const weeks: number[] = [];
  if (zoom !== 'quarter')
    for (let n = from; n <= to; n++) if (fromDn(n).getUTCDay() === 1) weeks.push((n - from) * ppd);

  // Scroll today into view on first render / zoom change
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    el.scrollLeft = Math.max(0, (dn(today) - from) * ppd - (el.clientWidth - labelWidth) * 0.3);
  }, [ppd, from, today, labelWidth]);

  const byId = new Map(items.map((i) => [i.id, i]));
  const focus = hover ?? selectedId ?? null;
  const links: { from: GanttItem; to: GanttItem; strong: boolean }[] = [];
  for (const it of items) {
    for (const dep of it.dependsOn ?? []) {
      const p = byId.get(dep);
      if (!p) continue;
      const strong = focus === it.id || focus === p.id;
      if (showDependencies || strong) links.push({ from: p, to: it, strong });
    }
  }

  const barGeom = (it: GanttItem) => {
    const s = it.start ?? it.end;
    const e = it.end ?? it.start;
    if (!s || !e) return null;
    const left = x(s);
    const right = x(e) + ppd;
    return { left, right, w: Math.max(right - left, 3) };
  };

  return (
    <div
      ref={scroller}
      className="relative overflow-auto rounded-sm border border-line bg-paper"
      style={{ maxHeight }}
    >
      <div className="relative" style={{ width: labelWidth + width, minHeight: HEAD + height }}>
        {/* Header */}
        <div className="sticky top-0 z-20 flex border-b border-line bg-stone" style={{ height: HEAD }}>
          <div
            className="sticky left-0 z-10 flex shrink-0 items-end border-r border-line bg-stone px-3 pb-1.5 text-[12px] font-[560] text-ink-2"
            style={{ width: labelWidth }}
          >
            Task
          </div>
          <div className="relative" style={{ width }}>
            {months.map((m) => (
              <div
                key={m.x}
                className="absolute top-0 h-[22px] truncate border-l border-line px-1.5 pt-1 text-[11.5px] font-[560] text-ink-2"
                style={{ left: m.x, width: m.w }}
              >
                {m.label}
              </div>
            ))}
            {zoom === 'week' &&
              weeks.map((w) => (
                <div
                  key={w}
                  className="num absolute top-[22px] border-l border-line-2 pl-1 text-[10.5px] text-ink-3"
                  style={{ left: w }}
                >
                  {fromDn(from + Math.round(w / ppd)).getUTCDate()}
                </div>
              ))}
            <Rule x={x(today)} label="Today" tone="today" />
            {target && <Rule x={x(target)} label={targetLabel} tone="target" />}
          </div>
        </div>

        {/* Grid, rules and dependency lines */}
        <svg
          className="pointer-events-none absolute"
          style={{ left: labelWidth, top: HEAD }}
          width={width}
          height={height}
          aria-hidden="true"
        >
          {weeks.map((w) => (
            <line key={w} x1={w} x2={w} y1={0} y2={height} stroke="var(--color-line-2)" />
          ))}
          {months.map((m) => (
            <line key={m.x} x1={m.x} x2={m.x} y1={0} y2={height} stroke="var(--color-line)" />
          ))}
          {rows.map((r, i) =>
            r.kind === 'group' ? (
              <rect key={r.group} x={0} y={i * ROW} width={width} height={ROW} fill="#f7f8f5" />
            ) : null,
          )}
          {target && (
            <line
              x1={x(target) + ppd / 2}
              x2={x(target) + ppd / 2}
              y1={0}
              y2={height}
              stroke="var(--color-lacquer)"
              strokeDasharray="4 3"
            />
          )}
          <line
            x1={x(today) + ppd / 2}
            x2={x(today) + ppd / 2}
            y1={0}
            y2={height}
            stroke="var(--color-crit)"
            strokeOpacity={0.7}
          />
          {links.map(({ from: a, to: b, strong }) => {
            const ga = barGeom(a);
            const gb = barGeom(b);
            const ia = rowIndex.get(a.id);
            const ib = rowIndex.get(b.id);
            if (!ga || !gb || ia === undefined || ib === undefined) return null;
            const x1 = a.milestone ? ga.left + ppd / 2 + 6 : ga.right;
            const y1 = ia * ROW + ROW / 2;
            const x2 = b.milestone ? gb.left + ppd / 2 - 6 : gb.left;
            const y2 = ib * ROW + ROW / 2;
            const mid = Math.max(x1 + 6, Math.min(x2 - 6, x1 + 10));
            const crit = a.critical && b.critical;
            return (
              <path
                key={`${a.id}-${b.id}`}
                d={`M${x1},${y1} H${mid} V${y2} H${x2}`}
                fill="none"
                stroke={crit ? 'var(--color-brass)' : 'var(--color-ink-3)'}
                strokeOpacity={strong ? 0.9 : 0.35}
                strokeWidth={strong ? 1.4 : 1}
                markerEnd="url(#gantt-arrow)"
              />
            );
          })}
          <defs>
            <marker
              id="gantt-arrow"
              viewBox="0 0 6 6"
              refX="5"
              refY="3"
              markerWidth="6"
              markerHeight="6"
              orient="auto"
            >
              <path d="M0,0 L6,3 L0,6 z" fill="var(--color-ink-3)" />
            </marker>
          </defs>
        </svg>

        {/* Rows */}
        <ul>
          {rows.map((r) => {
            if (r.kind === 'group') {
              const open = !collapsed.has(r.group);
              const done = r.items.filter((i) => i.done).length;
              const gs = r.items.map(barGeom).filter(Boolean) as { left: number; right: number }[];
              const gl = Math.min(...gs.map((g) => g.left));
              const gr = Math.max(...gs.map((g) => g.right));
              return (
                <li key={`g-${r.group}`} className="relative flex" style={{ height: ROW }}>
                  <button
                    type="button"
                    aria-expanded={open}
                    onClick={() =>
                      setCollapsed((c) => {
                        const n = new Set(c);
                        if (n.has(r.group)) n.delete(r.group);
                        else n.add(r.group);
                        return n;
                      })
                    }
                    className="sticky left-0 z-10 flex shrink-0 items-center gap-1.5 border-r border-b border-line-2 bg-[#f7f8f5] px-2 text-left text-[12.5px] font-[620] hover:text-lacquer"
                    style={{ width: labelWidth }}
                  >
                    {open ? (
                      <ChevronDown className="size-3.5 text-ink-3" />
                    ) : (
                      <ChevronRight className="size-3.5 text-ink-3" />
                    )}
                    <span className="flex-1 truncate">{r.group}</span>
                    <span className="num text-[11.5px] font-[520] text-ink-3">
                      {done}/{r.items.length}
                    </span>
                  </button>
                  <div className="relative border-b border-line-2" style={{ width }}>
                    {gs.length > 0 && (
                      <span
                        className="absolute top-[13px] h-[3px] rounded-full bg-ink-4/50"
                        style={{ left: gl, width: Math.max(gr - gl, 3) }}
                      />
                    )}
                  </div>
                </li>
              );
            }
            const it = r.item;
            const g = barGeom(it);
            const sel = selectedId === it.id;
            return (
              <li
                key={it.id}
                className={cx('group relative flex', sel && 'bg-brass-50')}
                style={{ height: ROW }}
                onMouseEnter={() => setHover(it.id)}
                onMouseLeave={() => setHover(null)}
              >
                <button
                  type="button"
                  onClick={() => onSelect?.(it.id)}
                  className={cx(
                    'sticky left-0 z-10 flex shrink-0 items-center gap-2 border-r border-b border-line-2 pr-2 pl-7 text-left text-[13px] group-hover:bg-stone',
                    sel ? 'bg-brass-50' : 'bg-paper',
                  )}
                  style={{ width: labelWidth }}
                >
                  <span
                    className={cx(
                      'min-w-0 flex-1 truncate',
                      it.done && 'text-ink-3 line-through decoration-ink-4',
                      it.critical && !it.done && 'font-[560]',
                    )}
                  >
                    {it.name}
                  </span>
                  {it.sub && <span className="shrink-0 truncate text-[11.5px] text-ink-3">{it.sub}</span>}
                </button>
                <div className="relative border-b border-line-2" style={{ width }}>
                  {g &&
                    (it.milestone ? (
                      <span
                        title={`${it.name} — ${it.end ?? it.start}`}
                        className={cx(
                          'absolute top-[9px] size-3 rotate-45 border',
                          it.done
                            ? 'border-ink-4 bg-stone-2'
                            : it.critical
                              ? 'border-brass bg-brass'
                              : it.overdue
                                ? 'border-crit bg-crit'
                                : 'border-lacquer bg-lacquer',
                        )}
                        style={{ left: g.left + ppd / 2 - 6 }}
                      />
                    ) : (
                      <span
                        title={`${it.name} — ${it.start} to ${it.end}`}
                        className={cx(
                          'absolute top-[8px] h-[14px] overflow-hidden rounded-[3px] border',
                          it.done
                            ? 'border-line bg-stone-2'
                            : it.critical
                              ? 'border-brass bg-brass-100'
                              : 'border-lacquer-600 bg-lacquer-100',
                          it.overdue && !it.done && 'border-crit',
                          sel && 'ring-2 ring-brass/40',
                        )}
                        style={{
                          left: g.left,
                          width: g.w,
                          backgroundImage: it.external && !it.done ? HATCH : undefined,
                        }}
                      >
                        {it.inProgress && (
                          <span
                            className={cx(
                              'absolute inset-y-0 left-0 w-1/2',
                              it.critical ? 'bg-brass' : 'bg-lacquer-600',
                            )}
                          />
                        )}
                      </span>
                    ))}
                  {g && it.milestone && ppd >= 4 && (
                    <span
                      className={cx(
                        'pointer-events-none absolute top-[6px] text-[11.5px] whitespace-nowrap',
                        it.done ? 'text-ink-4' : 'text-ink-2',
                      )}
                      style={{ left: g.left + ppd / 2 + 10 }}
                    >
                      {it.name}
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

const HATCH = 'repeating-linear-gradient(135deg, transparent 0 3px, rgb(255 255 255 / 0.75) 3px 6px)';

function Rule({ x, label, tone }: { x: number; label: string; tone: 'today' | 'target' }) {
  return (
    <span
      className={cx(
        'absolute bottom-1 -translate-x-1/2 rounded-xs px-1 text-[10.5px] font-[620] whitespace-nowrap',
        tone === 'today' ? 'bg-crit text-white' : 'bg-lacquer text-white',
      )}
      style={{ left: x }}
    >
      {label}
    </span>
  );
}

/** Legend for the schedule chart. */
const Sw = ({ cls, style, label }: { cls: string; style?: CSSProperties; label: string }) => (
  <span className="inline-flex items-center gap-1.5">
    <span className={cx('h-2.5 w-5 rounded-[2px] border', cls)} style={style} />
    {label}
  </span>
);

export function GanttLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12px] text-ink-2">
      <Sw cls="border-lacquer-600 bg-lacquer-100" label="Our team" />
      <Sw
        cls="border-lacquer-600 bg-lacquer-100"
        style={{ backgroundImage: HATCH }}
        label="Owner or vendor"
      />
      <Sw cls="border-brass bg-brass-100" label="Critical path" />
      <Sw cls="border-line bg-stone-2" label="Done" />
      <span className="inline-flex items-center gap-1.5">
        <span className="size-2.5 rotate-45 bg-lacquer" />
        Milestone
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="h-3 w-px bg-crit" />
        Today
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="h-3 w-0 border-l border-dashed border-lacquer" />
        Target open
      </span>
    </div>
  );
}
