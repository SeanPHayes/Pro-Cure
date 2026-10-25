import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BadgeCheck, Plus, Star, Store } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';
import {
  Button,
  Chips,
  cx,
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
import { ApiError, api, errorMessage, type Page } from '@/lib/api';
import { hasPerm, useSession } from '@/lib/auth';
import { pct } from '@/lib/format';
import { useListParams, useSearchParamInput } from '@/lib/hooks';
import {
  categoryLabel,
  categoryOptions,
  hq,
  Muted,
  qk,
  Rating,
  rate,
  type Vendor,
  type VendorPerformance,
  type VendorSuggestion,
} from './shared';

const DEFAULTS = { q: '', category: '', scope: 'mine', limit: '50' };

export function Component() {
  const s = useSession();
  const nav = useNavigate();
  const [p, set] = useListParams(DEFAULTS);
  const [text, setText] = useSearchParamInput(p.q, (q) => set({ q }));
  const [adding, setAdding] = useState(false);
  const query = {
    q: p.q || undefined,
    category: p.category || undefined,
    onlyMine: p.scope === 'mine' ? true : undefined,
    limit: Number(p.limit),
    offset: Number(p.offset),
  };
  const list = useQuery({
    queryKey: qk.vendors(query),
    queryFn: () => api.get<Page<Vendor>>('catalog', '/vendors', query),
    placeholderData: keepPreviousData,
  });
  // Measured on-time performance from the risk model (keyed by vendor); falls back to the profile figure.
  const perf = useQuery({
    queryKey: ['ai', 'vendor-performance'],
    queryFn: () => api.get<Page<VendorPerformance>>('ai', '/vendor-performance', { limit: 500 }),
    enabled: hasPerm(s, 'ai:use'),
    meta: { silent: true },
    retry: false,
  });
  const perfBy = new Map(perf.data?.items.map((x) => [x.vendorId, x]));
  const canWrite = hasPerm(s, 'vendors:write');
  const filtered = !!(p.q || p.category);

  const columns: Column<Vendor>[] = [
    {
      key: 'name',
      header: 'Vendor',
      cell: (r) => (
        <div className="min-w-[220px]">
          <div className="flex items-center gap-1.5 font-[560]">
            <Link
              to={`/app/catalog/vendors/${r.id}`}
              onClick={(e) => e.stopPropagation()}
              className="hover:text-lacquer"
            >
              {r.name}
            </Link>
            {r.verified && <BadgeCheck className="size-3.5 text-lacquer" aria-label="Verified by Pro-Cure" />}
          </div>
          <div className="text-[12px] text-ink-3">
            {r.profile ? (
              r.profile.preferred ? (
                <span className="inline-flex items-center gap-1 text-brass">
                  <Star className="size-3 fill-current" /> Preferred by your firm
                </span>
              ) : (
                'In your network'
              )
            ) : (
              'Network only'
            )}
          </div>
        </div>
      ),
    },
    {
      key: 'cats',
      header: 'Categories',
      cell: (r) => (
        <div className="max-w-[240px] truncate text-ink-2" title={r.categories.map(categoryLabel).join(', ')}>
          <Muted>{r.categories.map(categoryLabel).join(', ')}</Muted>
        </div>
      ),
    },
    {
      key: 'hq',
      header: 'Headquarters',
      cell: (r) => (
        <span className="whitespace-nowrap">
          <Muted>{hq(r)}</Muted>
        </span>
      ),
    },
    { key: 'rating', header: 'Rating', cell: (r) => <Rating value={r.profile?.rating} /> },
    {
      key: 'lead',
      header: 'Lead time',
      align: 'right',
      cell: (r) => <Muted>{r.profile?.leadTimeWeeks != null ? `${r.profile.leadTimeWeeks} wk` : null}</Muted>,
    },
    {
      key: 'deposit',
      header: 'Deposit',
      align: 'right',
      cell: (r) => <Muted>{r.profile?.depositPct != null ? pct(r.profile.depositPct, 0) : null}</Muted>,
    },
    {
      key: 'ontime',
      header: 'On time',
      align: 'right',
      cell: (r) => {
        const m = perfBy.get(r.id);
        const v = m?.onTimeRate ?? r.profile?.onTimeRate ?? null;
        return (
          <span
            className={cx(v !== null && v < 0.75 && 'text-risk')}
            title={m ? `Measured on ${m.sampleSize} deliveries` : undefined}
          >
            <Muted>{rate(v)}</Muted>
          </span>
        );
      },
    },
    {
      key: 'products',
      header: 'Products',
      align: 'right',
      cell: (r) => <Muted>{r.productCount || null}</Muted>,
    },
  ];

  return (
    <>
      <PageHeader
        title="Vendors"
        description="The Pro-Cure vendor network is shared across firms. Your terms, contacts and ratings for each vendor are private to your firm."
        actions={
          canWrite && (
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>
              Add vendor
            </Button>
          )
        }
      >
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <SearchInput
            value={text}
            onChange={setText}
            placeholder="Search vendors or email domains"
            className="w-full sm:w-72"
          />
          <Chips
            value={p.scope}
            onChange={(v) => set({ scope: v })}
            options={[
              { value: 'mine', label: 'In your network' },
              { value: 'all', label: 'Whole network' },
            ]}
          />
          <div className="w-[190px]">
            <Select
              aria-label="Category"
              value={p.category}
              onChange={(e) => set({ category: e.target.value })}
              placeholder="Any category"
              options={categoryOptions}
            />
          </div>
          {filtered && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setText('');
                set({ q: '', category: '' });
              }}
            >
              Clear filters
            </Button>
          )}
          <span className="num ml-auto text-[13px] text-ink-3">
            {list.data ? `${list.data.total} ${list.data.total === 1 ? 'vendor' : 'vendors'}` : ''}
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
            onRowClick={(r) => nav(`/app/catalog/vendors/${r.id}`)}
            empty={
              filtered || p.scope === 'all' ? (
                <EmptyState icon={<Store />} title="No vendors match these filters">
                  {p.scope === 'mine'
                    ? 'Search the whole network to find vendors your firm hasn’t worked with yet.'
                    : 'Try another name or category, or add the vendor to the network.'}
                </EmptyState>
              ) : (
                <EmptyState
                  icon={<Store />}
                  title="Your firm has no vendors yet"
                  action={
                    <Button variant="primary" onClick={() => set({ scope: 'all' })}>
                      Browse the network
                    </Button>
                  }
                >
                  Add vendors from the Pro-Cure network and record your terms with each.
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
      {canWrite && (
        <AddVendorSheet
          open={adding}
          onClose={() => setAdding(false)}
          onCreated={(v) => nav(`/app/catalog/vendors/${v.id}`)}
        />
      )}
    </>
  );
}

const EMPTY = {
  name: '',
  website: '',
  categories: [] as string[],
  hqCity: '',
  hqRegion: '',
  hqCountry: 'US',
  description: '',
  paymentTerms: '',
  depositPct: '',
  leadTimeWeeks: '',
  contactName: '',
  contactEmail: '',
  contactPhone: '',
};

export function AddVendorSheet({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (v: Vendor) => void;
}) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const [f, setF] = useState(EMPTY);
  const [suggestions, setSuggestions] = useState<VendorSuggestion[] | null>(null);
  useEffect(() => {
    if (open) {
      setF(EMPTY);
      setSuggestions(null);
    }
  }, [open]);
  const set = (patch: Partial<typeof EMPTY>) => setF((x) => ({ ...x, ...patch }));
  const num = (s: string) => (s.trim() === '' ? undefined : Number(s));

  const create = useMutation({
    mutationFn: (force: boolean) => {
      const contact =
        f.contactName || f.contactEmail || f.contactPhone
          ? { name: f.contactName || null, email: f.contactEmail || null, phone: f.contactPhone || null }
          : null;
      return api.post<Vendor>('catalog', '/vendors', {
        name: f.name.trim(),
        website: f.website.trim() || null,
        categories: f.categories,
        hqCity: f.hqCity.trim() || null,
        hqRegion: f.hqRegion.trim() || null,
        hqCountry: f.hqCountry.trim() || null,
        description: f.description.trim() || null,
        force,
        profile: {
          paymentTerms: f.paymentTerms.trim() || null,
          depositPct: num(f.depositPct) ?? null,
          leadTimeWeeks: num(f.leadTimeWeeks) ?? null,
          primaryContact: contact,
          contacts: contact ? [contact] : [],
        },
      });
    },
    onSuccess: (v) => {
      toast.success('Vendor added', { description: v.name });
      qc.invalidateQueries({ queryKey: ['catalog', 'vendors'] });
      onClose();
      onCreated(v);
    },
    onError: (e) => {
      const sug =
        e instanceof ApiError && e.status === 409
          ? (e.detail as { suggestions?: VendorSuggestion[] })?.suggestions
          : undefined;
      if (sug?.length) setSuggestions(sug);
      else toast.error(errorMessage(e));
    },
  });

  const useExisting = useMutation({
    mutationFn: (id: string) =>
      api.put('catalog', `/vendors/${id}/profile`, {
        paymentTerms: f.paymentTerms.trim() || undefined,
        depositPct: num(f.depositPct),
        leadTimeWeeks: num(f.leadTimeWeeks),
      }),
    onSuccess: (_d, id) => {
      toast.success('Vendor added to your network');
      qc.invalidateQueries({ queryKey: ['catalog'] });
      onClose();
      nav(`/app/catalog/vendors/${id}`);
    },
  });

  const valid = f.name.trim().length >= 2;
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Add vendor"
      description="Adds the company to the shared Pro-Cure network and starts your firm’s private record of terms."
      width={580}
      footer={
        suggestions ? (
          <>
            <Button variant="ghost" onClick={() => setSuggestions(null)}>
              Back to the form
            </Button>
            <Button loading={create.isPending} onClick={() => create.mutate(true)}>
              Create “{f.name.trim()}” anyway
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!valid}
              loading={create.isPending}
              onClick={() => create.mutate(false)}
            >
              Add vendor
            </Button>
          </>
        )
      }
    >
      {suggestions ? (
        <div>
          <div className="rounded-sm border border-warn/25 bg-warn-50 px-3 py-2 text-[13px]">
            <span className="font-[620]">This vendor may already be in the network.</span>{' '}
            <span className="text-ink-2">
              Pick the existing record to avoid a duplicate — your terms are added to it and stay private to
              your firm.
            </span>
          </div>
          <ul className="mt-4 divide-y divide-line-2 rounded-sm border border-line">
            {suggestions.map((x) => (
              <li key={x.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                <div>
                  <div className="font-[560]">{x.name}</div>
                  <div className="num text-[12px] text-ink-3">
                    {Math.round(x.similarity * 100)}% name match
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="primary"
                  loading={useExisting.isPending && useExisting.variables === x.id}
                  onClick={() => useExisting.mutate(x.id)}
                >
                  Use this vendor
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Company name" className="sm:col-span-2">
              {(id) => (
                <Input id={id} autoFocus value={f.name} onChange={(e) => set({ name: e.target.value })} />
              )}
            </Field>
            <Field label="Website" hint="Its domain is used to recognise emails from this vendor.">
              {(id) => (
                <Input
                  id={id}
                  value={f.website}
                  placeholder="https://"
                  onChange={(e) => set({ website: e.target.value })}
                />
              )}
            </Field>
            <Field label="City">
              {(id) => <Input id={id} value={f.hqCity} onChange={(e) => set({ hqCity: e.target.value })} />}
            </Field>
            <Field label="State or region">
              {(id) => (
                <Input id={id} value={f.hqRegion} onChange={(e) => set({ hqRegion: e.target.value })} />
              )}
            </Field>
            <Field label="Country">
              {(id) => (
                <Input id={id} value={f.hqCountry} onChange={(e) => set({ hqCountry: e.target.value })} />
              )}
            </Field>
            <div className="sm:col-span-2">
              <div className="mb-1.5 text-[13px] font-[560] text-ink-2">Categories</div>
              <CategoryPicker value={f.categories} onChange={(categories) => set({ categories })} />
            </div>
            <Field label="Description" className="sm:col-span-2">
              {(id) => (
                <Textarea
                  id={id}
                  value={f.description}
                  onChange={(e) => set({ description: e.target.value })}
                />
              )}
            </Field>
          </div>
          <div>
            <h3 className="font-[620]">Your terms</h3>
            <p className="mb-3 text-[13px] text-ink-3">
              Private to your firm. You can add the rest on the vendor page.
            </p>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Payment terms" className="sm:col-span-3">
                {(id) => (
                  <Input
                    id={id}
                    value={f.paymentTerms}
                    placeholder="50% deposit, balance net 30"
                    onChange={(e) => set({ paymentTerms: e.target.value })}
                  />
                )}
              </Field>
              <Field label="Deposit %">
                {(id) => (
                  <Input
                    id={id}
                    type="number"
                    min={0}
                    max={100}
                    value={f.depositPct}
                    onChange={(e) => set({ depositPct: e.target.value })}
                  />
                )}
              </Field>
              <Field label="Lead time (weeks)">
                {(id) => (
                  <Input
                    id={id}
                    type="number"
                    min={0}
                    value={f.leadTimeWeeks}
                    onChange={(e) => set({ leadTimeWeeks: e.target.value })}
                  />
                )}
              </Field>
              <div />
              <Field label="Contact name">
                {(id) => (
                  <Input
                    id={id}
                    value={f.contactName}
                    onChange={(e) => set({ contactName: e.target.value })}
                  />
                )}
              </Field>
              <Field label="Contact email">
                {(id) => (
                  <Input
                    id={id}
                    type="email"
                    value={f.contactEmail}
                    onChange={(e) => set({ contactEmail: e.target.value })}
                  />
                )}
              </Field>
              <Field label="Contact phone">
                {(id) => (
                  <Input
                    id={id}
                    value={f.contactPhone}
                    onChange={(e) => set({ contactPhone: e.target.value })}
                  />
                )}
              </Field>
            </div>
          </div>
        </div>
      )}
    </Sheet>
  );
}

/** Multi-select of spec categories as toggle pills. */
export function CategoryPicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {categoryOptions.map((o) => {
        const on = value.includes(o.value);
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(on ? value.filter((x) => x !== o.value) : [...value, o.value])}
            className={cx(
              'h-7 rounded-xs border px-2 text-[13px] font-[520]',
              on ? 'border-lacquer bg-lacquer-50 text-lacquer' : 'border-line text-ink-2 hover:border-ink-4',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
