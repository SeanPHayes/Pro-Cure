import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BadgeCheck, Lock, Plus, Star, Truck, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { toast } from 'sonner';
import { ActivityFeed } from '@/components/shared/ActivityFeed';
import { DocumentsPanel } from '@/components/shared/DocumentsPanel';
import {
  Button,
  Checkbox,
  EmptyState,
  ErrorNote,
  Facts,
  Field,
  IconButton,
  Input,
  Loading,
  PageHeader,
  Section,
  Select,
  Stat,
  StatusBadge,
  Tabs,
  Textarea,
  TitleBlock,
} from '@/components/ui';
import { type Column, DataTable } from '@/components/ui/DataTable';
import { api, type Page } from '@/lib/api';
import { hasPerm, useSession } from '@/lib/auth';
import { ago, pct } from '@/lib/format';
import { ProductSheet } from './ProductsPage';
import {
  type Contact,
  Crumb,
  categoryLabel,
  friendlyError,
  hq,
  Muted,
  type Product,
  qk,
  Rating,
  rate,
  type Vendor,
  type VendorPerformance,
  type VendorProfile,
} from './shared';

export function Component() {
  const { id = '' } = useParams();
  const s = useSession();
  const [tab, setTab] = useState('overview');
  const vendor = useQuery({
    queryKey: qk.vendor(id),
    queryFn: () => api.get<Vendor>('catalog', `/vendors/${id}`),
  });
  if (vendor.isLoading) return <Loading label="Loading vendor" />;
  if (vendor.isError || !vendor.data)
    return (
      <>
        <PageHeader title="Vendor" />
        <ErrorNote error={vendor.error ?? new Error('This vendor could not be found.')} />
      </>
    );
  const v = vendor.data;
  const pr = v.profile;
  const canWrite = hasPerm(s, 'vendors:write');

  return (
    <>
      <div className="border-b border-line bg-paper px-6 pt-4 pb-5 max-sm:px-4">
        <div className="mb-2">
          <Crumb to="/app/catalog/vendors">Vendors</Crumb>
        </div>
        <TitleBlock
          title={
            <span className="inline-flex items-center gap-2">
              {v.name}
              {v.verified && <BadgeCheck className="size-4 text-lacquer" aria-label="Verified by Pro-Cure" />}
            </span>
          }
          subtitle={
            pr?.preferred ? (
              <span className="inline-flex items-center gap-1 text-brass">
                <Star className="size-3.5 fill-current" />
                Preferred by your firm
              </span>
            ) : pr ? (
              'In your network'
            ) : (
              'Network vendor — your firm has no terms on record yet'
            )
          }
          fields={[
            { label: 'Headquarters', value: <Muted>{hq(v)}</Muted> },
            {
              label: 'Lead time',
              value: <Muted>{pr?.leadTimeWeeks != null ? `${pr.leadTimeWeeks} weeks` : null}</Muted>,
            },
            {
              label: 'Deposit',
              value: <Muted>{pr?.depositPct != null ? pct(pr.depositPct, 0) : null}</Muted>,
            },
            { label: 'Rating', value: <Rating value={pr?.rating} /> },
          ]}
        />
        <Tabs
          className="mt-4 -mb-5"
          value={tab}
          onChange={setTab}
          items={[
            { value: 'overview', label: 'Overview' },
            { value: 'terms', label: 'Your terms' },
            { value: 'products', label: 'Products', count: v.productCount },
            { value: 'files', label: 'Files' },
            { value: 'activity', label: 'Activity' },
          ]}
        />
      </div>
      <div className="px-6 py-5 max-sm:px-4">
        {tab === 'overview' && <Overview v={v} onEditTerms={() => setTab('terms')} canWrite={canWrite} />}
        {tab === 'terms' && <TermsForm v={v} canWrite={canWrite} />}
        {tab === 'products' && <VendorProducts vendorId={v.id} />}
        {tab === 'files' && (
          <Section title="Files">
            <DocumentsPanel entityType="vendor" entityId={v.id} defaultKind="contract" readOnly={!canWrite} />
          </Section>
        )}
        {tab === 'activity' && (
          <Section title="History">
            <ActivityFeed service="catalog" path={`/vendors/${v.id}/activity`} />
          </Section>
        )}
      </div>
    </>
  );
}

function Overview({ v, onEditTerms, canWrite }: { v: Vendor; onEditTerms: () => void; canWrite: boolean }) {
  const pr = v.profile;
  const contacts = pr?.contacts?.length ? pr.contacts : pr?.primaryContact ? [pr.primaryContact] : [];
  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
      <div className="space-y-5">
        <Section
          title={
            <span className="inline-flex items-center gap-2">
              Your terms <Lock className="size-3.5 text-ink-3" aria-label="Private" />
            </span>
          }
          actions={
            canWrite && (
              <Button size="sm" onClick={onEditTerms}>
                {pr ? 'Edit terms' : 'Add your terms'}
              </Button>
            )
          }
        >
          {pr ? (
            <div className="[&_dl]:grid-cols-2 sm:[&_dl]:grid-cols-3">
              <Facts
                cols={3}
                items={[
                  { label: 'Payment terms', value: <Muted>{pr.paymentTerms}</Muted> },
                  {
                    label: 'Deposit',
                    value: <Muted>{pr.depositPct != null ? pct(pr.depositPct, 0) : null}</Muted>,
                  },
                  { label: 'Account number', value: <Muted>{pr.accountNumber}</Muted> },
                  {
                    label: 'Lead time',
                    value: <Muted>{pr.leadTimeWeeks != null ? `${pr.leadTimeWeeks} weeks` : null}</Muted>,
                  },
                  {
                    label: 'Transit',
                    value: <Muted>{pr.transitDays != null ? `${pr.transitDays} days` : null}</Muted>,
                  },
                  {
                    label: 'Origin',
                    value: (
                      <Muted>
                        {pr.origin === 'international'
                          ? 'International'
                          : pr.origin === 'domestic'
                            ? 'Domestic'
                            : null}
                      </Muted>
                    ),
                  },
                  { label: 'Ship method', value: <Muted>{pr.shipMethod}</Muted> },
                  { label: 'Freight terms', value: <Muted>{pr.freightTerms}</Muted> },
                  { label: 'Tags', value: <Muted>{pr.tags.length ? pr.tags.join(', ') : null}</Muted> },
                ]}
              />
            </div>
          ) : (
            <EmptyState title="No terms on record">
              Add your payment terms, lead time and contacts so quotes and purchase orders use them.
            </EmptyState>
          )}
          {pr?.notes && (
            <p className="mt-4 border-t border-line-2 pt-3 whitespace-pre-line text-ink-2">{pr.notes}</p>
          )}
        </Section>
        <PerformancePanel vendorId={v.id} />
      </div>
      <div className="space-y-5">
        <Section title="Network listing">
          <Facts
            items={[
              {
                label: 'Website',
                value: v.website ? (
                  <a
                    href={v.website}
                    target="_blank"
                    rel="noreferrer"
                    className="text-lacquer hover:underline"
                  >
                    {v.website.replace(/^https?:\/\//, '')}
                  </a>
                ) : null,
              },
              { label: 'Categories', value: <Muted>{v.categories.map(categoryLabel).join(', ')}</Muted> },
              { label: 'Email domains', value: <Muted>{v.emailDomains.join(', ')}</Muted> },
              {
                label: 'Portal',
                value: v.orgId ? 'Uses the Pro-Cure vendor portal' : 'Not on the vendor portal yet',
              },
              { label: 'About', value: <Muted>{v.description}</Muted> },
            ]}
          />
          <p className="mt-4 text-[12px] text-ink-3">
            Shared with every firm on Pro-Cure.{' '}
            {v.verified ? 'Verified by Pro-Cure.' : 'Not yet verified by Pro-Cure.'}
          </p>
        </Section>
        <Section title="Contacts">
          {contacts.length ? (
            <ul className="space-y-3">
              {contacts.map((c) => (
                <li key={`${c.email}${c.name}`}>
                  <div className="font-[560]">
                    {c.name ?? c.email}
                    {c.role && <span className="ml-1.5 font-normal text-ink-3">{c.role}</span>}
                  </div>
                  <div className="text-[13px] text-ink-2">
                    {c.email && (
                      <a href={`mailto:${c.email}`} className="hover:text-lacquer hover:underline">
                        {c.email}
                      </a>
                    )}
                    {c.email && c.phone && ' · '}
                    {c.phone}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-ink-3">No contacts yet. Add them under Your terms.</p>
          )}
        </Section>
      </div>
    </div>
  );
}

function PerformancePanel({ vendorId }: { vendorId: string }) {
  const s = useSession();
  const q = useQuery({
    queryKey: ['ai', 'vendor-performance', vendorId],
    queryFn: () => api.get<Page<VendorPerformance>>('ai', '/vendor-performance', { vendorId }),
    enabled: hasPerm(s, 'ai:use'),
    meta: { silent: true },
    retry: false,
  });
  const m = q.data?.items[0];
  return (
    <Section
      title={
        <span className="inline-flex items-center gap-2">
          <Truck className="size-4 text-ink-3" /> Delivery performance
        </span>
      }
      actions={m && <span className="text-[12px] text-ink-3">Updated {ago(m.updatedAt)}</span>}
    >
      {!hasPerm(s, 'ai:use') ? (
        <p className="text-ink-3">Delivery analytics are available to users with AI assistant access.</p>
      ) : q.isLoading ? (
        <Loading />
      ) : q.isError ? (
        <p className="text-crit">{friendlyError(q.error, 'Delivery analytics')}</p>
      ) : !m || m.sampleSize === 0 ? (
        <EmptyState title="Not enough history yet">
          On-time rate and slip appear once this vendor has delivered on a few of your purchase orders and the
          risk model has run.{' '}
          <Link to="/app/ai" className="font-[560] text-lacquer hover:underline">
            Run delivery risk
          </Link>
        </EmptyState>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-5 sm:grid-cols-4">
            <Stat
              label="On time"
              value={rate(m.onTimeRate) ?? '—'}
              tone={m.onTimeRate !== null && m.onTimeRate < 0.75 ? 'risk' : 'ok'}
            />
            <Stat label="Mean slip" value={m.meanSlipDays != null ? `${m.meanSlipDays.toFixed(1)} d` : '—'} />
            <Stat
              label="90th percentile slip"
              value={m.p90SlipDays != null ? `${m.p90SlipDays.toFixed(0)} d` : '—'}
            />
            <Stat label="Deliveries measured" value={m.sampleSize} />
          </div>
          <p className="mt-4 text-[12px] text-ink-3">
            {m.sampleSize < 5
              ? 'Few deliveries so far — figures lean on your firm’s average across all vendors.'
              : 'Measured from your firm’s purchase orders, adjusted toward your average when history is thin.'}
            {m.shipDateChangeRate != null &&
              ` Ship dates changed on ${rate(m.shipDateChangeRate)} of orders.`}
          </p>
        </>
      )}
    </Section>
  );
}

// ------------------------------------------------------------------ Terms (private profile)
interface TermsDraft {
  paymentTerms: string;
  depositPct: string;
  leadTimeWeeks: string;
  transitDays: string;
  origin: string;
  shipMethod: string;
  freightTerms: string;
  accountNumber: string;
  rating: string;
  preferred: boolean;
  notes: string;
  tags: string;
  contacts: Contact[];
}
const toDraft = (p: VendorProfile | null): TermsDraft => ({
  paymentTerms: p?.paymentTerms ?? '',
  depositPct: p?.depositPct?.toString() ?? '',
  leadTimeWeeks: p?.leadTimeWeeks?.toString() ?? '',
  transitDays: p?.transitDays?.toString() ?? '',
  origin: p?.origin ?? '',
  shipMethod: p?.shipMethod ?? '',
  freightTerms: p?.freightTerms ?? '',
  accountNumber: p?.accountNumber ?? '',
  rating: p?.rating?.toString() ?? '',
  preferred: p?.preferred ?? false,
  notes: p?.notes ?? '',
  tags: p?.tags.join(', ') ?? '',
  contacts: p?.contacts?.length ? p.contacts : p?.primaryContact ? [p.primaryContact] : [],
});

function TermsForm({ v, canWrite }: { v: Vendor; canWrite: boolean }) {
  const qc = useQueryClient();
  const initial = useMemo(() => toDraft(v.profile), [v.profile]);
  const [f, setF] = useState(initial);
  useEffect(() => setF(initial), [initial]);
  const dirty = JSON.stringify(f) !== JSON.stringify(initial);
  const set = (patch: Partial<TermsDraft>) => setF((x) => ({ ...x, ...patch }));
  const n = (s: string) => (s.trim() === '' ? null : Number(s));
  const errors = {
    depositPct:
      f.depositPct && (Number(f.depositPct) < 0 || Number(f.depositPct) > 100)
        ? 'Between 0 and 100'
        : undefined,
    rating: f.rating && (Number(f.rating) < 0 || Number(f.rating) > 5) ? 'Between 0 and 5' : undefined,
  };
  const save = useMutation({
    mutationFn: () => {
      const contacts = f.contacts.filter((c) => c.name || c.email || c.phone);
      return api.put<VendorProfile>('catalog', `/vendors/${v.id}/profile`, {
        paymentTerms: f.paymentTerms.trim() || null,
        depositPct: n(f.depositPct),
        leadTimeWeeks: n(f.leadTimeWeeks) === null ? null : Math.round(Number(f.leadTimeWeeks)),
        transitDays: n(f.transitDays) === null ? null : Math.round(Number(f.transitDays)),
        origin: f.origin || null,
        shipMethod: f.shipMethod.trim() || null,
        freightTerms: f.freightTerms.trim() || null,
        accountNumber: f.accountNumber.trim() || null,
        rating: n(f.rating),
        preferred: f.preferred,
        notes: f.notes.trim() || null,
        tags: f.tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
        contacts,
        primaryContact: contacts[0] ?? null,
      });
    },
    onSuccess: () => {
      toast.success('Terms saved');
      qc.invalidateQueries({ queryKey: qk.vendor(v.id) });
      qc.invalidateQueries({ queryKey: ['catalog', 'vendors'] });
      qc.invalidateQueries({ queryKey: ['activity', 'catalog'] });
    },
  });
  const ro = !canWrite;
  return (
    <div className="max-w-[880px]">
      <div className="mb-4 flex items-start gap-2.5 rounded-sm border border-lacquer/20 bg-lacquer-50 px-3 py-2.5 text-[13px]">
        <Lock className="mt-0.5 size-4 shrink-0 text-lacquer" />
        <div>
          <span className="font-[620]">Private to your firm.</span>{' '}
          <span className="text-ink-2">
            Other firms on Pro-Cure and {v.name} itself never see these terms. Quotes and purchase orders use
            them as defaults.
          </span>
        </div>
      </div>
      <Section title="Commercial terms">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Payment terms" className="sm:col-span-2">
            {(id) => (
              <Input
                id={id}
                disabled={ro}
                value={f.paymentTerms}
                placeholder="50% deposit, balance net 30"
                onChange={(e) => set({ paymentTerms: e.target.value })}
              />
            )}
          </Field>
          <Field label="Deposit %" error={errors.depositPct}>
            {(id) => (
              <Input
                id={id}
                disabled={ro}
                type="number"
                min={0}
                max={100}
                step="any"
                value={f.depositPct}
                onChange={(e) => set({ depositPct: e.target.value })}
              />
            )}
          </Field>
          <Field label="Account number">
            {(id) => (
              <Input
                id={id}
                disabled={ro}
                value={f.accountNumber}
                onChange={(e) => set({ accountNumber: e.target.value })}
              />
            )}
          </Field>
          <Field label="Rating (0–5)" error={errors.rating}>
            {(id) => (
              <Input
                id={id}
                disabled={ro}
                type="number"
                min={0}
                max={5}
                step={0.1}
                value={f.rating}
                onChange={(e) => set({ rating: e.target.value })}
              />
            )}
          </Field>
          {/* biome-ignore lint/a11y/noLabelWithoutControl: wraps the Checkbox input */}
          <label className="flex items-center gap-2 self-end pb-2">
            <Checkbox
              checked={f.preferred}
              onChange={(preferred) => !ro && set({ preferred })}
              label="Preferred vendor"
            />
            <span className="font-[560]">Preferred vendor</span>
          </label>
        </div>
      </Section>
      <Section title="Lead time and shipping" className="mt-5">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Lead time (weeks)" hint="Production time from approved order to ready to ship.">
            {(id) => (
              <Input
                id={id}
                disabled={ro}
                type="number"
                min={0}
                value={f.leadTimeWeeks}
                onChange={(e) => set({ leadTimeWeeks: e.target.value })}
              />
            )}
          </Field>
          <Field label="Transit (days)">
            {(id) => (
              <Input
                id={id}
                disabled={ro}
                type="number"
                min={0}
                value={f.transitDays}
                onChange={(e) => set({ transitDays: e.target.value })}
              />
            )}
          </Field>
          <Field label="Origin">
            {(id) => (
              <Select
                id={id}
                disabled={ro}
                value={f.origin}
                onChange={(e) => set({ origin: e.target.value })}
                placeholder="Not set"
                options={[
                  { value: 'domestic', label: 'Domestic' },
                  { value: 'international', label: 'International' },
                ]}
              />
            )}
          </Field>
          <Field label="Ship method">
            {(id) => (
              <Input
                id={id}
                disabled={ro}
                value={f.shipMethod}
                placeholder="LTL, dedicated truck, ocean…"
                onChange={(e) => set({ shipMethod: e.target.value })}
              />
            )}
          </Field>
          <Field label="Freight terms" className="sm:col-span-2">
            {(id) => (
              <Input
                id={id}
                disabled={ro}
                value={f.freightTerms}
                placeholder="FOB origin, prepay & add"
                onChange={(e) => set({ freightTerms: e.target.value })}
              />
            )}
          </Field>
        </div>
      </Section>
      <Section
        title="Contacts"
        className="mt-5"
        actions={
          !ro && (
            <Button
              size="sm"
              variant="ghost"
              icon={<Plus className="size-3.5" />}
              onClick={() => set({ contacts: [...f.contacts, { name: '', email: '', phone: '', role: '' }] })}
            >
              Add contact
            </Button>
          )
        }
      >
        {!f.contacts.length ? (
          <p className="text-ink-3">
            No contacts yet. The first contact is used as the primary contact on cost requests and POs.
          </p>
        ) : (
          <div className="space-y-3">
            {f.contacts.map((c, i) => {
              const upd = (patch: Partial<Contact>) => {
                const next = [...f.contacts];
                next[i] = { ...c, ...patch };
                set({ contacts: next });
              };
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: contact rows are positional
                <div key={i} className="grid items-end gap-2 sm:grid-cols-[1fr_1fr_1.3fr_1fr_auto]">
                  <Field label={i === 0 ? 'Name (primary)' : 'Name'}>
                    {(id) => (
                      <Input
                        id={id}
                        disabled={ro}
                        value={c.name ?? ''}
                        onChange={(e) => upd({ name: e.target.value })}
                      />
                    )}
                  </Field>
                  <Field label="Role">
                    {(id) => (
                      <Input
                        id={id}
                        disabled={ro}
                        value={c.role ?? ''}
                        onChange={(e) => upd({ role: e.target.value })}
                      />
                    )}
                  </Field>
                  <Field label="Email">
                    {(id) => (
                      <Input
                        id={id}
                        disabled={ro}
                        type="email"
                        value={c.email ?? ''}
                        onChange={(e) => upd({ email: e.target.value })}
                      />
                    )}
                  </Field>
                  <Field label="Phone">
                    {(id) => (
                      <Input
                        id={id}
                        disabled={ro}
                        value={c.phone ?? ''}
                        onChange={(e) => upd({ phone: e.target.value })}
                      />
                    )}
                  </Field>
                  {!ro && (
                    <IconButton
                      label="Remove contact"
                      className="mb-0.5"
                      onClick={() => set({ contacts: f.contacts.filter((_, j) => j !== i) })}
                    >
                      <X className="size-4" />
                    </IconButton>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Section>
      <Section title="Notes" className="mt-5">
        <div className="grid gap-4">
          <Field label="Tags" hint="Comma-separated, e.g. preferred, quick-ship">
            {(id) => (
              <Input id={id} disabled={ro} value={f.tags} onChange={(e) => set({ tags: e.target.value })} />
            )}
          </Field>
          <Field label="Internal notes">
            {(id) => (
              <Textarea
                id={id}
                disabled={ro}
                value={f.notes}
                onChange={(e) => set({ notes: e.target.value })}
              />
            )}
          </Field>
        </div>
      </Section>
      {!ro && (
        <div className="sticky bottom-0 mt-5 flex items-center justify-end gap-2 border-t border-line bg-stone py-3">
          {dirty && <span className="mr-auto text-[13px] text-ink-3">Unsaved changes</span>}
          <Button variant="ghost" disabled={!dirty} onClick={() => setF(initial)}>
            Discard changes
          </Button>
          <Button
            variant="primary"
            disabled={!dirty || !!errors.depositPct || !!errors.rating}
            loading={save.isPending}
            onClick={() => save.mutate()}
          >
            Save terms
          </Button>
        </div>
      )}
    </div>
  );
}

function VendorProducts({ vendorId }: { vendorId: string }) {
  const [open, setOpen] = useState<Product | null>(null);
  const q = useQuery({
    queryKey: ['catalog', 'vendor-products', vendorId],
    queryFn: () => api.get<Page<Product>>('catalog', `/vendors/${vendorId}/products`, { limit: 200 }),
  });
  const columns: Column<Product>[] = [
    { key: 'sku', header: 'SKU', width: 140, cell: (r) => <span className="num font-[560]">{r.sku}</span> },
    { key: 'name', header: 'Product', cell: (r) => <div className="min-w-[220px]">{r.name}</div> },
    { key: 'cat', header: 'Category', cell: (r) => categoryLabel(r.category) },
    {
      key: 'lead',
      header: 'Typical lead time',
      align: 'right',
      cell: (r) => <Muted>{r.typicalLeadTimeWeeks != null ? `${r.typicalLeadTimeWeeks} wk` : null}</Muted>,
    },
    {
      key: 'std',
      header: 'Brand standards',
      align: 'right',
      cell: (r) => <Muted>{r.brandStandardItemIds.length || null}</Muted>,
    },
    {
      key: 'status',
      header: 'Status',
      cell: (r) => (
        <StatusBadge
          status={r.status === 'active' ? 'active' : 'cancelled'}
          label={r.status === 'active' ? 'Active' : 'Discontinued'}
        />
      ),
    },
  ];
  if (q.isError) return <ErrorNote error={q.error} />;
  return (
    <Section bodyClassName="p-0">
      <DataTable
        columns={columns}
        rows={q.data?.items}
        loading={q.isLoading}
        onRowClick={setOpen}
        empty={
          <EmptyState title="No products listed">
            Products this vendor offers in the shared catalog appear here.
          </EmptyState>
        }
      />
      <ProductSheet product={open} onClose={() => setOpen(null)} />
    </Section>
  );
}
