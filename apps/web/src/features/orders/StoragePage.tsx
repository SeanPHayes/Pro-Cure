import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { Building2, MapPin, Plus, Warehouse } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import {
  Button,
  Chips,
  cx,
  Dialog,
  EmptyState,
  ErrorNote,
  Field,
  Input,
  PageHeader,
  SearchInput,
  Select,
  Sheet,
  Textarea,
} from '@/components/ui';
import { type Column, DataTable, Pagination } from '@/components/ui/DataTable';
import { api, type Page } from '@/lib/api';
import { hasPerm, useSession } from '@/lib/auth';
import { ago, count } from '@/lib/format';
import { useListParams, useSearchParamInput } from '@/lib/hooks';
import { fmtAddress, ok, useInvalidateOrders, useProjectsLite } from './shared';
import type { StorageItem, StorageItemStatus, StorageLocation, StorageLocationKind } from './types';

const STATUS: StorageItemStatus[] = ['stored', 'staged', 'installed', 'damaged'];
const STATUS_LABEL: Record<StorageItemStatus, string> = {
  in_transit: 'In transit',
  stored: 'Stored',
  staged: 'Staged',
  installed: 'Installed',
  damaged: 'Damaged',
};
const STATUS_TONE: Record<StorageItemStatus, string> = {
  in_transit: 'text-info',
  stored: 'text-ink',
  staged: 'text-lacquer',
  installed: 'text-ok',
  damaged: 'text-crit',
};
const KIND_LABEL: Record<StorageLocationKind, string> = {
  warehouse: 'Warehouse',
  on_site: 'On site',
  staging: 'Staging',
};
const KIND_ICON: Record<StorageLocationKind, typeof Warehouse> = {
  warehouse: Warehouse,
  on_site: Building2,
  staging: MapPin,
};

const DEFAULTS = { projectId: '', locationId: '', status: 'stored,staged,damaged', q: '', limit: '100' };

export function Component() {
  const s = useSession();
  const canWrite = hasPerm(s, 'logistics:write');
  const [p, set] = useListParams(DEFAULTS);
  const [text, setText] = useSearchParamInput(p.q, (q) => set({ q }));
  const projects = useProjectsLite();
  const [adding, setAdding] = useState(false);
  const [moving, setMoving] = useState<StorageItem | null>(null);

  const locations = useQuery({
    queryKey: ok.locations({ projectId: p.projectId }),
    queryFn: () =>
      api.get<StorageLocation[]>('orders', '/storage-locations', { projectId: p.projectId || undefined }),
  });
  const query = {
    projectId: p.projectId || undefined,
    locationId: p.locationId || undefined,
    status: p.status || undefined,
    q: p.q || undefined,
    limit: Number(p.limit),
    offset: Number(p.offset),
  };
  const items = useQuery({
    queryKey: ok.storage(query),
    queryFn: () => api.get<Page<StorageItem>>('orders', '/storage-items', query),
    placeholderData: keepPreviousData,
  });
  // Status totals for the chips (whole scope, ignoring the status filter).
  const totals = useQuery({
    queryKey: ok.storage({ totals: true, projectId: p.projectId, locationId: p.locationId }),
    queryFn: () =>
      api.get<Page<StorageItem>>('orders', '/storage-items', {
        projectId: p.projectId || undefined,
        locationId: p.locationId || undefined,
        limit: 500,
      }),
    select: (d) => {
      const t: Record<string, number> = {};
      for (const i of d.items) t[i.status] = (t[i.status] ?? 0) + i.quantity;
      return t;
    },
  });

  const projectName = (id: string | null) => projects.data?.find((x) => x.id === id)?.name;
  const statusChip = STATUS.includes(p.status as StorageItemStatus)
    ? p.status
    : p.status === 'stored,staged,damaged'
      ? 'open'
      : 'all';

  const cols: Column<StorageItem>[] = [
    {
      key: 'item',
      header: 'Item',
      cell: (r) => (
        <div className="min-w-[200px]">
          <div className="font-[560]">{r.name}</div>
          <div className="text-[12px] text-ink-3">
            <span className="num">{r.code}</span> ·{' '}
            <Link
              to={`/app/orders/${r.poId}`}
              className="num hover:text-lacquer hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              {r.poNumber}
            </Link>{' '}
            · {r.vendorName}
          </div>
        </div>
      ),
    },
    {
      key: 'project',
      header: 'Project',
      cell: (r) => (
        <div className="max-w-[180px] truncate text-[13px] text-ink-2">{projectName(r.projectId) ?? '—'}</div>
      ),
    },
    {
      key: 'location',
      header: 'Location',
      cell: (r) => (
        <div className="max-w-[220px] min-w-[150px]">
          <div className="truncate">{r.locationName ?? <span className="text-ink-4">Unassigned</span>}</div>
          {r.areaNote && <div className="truncate text-[12px] text-ink-3">{r.areaNote}</div>}
        </div>
      ),
    },
    { key: 'qty', header: 'Qty', align: 'right', cell: (r) => count(r.quantity) },
    {
      key: 'status',
      header: 'Status',
      cell: (r) =>
        canWrite ? (
          <StatusSelect item={r} />
        ) : (
          <span className={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</span>
        ),
    },
    {
      key: 'updated',
      header: 'Updated',
      cell: (r) => (
        <span className="text-[12.5px] whitespace-nowrap text-ink-3">
          {ago(r.updatedAt)}
          {r.updatedByName && ` · ${r.updatedByName.split(' ')[0]}`}
        </span>
      ),
    },
    ...(canWrite
      ? [
          {
            key: 'move',
            header: '',
            cell: (r: StorageItem) =>
              r.status !== 'installed' && (
                <Button size="sm" variant="ghost" onClick={() => setMoving(r)}>
                  Move
                </Button>
              ),
          },
        ]
      : []),
  ];

  return (
    <>
      <PageHeader
        title="Receiving & storage"
        description="Where every received item is: warehouse, on-site storage or staged in the room, through to installed."
        actions={
          canWrite && (
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>
              Add location
            </Button>
          )
        }
      >
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <div className="w-full sm:w-[260px]">
            <Select
              aria-label="Project"
              value={p.projectId}
              onChange={(e) => set({ projectId: e.target.value, locationId: '' })}
              placeholder="All projects"
              options={(projects.data ?? []).map((x) => ({ value: x.id, label: `${x.number} ${x.name}` }))}
            />
          </div>
          <SearchInput
            value={text}
            onChange={setText}
            placeholder="Item, code, PO or room"
            className="w-full sm:w-60"
          />
        </div>
      </PageHeader>

      <div className="space-y-4 px-4 py-4 sm:px-6">
        {locations.isError ? (
          <ErrorNote error={locations.error} />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <LocationCard
              active={!p.locationId}
              onClick={() => set({ locationId: '' })}
              title="All locations"
              sub={`${locations.data?.length ?? 0} locations`}
              value={(locations.data ?? []).reduce((a, l) => a + (l.itemCount ?? 0), 0)}
            />
            {(locations.data ?? []).map((l) => {
              const Icon = KIND_ICON[l.kind];
              return (
                <LocationCard
                  key={l.id}
                  active={p.locationId === l.id}
                  onClick={() => set({ locationId: p.locationId === l.id ? '' : l.id })}
                  icon={<Icon className="size-4" />}
                  title={l.name}
                  sub={[KIND_LABEL[l.kind], l.projectId ? projectName(l.projectId) : 'Shared by all projects']
                    .filter(Boolean)
                    .join(' · ')}
                  value={l.itemCount ?? 0}
                  address={fmtAddress(l.address).replace(/\n/g, ', ')}
                />
              );
            })}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <div className="max-w-full overflow-x-auto">
            <Chips
              value={statusChip as string}
              onChange={(v) => set({ status: v === 'open' ? 'stored,staged,damaged' : v === 'all' ? '' : v })}
              options={[
                {
                  value: 'open',
                  label: 'Not installed',
                  count:
                    (totals.data?.stored ?? 0) + (totals.data?.staged ?? 0) + (totals.data?.damaged ?? 0),
                },
                ...STATUS.map((x) => ({ value: x, label: STATUS_LABEL[x], count: totals.data?.[x] ?? 0 })),
                { value: 'all', label: 'All' },
              ]}
            />
          </div>
          <span className="text-[12.5px] text-ink-3">Quantities in units</span>
        </div>

        <div className="overflow-hidden rounded-md border border-line bg-paper">
          {items.isError ? (
            <ErrorNote error={items.error} />
          ) : (
            <DataTable
              columns={cols}
              rows={items.data?.items}
              loading={items.isLoading}
              rowClassName={(r) => (r.status === 'damaged' ? 'bg-crit-50/40' : undefined)}
              empty={
                <EmptyState icon={<Warehouse />} title="Nothing here">
                  Items appear when a shipment is received into a location from its purchase order.
                </EmptyState>
              }
              footer={
                items.data && (
                  <Pagination
                    total={items.data.total}
                    limit={items.data.limit}
                    offset={items.data.offset}
                    onChange={(o) => set({ offset: String(o) })}
                  />
                )
              }
            />
          )}
        </div>
      </div>
      <LocationSheet open={adding} onClose={() => setAdding(false)} defaultProjectId={p.projectId} />
      <MoveDialog item={moving} locations={locations.data ?? []} onClose={() => setMoving(null)} />
    </>
  );
}

function LocationCard({
  active,
  onClick,
  icon,
  title,
  sub,
  value,
  address,
}: {
  active: boolean;
  onClick: () => void;
  icon?: React.ReactNode;
  title: string;
  sub: string;
  value: number;
  address?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cx(
        'flex min-w-0 items-start gap-3 rounded-md border bg-paper px-3.5 py-3 text-left transition-colors',
        active ? 'border-brass bg-brass-50' : 'border-line hover:border-ink-4',
      )}
    >
      {icon && <span className="mt-0.5 text-ink-3">{icon}</span>}
      <span className="min-w-0 flex-1">
        <span className="block truncate font-[620]">{title}</span>
        <span className="block truncate text-[12px] text-ink-3">{sub}</span>
        {address && <span className="block truncate text-[12px] text-ink-3">{address}</span>}
      </span>
      <span className="text-right">
        <span className="num block text-[18px] leading-tight font-[620]">{count(value)}</span>
        <span className="block text-[11.5px] text-ink-3">units held</span>
      </span>
    </button>
  );
}

function StatusSelect({ item }: { item: StorageItem }) {
  const invalidate = useInvalidateOrders();
  const m = useMutation({
    mutationFn: (status: StorageItemStatus) => api.patch('orders', `/storage-items/${item.id}`, { status }),
    onSuccess: (_d, status) => {
      toast.success(`${item.code} ×${item.quantity} marked ${STATUS_LABEL[status].toLowerCase()}`);
      invalidate();
    },
  });
  return (
    <select
      aria-label={`Status of ${item.code}`}
      value={item.status}
      disabled={m.isPending}
      onChange={(e) => m.mutate(e.target.value as StorageItemStatus)}
      className={cx(
        'h-7 cursor-pointer rounded-xs border border-transparent bg-transparent px-1.5 font-[560] hover:border-line hover:bg-paper focus:border-lacquer focus:outline-none',
        STATUS_TONE[item.status],
      )}
    >
      {(item.status === 'in_transit' ? ['in_transit', ...STATUS] : STATUS).map((x) => (
        <option key={x} value={x}>
          {STATUS_LABEL[x as StorageItemStatus]}
        </option>
      ))}
    </select>
  );
}

function MoveDialog({
  item,
  locations,
  onClose,
}: {
  item: StorageItem | null;
  locations: StorageLocation[];
  onClose: () => void;
}) {
  const invalidate = useInvalidateOrders();
  const [loc, setLoc] = useState('');
  const [qty, setQty] = useState('');
  const [area, setArea] = useState('');
  const [status, setStatus] = useState('');
  const [forId, setForId] = useState<string | null>(null);
  if (item && forId !== item.id) {
    setForId(item.id);
    setLoc(item.storageLocationId ?? '');
    setQty(String(item.quantity));
    setArea(item.areaNote ?? '');
    setStatus('');
  }
  const n = Number(qty);
  const m = useMutation({
    mutationFn: () =>
      api.patch('orders', `/storage-items/${item!.id}`, {
        storageLocationId: loc || null,
        areaNote: area.trim() || null,
        status: status || undefined,
        quantity: n < item!.quantity ? n : undefined,
      }),
    onSuccess: () => {
      const l = locations.find((x) => x.id === loc);
      toast.success(`Moved ${n} × ${item!.code}${l ? ` to ${l.name}` : ''}`);
      invalidate();
      onClose();
    },
  });
  return (
    <Dialog
      open={!!item}
      onClose={onClose}
      title={item ? `Move ${item.code} · ${item.name}` : ''}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={m.isPending}
            disabled={!item || !(n > 0) || n > item.quantity}
            onClick={() => m.mutate()}
          >
            Move items
          </Button>
        </>
      }
    >
      {item && (
        <div className="space-y-3">
          <Field
            label="How many"
            hint={`Of ${item.quantity} at ${item.locationName ?? 'no location'}. Moving fewer splits the row.`}
          >
            {(id) => (
              <Input
                id={id}
                type="number"
                min={1}
                max={item.quantity}
                value={qty}
                onChange={(e) => setQty(e.target.value)}
              />
            )}
          </Field>
          <Field label="To location">
            {(id) => (
              <Select
                id={id}
                value={loc}
                onChange={(e) => setLoc(e.target.value)}
                placeholder="Unassigned"
                options={locations.map((l) => ({ value: l.id, label: `${l.name} · ${KIND_LABEL[l.kind]}` }))}
              />
            )}
          </Field>
          <Field label="Area or room (optional)">
            {(id) => (
              <Input
                id={id}
                value={area}
                onChange={(e) => setArea(e.target.value)}
                placeholder="e.g. Floor 3 corridor, Room 412"
              />
            )}
          </Field>
          <Field label="Status">
            {(id) => (
              <Select
                id={id}
                value={status}
                onChange={(e) => setStatus(e.target.value)}
                placeholder={`Keep as ${STATUS_LABEL[item.status].toLowerCase()}`}
                options={STATUS.map((x) => ({ value: x, label: STATUS_LABEL[x] }))}
              />
            )}
          </Field>
        </div>
      )}
    </Dialog>
  );
}

function LocationSheet({
  open,
  onClose,
  defaultProjectId,
}: {
  open: boolean;
  onClose: () => void;
  defaultProjectId: string;
}) {
  const invalidate = useInvalidateOrders();
  const projects = useProjectsLite();
  const [f, setF] = useState({
    projectId: defaultProjectId,
    name: '',
    kind: 'warehouse' as StorageLocationKind,
    line1: '',
    city: '',
    region: '',
    postalCode: '',
    notes: '',
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF((x) => ({ ...x, [k]: e.target.value }));
  const m = useMutation({
    mutationFn: () =>
      api.post('orders', '/storage-locations', {
        projectId: f.projectId || null,
        name: f.name.trim(),
        kind: f.kind,
        address: Object.fromEntries(
          Object.entries({ line1: f.line1, city: f.city, region: f.region, postalCode: f.postalCode }).filter(
            ([, v]) => v,
          ),
        ),
        notes: f.notes.trim() || null,
      }),
    onSuccess: () => {
      toast.success(`${f.name} added`);
      invalidate();
      setF((x) => ({ ...x, name: '', line1: '', city: '', region: '', postalCode: '', notes: '' }));
      onClose();
    },
  });
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Add storage location"
      description="A warehouse bay, a storage room at the hotel, or a staging area on a floor."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={m.isPending}
            disabled={!f.name.trim()}
            onClick={() => m.mutate()}
          >
            Add location
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name">
          {(id) => (
            <Input
              id={id}
              value={f.name}
              onChange={set('name')}
              placeholder="e.g. Port City Warehousing — bay 14"
            />
          )}
        </Field>
        <Field label="Kind">
          {(id) => (
            <Select
              id={id}
              value={f.kind}
              onChange={set('kind')}
              options={(['warehouse', 'on_site', 'staging'] as const).map((k) => ({
                value: k,
                label: KIND_LABEL[k],
              }))}
            />
          )}
        </Field>
        <Field
          label="Project"
          hint="On-site and staging locations belong to a project; the owner sees them in their portal."
        >
          {(id) => (
            <Select
              id={id}
              value={f.projectId}
              onChange={set('projectId')}
              placeholder="Shared by all projects"
              options={(projects.data ?? []).map((x) => ({ value: x.id, label: `${x.number} ${x.name}` }))}
            />
          )}
        </Field>
        <Field label="Street">{(id) => <Input id={id} value={f.line1} onChange={set('line1')} />}</Field>
        <div className="grid grid-cols-[1fr_80px_100px] gap-2">
          <Field label="City">{(id) => <Input id={id} value={f.city} onChange={set('city')} />}</Field>
          <Field label="State">{(id) => <Input id={id} value={f.region} onChange={set('region')} />}</Field>
          <Field label="ZIP">
            {(id) => <Input id={id} value={f.postalCode} onChange={set('postalCode')} />}
          </Field>
        </div>
        <Field label="Notes">
          {(id) => (
            <Textarea
              id={id}
              rows={3}
              value={f.notes}
              onChange={set('notes')}
              placeholder="Receiving hours, dock height, who to call"
            />
          )}
        </Field>
      </div>
    </Sheet>
  );
}
