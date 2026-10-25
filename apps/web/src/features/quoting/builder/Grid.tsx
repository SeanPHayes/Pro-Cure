import { BedDouble, Check, MoreHorizontal, Undo2 } from 'lucide-react';
import { memo, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Badge, Checkbox, cx } from '@/components/ui';
import { Popover } from '@/components/ui/Popover';
import { Tooltip } from '@/components/ui/Tooltip';
import { money } from '@/lib/format';
import { ExpiryBadge, FlagChips, MarginCell, parseNum } from '../shared';
import type { Line, Location, QuoteDetail } from '../types';
import type { LinePatch } from './data';
import { QtyEditor } from './QtyEditor';

export interface GridProps {
  quote: QuoteDetail;
  lines: Line[];
  locations: Location[];
  /** Group rows under location headers (when not filtered to a single leaf). */
  grouped: boolean;
  costs: boolean;
  canEdit: boolean;
  canReady: boolean;
  selected: Set<string>;
  onSelect: (s: Set<string>) => void;
  onPatch: (line: Line, patch: LinePatch) => void;
  onRowMenu: (line: Line, anchor: HTMLElement) => void;
  empty: ReactNode;
}

type ColKey =
  | 'code'
  | 'name'
  | 'vendor'
  | 'qty'
  | 'unit'
  | 'unitCost'
  | 'markup'
  | 'unitPrice'
  | 'extCost'
  | 'extSell'
  | 'margin'
  | 'flags'
  | 'ready';

interface Col {
  key: ColKey;
  header: string;
  width: number;
  align?: 'right' | 'center';
  /** Inline text editor value; undefined → not inline-editable. */
  edit?: (l: Line) => string;
  commit?: (l: Line, v: string) => LinePatch | null | { error: string };
}

const fmtNum = (n: number | null | undefined, dp = 2) =>
  n === null || n === undefined ? '' : String(Math.round(n * 10 ** dp) / 10 ** dp);

/** Frozen columns (left offsets) so code + item stay visible while scrolling to the money. */
const STICKY: Partial<Record<ColKey, number>> = { code: 36, name: 122 };

/** Is a line editable at all (quote stage, ordered, permissions)? */
export const lineEditable = (l: Line, canEdit: boolean) => canEdit && !l.poId;

export function Grid(props: GridProps) {
  const { quote, lines, locations, grouped, costs, canEdit, canReady, selected, onSelect, onPatch } = props;
  const cols = useMemo<Col[]>(() => {
    const c: Col[] = [
      { key: 'code', header: 'Code', width: 86 },
      {
        key: 'name',
        header: 'Item',
        width: 250,
        edit: (l) => l.name,
        commit: (l, v) =>
          v.trim() && v.trim() !== l.name
            ? { name: v.trim() }
            : v.trim()
              ? null
              : { error: 'Name is required' },
      },
      { key: 'vendor', header: 'Vendor', width: 128 },
      {
        key: 'qty',
        header: 'Qty',
        width: 84,
        align: 'right',
        edit: (l) => (l.qtyMode === 'fixed' && !l.handing ? fmtNum(l.qtyFixed, 4) : ''),
        commit: (l, v) => {
          const n = parseNum(v);
          if (n === null || Number.isNaN(n) || n < 0) return { error: 'Enter a quantity of 0 or more' };
          return n === l.qtyFixed && l.qtyMode === 'fixed' ? null : { qtyMode: 'fixed', qtyFixed: n };
        },
      },
      {
        key: 'unit',
        header: 'Unit',
        width: 48,
        edit: (l) => l.unit,
        commit: (l, v) => (v.trim() && v.trim() !== l.unit ? { unit: v.trim().slice(0, 16) } : null),
      },
    ];
    if (costs)
      c.push(
        {
          key: 'unitCost',
          header: 'Unit cost',
          width: 104,
          align: 'right',
          edit: (l) => fmtNum(l.unitCost, 4),
          commit: (l, v) => {
            const n = parseNum(v);
            if (n !== null && (Number.isNaN(n) || n < 0)) return { error: 'Enter a cost, or leave blank' };
            return n === l.unitCost ? null : { unitCost: n };
          },
        },
        {
          key: 'markup',
          header: 'Markup',
          width: 66,
          align: 'right',
          edit: (l) => fmtNum(l.markupPct, 3),
          commit: (l, v) => {
            const n = parseNum(v);
            if (n === null || Number.isNaN(n) || n < -100 || n > 1000) return { error: 'Enter a markup %' };
            return n === l.markupPct && !l.priceOverride ? null : { markupPct: n };
          },
        },
      );
    c.push({
      key: 'unitPrice',
      header: 'Unit price',
      width: 104,
      align: 'right',
      edit: costs ? (l) => fmtNum(l.unitPrice, 4) : undefined,
      commit: (l, v) => {
        const n = parseNum(v);
        if (n !== null && (Number.isNaN(n) || n < 0))
          return { error: 'Enter a price, or leave blank to use markup' };
        if (n === null) return l.priceOverride ? { unitPrice: null } : null;
        return n === l.unitPrice ? null : { unitPrice: n };
      },
    });
    if (costs) c.push({ key: 'extCost', header: 'Ext. cost', width: 104, align: 'right' });
    c.push({ key: 'extSell', header: 'Ext. sell', width: 108, align: 'right' });
    if (costs) c.push({ key: 'margin', header: 'Margin', width: 64, align: 'right' });
    c.push({ key: 'flags', header: 'Flags', width: 84 });
    c.push({ key: 'ready', header: 'Ready', width: 52, align: 'center' });
    return c;
  }, [costs]);

  // ---------------------------------------------------------------- rows (+ group headers)
  const rows = useMemo(() => {
    type R =
      | { type: 'group'; loc: Location | null; count: number; sell: number }
      | { type: 'line'; line: Line };
    if (!grouped) return lines.map((line) => ({ type: 'line', line }) as R);
    const out: R[] = [];
    const byLoc = new Map<string | null, Line[]>();
    for (const l of lines) {
      const k = l.locationId && locations.some((x) => x.id === l.locationId) ? l.locationId : null;
      if (!byLoc.has(k)) byLoc.set(k, []);
      byLoc.get(k)!.push(l);
    }
    const order: (Location | null)[] = [...locations, null];
    for (const loc of order) {
      const ls = byLoc.get(loc?.id ?? null);
      if (!ls?.length) continue;
      const sell = ls.reduce((a, l) => a + (l.isSelected ? (l.extendedPrice ?? 0) : 0), 0);
      out.push({ type: 'group', loc, count: ls.length, sell });
      for (const line of ls) out.push({ type: 'line', line });
    }
    return out;
  }, [lines, locations, grouped]);
  const lineOrder = useMemo(
    () => (lines.length ? rows.flatMap((r) => (r.type === 'line' ? [r.line] : [])) : []),
    [rows, lines.length],
  );
  const indexOf = useMemo(() => new Map(lineOrder.map((l, i) => [l.id, i])), [lineOrder]);

  // ---------------------------------------------------------------- active cell & editing
  const editableKeys = useMemo(
    () => cols.filter((c) => c.edit || c.key === 'qty' || c.key === 'ready').map((c) => c.key),
    [cols],
  );
  const [active, setActive] = useState<{ row: number; col: ColKey } | null>(null);
  const [editing, setEditing] = useState<{ seed?: string } | null>(null);
  const [qtyFor, setQtyFor] = useState<{ line: Line; anchor: HTMLElement } | null>(null);
  const wrap = useRef<HTMLDivElement>(null);

  // Keep active row in range when lines change (filtering).
  useEffect(() => {
    if (active && active.row >= lineOrder.length)
      setActive(lineOrder.length ? { ...active, row: lineOrder.length - 1 } : null);
  }, [lineOrder.length, active]);

  const cellEl = (row: number, col: ColKey) =>
    wrap.current?.querySelector<HTMLElement>(`[data-cell="${row}:${col}"]`) ?? null;

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll only when the active cell moves
  useEffect(() => {
    if (!active || editing) return;
    const el = cellEl(active.row, active.col);
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active, editing]);

  const focusGrid = () => wrap.current?.focus({ preventScroll: true });
  // Group header rows stay pinned to the visible width while the table scrolls sideways.
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => el.style.setProperty('--grid-w', `${el.clientWidth}px`));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const canEditCell = useCallback(
    (l: Line, key: ColKey) => {
      if (key === 'ready') return canReady && !l.poId && l.isSelected;
      if (!lineEditable(l, canEdit)) return false;
      if (key === 'unitPrice' && !costs) return false;
      return true;
    },
    [canEdit, canReady, costs],
  );

  const openQty = (row: number) => {
    const l = lineOrder[row];
    const el = cellEl(row, 'qty');
    if (l && el) setQtyFor({ line: l, anchor: el });
  };

  const startEdit = (row: number, col: ColKey, seed?: string) => {
    const l = lineOrder[row];
    if (!l) return;
    if (col === 'ready') {
      if (canEditCell(l, 'ready')) onPatch(l, { readyToOrder: !l.readyToOrder });
      return;
    }
    if (col === 'qty' && (l.qtyMode === 'per_room' || l.handing || !lineEditable(l, canEdit))) {
      openQty(row);
      return;
    }
    if (!canEditCell(l, col)) {
      if (lineEditable(l, canEdit) === false && canEdit && l.poId)
        toast.message(`${l.code} is on ${l.poNumber ?? 'a PO'} and can’t be changed`);
      return;
    }
    if (!cols.find((c) => c.key === col)?.edit) return;
    setEditing({ seed });
  };

  const move = (dRow: number, dCol: number) => {
    setActive((a) => {
      if (!lineOrder.length) return null;
      if (!a) return { row: 0, col: editableKeys[0]! };
      let ci = editableKeys.indexOf(a.col);
      let row = a.row;
      if (ci < 0) ci = 0;
      ci += dCol;
      if (ci >= editableKeys.length) {
        ci = 0;
        row++;
      } else if (ci < 0) {
        ci = editableKeys.length - 1;
        row--;
      }
      row = Math.max(0, Math.min(lineOrder.length - 1, row + dRow));
      return { row, col: editableKeys[ci]! };
    });
  };

  const commit = (l: Line, col: Col, value: string): boolean => {
    const r = col.commit?.(l, value);
    if (r && 'error' in r) {
      toast.error(r.error as string);
      return false;
    }
    if (r) onPatch(l, r as LinePatch);
    return true;
  };

  const onGridKey = (e: React.KeyboardEvent) => {
    if (editing || qtyFor) return;
    if (!active) {
      if (['ArrowDown', 'ArrowUp', 'Enter', 'Tab'].includes(e.key) && lineOrder.length) {
        e.preventDefault();
        setActive({ row: 0, col: editableKeys[0]! });
      }
      return;
    }
    const l = lineOrder[active.row];
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        move(1, 0);
        break;
      case 'ArrowUp':
        e.preventDefault();
        move(-1, 0);
        break;
      case 'ArrowRight':
        e.preventDefault();
        move(0, 1);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        move(0, -1);
        break;
      case 'Tab':
        e.preventDefault();
        move(0, e.shiftKey ? -1 : 1);
        break;
      case 'Enter':
      case 'F2':
        e.preventDefault();
        startEdit(active.row, active.col);
        break;
      case ' ':
        e.preventDefault();
        if (active.col === 'ready') startEdit(active.row, 'ready');
        else if (l) {
          const next = new Set(selected);
          if (next.has(l.id)) next.delete(l.id);
          else next.add(l.id);
          onSelect(next);
        }
        break;
      case 'Escape':
        setActive(null);
        break;
      case 'Backspace':
      case 'Delete':
        if (l && (active.col === 'unitPrice' || active.col === 'unitCost') && canEditCell(l, active.col)) {
          e.preventDefault();
          const col = cols.find((c) => c.key === active.col)!;
          commit(l, col, '');
        }
        break;
      default:
        if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey && l) {
          const col = cols.find((c) => c.key === active.col);
          if (
            col?.edit &&
            canEditCell(l, active.col) &&
            !(active.col === 'qty' && (l.qtyMode === 'per_room' || l.handing))
          ) {
            e.preventDefault();
            setEditing({ seed: e.key });
          } else if (active.col === 'qty') {
            e.preventDefault();
            openQty(active.row);
          }
        }
    }
  };

  const allIds = lineOrder.map((l) => l.id);
  const allSel = allIds.length > 0 && allIds.every((id) => selected.has(id));
  const someSel = allIds.some((id) => selected.has(id));
  const totalWidth = 36 + cols.reduce((a, c) => a + c.width, 0) + 40;

  return (
    // biome-ignore lint/a11y/useSemanticElements: a focusable wrapper drives keyboard navigation for the table inside
    <div
      ref={wrap}
      role="grid"
      tabIndex={0}
      onKeyDown={onGridKey}
      aria-label="Quote lines — arrow keys move, Enter edits"
      className="relative min-h-0 flex-1 overflow-auto outline-none focus-visible:ring-0"
    >
      <table
        aria-rowcount={lineOrder.length}
        className="grid-table q-grid"
        style={{ minWidth: totalWidth, tableLayout: 'fixed' }}
      >
        <colgroup>
          <col style={{ width: 36 }} />
          {cols.map((c) => (
            <col key={c.key} style={{ width: c.key === 'name' ? undefined : c.width, minWidth: c.width }} />
          ))}
          <col style={{ width: 40 }} />
        </colgroup>
        <thead>
          <tr>
            <th className="q-stick" style={{ left: 0 }}>
              <Checkbox
                label="Select all lines"
                checked={allSel}
                indeterminate={someSel && !allSel}
                onChange={(v) => onSelect(new Set(v ? allIds : []))}
              />
            </th>
            {cols.map((c) => (
              <th
                key={c.key}
                className={cx(
                  c.align === 'right' && 'right',
                  c.align === 'center' && 'text-center',
                  STICKY[c.key] !== undefined && 'q-stick',
                  c.key === 'name' && 'q-stick-edge',
                )}
                style={STICKY[c.key] !== undefined ? { left: STICKY[c.key] } : undefined}
              >
                {c.header}
              </th>
            ))}
            <th aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {!lineOrder.length ? (
            <tr>
              <td colSpan={cols.length + 2} className="!border-0">
                {props.empty}
              </td>
            </tr>
          ) : (
            rows.map((r) =>
              r.type === 'group' ? (
                <tr key={`g:${r.loc?.id ?? 'none'}`} className="q-group">
                  <td colSpan={cols.length + 2} className="!bg-stone !py-1.5">
                    <div
                      className="sticky left-3 flex items-center justify-between gap-3"
                      style={{
                        paddingLeft: (r.loc?.depth ?? 0) * 14,
                        width: 'min(100%, calc(var(--grid-w, 900px) - 24px))',
                      }}
                    >
                      <span className="truncate font-[620]">
                        {r.loc ? r.loc.path : 'Unassigned'}
                        <span className="num ml-2 text-[12px] font-[480] text-ink-3">
                          {r.count} {r.count === 1 ? 'line' : 'lines'}
                        </span>
                      </span>
                      <span className="num text-[13px] font-[600]">{money(r.sell)}</span>
                    </div>
                  </td>
                </tr>
              ) : (
                <Row
                  key={r.line.id}
                  line={r.line}
                  index={indexOf.get(r.line.id)!}
                  cols={cols}
                  quote={quote}
                  costs={costs}
                  selected={selected.has(r.line.id)}
                  activeCol={active?.row === indexOf.get(r.line.id) ? (active?.col ?? null) : null}
                  editing={active?.row === indexOf.get(r.line.id) && editing ? editing : null}
                  canEditCell={canEditCell}
                  onToggle={(v) => {
                    const next = new Set(selected);
                    if (v) next.add(r.line.id);
                    else next.delete(r.line.id);
                    onSelect(next);
                  }}
                  onCellClick={(col, dbl) => {
                    const row = indexOf.get(r.line.id)!;
                    const wasActive = active?.row === row && active.col === col && !editing;
                    setActive({ row, col });
                    focusGrid();
                    if (col === 'ready' || col === 'qty' || dbl || wasActive) startEdit(row, col);
                  }}
                  onCommit={(col, value, nav) => {
                    const ok = commit(r.line, col, value);
                    if (!ok) return;
                    setEditing(null);
                    focusGrid();
                    if (nav === 'down') move(1, 0);
                    else if (nav === 'right') move(0, 1);
                    else if (nav === 'left') move(0, -1);
                  }}
                  onCancel={() => {
                    setEditing(null);
                    focusGrid();
                  }}
                  onMenu={(el) => props.onRowMenu(r.line, el)}
                  onRevertPrice={() => onPatch(r.line, { unitPrice: null })}
                />
              ),
            )
          )}
        </tbody>
      </table>
      <Popover
        anchor={qtyFor?.anchor ?? null}
        open={!!qtyFor}
        onClose={() => {
          setQtyFor(null);
          focusGrid();
        }}
        label="Quantity breakdown"
        width={360}
      >
        {qtyFor && (
          <QtyEditor
            line={lineOrder.find((l) => l.id === qtyFor.line.id) ?? qtyFor.line}
            quote={quote}
            readOnly={!lineEditable(qtyFor.line, canEdit)}
            onCancel={() => {
              setQtyFor(null);
              focusGrid();
            }}
            onSave={(p) => {
              onPatch(qtyFor.line, p);
              setQtyFor(null);
              focusGrid();
            }}
          />
        )}
      </Popover>
      <style>{`
        .q-grid td { padding-top: 5px; padding-bottom: 5px; height: 44px; }
        .q-grid th { z-index: 2; }
        .q-grid .q-stick { position: sticky; background: var(--color-paper); z-index: 1; }
        .q-grid th.q-stick { background: var(--color-stone); z-index: 3; }
        .q-grid .q-stick-edge { box-shadow: inset -1px 0 0 var(--color-line); }
        .q-grid td.q-stick-edge[data-active="true"] { box-shadow: inset 0 0 0 2px var(--color-brass); }
        .q-grid td[data-active="true"] { box-shadow: inset 0 0 0 2px var(--color-brass); background: var(--color-paper) !important; }
        .q-grid tr.q-alt td { color: var(--color-ink-3); }
        .q-grid td.q-edit:hover { background: var(--color-brass-50); cursor: cell; }
      `}</style>
    </div>
  );
}

// ---------------------------------------------------------------- row
interface RowProps {
  line: Line;
  index: number;
  cols: Col[];
  quote: QuoteDetail;
  costs: boolean;
  selected: boolean;
  activeCol: ColKey | null;
  editing: { seed?: string } | null;
  canEditCell: (l: Line, k: ColKey) => boolean;
  onToggle: (v: boolean) => void;
  onCellClick: (col: ColKey, dbl: boolean) => void;
  onCommit: (col: Col, value: string, nav: 'down' | 'right' | 'left' | null) => void;
  onCancel: () => void;
  onMenu: (el: HTMLElement) => void;
  onRevertPrice: () => void;
}

const Row = memo(function Row(p: RowProps) {
  const l = p.line;
  const rooms = p.quote.roomTypes;
  const render = (k: ColKey): ReactNode => {
    switch (k) {
      case 'code':
        return (
          <div className="min-w-0">
            <div className="num truncate text-[13px] font-[560]">{l.code}</div>
            {!l.isSelected && (
              <Tooltip content="Competing option in the price matrix. Not counted in totals until selected.">
                <Badge tone="neutral" className="!h-[18px] !px-1 !text-[11px]">
                  Alternate
                </Badge>
              </Tooltip>
            )}
            {l.poNumber && (
              <Badge tone="ok" className="!h-[18px] !px-1 !text-[11px]">
                {l.poNumber}
              </Badge>
            )}
          </div>
        );
      case 'name':
        return (
          <div className="min-w-0">
            <div className="truncate font-[560]" title={l.name}>
              {l.name}
            </div>
            <div
              className="truncate text-[12px] text-ink-3"
              title={[l.finish, l.dimensions].filter(Boolean).join(' · ')}
            >
              {[l.finish, l.dimensions].filter(Boolean).join(' · ') || ' '}
            </div>
          </div>
        );
      case 'vendor':
        return (
          <div className="truncate text-ink-2">
            {l.vendorName ?? <span className="text-ink-4">No vendor</span>}
          </div>
        );
      case 'qty': {
        const perRoom = l.qtyMode === 'per_room';
        const summary = perRoom
          ? rooms
              .filter((r) => l.qtyPerRoom?.[r.id])
              .map((r) => `${l.qtyPerRoom[r.id]}×${r.code}`)
              .join(' ')
          : '';
        return (
          <div className="min-w-0 text-right">
            <div className="num inline-flex items-center gap-1 font-[560]">
              {perRoom && <BedDouble className="size-3.5 text-ink-4" aria-label="Per room type" />}
              {l.quantity.toLocaleString()}
            </div>
            <div className="num truncate text-[11px] text-ink-3">
              {l.handing ? `L${l.handing.left} R${l.handing.right}` : summary}
              {l.atticStockPct ? ` +${l.atticStockPct}%` : ''}
            </div>
          </div>
        );
      }
      case 'unit':
        return <span className="text-ink-2">{l.unit}</span>;
      case 'unitCost':
        return (
          <div className="text-right">
            <div className={cx('num', l.unitCost === null && 'text-ink-4')}>
              {l.unitCost === null ? 'No cost' : money(l.unitCost)}
            </div>
            <ExpiryBadge expiresAt={l.unitCost === null ? null : l.costExpiresAt} compact />
          </div>
        );
      case 'markup':
        return (
          <span className={cx('num', l.priceOverride && 'text-ink-4 line-through decoration-ink-4')}>
            {l.markupPct === null ? '—' : `${fmtNum(l.markupPct, 2)}%`}
          </span>
        );
      case 'unitPrice':
        return (
          <div className="flex items-center justify-end gap-1">
            {l.priceOverride && (
              <Tooltip content="Price set by hand (overrides markup). Press Delete on the cell or click to go back to markup.">
                <button
                  type="button"
                  aria-label="Use markup price"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (p.canEditCell(l, 'unitPrice')) p.onRevertPrice();
                  }}
                  className="grid size-4 place-items-center rounded-xs bg-brass-100 text-brass"
                >
                  <Undo2 className="size-3" />
                </button>
              </Tooltip>
            )}
            <span className={cx('num', l.priceOverride && 'font-[600] text-brass')}>
              {money(l.unitPrice)}
            </span>
          </div>
        );
      case 'extCost':
        return <span className="num text-ink-2">{money(l.extendedCost)}</span>;
      case 'extSell':
        return <span className="num font-[600]">{money(l.extendedPrice)}</span>;
      case 'margin':
        return <MarginCell value={l.marginPct} floor={p.quote.minMarginPct} />;
      case 'flags':
        return <FlagChips flags={l.flags} hideCostFlags={!p.costs} />;
      case 'ready':
        return l.readyToOrder ? (
          <span
            className="inline-grid size-5 place-items-center rounded-xs bg-ok text-white"
            role="img"
            aria-label="Ready to order"
          >
            <Check className="size-3.5" />
          </span>
        ) : p.canEditCell(l, 'ready') ? (
          <span
            className="inline-block size-4 rounded-xs border border-ink-4"
            role="img"
            aria-label="Not ready"
          />
        ) : (
          <span className="text-ink-4">—</span>
        );
    }
  };

  return (
    <tr data-selected={p.selected || undefined} className={cx(!l.isSelected && 'q-alt')}>
      <td className="q-stick" style={{ left: 0 }}>
        <Checkbox label={`Select ${l.code}`} checked={p.selected} onChange={p.onToggle} />
      </td>
      {p.cols.map((c) => {
        const isActive = p.activeCol === c.key;
        const editable = (!!c.edit || c.key === 'qty' || c.key === 'ready') && p.canEditCell(l, c.key);
        return (
          <td
            key={c.key}
            data-cell={`${p.index}:${c.key}`}
            data-active={isActive || undefined}
            className={cx(
              c.align === 'right' && 'right',
              c.align === 'center' && 'text-center',
              editable && 'q-edit',
              'overflow-hidden',
              STICKY[c.key] !== undefined && 'q-stick',
              c.key === 'name' && 'q-stick-edge',
            )}
            style={STICKY[c.key] !== undefined ? { left: STICKY[c.key] } : undefined}
            onMouseDown={(e) => {
              if ((e.target as HTMLElement).closest('input,button')) return;
              // Commit an open editor elsewhere first (preventDefault below would stop its blur).
              const ae = document.activeElement as HTMLElement | null;
              if (ae?.tagName === 'INPUT' && ae.closest('.q-grid')) ae.blur();
              e.preventDefault();
              p.onCellClick(c.key, e.detail > 1);
            }}
          >
            {isActive && p.editing && c.edit ? (
              <CellInput
                initial={p.editing.seed ?? c.edit(l)}
                selectAll={p.editing.seed === undefined}
                align={c.align}
                onCommit={(v, nav) => p.onCommit(c, v, nav)}
                onCancel={p.onCancel}
              />
            ) : (
              render(c.key)
            )}
          </td>
        );
      })}
      <td className="!px-1">
        <button
          type="button"
          aria-label={`Actions for ${l.code}`}
          className="grid size-7 place-items-center rounded-sm text-ink-3 hover:bg-stone-2 hover:text-ink"
          onClick={(e) => p.onMenu(e.currentTarget)}
        >
          <MoreHorizontal className="size-4" />
        </button>
      </td>
    </tr>
  );
});

function CellInput({
  initial,
  selectAll,
  align,
  onCommit,
  onCancel,
}: {
  initial: string;
  selectAll: boolean;
  align?: 'right' | 'center';
  onCommit: (v: string, nav: 'down' | 'right' | 'left' | null) => void;
  onCancel: () => void;
}) {
  const [v, setV] = useState(initial);
  const done = useRef(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    if (selectAll) el.select();
    else el.setSelectionRange(el.value.length, el.value.length);
  }, [selectAll]);
  const finish = (nav: 'down' | 'right' | 'left' | null) => {
    if (done.current) return;
    done.current = true;
    onCommit(v, nav);
    // If the commit was rejected the editor stays mounted; allow another try.
    setTimeout(() => {
      done.current = false;
    }, 0);
  };
  return (
    <input
      ref={ref}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          finish('down');
        } else if (e.key === 'Tab') {
          e.preventDefault();
          finish(e.shiftKey ? 'left' : 'right');
        } else if (e.key === 'Escape') {
          e.preventDefault();
          done.current = true;
          onCancel();
        }
      }}
      onBlur={() => finish(null)}
      className={cx(
        'num h-8 w-full rounded-xs border border-lacquer bg-paper px-1.5 outline-none ring-2 ring-lacquer/15',
        align === 'right' && 'text-right',
      )}
    />
  );
}
