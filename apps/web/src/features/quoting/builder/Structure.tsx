import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, FolderTree, MoreHorizontal, Plus, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button, cx, Dialog, Field, Input, Menu, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { money, moneyShort } from '@/lib/format';
import { plural, qk } from '../shared';
import type { Line, Location, QuoteDetail, RoomType } from '../types';
import { descendants } from './calc';
import { useRefreshDerived } from './data';

// ================================================================ location tree
export function LocationTree({
  quote,
  lines,
  value,
  onChange,
  canEdit,
}: {
  quote: QuoteDetail;
  lines: Line[];
  value: string | null;
  onChange: (id: string | null) => void;
  canEdit: boolean;
}) {
  const qc = useQueryClient();
  const refresh = useRefreshDerived(quote.id);
  const locs = quote.locations;
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<
    | { kind: 'add'; parentId: string | null }
    | { kind: 'rename'; loc: Location }
    | { kind: 'move'; loc: Location }
    | { kind: 'delete'; loc: Location }
    | { kind: 'template' }
    | null
  >(null);

  const totals = useMemo(() => {
    const own = new Map<string | null, number>();
    const counts = new Map<string | null, number>();
    for (const l of lines) {
      const k = l.locationId && locs.some((x) => x.id === l.locationId) ? l.locationId : null;
      counts.set(k, (counts.get(k) ?? 0) + 1);
      if (l.isSelected) own.set(k, (own.get(k) ?? 0) + (l.extendedPrice ?? 0));
    }
    const sub = new Map<string, { sell: number; count: number }>();
    for (const loc of locs) {
      let sell = 0;
      let count = 0;
      for (const d of descendants(loc.id, locs)) {
        sell += own.get(d) ?? 0;
        count += counts.get(d) ?? 0;
      }
      sub.set(loc.id, { sell, count });
    }
    return { sub, unassigned: { sell: own.get(null) ?? 0, count: counts.get(null) ?? 0 } };
  }, [lines, locs]);

  const hasChildren = (id: string) => locs.some((l) => l.parentId === id);
  const hidden = (l: Location) => {
    let p = l.parentId;
    while (p) {
      if (collapsed.has(p)) return true;
      p = locs.find((x) => x.id === p)?.parentId ?? null;
    }
    return false;
  };
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: qk.quote(quote.id), exact: true });
    qc.invalidateQueries({ queryKey: qk.lines(quote.id) });
    refresh(true);
  };
  const total = lines.reduce((a, l) => a + (l.isSelected ? (l.extendedPrice ?? 0) : 0), 0);

  const item = (
    id: string | null,
    label: string,
    sell: number,
    count: number,
    depth: number,
    loc?: Location,
  ) => (
    <div
      key={id ?? 'all'}
      className={cx(
        'group flex h-8 items-center gap-1 rounded-sm pr-1 text-[13px]',
        value === id ? 'bg-brass-50 text-ink' : 'text-ink-2 hover:bg-stone',
      )}
      style={{ paddingLeft: 4 + depth * 14 }}
    >
      {loc && hasChildren(loc.id) ? (
        <button
          type="button"
          aria-label={collapsed.has(loc.id) ? `Expand ${loc.name}` : `Collapse ${loc.name}`}
          className="grid size-5 shrink-0 place-items-center rounded-xs text-ink-3 hover:bg-stone-2"
          onClick={() =>
            setCollapsed((c) => {
              const n = new Set(c);
              if (n.has(loc.id)) n.delete(loc.id);
              else n.add(loc.id);
              return n;
            })
          }
        >
          {collapsed.has(loc.id) ? (
            <ChevronRight className="size-3.5" />
          ) : (
            <ChevronDown className="size-3.5" />
          )}
        </button>
      ) : (
        <span className="size-5 shrink-0" />
      )}
      <button
        type="button"
        onClick={() => onChange(id)}
        aria-current={value === id || undefined}
        className={cx(
          'flex min-w-0 flex-1 items-center justify-between gap-2 text-left',
          value === id && 'font-[600]',
        )}
      >
        <span className="truncate">{label}</span>
        <span className="num shrink-0 text-[12px] text-ink-3" title={`${count} lines · ${money(sell)}`}>
          {moneyShort(sell)}
        </span>
      </button>
      {loc && canEdit && (
        <Menu
          trigger={(open) => (
            <button
              type="button"
              aria-label={`Actions for ${loc.name}`}
              onClick={open}
              className="grid size-6 place-items-center rounded-xs text-ink-3 opacity-0 group-hover:opacity-100 hover:bg-stone-2 focus:opacity-100"
            >
              <MoreHorizontal className="size-3.5" />
            </button>
          )}
          items={[
            { label: 'Add sub-location', onSelect: () => setDialog({ kind: 'add', parentId: loc.id }) },
            { label: 'Rename', onSelect: () => setDialog({ kind: 'rename', loc }) },
            { label: 'Move', onSelect: () => setDialog({ kind: 'move', loc }) },
            'divider',
            { label: 'Delete location', danger: true, onSelect: () => setDialog({ kind: 'delete', loc }) },
          ]}
        />
      )}
    </div>
  );

  return (
    <nav aria-label="Locations" className="flex flex-col">
      <div className="flex items-center justify-between px-1 pb-1.5">
        <span className="text-[12px] font-[560] text-ink-3">Locations</span>
        {canEdit && (
          <Menu
            trigger={(open) => (
              <button
                type="button"
                onClick={open}
                aria-label="Add location"
                className="grid size-6 place-items-center rounded-xs text-ink-2 hover:bg-stone-2"
              >
                <Plus className="size-4" />
              </button>
            )}
            items={[
              { label: 'Add location', onSelect: () => setDialog({ kind: 'add', parentId: null }) },
              { label: 'Apply location template', onSelect: () => setDialog({ kind: 'template' }) },
            ]}
          />
        )}
      </div>
      {item(null, 'All locations', total, lines.length, 0)}
      {locs
        .filter((l) => !hidden(l))
        .map((l) => {
          const t = totals.sub.get(l.id) ?? { sell: 0, count: 0 };
          return item(l.id, l.name, t.sell, t.count, l.depth, l);
        })}
      {totals.unassigned.count > 0 &&
        item('__unassigned__', 'Unassigned', totals.unassigned.sell, totals.unassigned.count, 0)}
      {!locs.length && (
        <div className="mt-2 rounded-sm border border-dashed border-line px-3 py-3 text-[13px] text-ink-2">
          <FolderTree className="mb-1 size-4 text-ink-4" />
          Organize lines by area — Guestrooms, Lobby, Corridors.
          {canEdit && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Button size="sm" onClick={() => setDialog({ kind: 'add', parentId: null })}>
                Add location
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: 'template' })}>
                Use template
              </Button>
            </div>
          )}
        </div>
      )}
      <LocationDialogs
        quote={quote}
        dialog={dialog}
        onClose={() => setDialog(null)}
        onDone={(selectId) => {
          invalidate();
          setDialog(null);
          if (selectId !== undefined) onChange(selectId);
        }}
        lineCount={(id) => totals.sub.get(id)?.count ?? 0}
      />
    </nav>
  );
}

function LocationDialogs({
  quote,
  dialog,
  onClose,
  onDone,
  lineCount,
}: {
  quote: QuoteDetail;
  dialog:
    | { kind: 'add'; parentId: string | null }
    | { kind: 'rename'; loc: Location }
    | { kind: 'move'; loc: Location }
    | { kind: 'delete'; loc: Location }
    | { kind: 'template' }
    | null;
  onClose: () => void;
  onDone: (selectId?: string | null) => void;
  lineCount: (id: string) => number;
}) {
  const [name, setName] = useState('');
  const [target, setTarget] = useState('');
  const [lastKey, setLastKey] = useState('');
  const key = dialog ? `${dialog.kind}:${'loc' in dialog ? dialog.loc.id : ''}` : '';
  if (key !== lastKey) {
    setLastKey(key);
    setName(dialog?.kind === 'rename' ? dialog.loc.name : '');
    setTarget(dialog?.kind === 'move' ? (dialog.loc.parentId ?? '') : '');
  }
  const templates = useQuery({
    queryKey: ['quoting', 'location-templates'],
    queryFn: () =>
      api.get<{ id: string; name: string; description: string | null }[]>('quoting', '/location-templates'),
    enabled: dialog?.kind === 'template',
  });
  const base = `/quotes/${quote.id}/locations`;
  const m = useMutation({
    mutationFn: async (): Promise<string | null | undefined> => {
      if (!dialog) return;
      if (dialog.kind === 'add') {
        const l = await api.post<Location>('quoting', base, {
          name: name.trim(),
          parentId: dialog.parentId,
          kind: dialog.parentId ? 'room' : 'area',
        });
        toast.success(`Location “${l.name}” added`);
        return l.id;
      }
      if (dialog.kind === 'rename') {
        await api.patch('quoting', `${base}/${dialog.loc.id}`, { name: name.trim() });
        toast.success('Location renamed');
        return undefined;
      }
      if (dialog.kind === 'move') {
        await api.patch('quoting', `${base}/${dialog.loc.id}`, { parentId: target || null });
        toast.success(`Moved “${dialog.loc.name}”`);
        return undefined;
      }
      if (dialog.kind === 'delete') {
        await api.del('quoting', `${base}/${dialog.loc.id}`, { moveLinesTo: target || undefined });
        toast.success(`Location “${dialog.loc.name}” deleted`);
        return null;
      }
      if (dialog.kind === 'template') {
        const r = await api.post<{ created: number }>('quoting', `${base}/apply-template`, {
          locationTemplateId: target,
        });
        toast.success(`Added ${plural('location', r.created)}`);
      }
      return undefined;
    },
    onSuccess: (id) => onDone(id),
  });
  if (!dialog) return null;
  const sub = 'loc' in dialog ? descendants(dialog.loc.id, quote.locations) : new Set<string>();
  const others = quote.locations.filter((l) => !sub.has(l.id));
  const submit = () => {
    if ((dialog.kind === 'add' || dialog.kind === 'rename') && !name.trim()) return;
    if (dialog.kind === 'template' && !target) return;
    m.mutate();
  };
  const title =
    dialog.kind === 'add'
      ? dialog.parentId
        ? `Add a sub-location under ${quote.locations.find((l) => l.id === dialog.parentId)?.name}`
        : 'Add location'
      : dialog.kind === 'rename'
        ? 'Rename location'
        : dialog.kind === 'move'
          ? `Move “${dialog.loc.name}”`
          : dialog.kind === 'delete'
            ? `Delete “${dialog.loc.name}”?`
            : 'Apply a location template';
  const n = 'loc' in dialog ? lineCount(dialog.loc.id) : 0;
  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant={dialog.kind === 'delete' ? 'danger' : 'primary'}
            loading={m.isPending}
            onClick={submit}
          >
            {dialog.kind === 'add'
              ? 'Add location'
              : dialog.kind === 'rename'
                ? 'Rename'
                : dialog.kind === 'move'
                  ? 'Move location'
                  : dialog.kind === 'delete'
                    ? 'Delete location'
                    : 'Apply template'}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="space-y-3"
      >
        {(dialog.kind === 'add' || dialog.kind === 'rename') && (
          <Field label="Name">
            {(id) => (
              <Input
                id={id}
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Guestrooms"
              />
            )}
          </Field>
        )}
        {dialog.kind === 'move' && (
          <Field label="Put it under">
            {(id) => (
              <Select
                id={id}
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                options={[
                  { value: '', label: 'Top level' },
                  ...others.map((l) => ({ value: l.id, label: l.path })),
                ]}
              />
            )}
          </Field>
        )}
        {dialog.kind === 'delete' && (
          <>
            <p className="text-ink-2">
              {sub.size > 1 ? `Its ${sub.size - 1} sub-location(s) are deleted too. ` : ''}
              {n
                ? `${plural('line', n)} will be moved — nothing is deleted from the quote.`
                : 'It has no lines.'}
            </p>
            {n > 0 && (
              <Field label="Move its lines to">
                {(id) => (
                  <Select
                    id={id}
                    value={target}
                    onChange={(e) => setTarget(e.target.value)}
                    options={[
                      { value: '', label: 'Unassigned' },
                      ...others.map((l) => ({ value: l.id, label: l.path })),
                    ]}
                  />
                )}
              </Field>
            )}
          </>
        )}
        {dialog.kind === 'template' &&
          (templates.data && !templates.data.length ? (
            <p className="text-ink-2">
              No location templates saved yet. Save one from a quote with a good location tree (quote menu →
              Save as template saves the whole quote; location templates are managed in Settings).
            </p>
          ) : (
            <Field label="Template" hint="Locations are added at the top level; existing ones are kept.">
              {(id) => (
                <Select
                  id={id}
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                  placeholder="Choose a template"
                  options={(templates.data ?? []).map((t) => ({ value: t.id, label: t.name }))}
                />
              )}
            </Field>
          ))}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

// ================================================================ room types
export function RoomTypesStrip({ quote, canEdit }: { quote: QuoteDetail; canEdit: boolean }) {
  const qc = useQueryClient();
  const refresh = useRefreshDerived(quote.id);
  const [adding, setAdding] = useState(false);
  const keys = quote.roomTypes.reduce((a, r) => a + r.count, 0);
  const done = () => {
    qc.invalidateQueries({ queryKey: qk.quote(quote.id), exact: true });
    qc.invalidateQueries({ queryKey: qk.lines(quote.id) });
    refresh(true);
  };
  const patch = useMutation({
    mutationFn: ({ rt, body }: { rt: RoomType; body: Partial<RoomType> }) =>
      api.patch<RoomType & { linesRecomputed: number }>(
        'quoting',
        `/quotes/${quote.id}/room-types/${rt.id}`,
        body,
      ),
    onSuccess: (r, { rt, body }) => {
      if (body.count !== undefined)
        toast.success(
          `${rt.name}: ${rt.count} → ${r.count} rooms. ${r.linesRecomputed ? `${plural('line', r.linesRecomputed)} recalculated.` : 'No line quantities changed.'}`,
        );
      done();
    },
    onError: () => done(),
  });
  const remove = useMutation({
    mutationFn: (rt: RoomType) => api.del('quoting', `/quotes/${quote.id}/room-types/${rt.id}`),
    onSuccess: (_r, rt) => {
      toast.success(`Room type ${rt.name} removed`);
      done();
    },
  });

  return (
    <div className="flex min-w-0 items-center gap-2 overflow-x-auto py-0.5">
      <span className="shrink-0 text-[12px] font-[560] text-ink-3">
        Room types <span className="num font-[480]">· {keys.toLocaleString()} keys</span>
      </span>
      {quote.roomTypes.map((rt) => (
        <RoomChip
          key={rt.id}
          rt={rt}
          canEdit={canEdit}
          onCount={(count) => count !== rt.count && patch.mutate({ rt, body: { count } })}
          onRemove={() => remove.mutate(rt)}
        />
      ))}
      {canEdit &&
        (adding ? (
          <NewRoomType
            quoteId={quote.id}
            onDone={() => {
              setAdding(false);
              done();
            }}
            onCancel={() => setAdding(false)}
          />
        ) : (
          <Button
            size="sm"
            variant="ghost"
            icon={<Plus className="size-3.5" />}
            onClick={() => setAdding(true)}
          >
            Room type
          </Button>
        ))}
      {!quote.roomTypes.length && !canEdit && <span className="text-[13px] text-ink-3">None</span>}
    </div>
  );
}

function RoomChip({
  rt,
  canEdit,
  onCount,
  onRemove,
}: {
  rt: RoomType;
  canEdit: boolean;
  onCount: (n: number) => void;
  onRemove: () => void;
}) {
  const [v, setV] = useState(String(rt.count));
  const [seen, setSeen] = useState(rt.count);
  if (seen !== rt.count) {
    setSeen(rt.count);
    setV(String(rt.count));
  }
  const commit = () => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) {
      toast.error('Room count must be a whole number');
      setV(String(rt.count));
      return;
    }
    onCount(n);
  };
  return (
    <span className="group inline-flex h-8 shrink-0 items-center gap-1.5 rounded-sm border border-line bg-paper pr-1 pl-2.5">
      <span className="text-[13px] font-[560]" title={rt.code}>
        {rt.name}
      </span>
      <span className="text-ink-4">×</span>
      {canEdit ? (
        <input
          aria-label={`${rt.name} room count`}
          inputMode="numeric"
          value={v}
          onChange={(e) => setV(e.target.value)}
          onFocus={(e) => e.target.select()}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') {
              setV(String(rt.count));
              setTimeout(() => (e.target as HTMLInputElement).blur());
            }
          }}
          className="num h-6 w-12 rounded-xs border border-transparent bg-stone px-1 text-right font-[600] hover:border-line focus:border-lacquer focus:bg-paper focus:outline-none"
        />
      ) : (
        <span className="num font-[600]">{rt.count}</span>
      )}
      {canEdit && (
        <button
          type="button"
          aria-label={`Remove ${rt.name}`}
          onClick={onRemove}
          className="grid size-5 place-items-center rounded-xs text-ink-4 opacity-0 group-hover:opacity-100 hover:bg-stone-2 hover:text-crit focus:opacity-100"
        >
          <X className="size-3" />
        </button>
      )}
    </span>
  );
}

function NewRoomType({
  quoteId,
  onDone,
  onCancel,
}: {
  quoteId: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [count, setCount] = useState('');
  const m = useMutation({
    mutationFn: () =>
      api.post('quoting', `/quotes/${quoteId}/room-types`, {
        name: name.trim(),
        code:
          name
            .trim()
            .split(/[\s/]+/)
            .map((w) => w[0])
            .join('')
            .toUpperCase()
            .slice(0, 8) || 'RT',
        count: Number(count) || 0,
      }),
    onSuccess: () => {
      toast.success(`Room type ${name.trim()} added`);
      onDone();
    },
  });
  return (
    <form
      className="inline-flex shrink-0 items-center gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) m.mutate();
      }}
    >
      <Input
        autoFocus
        aria-label="Room type name"
        className="!h-8 w-32"
        placeholder="King suite"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && onCancel()}
      />
      <Input
        aria-label="Room count"
        className="num !h-8 w-16"
        placeholder="Rooms"
        inputMode="numeric"
        value={count}
        onChange={(e) => setCount(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && onCancel()}
      />
      <Button size="sm" variant="primary" type="submit" loading={m.isPending}>
        Add
      </Button>
      <Button size="sm" variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
    </form>
  );
}
