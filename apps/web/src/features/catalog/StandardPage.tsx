import { ActivityFeed } from '@/components/shared/ActivityFeed';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, FileUp, ListPlus, Pencil, Plus, Send, Share2, Trash2, X } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  ErrorNote,
  Facts,
  Field,
  IconButton,
  Input,
  Loading,
  PageHeader,
  SearchInput,
  Section,
  Select,
  Sheet,
  StatusBadge,
  Textarea,
  TitleBlock,
} from '@/components/ui';
import { type Column, DataTable } from '@/components/ui/DataTable';
import { api, documentUrl, type Page, type Session } from '@/lib/api';
import { hasPerm, useSession } from '@/lib/auth';
import { count, date, dateTime } from '@/lib/format';
import { BrandSpecImportSheet } from '../ai/BrandSpecImportSheet';
import {
  type ApprovedVendor,
  type BrandStandardDetail,
  type BrandStandardItem,
  Crumb,
  categoryLabel,
  categoryOptions,
  friendlyError,
  isServiceDown,
  Muted,
  type Product,
  qk,
  SharingMark,
  standardStatusLabel,
  useVendorOptions,
} from './shared';

/** Mirrors services/catalog/src/access.ts isCurator. */
const isCurator = (s: Session | null) =>
  hasPerm(s, 'catalog:curate') &&
  (s?.context.actor === 'platform' ||
    !!s?.context.roles.some((r) => r === 'catalog_curator' || r === 'platform_admin'));

export function Component() {
  const { id = '' } = useParams();
  const s = useSession();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<BrandStandardItem | 'new' | null>(null);
  const [headerOpen, setHeaderOpen] = useState(false);
  const [toLibrary, setToLibrary] = useState(false);
  const [importing, setImporting] = useState(false);
  const [confirm, setConfirm] = useState<'submit' | 'publish' | null>(null);

  const std = useQuery({
    queryKey: qk.standard(id),
    queryFn: () => api.get<BrandStandardDetail>('catalog', `/brand-standards/${id}`),
  });
  const openItemId = params.get('item');
  const openItem = std.data?.items.find((i) => i.id === openItemId) ?? null;
  const setOpenItem = (itemId: string | null) =>
    setParams(
      (prev) => {
        const n = new URLSearchParams(prev);
        if (itemId) n.set('item', itemId);
        else n.delete('item');
        return n;
      },
      { replace: true },
    );

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: qk.standard(id) });
    qc.invalidateQueries({ queryKey: ['catalog', 'standards'] });
    qc.invalidateQueries({ queryKey: ['activity', 'catalog'] });
  };
  const transition = useMutation({
    mutationFn: (to: 'submit' | 'publish') => api.post('catalog', `/brand-standards/${id}/${to}`),
    onSuccess: (_d, to) => {
      toast.success(to === 'submit' ? 'Submitted for review' : 'Package published');
      setConfirm(null);
      invalidate();
    },
  });

  const items = std.data?.items ?? [];
  const term = q.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      items.filter(
        (i) =>
          (!category || i.category === category) &&
          (!term ||
            [i.code, i.name, i.finish, i.materials, i.description, ...i.approvedVendors.map((v) => v.name)]
              .filter(Boolean)
              .some((x) => x!.toLowerCase().includes(term))),
      ),
    [items, category, term],
  );
  const byArea = useMemo(() => {
    const m = new Map<string, BrandStandardItem[]>();
    for (const i of filtered) m.set(i.area, [...(m.get(i.area) ?? []), i]);
    return [...m.entries()];
  }, [filtered]);
  const presentCategories = [...new Set(items.map((i) => i.category))];

  if (std.isLoading) return <Loading label="Loading brand standard" />;
  if (std.isError || !std.data)
    return (
      <>
        <PageHeader title="Brand standard" />
        <ErrorNote error={std.error ?? new Error('This brand standard could not be found.')} />
      </>
    );
  const d = std.data;
  const curator = isCurator(s);
  const canEdit =
    hasPerm(s, 'catalog:contribute') && (curator || (d.mine && ['draft', 'submitted'].includes(d.status)));
  const canSubmit = hasPerm(s, 'catalog:contribute') && d.mine && d.status === 'draft';
  const canPublish = curator && ['draft', 'submitted'].includes(d.status);
  const canLibrary = hasPerm(s, 'specs:write');
  const canImport = canEdit && hasPerm(s, 'ai:use') && d.status === 'draft';

  return (
    <>
      <div className="border-b border-line bg-paper px-6 pt-4 pb-5 max-sm:px-4">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
          <Crumb to="/app/catalog/standards">Brand standards</Crumb>
          <div className="flex flex-wrap items-center gap-2">
            {d.sourceDocumentId && (
              <a
                href={documentUrl(d.sourceDocumentId)}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-9 items-center gap-2 rounded-sm px-3 font-[560] text-ink-2 hover:bg-stone-2 hover:text-ink"
              >
                <FileText className="size-4" />
                Source PDF
              </a>
            )}
            {canEdit && (
              <Button icon={<Pencil className="size-4" />} onClick={() => setHeaderOpen(true)}>
                Edit details
              </Button>
            )}
            {canImport && (
              <Button icon={<FileUp className="size-4" />} onClick={() => setImporting(true)}>
                Import from PDF
              </Button>
            )}
            {canSubmit && (
              <Button icon={<Send className="size-4" />} onClick={() => setConfirm('submit')}>
                Submit for review
              </Button>
            )}
            {canPublish && (
              <Button
                variant="brass"
                icon={<Share2 className="size-4" />}
                onClick={() => setConfirm('publish')}
              >
                Publish to all firms
              </Button>
            )}
          </div>
        </div>
        <TitleBlock
          title={d.name}
          subtitle={
            <span className="inline-flex flex-wrap items-center gap-2">
              {d.brandName}
              <SharingMark s={d} />
            </span>
          }
          fields={[
            { label: 'Version', value: <span className="num">{d.version}</span> },
            { label: 'Effective', value: <span className="num">{date(d.effectiveDate)}</span> },
            {
              label: 'Status',
              value: <StatusBadge status={d.status} label={standardStatusLabel[d.status]} />,
            },
            { label: 'Items', value: <span className="num">{count(d.itemCount)}</span> },
          ]}
        />
        {d.status === 'submitted' && d.mine && (
          <p className="mt-3 text-[13px] text-ink-2">
            Submitted {dateTime(d.submittedAt)}. A Pro-Cure curator will review it and publish it to every
            firm.
          </p>
        )}
        {d.notes && <p className="mt-3 max-w-[80ch] text-[13px] text-ink-2">{d.notes}</p>}
      </div>

      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-line bg-stone px-6 py-3 max-sm:px-4">
        <SearchInput value={q} onChange={setQ} placeholder="Filter items" className="w-full sm:w-64" />
        <div className="w-[190px]">
          <Select
            aria-label="Category"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            placeholder="All categories"
            options={categoryOptions.filter((o) => presentCategories.includes(o.value))}
          />
        </div>
        {(q || category) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setQ('');
              setCategory('');
            }}
          >
            Clear filters
          </Button>
        )}
        <div className="ml-auto flex items-center gap-2">
          {selected.size > 0 && (
            <>
              <span className="num text-[13px] text-ink-2">{selected.size} selected</span>
              <IconButton label="Clear selection" onClick={() => setSelected(new Set())}>
                <X className="size-4" />
              </IconButton>
            </>
          )}
          {canLibrary && (
            <Button
              variant={selected.size ? 'primary' : 'secondary'}
              icon={<ListPlus className="size-4" />}
              disabled={!items.length}
              onClick={() => setToLibrary(true)}
            >
              {selected.size ? `Add ${selected.size} to spec library` : 'Add to spec library'}
            </Button>
          )}
          {canEdit && (
            <Button icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
              Add item
            </Button>
          )}
        </div>
      </div>
      {!items.length ? (
        <EmptyState
          icon={<FileText />}
          title="This package has no items yet"
          action={
            canEdit && (
              <div className="flex gap-2">
                {canImport && (
                  <Button variant="primary" onClick={() => setImporting(true)}>
                    Import from PDF
                  </Button>
                )}
                <Button onClick={() => setEditing('new')}>Add item</Button>
              </div>
            )
          }
        >
          Read the brand’s PDF into items, or add them one at a time.
        </EmptyState>
      ) : !byArea.length ? (
        <EmptyState title="No items match these filters">Clear the filters to see every item.</EmptyState>
      ) : (
        <div className="space-y-5 px-6 py-5 max-sm:px-4">
          {byArea.map(([area, rows]) => (
            <AreaTable
              key={area}
              area={area}
              rows={rows}
              selected={canLibrary ? selected : undefined}
              onSelect={canLibrary ? setSelected : undefined}
              onOpen={(i) => setOpenItem(i.id)}
            />
          ))}
        </div>
      )}

      <div className="px-6 pb-8 max-sm:px-4">
        <Section title="History">
          <ActivityFeed service="catalog" path={`/brand-standards/${id}/activity`} />
        </Section>
      </div>

      <ItemSheet
        item={openItem}
        onClose={() => setOpenItem(null)}
        canEdit={canEdit}
        onEdit={(i) => {
          setOpenItem(null);
          setEditing(i);
        }}
      />
      {canEdit && (
        <ItemFormSheet
          standardId={id}
          item={editing}
          onClose={() => setEditing(null)}
          onSaved={invalidate}
          areas={[...new Set(items.map((i) => i.area))]}
        />
      )}
      {canEdit && (
        <HeaderSheet open={headerOpen} onClose={() => setHeaderOpen(false)} std={d} onSaved={invalidate} />
      )}
      {canLibrary && (
        <SpecLibraryDialog
          open={toLibrary}
          onClose={() => setToLibrary(false)}
          std={d}
          items={selected.size ? items.filter((i) => selected.has(i.id)) : items}
          onDone={() => setSelected(new Set())}
        />
      )}
      {canImport && (
        <BrandSpecImportSheet
          open={importing}
          onClose={() => setImporting(false)}
          defaultStandardId={d.id}
          defaultBrandId={d.brandId}
        />
      )}
      <Dialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        title={
          confirm === 'publish' ? 'Publish this package to every firm?' : 'Submit this package for review?'
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant={confirm === 'publish' ? 'brass' : 'primary'}
              loading={transition.isPending}
              onClick={() => confirm && transition.mutate(confirm)}
            >
              {confirm === 'publish' ? 'Publish to all firms' : 'Submit for review'}
            </Button>
          </>
        }
      >
        <p className="text-ink-2">
          {confirm === 'publish'
            ? `All ${d.itemCount} items become shared intelligence that every firm on Pro-Cure can use. Older published versions of this package are marked superseded.`
            : `Pro-Cure curators will review the ${d.itemCount} items. You can keep editing until it is published.`}
        </p>
      </Dialog>
    </>
  );
}

function AreaTable({
  area,
  rows,
  selected,
  onSelect,
  onOpen,
}: {
  area: string;
  rows: BrandStandardItem[];
  selected?: Set<string>;
  onSelect?: (s: Set<string>) => void;
  onOpen: (i: BrandStandardItem) => void;
}) {
  const columns: Column<BrandStandardItem>[] = [
    {
      key: 'code',
      header: 'Code',
      width: 110,
      cell: (r) => (
        <button
          type="button"
          className="num font-[600] whitespace-nowrap hover:text-lacquer"
          onClick={(e) => {
            e.stopPropagation();
            onOpen(r);
          }}
        >
          {r.code}
        </button>
      ),
    },
    {
      key: 'name',
      header: 'Item',
      cell: (r) => (
        <div className="min-w-[240px]">
          <div className="font-[560]">{r.name}</div>
          {r.quantityBasis && <div className="text-[12px] text-ink-3">{r.quantityBasis}</div>}
        </div>
      ),
    },
    {
      key: 'cat',
      header: 'Category',
      cell: (r) => <span className="whitespace-nowrap">{categoryLabel(r.category)}</span>,
    },
    {
      key: 'dims',
      header: 'Dimensions',
      cell: (r) => (
        <span className="num whitespace-nowrap text-ink-2">
          <Muted>{r.dimensions}</Muted>
        </span>
      ),
    },
    {
      key: 'finish',
      header: 'Finish',
      cell: (r) => (
        <div className="max-w-[240px] truncate text-ink-2" title={r.finish ?? undefined}>
          <Muted>{r.finish}</Muted>
        </div>
      ),
    },
    {
      key: 'vendors',
      header: 'Approved vendors',
      cell: (r) =>
        r.approvedVendors.length ? (
          <div className="max-w-[260px] truncate" title={r.approvedVendors.map((v) => v.name).join(', ')}>
            {r.approvedVendors.map((v) => v.name).join(', ')}
          </div>
        ) : (
          <span className="text-ink-4">Any</span>
        ),
    },
  ];
  return (
    <section className="overflow-hidden rounded-md border border-line bg-paper">
      <header className="flex items-baseline justify-between border-b border-line-2 px-4 py-2.5">
        <h2 className="text-[15px] font-[640]">{area}</h2>
        <span className="num text-[12px] text-ink-3">{rows.length} items</span>
      </header>
      <DataTable
        columns={columns}
        rows={rows}
        selected={selected}
        onSelect={
          onSelect && selected
            ? (ids) => {
                // Selection spans areas: merge this area's change into the global set.
                const next = new Set([...selected].filter((x) => !rows.some((r) => r.id === x)));
                for (const x of ids) next.add(x);
                onSelect(next);
              }
            : undefined
        }
        onRowClick={onOpen}
        dense
      />
    </section>
  );
}

// ------------------------------------------------------------------ Item detail
function ItemSheet({
  item,
  onClose,
  canEdit,
  onEdit,
}: {
  item: BrandStandardItem | null;
  onClose: () => void;
  canEdit: boolean;
  onEdit: (i: BrandStandardItem) => void;
}) {
  const products = useQuery({
    queryKey: ['catalog', 'products', { brandStandardItemId: item?.id }],
    queryFn: () =>
      api.get<Page<Product>>('catalog', '/products', { brandStandardItemId: item!.id, limit: 50 }),
    enabled: !!item,
  });
  if (!item) return null;
  const attrs = Object.entries(item.attributes ?? {}).filter(([k]) => k !== 'sourcePage');
  return (
    <Sheet
      open
      onClose={onClose}
      width={560}
      title={
        <span>
          <span className="num mr-2 text-ink-3">{item.code}</span>
          {item.name}
        </span>
      }
      description={`${item.area} · ${categoryLabel(item.category)}`}
      footer={
        canEdit ? (
          <Button icon={<Pencil className="size-4" />} onClick={() => onEdit(item)}>
            Edit item
          </Button>
        ) : undefined
      }
    >
      <div className="space-y-6">
        <Facts
          cols={2}
          items={[
            { label: 'Dimensions', value: <Muted>{item.dimensions}</Muted> },
            { label: 'Quantity basis', value: <Muted>{item.quantityBasis}</Muted> },
            { label: 'Finish', value: <Muted>{item.finish}</Muted> },
            { label: 'Materials', value: <Muted>{item.materials}</Muted> },
          ]}
        />
        {item.description && (
          <div>
            <div className="text-[12px] text-ink-3">Description</div>
            <p className="mt-0.5 whitespace-pre-line">{item.description}</p>
          </div>
        )}
        {attrs.length > 0 && (
          <Facts items={attrs.map(([k, v]) => ({ label: k, value: String(v) }))} cols={2} />
        )}
        <div>
          <h3 className="mb-2 font-[620]">Approved vendors</h3>
          {item.approvedVendors.length ? (
            <ul className="divide-y divide-line-2 rounded-sm border border-line">
              {item.approvedVendors.map((v) => (
                <li
                  key={`${v.name}${v.model ?? ''}`}
                  className="flex items-center justify-between gap-3 px-3 py-2"
                >
                  {v.vendorId ? (
                    <Link
                      to={`/app/catalog/vendors/${v.vendorId}`}
                      className="font-[560] text-lacquer hover:underline"
                    >
                      {v.name}
                    </Link>
                  ) : (
                    <span className="font-[560]">
                      {v.name} <span className="text-[12px] font-normal text-ink-3">not in the network</span>
                    </span>
                  )}
                  {v.model && <span className="num text-[13px] text-ink-2">{v.model}</span>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-ink-3">The brand doesn’t restrict manufacturers for this item.</p>
          )}
        </div>
        <div>
          <h3 className="mb-2 font-[620]">Matching products</h3>
          {products.isLoading ? (
            <Loading />
          ) : products.isError ? (
            <p className="text-crit">{friendlyError(products.error, 'The product catalog')}</p>
          ) : !products.data?.items.length ? (
            <p className="text-ink-3">No catalog products are linked to this item yet.</p>
          ) : (
            <ul className="divide-y divide-line-2 rounded-sm border border-line">
              {products.data.items.map((p) => (
                <li key={p.id} className="px-3 py-2">
                  <div className="flex items-center justify-between gap-3">
                    <Link
                      to={`/app/catalog/products?product=${p.id}`}
                      className="font-[560] hover:text-lacquer hover:underline"
                    >
                      {p.name}
                    </Link>
                    <span className="num text-[12px] text-ink-3">{p.sku}</span>
                  </div>
                  <div className="text-[12px] text-ink-3">
                    {p.vendorName}
                    {p.typicalLeadTimeWeeks ? ` · ${p.typicalLeadTimeWeeks} wk typical lead time` : ''}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Sheet>
  );
}

// ------------------------------------------------------------------ Item create/edit
interface ItemDraft {
  code: string;
  area: string;
  category: string;
  name: string;
  description: string;
  dimensions: string;
  finish: string;
  materials: string;
  quantityBasis: string;
  approvedVendors: ApprovedVendor[];
}
const toDraft = (i: BrandStandardItem | null, area: string): ItemDraft => ({
  code: i?.code ?? '',
  area: i?.area ?? area,
  category: i?.category ?? 'casegoods',
  name: i?.name ?? '',
  description: i?.description ?? '',
  dimensions: i?.dimensions ?? '',
  finish: i?.finish ?? '',
  materials: i?.materials ?? '',
  quantityBasis: i?.quantityBasis ?? '',
  approvedVendors: i?.approvedVendors ?? [],
});
const orNull = (s: string) => (s.trim() ? s.trim() : null);

function ItemFormSheet({
  standardId,
  item,
  onClose,
  onSaved,
  areas,
}: {
  standardId: string;
  item: BrandStandardItem | 'new' | null;
  onClose: () => void;
  onSaved: () => void;
  areas: string[];
}) {
  const existing = item && item !== 'new' ? item : null;
  const [f, setF] = useState<ItemDraft>(() => toDraft(existing, areas[0] ?? 'Guestroom'));
  const [confirmDelete, setConfirmDelete] = useState(false);
  const vendors = useVendorOptions();
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when a different item opens
  useEffect(() => setF(toDraft(existing, areas[0] ?? 'Guestroom')), [item]);
  const set = (patch: Partial<ItemDraft>) => setF((x) => ({ ...x, ...patch }));

  const save = useMutation({
    mutationFn: () => {
      const body = {
        code: f.code.trim(),
        area: f.area.trim() || 'General',
        category: f.category,
        name: f.name.trim(),
        description: orNull(f.description),
        dimensions: orNull(f.dimensions),
        finish: orNull(f.finish),
        materials: orNull(f.materials),
        quantityBasis: orNull(f.quantityBasis),
        approvedVendors: f.approvedVendors
          .filter((v) => v.name.trim())
          .map((v) => ({ ...v, model: v.model?.trim() || undefined })),
      };
      return existing
        ? api.patch('catalog', `/brand-standards/${standardId}/items/${existing.id}`, body)
        : api.post('catalog', `/brand-standards/${standardId}/items`, { items: [body] });
    },
    onSuccess: () => {
      toast.success(existing ? 'Item saved' : 'Item added');
      onSaved();
      onClose();
    },
  });
  const remove = useMutation({
    mutationFn: () => api.del('catalog', `/brand-standards/${standardId}/items/${existing!.id}`),
    onSuccess: () => {
      toast.success('Item removed');
      setConfirmDelete(false);
      onSaved();
      onClose();
    },
  });

  if (!item) return null;
  const valid = f.code.trim() && f.name.trim();
  const vendorById = new Map(vendors.data?.map((v) => [v.id, v.name]));
  return (
    <Sheet
      open
      onClose={onClose}
      title={existing ? `Edit ${existing.code}` : 'Add item'}
      width={560}
      footer={
        <>
          {existing && (
            <Button
              variant="danger"
              className="mr-auto"
              icon={<Trash2 className="size-4" />}
              onClick={() => setConfirmDelete(true)}
            >
              Remove item
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!valid} loading={save.isPending} onClick={() => save.mutate()}>
            {existing ? 'Save item' : 'Add item'}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Item code">
          {(id) => (
            <Input
              id={id}
              value={f.code}
              onChange={(e) => set({ code: e.target.value })}
              placeholder="CG-101"
            />
          )}
        </Field>
        <Field label="Category">
          {(id) => (
            <Select
              id={id}
              value={f.category}
              onChange={(e) => set({ category: e.target.value })}
              options={categoryOptions}
            />
          )}
        </Field>
        <Field label="Name" className="sm:col-span-2">
          {(id) => (
            <Input
              id={id}
              value={f.name}
              onChange={(e) => set({ name: e.target.value })}
              placeholder="King headboard"
            />
          )}
        </Field>
        <Field label="Area">
          {(id) => (
            <>
              <Input
                id={id}
                list={`${id}-areas`}
                value={f.area}
                onChange={(e) => set({ area: e.target.value })}
              />
              <datalist id={`${id}-areas`}>
                {areas.map((a) => (
                  <option key={a} value={a} />
                ))}
              </datalist>
            </>
          )}
        </Field>
        <Field label="Quantity basis">
          {(id) => (
            <Input
              id={id}
              value={f.quantityBasis}
              onChange={(e) => set({ quantityBasis: e.target.value })}
              placeholder="1 per king room"
            />
          )}
        </Field>
        <Field label="Dimensions">
          {(id) => (
            <Input id={id} value={f.dimensions} onChange={(e) => set({ dimensions: e.target.value })} />
          )}
        </Field>
        <Field label="Finish">
          {(id) => <Input id={id} value={f.finish} onChange={(e) => set({ finish: e.target.value })} />}
        </Field>
        <Field label="Materials" className="sm:col-span-2">
          {(id) => <Input id={id} value={f.materials} onChange={(e) => set({ materials: e.target.value })} />}
        </Field>
        <Field label="Description" className="sm:col-span-2">
          {(id) => (
            <Textarea id={id} value={f.description} onChange={(e) => set({ description: e.target.value })} />
          )}
        </Field>
        <div className="sm:col-span-2">
          <div className="mb-1.5 text-[13px] font-[560] text-ink-2">Approved vendors</div>
          <div className="space-y-2">
            {f.approvedVendors.map((v, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional
              <div key={i} className="flex gap-2">
                <div className="flex-1">
                  <Select
                    aria-label="Vendor"
                    value={v.vendorId ?? ''}
                    onChange={(e) => {
                      const next = [...f.approvedVendors];
                      next[i] = {
                        ...v,
                        vendorId: e.target.value || undefined,
                        name: e.target.value ? (vendorById.get(e.target.value) ?? v.name) : v.name,
                      };
                      set({ approvedVendors: next });
                    }}
                    placeholder={
                      v.vendorId
                        ? 'Not in the network'
                        : v.name
                          ? `${v.name} (not in the network)`
                          : 'Choose a vendor'
                    }
                    options={(vendors.data ?? []).map((x) => ({ value: x.id, label: x.name }))}
                  />
                </div>
                <Input
                  aria-label="Model"
                  className="!w-36"
                  placeholder="Model"
                  value={v.model ?? ''}
                  onChange={(e) => {
                    const next = [...f.approvedVendors];
                    next[i] = { ...v, model: e.target.value };
                    set({ approvedVendors: next });
                  }}
                />
                <IconButton
                  label="Remove vendor"
                  onClick={() => set({ approvedVendors: f.approvedVendors.filter((_, j) => j !== i) })}
                >
                  <X className="size-4" />
                </IconButton>
              </div>
            ))}
            <Button
              size="sm"
              variant="ghost"
              icon={<Plus className="size-3.5" />}
              onClick={() => set({ approvedVendors: [...f.approvedVendors, { name: '' }] })}
            >
              Add approved vendor
            </Button>
          </div>
        </div>
      </div>
      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={`Remove ${existing?.code}?`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate()}>
              Remove item
            </Button>
          </>
        }
      >
        <p className="text-ink-2">
          The item is removed from this package. Specs already in your library keep their copy.
        </p>
      </Dialog>
    </Sheet>
  );
}

// ------------------------------------------------------------------ Header edit
function HeaderSheet({
  open,
  onClose,
  std,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  std: BrandStandardDetail;
  onSaved: () => void;
}) {
  const [f, setF] = useState({ name: '', version: '', effectiveDate: '', notes: '' });
  useEffect(() => {
    if (open)
      setF({
        name: std.name,
        version: std.version,
        effectiveDate: std.effectiveDate ?? '',
        notes: std.notes ?? '',
      });
  }, [open, std]);
  const save = useMutation({
    mutationFn: () =>
      api.patch('catalog', `/brand-standards/${std.id}`, {
        name: f.name.trim(),
        version: f.version.trim(),
        effectiveDate: f.effectiveDate || null,
        notes: f.notes.trim() || null,
      }),
    onSuccess: () => {
      toast.success('Package details saved');
      onSaved();
      onClose();
    },
  });
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Edit package details"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={save.isPending}
            disabled={f.name.trim().length < 2}
            onClick={() => save.mutate()}
          >
            Save details
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Package name" className="sm:col-span-2">
          {(id) => <Input id={id} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}
        </Field>
        <Field label="Version">
          {(id) => (
            <Input id={id} value={f.version} onChange={(e) => setF({ ...f, version: e.target.value })} />
          )}
        </Field>
        <Field label="Effective date">
          {(id) => (
            <Input
              id={id}
              type="date"
              value={f.effectiveDate}
              onChange={(e) => setF({ ...f, effectiveDate: e.target.value })}
            />
          )}
        </Field>
        <Field label="Notes" className="sm:col-span-2">
          {(id) => (
            <Textarea id={id} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
          )}
        </Field>
      </div>
    </Sheet>
  );
}

// ------------------------------------------------------------------ Add to spec library
function SpecLibraryDialog({
  open,
  onClose,
  std,
  items,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  std: BrandStandardDetail;
  items: BrandStandardItem[];
  onDone: () => void;
}) {
  const nav = useNavigate();
  const [assign, setAssign] = useState<Record<string, string>>({});
  const [error, setError] = useState<ReactNode>(null);
  useEffect(() => {
    if (!open) return;
    setError(null);
    setAssign(
      Object.fromEntries(items.map((i) => [i.id, i.approvedVendors.find((v) => v.vendorId)?.vendorId ?? ''])),
    );
  }, [open, items]);
  const add = useMutation({
    mutationFn: () =>
      api.post<{ created: number; updated: number }>('quoting', '/specs/from-brand-standard', {
        standardId: std.id,
        itemIds: items.map((i) => i.id),
        vendorAssignments: Object.fromEntries(Object.entries(assign).filter(([, v]) => v)),
      }),
    onSuccess: (r) => {
      toast.success('Added to spec library', {
        description: `${r.created} new, ${r.updated} updated`,
        action: { label: 'Open spec library', onClick: () => nav('/app/specs') },
      });
      onDone();
      onClose();
    },
    onError: (e) =>
      setError(
        isServiceDown(e)
          ? 'The spec library is unavailable right now, so nothing was added. Try again in a few minutes.'
          : friendlyError(e, 'The spec library'),
      ),
  });
  const choosable = items.filter((i) => i.approvedVendors.some((v) => v.vendorId));
  return (
    <Dialog
      open={open}
      onClose={onClose}
      width={620}
      title={`Add ${items.length} ${items.length === 1 ? 'item' : 'items'} to your spec library`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={add.isPending} onClick={() => add.mutate()}>
            {`Add ${items.length} to spec library`}
          </Button>
        </>
      }
    >
      <p className="text-ink-2">
        Each item becomes a private spec your firm can quote, linked back to this brand standard. Existing
        specs with the same code are updated.
      </p>
      {choosable.length > 0 && (
        <div className="mt-4 max-h-[48vh] overflow-y-auto rounded-sm border border-line">
          <table className="grid-table">
            <thead>
              <tr>
                <th>Item</th>
                <th style={{ width: 240 }}>Vendor</th>
              </tr>
            </thead>
            <tbody>
              {choosable.map((i) => (
                <tr key={i.id}>
                  <td>
                    <span className="num mr-2 text-ink-3">{i.code}</span>
                    {i.name}
                  </td>
                  <td>
                    <Select
                      aria-label={`Vendor for ${i.code}`}
                      value={assign[i.id] ?? ''}
                      onChange={(e) => setAssign({ ...assign, [i.id]: e.target.value })}
                      placeholder="No vendor yet"
                      options={i.approvedVendors
                        .filter((v) => v.vendorId)
                        .map((v) => ({ value: v.vendorId!, label: v.name }))}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {error && (
        <div role="alert" className="mt-3 rounded-sm border border-crit/25 bg-crit-50 px-3 py-2 text-crit">
          {error}
        </div>
      )}
      {items.length > choosable.length && choosable.length > 0 && (
        <p className="mt-2 text-[12px] text-ink-3">
          <Badge>{items.length - choosable.length}</Badge> items have no network vendor to assign and are
          added without one.
        </p>
      )}
    </Dialog>
  );
}
