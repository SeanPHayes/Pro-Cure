import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Boxes, Pencil, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import {
  Button,
  EmptyState,
  ErrorNote,
  Facts,
  Field,
  Input,
  PageHeader,
  SearchInput,
  Select,
  Sheet,
  StatusBadge,
  Textarea,
} from '@/components/ui';
import { type Column, DataTable, Pagination } from '@/components/ui/DataTable';
import { api, type Page } from '@/lib/api';
import { hasPerm, useSession } from '@/lib/auth';
import { useListParams, useSearchParamInput } from '@/lib/hooks';
import { categoryLabel, categoryOptions, Muted, type Product, qk, useVendorOptions } from './shared';

const DEFAULTS = { q: '', vendorId: '', category: '', status: 'active', limit: '50' };

const ProductStatus = ({ status }: { status: Product['status'] }) => (
  <StatusBadge
    status={status === 'active' ? 'active' : 'cancelled'}
    label={status === 'active' ? 'Active' : 'Discontinued'}
  />
);

export function Component() {
  const s = useSession();
  const [p, set] = useListParams(DEFAULTS);
  const [text, setText] = useSearchParamInput(p.q, (q) => set({ q }));
  const [params, setParams] = useSearchParams();
  const [editing, setEditing] = useState<Product | 'new' | null>(null);
  const vendors = useVendorOptions();
  const query = {
    q: p.q || undefined,
    vendorId: p.vendorId || undefined,
    category: p.category || undefined,
    status: p.status || undefined,
    limit: Number(p.limit),
    offset: Number(p.offset),
  };
  const list = useQuery({
    queryKey: qk.products(query),
    queryFn: () => api.get<Page<Product>>('catalog', '/products', query),
    placeholderData: keepPreviousData,
  });
  const openId = params.get('product');
  const fromList = list.data?.items.find((x) => x.id === openId);
  const single = useQuery({
    queryKey: ['catalog', 'product', openId],
    queryFn: () => api.get<Product>('catalog', `/products/${openId}`),
    enabled: !!openId && !fromList,
  });
  const open = fromList ?? single.data ?? null;
  const setOpen = (id: string | null) =>
    setParams(
      (prev) => {
        const n = new URLSearchParams(prev);
        if (id) n.set('product', id);
        else n.delete('product');
        return n;
      },
      { replace: true },
    );
  const canWrite = hasPerm(s, 'catalog:contribute');
  const filtered = !!(p.q || p.vendorId || p.category || p.status !== 'active');

  const columns: Column<Product>[] = [
    {
      key: 'sku',
      header: 'SKU',
      width: 140,
      cell: (r) => <span className="num font-[560] whitespace-nowrap">{r.sku}</span>,
    },
    {
      key: 'name',
      header: 'Product',
      cell: (r) => (
        <div className="min-w-[220px]">
          <button
            type="button"
            className="text-left font-[560] hover:text-lacquer"
            onClick={(e) => {
              e.stopPropagation();
              setOpen(r.id);
            }}
          >
            {r.name}
          </button>
          {r.dimensions && <div className="num text-[12px] text-ink-3">{r.dimensions}</div>}
        </div>
      ),
    },
    {
      key: 'vendor',
      header: 'Vendor',
      cell: (r) => (
        <Link
          to={`/app/catalog/vendors/${r.vendorId}`}
          onClick={(e) => e.stopPropagation()}
          className="whitespace-nowrap hover:text-lacquer hover:underline"
        >
          {r.vendorName}
        </Link>
      ),
    },
    {
      key: 'cat',
      header: 'Category',
      cell: (r) => <span className="whitespace-nowrap">{categoryLabel(r.category)}</span>,
    },
    {
      key: 'lead',
      header: 'Lead time',
      align: 'right',
      cell: (r) => <Muted>{r.typicalLeadTimeWeeks != null ? `${r.typicalLeadTimeWeeks} wk` : null}</Muted>,
    },
    {
      key: 'std',
      header: 'Meets standards',
      align: 'right',
      cell: (r) => <Muted>{r.brandStandardItemIds.length || null}</Muted>,
    },
    ...(p.status !== 'active'
      ? [{ key: 'status', header: 'Status', cell: (r: Product) => <ProductStatus status={r.status} /> }]
      : []),
  ];

  return (
    <>
      <PageHeader
        title="Products"
        description="The shared product catalog: what network vendors make, and which brand-standard items each product meets."
        actions={
          canWrite && (
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
              Add product
            </Button>
          )
        }
      >
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <SearchInput
            value={text}
            onChange={setText}
            placeholder="Search name or SKU"
            className="w-full sm:w-72"
          />
          <div className="w-[220px]">
            <Select
              aria-label="Vendor"
              value={p.vendorId}
              onChange={(e) => set({ vendorId: e.target.value })}
              placeholder="Any vendor"
              options={(vendors.data ?? []).map((v) => ({ value: v.id, label: v.name }))}
            />
          </div>
          <div className="w-[190px]">
            <Select
              aria-label="Category"
              value={p.category}
              onChange={(e) => set({ category: e.target.value })}
              placeholder="Any category"
              options={categoryOptions}
            />
          </div>
          <div className="w-[160px]">
            <Select
              aria-label="Status"
              value={p.status}
              onChange={(e) => set({ status: e.target.value })}
              options={[
                { value: 'active', label: 'Active' },
                { value: 'discontinued', label: 'Discontinued' },
                { value: '', label: 'Any status' },
              ]}
            />
          </div>
          {filtered && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setText('');
                set({ q: '', vendorId: '', category: '', status: 'active' });
              }}
            >
              Clear filters
            </Button>
          )}
          <span className="num ml-auto text-[13px] text-ink-3">
            {list.data ? `${list.data.total} ${list.data.total === 1 ? 'product' : 'products'}` : ''}
          </span>
        </div>
      </PageHeader>
      {list.isError ? (
        <ErrorNote error={list.error} />
      ) : (
        <div className="bg-paper [&_td:first-child]:pl-6 [&_td:last-child]:pr-6 [&_th:first-child]:pl-6 [&_th:last-child]:pr-6">
          <DataTable
            columns={columns}
            rows={list.data?.items}
            loading={list.isLoading}
            onRowClick={(r) => setOpen(r.id)}
            empty={
              filtered ? (
                <EmptyState icon={<Boxes />} title="No products match these filters">
                  Try another vendor or category, or clear the filters.
                </EmptyState>
              ) : (
                <EmptyState
                  icon={<Boxes />}
                  title="No products in the catalog yet"
                  action={
                    canWrite && (
                      <Button variant="primary" onClick={() => setEditing('new')}>
                        Add product
                      </Button>
                    )
                  }
                >
                  Add the products your vendors make so designers can match them to brand standards.
                </EmptyState>
              )
            }
            footer={
              list.data && (
                <Pagination
                  total={list.data.total}
                  limit={list.data.limit}
                  offset={list.data.offset}
                  onChange={(o) => set({ offset: String(o) })}
                />
              )
            }
          />
        </div>
      )}
      <ProductSheet
        product={open}
        onClose={() => setOpen(null)}
        onEdit={
          canWrite
            ? (x) => {
                setOpen(null);
                setEditing(x);
              }
            : undefined
        }
      />
      {canWrite && (
        <ProductFormSheet product={editing} onClose={() => setEditing(null)} onSaved={(x) => setOpen(x.id)} />
      )}
    </>
  );
}

export function ProductSheet({
  product,
  onClose,
  onEdit,
}: {
  product: Product | null;
  onClose: () => void;
  onEdit?: (p: Product) => void;
}) {
  if (!product) return null;
  const attrs = Object.entries(product.attributes ?? {});
  return (
    <Sheet
      open
      onClose={onClose}
      title={product.name}
      description={
        <>
          <span className="num">{product.sku}</span> ·{' '}
          <Link to={`/app/catalog/vendors/${product.vendorId}`} className="text-lacquer hover:underline">
            {product.vendorName}
          </Link>
        </>
      }
      footer={
        onEdit ? (
          <Button icon={<Pencil className="size-4" />} onClick={() => onEdit(product)}>
            Edit product
          </Button>
        ) : undefined
      }
    >
      <div className="space-y-6">
        {product.imageUrls[0] && (
          <img
            src={product.imageUrls[0]}
            alt={product.name}
            className="max-h-64 w-full rounded-sm border border-line object-contain"
          />
        )}
        <Facts
          cols={2}
          items={[
            { label: 'Category', value: categoryLabel(product.category) },
            { label: 'Status', value: <ProductStatus status={product.status} /> },
            { label: 'Dimensions', value: <Muted>{product.dimensions}</Muted> },
            {
              label: 'Typical lead time',
              value: (
                <Muted>
                  {product.typicalLeadTimeWeeks != null ? `${product.typicalLeadTimeWeeks} weeks` : null}
                </Muted>
              ),
            },
            { label: 'Materials', value: <Muted>{product.materials}</Muted> },
            { label: 'Finishes', value: <Muted>{product.finishes.join(', ')}</Muted> },
          ]}
        />
        {product.description && <p className="whitespace-pre-line text-ink-2">{product.description}</p>}
        {attrs.length > 0 && (
          <Facts cols={2} items={attrs.map(([k, v]) => ({ label: k, value: String(v) }))} />
        )}
        <p className="text-[13px] text-ink-3">
          {product.brandStandardItemIds.length
            ? `Meets ${product.brandStandardItemIds.length} brand-standard ${product.brandStandardItemIds.length === 1 ? 'item' : 'items'}. Open a brand standard item to see its matching products.`
            : 'Not linked to any brand-standard item yet.'}
        </p>
      </div>
    </Sheet>
  );
}

const EMPTY = {
  vendorId: '',
  sku: '',
  name: '',
  category: 'casegoods',
  dimensions: '',
  materials: '',
  finishes: '',
  description: '',
  typicalLeadTimeWeeks: '',
  status: 'active',
};

function ProductFormSheet({
  product,
  onClose,
  onSaved,
}: {
  product: Product | 'new' | null;
  onClose: () => void;
  onSaved: (p: Product) => void;
}) {
  const qc = useQueryClient();
  const vendors = useVendorOptions();
  const existing = product && product !== 'new' ? product : null;
  const [f, setF] = useState(EMPTY);
  useEffect(() => {
    setF(
      existing
        ? {
            vendorId: existing.vendorId,
            sku: existing.sku,
            name: existing.name,
            category: existing.category,
            dimensions: existing.dimensions ?? '',
            materials: existing.materials ?? '',
            finishes: existing.finishes.join(', '),
            description: existing.description ?? '',
            typicalLeadTimeWeeks: existing.typicalLeadTimeWeeks?.toString() ?? '',
            status: existing.status,
          }
        : EMPTY,
    );
  }, [existing]);
  const set = (patch: Partial<typeof EMPTY>) => setF((x) => ({ ...x, ...patch }));
  const save = useMutation({
    mutationFn: () => {
      const body = {
        sku: f.sku.trim(),
        name: f.name.trim(),
        category: f.category,
        dimensions: f.dimensions.trim() || null,
        materials: f.materials.trim() || null,
        description: f.description.trim() || null,
        finishes: f.finishes
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean),
        typicalLeadTimeWeeks: f.typicalLeadTimeWeeks ? Math.round(Number(f.typicalLeadTimeWeeks)) : null,
        status: f.status as Product['status'],
      };
      return existing
        ? api.patch<Product>('catalog', `/products/${existing.id}`, body)
        : api.post<Product>('catalog', '/products', { ...body, vendorId: f.vendorId });
    },
    onSuccess: (x) => {
      toast.success(existing ? 'Product saved' : 'Product added');
      qc.invalidateQueries({ queryKey: ['catalog'] });
      onClose();
      onSaved(x);
    },
  });
  if (!product) return null;
  const valid = (existing || f.vendorId) && f.sku.trim() && f.name.trim();
  return (
    <Sheet
      open
      onClose={onClose}
      title={existing ? `Edit ${existing.sku}` : 'Add product'}
      description="Products are shared with every firm on Pro-Cure. Pricing stays in your private spec library."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!valid} loading={save.isPending} onClick={() => save.mutate()}>
            {existing ? 'Save product' : 'Add product'}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Vendor" className="sm:col-span-2">
          {(id) => (
            <Select
              id={id}
              disabled={!!existing}
              value={f.vendorId}
              onChange={(e) => set({ vendorId: e.target.value })}
              placeholder="Choose a vendor"
              options={(vendors.data ?? []).map((v) => ({ value: v.id, label: v.name }))}
            />
          )}
        </Field>
        <Field label="SKU">
          {(id) => <Input id={id} value={f.sku} onChange={(e) => set({ sku: e.target.value })} />}
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
          {(id) => <Input id={id} value={f.name} onChange={(e) => set({ name: e.target.value })} />}
        </Field>
        <Field label="Dimensions">
          {(id) => (
            <Input id={id} value={f.dimensions} onChange={(e) => set({ dimensions: e.target.value })} />
          )}
        </Field>
        <Field label="Typical lead time (weeks)">
          {(id) => (
            <Input
              id={id}
              type="number"
              min={0}
              value={f.typicalLeadTimeWeeks}
              onChange={(e) => set({ typicalLeadTimeWeeks: e.target.value })}
            />
          )}
        </Field>
        <Field label="Materials" className="sm:col-span-2">
          {(id) => <Input id={id} value={f.materials} onChange={(e) => set({ materials: e.target.value })} />}
        </Field>
        <Field label="Finishes" hint="Comma-separated" className="sm:col-span-2">
          {(id) => <Input id={id} value={f.finishes} onChange={(e) => set({ finishes: e.target.value })} />}
        </Field>
        <Field label="Description" className="sm:col-span-2">
          {(id) => (
            <Textarea id={id} value={f.description} onChange={(e) => set({ description: e.target.value })} />
          )}
        </Field>
        {existing && (
          <Field label="Status">
            {(id) => (
              <Select
                id={id}
                value={f.status}
                onChange={(e) => set({ status: e.target.value })}
                options={[
                  { value: 'active', label: 'Active' },
                  { value: 'discontinued', label: 'Discontinued' },
                ]}
              />
            )}
          </Field>
        )}
      </div>
    </Sheet>
  );
}
