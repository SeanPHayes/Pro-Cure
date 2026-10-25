import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { Checkbox, cx, EmptyState, Spinner } from './index';

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  align?: 'left' | 'right' | 'center';
  width?: number | string;
  /** Server sort key; clicking the header toggles `key` / `-key`. */
  sort?: string;
  className?: string;
}

export function DataTable<T extends { id: string }>({
  columns,
  rows,
  loading,
  empty,
  onRowClick,
  selected,
  onSelect,
  sort,
  onSort,
  footer,
  dense,
  rowClassName,
  stickyOffset = 0,
}: {
  columns: Column<T>[];
  rows: T[] | undefined;
  loading?: boolean;
  empty?: ReactNode;
  onRowClick?: (row: T) => void;
  selected?: Set<string>;
  onSelect?: (ids: Set<string>) => void;
  sort?: string;
  onSort?: (sort: string) => void;
  footer?: ReactNode;
  dense?: boolean;
  rowClassName?: (row: T) => string | undefined;
  stickyOffset?: number;
}) {
  const allIds = rows?.map((r) => r.id) ?? [];
  const allSelected = !!selected && allIds.length > 0 && allIds.every((id) => selected.has(id));
  const someSelected = !!selected && allIds.some((id) => selected.has(id));
  const sortKey = sort?.replace(/^-/, '');
  const desc = sort?.startsWith('-');

  return (
    <div className="overflow-x-auto">
      <table className={cx('grid-table', dense && '[&_td]:py-1.5')}>
        <thead>
          <tr>
            {onSelect && (
              <th style={{ width: 36, top: stickyOffset }}>
                <Checkbox
                  label="Select all"
                  checked={allSelected}
                  indeterminate={someSelected && !allSelected}
                  onChange={(v) => onSelect(new Set(v ? allIds : []))}
                />
              </th>
            )}
            {columns.map((c) => (
              <th
                key={c.key}
                style={{ width: c.width, top: stickyOffset }}
                className={cx(c.align === 'right' && 'right', c.align === 'center' && 'text-center')}
                aria-sort={sortKey === c.sort ? (desc ? 'descending' : 'ascending') : undefined}
              >
                {c.sort && onSort ? (
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 hover:text-ink"
                    onClick={() => onSort(sortKey === c.sort && !desc ? `-${c.sort}` : c.sort!)}
                  >
                    {c.header}
                    {sortKey === c.sort &&
                      (desc ? <ArrowDown className="size-3.5" /> : <ArrowUp className="size-3.5" />)}
                  </button>
                ) : (
                  c.header
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading && !rows?.length ? (
            <tr>
              <td colSpan={columns.length + (onSelect ? 1 : 0)}>
                <div className="flex justify-center py-12">
                  <Spinner />
                </div>
              </td>
            </tr>
          ) : !rows?.length ? (
            <tr>
              <td colSpan={columns.length + (onSelect ? 1 : 0)} className="!border-0">
                {empty ?? <EmptyState title="Nothing here yet" />}
              </td>
            </tr>
          ) : (
            rows.map((r) => (
              <tr
                key={r.id}
                data-selected={selected?.has(r.id) || undefined}
                onClick={onRowClick ? () => onRowClick(r) : undefined}
                className={cx(onRowClick && 'cursor-pointer', rowClassName?.(r))}
              >
                {onSelect && selected && (
                  <td>
                    <Checkbox
                      label="Select row"
                      checked={selected.has(r.id)}
                      onChange={(v) => {
                        const next = new Set(selected);
                        if (v) next.add(r.id);
                        else next.delete(r.id);
                        onSelect(next);
                      }}
                    />
                  </td>
                )}
                {columns.map((c) => (
                  <td
                    key={c.key}
                    className={cx(
                      c.align === 'right' && 'right num',
                      c.align === 'center' && 'text-center',
                      c.className,
                    )}
                  >
                    {c.cell(r)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
      {footer}
    </div>
  );
}

export function Pagination({
  total,
  limit,
  offset,
  onChange,
}: {
  total: number;
  limit: number;
  offset: number;
  onChange: (offset: number) => void;
}) {
  if (total <= limit) return null;
  const from = offset + 1;
  const to = Math.min(offset + limit, total);
  return (
    <div className="flex items-center justify-between border-t border-line-2 px-3 py-2 text-[13px] text-ink-2">
      <span className="num">
        {from}–{to} of {total}
      </span>
      <div className="flex gap-1">
        <button
          type="button"
          className="grid size-7 place-items-center rounded-xs hover:bg-stone disabled:opacity-30"
          disabled={offset === 0}
          onClick={() => onChange(Math.max(0, offset - limit))}
          aria-label="Previous page"
        >
          <ChevronLeft className="size-4" />
        </button>
        <button
          type="button"
          className="grid size-7 place-items-center rounded-xs hover:bg-stone disabled:opacity-30"
          disabled={to >= total}
          onClick={() => onChange(offset + limit)}
          aria-label="Next page"
        >
          <ChevronRight className="size-4" />
        </button>
      </div>
    </div>
  );
}
