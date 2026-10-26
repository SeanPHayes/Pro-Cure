import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { differenceInCalendarDays, parseISO } from 'date-fns';
import { Plus, ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { uploadDocument } from '@/components/shared/DocumentsPanel';
import {
  Badge,
  Button,
  Chips,
  EmptyState,
  ErrorNote,
  Field,
  PageHeader,
  SearchInput,
  Select,
  Sheet,
  Textarea,
} from '@/components/ui';
import { type Column, DataTable, Pagination } from '@/components/ui/DataTable';
import { api, type Page } from '@/lib/api';
import { hasPerm, useSession } from '@/lib/auth';
import { date, money } from '@/lib/format';
import { useListParams, useSearchParamInput } from '@/lib/hooks';
import {
  CLAIM_STATUS_LABEL,
  CLAIM_TONE,
  CLAIM_TYPE_LABEL,
  FilePicker,
  isClosedClaim,
  ok,
  useInvalidateOrders,
  useProjectsLite,
  useVendorsLite,
} from './shared';
import type { Claim, ClaimType, PoDetail, PoGridRow } from './types';

const OPEN = 'open,submitted_to_vendor,vendor_acknowledged,replacement_ordered';
const DEFAULTS = { show: 'open', projectId: '', vendorId: '', q: '', limit: '50' };
const REPORTER: Record<string, { label: string; tone: 'neutral' | 'brass' | 'info' }> = {
  internal: { label: 'Our team', tone: 'neutral' },
  client: { label: 'Owner', tone: 'brass' },
  vendor: { label: 'Vendor', tone: 'info' },
};

export function Component() {
  const s = useSession();
  const nav = useNavigate();
  const canWrite = hasPerm(s, 'claims:write');
  const [p, set] = useListParams(DEFAULTS);
  const [text, setText] = useSearchParamInput(p.q, (q) => set({ q }));
  const projects = useProjectsLite();
  const vendors = useVendorsLite();
  const [creating, setCreating] = useState(false);
  const query = {
    status:
      p.show === 'open'
        ? OPEN
        : p.show === 'closed'
          ? 'credited,resolved,rejected'
          : p.show === 'new'
            ? 'open'
            : undefined,
    projectId: p.projectId || undefined,
    vendorId: p.vendorId || undefined,
    q: p.q || undefined,
    limit: Number(p.limit),
    offset: Number(p.offset),
  };
  const list = useQuery({
    queryKey: ok.claims(query),
    queryFn: () => api.get<Page<Claim>>('orders', '/claims', query),
    placeholderData: keepPreviousData,
  });
  const projectName = (id: string) => projects.data?.find((x) => x.id === id)?.name;

  const cols: Column<Claim>[] = [
    {
      key: 'number',
      header: 'Claim',
      cell: (r) => (
        <div className="whitespace-nowrap">
          <div className="num font-[620]">{r.number}</div>
          <div className="text-[12px] text-ink-3">{CLAIM_TYPE_LABEL[r.type]}</div>
        </div>
      ),
    },
    {
      key: 'desc',
      header: 'What happened',
      cell: (r) => (
        <div className="line-clamp-2 max-w-[420px] min-w-[240px] text-[13px] text-ink-2">{r.description}</div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (r) => <Badge tone={CLAIM_TONE[r.status]}>{CLAIM_STATUS_LABEL[r.status]}</Badge>,
    },
    {
      key: 'order',
      header: 'Order · vendor',
      cell: (r) => (
        <div className="max-w-[200px] min-w-[140px]">
          <div className="num truncate">{r.poNumber ?? 'No order yet'}</div>
          <div className="truncate text-[12px] text-ink-3">{r.vendorName ?? '—'}</div>
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
      key: 'by',
      header: 'Reported by',
      cell: (r) => (
        <div className="whitespace-nowrap">
          <Badge tone={REPORTER[r.reportedByActor]?.tone}>{REPORTER[r.reportedByActor]?.label}</Badge>
          <div className="mt-0.5 text-[12px] text-ink-3">{r.reportedByName}</div>
        </div>
      ),
    },
    {
      key: 'age',
      header: 'Age',
      align: 'right',
      cell: (r) => {
        const end = r.resolvedAt ? parseISO(r.resolvedAt) : new Date();
        const d = differenceInCalendarDays(end, parseISO(r.reportedAt));
        return (
          <div className="whitespace-nowrap">
            <div className={!isClosedClaim(r.status) && d > 14 ? 'font-[560] text-warn' : undefined}>
              {d === 0 ? 'Today' : `${d} ${d === 1 ? 'day' : 'days'}`}
            </div>
            <div className="text-[12px] text-ink-3">
              {r.resolvedAt ? `closed ${date(r.resolvedAt)}` : date(r.reportedAt)}
            </div>
          </div>
        );
      },
    },
    {
      key: 'credit',
      header: 'Credit',
      align: 'right',
      cell: (r) => (r.creditAmount ? money(r.creditAmount) : <span className="text-ink-4">—</span>),
    },
  ];

  return (
    <>
      <PageHeader
        title="Claims"
        description="Damaged, missing and wrong items, reported by your team, owners or found at receiving, through to replacement or credit."
        actions={
          canWrite && (
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
              Open claim
            </Button>
          )
        }
      >
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Chips
            value={p.show as 'open' | 'new' | 'closed' | 'all'}
            onChange={(show) => set({ show })}
            options={[
              { value: 'open', label: 'Open' },
              { value: 'new', label: 'Not yet sent to vendor' },
              { value: 'closed', label: 'Closed' },
              { value: 'all', label: 'All' },
            ]}
          />
          <div className="w-full sm:w-[220px]">
            <Select
              aria-label="Project"
              value={p.projectId}
              onChange={(e) => set({ projectId: e.target.value })}
              placeholder="All projects"
              options={(projects.data ?? []).map((x) => ({ value: x.id, label: `${x.number} ${x.name}` }))}
            />
          </div>
          <div className="w-full sm:w-[180px]">
            <Select
              aria-label="Vendor"
              value={p.vendorId}
              onChange={(e) => set({ vendorId: e.target.value })}
              placeholder="All vendors"
              options={(vendors.data ?? []).map((x) => ({ value: x.id, label: x.name }))}
            />
          </div>
          <SearchInput
            value={text}
            onChange={setText}
            placeholder="Claim, PO or description"
            className="w-full sm:w-56"
          />
        </div>
      </PageHeader>
      <div className="px-4 py-4 sm:px-6">
        <div className="overflow-hidden rounded-md border border-line bg-paper">
          {list.isError ? (
            <ErrorNote error={list.error} />
          ) : (
            <DataTable
              columns={cols}
              rows={list.data?.items}
              loading={list.isLoading}
              onRowClick={(r) => nav(`/app/claims/${r.id}`)}
              empty={
                <EmptyState
                  icon={<ShieldAlert />}
                  title={p.show === 'open' ? 'No open claims' : 'No claims here'}
                >
                  Claims open automatically when damage is recorded at receiving, and when an owner reports a
                  problem in their portal.
                </EmptyState>
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
          )}
        </div>
      </div>
      <NewClaimSheet open={creating} onClose={() => setCreating(false)} />
    </>
  );
}

const TYPES: ClaimType[] = ['damage', 'concealed_damage', 'shortage', 'wrong_item', 'defect', 'other'];

function NewClaimSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const nav = useNavigate();
  const invalidate = useInvalidateOrders();
  const projects = useProjectsLite();
  const [projectId, setProjectId] = useState('');
  const [poId, setPoId] = useState('');
  const [type, setType] = useState<ClaimType>('damage');
  const [desc, setDesc] = useState('');
  const [qty, setQty] = useState<Record<string, string>>({});
  const [photos, setPhotos] = useState<File[]>([]);
  const pos = useQuery({
    queryKey: ['orders', 'claim-pos', projectId],
    queryFn: () =>
      api.get<Page<PoGridRow>>('orders', '/purchase-orders', { projectId, limit: 200, includeClosed: true }),
    enabled: open && !!projectId,
  });
  const po = useQuery({
    queryKey: ['orders', 'po', poId],
    queryFn: () => api.get<PoDetail>('orders', `/purchase-orders/${poId}`),
    enabled: !!poId,
  });
  const m = useMutation({
    mutationFn: async () => {
      const ids: string[] = [];
      const vendorOrgId = po.data?.vendorOrgId ?? null;
      for (const f of photos)
        ids.push(
          (
            await uploadDocument(f, {
              entityType: poId ? 'purchase_order' : 'project',
              entityId: poId || projectId,
              kind: 'photo',
              visibility: vendorOrgId ? 'vendor' : 'internal',
              vendorOrgId,
            })
          ).id,
        );
      return api.post<Claim>('orders', '/claims', {
        projectId,
        poId: poId || undefined,
        type,
        description: desc.trim(),
        photoDocumentIds: ids,
        items: Object.entries(qty)
          .filter(([, v]) => Number(v) > 0)
          .map(([poLineId, v]) => ({ poLineId, quantity: Number(v) })),
      });
    },
    onSuccess: (c) => {
      toast.success(`Claim ${c.number} opened`);
      invalidate();
      onClose();
      nav(`/app/claims/${c.id}`);
    },
  });
  return (
    <Sheet
      open={open}
      onClose={onClose}
      width={600}
      title="Open claim"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={m.isPending}
            disabled={!projectId || !desc.trim()}
            onClick={() => m.mutate()}
          >
            Open claim
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Project">
          {(id) => (
            <Select
              id={id}
              value={projectId}
              onChange={(e) => {
                setProjectId(e.target.value);
                setPoId('');
              }}
              placeholder="Choose a project"
              options={(projects.data ?? []).map((x) => ({ value: x.id, label: `${x.number} ${x.name}` }))}
            />
          )}
        </Field>
        <Field label="Purchase order" hint="Needed to send the claim to the vendor.">
          {(id) => (
            <Select
              id={id}
              value={poId}
              disabled={!projectId}
              onChange={(e) => setPoId(e.target.value)}
              placeholder="Not known yet"
              options={(pos.data?.items ?? []).map((x) => ({
                value: x.id,
                label: `${x.number} · ${x.vendorName}`,
              }))}
            />
          )}
        </Field>
        <Field label="Type">
          {(id) => (
            <Select
              id={id}
              value={type}
              onChange={(e) => setType(e.target.value as ClaimType)}
              options={TYPES.map((t) => ({ value: t, label: CLAIM_TYPE_LABEL[t] }))}
            />
          )}
        </Field>
        <Field label="What happened">
          {(id) => <Textarea id={id} rows={4} value={desc} onChange={(e) => setDesc(e.target.value)} />}
        </Field>
        {po.data && (
          <fieldset>
            <legend className="mb-1.5 text-[13px] font-[560] text-ink-2">Affected items (optional)</legend>
            <ul className="max-h-60 divide-y divide-line-2 overflow-y-auto rounded-sm border border-line">
              {po.data.lines.map((l) => (
                <li key={l.id} className="flex items-center gap-3 px-3 py-1.5">
                  <span className="min-w-0 flex-1 truncate text-[13px]">
                    <span className="num text-ink-3">{l.code}</span> {l.name}
                  </span>
                  <input
                    aria-label={`Quantity of ${l.code}`}
                    inputMode="numeric"
                    placeholder="0"
                    value={qty[l.id] ?? ''}
                    onChange={(e) => setQty((x) => ({ ...x, [l.id]: e.target.value }))}
                    className="num h-7 w-16 rounded-xs border border-line px-2 text-right focus:border-lacquer focus:outline-none"
                  />
                </li>
              ))}
            </ul>
          </fieldset>
        )}
        <Field label="Photos">{() => <FilePicker files={photos} onChange={setPhotos} />}</Field>
      </div>
    </Sheet>
  );
}
