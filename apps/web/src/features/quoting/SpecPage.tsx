import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, Link2, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { ActivityFeed } from '@/components/shared/ActivityFeed';
import { DocumentsPanel } from '@/components/shared/DocumentsPanel';
import {
  Badge,
  Button,
  Dialog,
  Field,
  Input,
  Loading,
  Menu,
  Section,
  Select,
  StatusBadge,
  Tabs,
  Textarea,
  TitleBlock,
} from '@/components/ui';
import { api, type Page } from '@/lib/api';
import { hasPerm, useSession } from '@/lib/auth';
import { date, dateTime, humanize, money } from '@/lib/format';
import {
  BackLink,
  CostStatusBadge,
  categoryLabel,
  parseNum,
  plural,
  QUOTE_STATUS_LABEL,
  qk,
  RecordError,
  SPEC_CATEGORY_OPTIONS,
  useCostsVisible,
  useVendors,
} from './shared';
import type { MasterSpecDetail, Spec, SpecDetail } from './types';

type Form = Record<
  | 'code'
  | 'name'
  | 'category'
  | 'vendorId'
  | 'vendorSku'
  | 'finish'
  | 'dimensions'
  | 'materials'
  | 'description'
  | 'unit'
  | 'cost'
  | 'costExpiresAt'
  | 'leadTimeWeeks'
  | 'freightUnit'
  | 'notes',
  string
>;
const toForm = (s: Spec): Form => ({
  code: s.code,
  name: s.name,
  category: s.category,
  vendorId: s.vendorId ?? '',
  vendorSku: s.vendorSku ?? '',
  finish: s.finish ?? '',
  dimensions: s.dimensions ?? '',
  materials: s.materials ?? '',
  description: s.description ?? '',
  unit: s.unit,
  cost: s.cost === null ? '' : String(s.cost),
  costExpiresAt: s.costExpiresAt ?? '',
  leadTimeWeeks: s.leadTimeWeeks === null ? '' : String(s.leadTimeWeeks),
  freightUnit: s.freightUnit === null ? '' : String(s.freightUnit),
  notes: s.notes ?? '',
});

export function Component() {
  const { id = '' } = useParams();
  const s = useSession();
  const qc = useQueryClient();
  const nav = useNavigate();
  const costs = useCostsVisible();
  const canWrite = hasPerm(s, 'specs:write');
  const vendors = useVendors();
  const [tab, setTab] = useState<'details' | 'files' | 'activity'>('details');
  const q = useQuery({
    queryKey: qk.spec(id),
    queryFn: () => api.get<SpecDetail>('quoting', `/specs/${id}`),
  });
  const [f, setF] = useState<Form | null>(null);
  useEffect(() => {
    if (q.data) setF(toForm(q.data));
  }, [q.data]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [linking, setLinking] = useState(false);

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch<Spec>('quoting', `/specs/${id}`, body),
    onSuccess: () => {
      toast.success('Spec saved');
      qc.invalidateQueries({ queryKey: qk.spec(id) });
      qc.invalidateQueries({ queryKey: ['quoting', 'specs'] });
      qc.invalidateQueries({ queryKey: ['activity', 'quoting', `/specs/${id}/activity`] });
    },
  });
  const del = useMutation({
    mutationFn: () => api.del('quoting', `/specs/${id}`),
    onSuccess: () => {
      toast.success('Spec deleted');
      qc.invalidateQueries({ queryKey: ['quoting', 'specs'] });
      nav('/app/specs');
    },
  });

  const diff = useMemo(() => {
    if (!q.data || !f) return {};
    const base = toForm(q.data);
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(f) as (keyof Form)[]) {
      if (f[k] === base[k]) continue;
      if (['cost', 'leadTimeWeeks', 'freightUnit'].includes(k)) out[k] = parseNum(f[k]);
      else if (k === 'vendorId') out[k] = f[k] || null;
      else if (k === 'costExpiresAt') out[k] = f[k] || null;
      else if (['code', 'name', 'category', 'unit'].includes(k)) out[k] = f[k].trim();
      else out[k] = f[k].trim() || null;
    }
    return out;
  }, [f, q.data]);
  const dirty = Object.keys(diff).length > 0;
  const invalid =
    !!f &&
    (!f.code.trim() ||
      !f.name.trim() ||
      ['cost', 'leadTimeWeeks', 'freightUnit'].some((k) => {
        const n = parseNum(f[k as keyof Form]);
        return n !== null && (Number.isNaN(n) || n < 0);
      }));

  if (q.isLoading || (!f && q.data)) return <Loading label="Loading spec" />;
  if (q.isError || !q.data || !f)
    return (
      <RecordError
        error={q.error}
        what="spec"
        back={{ to: '/app/specs', label: 'Back to the spec library' }}
      />
    );
  const sp = q.data;
  const set = (k: keyof Form) => (e: { target: { value: string } }) =>
    setF((x) => (x ? { ...x, [k]: e.target.value } : x));

  return (
    <div className="px-4 py-4 pb-24 sm:px-6">
      <div className="mb-3 flex items-center justify-between gap-2">
        <BackLink to="/app/specs">Spec library</BackLink>
        {canWrite && (
          <Menu
            trigger={(open) => (
              <Button size="sm" onClick={open}>
                More
              </Button>
            )}
            items={[
              ...(costs
                ? [
                    {
                      label: sp.masterSpecId ? 'Change master spec' : 'Add to a master spec',
                      icon: <Link2 className="size-4 text-ink-3" />,
                      onSelect: () => setLinking(true),
                    },
                  ]
                : []),
              {
                label: sp.archived ? 'Restore from archive' : 'Archive spec',
                icon: <Archive className="size-4 text-ink-3" />,
                onSelect: () => save.mutate({ archived: !sp.archived }),
              },
              {
                label: 'Delete spec',
                icon: <Trash2 className="size-4" />,
                danger: true,
                onSelect: () => setConfirmDelete(true),
              },
            ]}
          />
        )}
      </div>
      <TitleBlock
        title={sp.name}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            {categoryLabel(sp.category)}
            {sp.brandStandardItemId && <Badge tone="lacquer">Brand standard</Badge>}
            {sp.archived && <StatusBadge status="archived" />}
          </span>
        }
        fields={[
          { label: 'Code', value: <span className="num">{sp.code}</span> },
          { label: 'Vendor', value: sp.vendorName ?? 'Not assigned' },
          ...(costs
            ? [
                { label: 'Cost', value: <span className="num">{money(sp.cost)}</span> },
                {
                  label: 'Cost valid until',
                  value: <CostStatusBadge status={sp.costStatus} expiresAt={sp.costExpiresAt} />,
                },
              ]
            : []),
          { label: 'Used in', value: plural('quote', sp.usage.quoteCount) },
        ]}
      />
      <Tabs
        className="mt-5 border-b border-line"
        value={tab}
        onChange={(v) => setTab(v as typeof tab)}
        items={[
          { value: 'details', label: 'Details' },
          { value: 'files', label: 'Files' },
          { value: 'activity', label: 'Activity' },
        ]}
      />
      {tab === 'details' && (
        <div className="grid gap-4 pt-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
          <Section title="Specification">
            <fieldset disabled={!canWrite} className="space-y-4">
              <div className="grid grid-cols-[140px_1fr] gap-3">
                <Field label="Code">
                  {(i) => <Input id={i} className="num" value={f.code} onChange={set('code')} />}
                </Field>
                <Field label="Name">{(i) => <Input id={i} value={f.name} onChange={set('name')} />}</Field>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Category">
                  {(i) => (
                    <Select
                      id={i}
                      value={f.category}
                      onChange={set('category')}
                      options={SPEC_CATEGORY_OPTIONS}
                    />
                  )}
                </Field>
                <Field label="Vendor">
                  {(i) => (
                    <Select
                      id={i}
                      value={f.vendorId}
                      onChange={set('vendorId')}
                      placeholder="Not assigned"
                      options={(vendors.data ?? []).map((v) => ({ value: v.id, label: v.name }))}
                    />
                  )}
                </Field>
                <Field label="Vendor SKU">
                  {(i) => <Input id={i} value={f.vendorSku} onChange={set('vendorSku')} />}
                </Field>
                <Field label="Unit">{(i) => <Input id={i} value={f.unit} onChange={set('unit')} />}</Field>
                <Field label="Finish">
                  {(i) => <Input id={i} value={f.finish} onChange={set('finish')} />}
                </Field>
                <Field label="Dimensions">
                  {(i) => <Input id={i} value={f.dimensions} onChange={set('dimensions')} />}
                </Field>
              </div>
              <Field label="Materials">
                {(i) => <Input id={i} value={f.materials} onChange={set('materials')} />}
              </Field>
              <Field label="Description">
                {(i) => <Textarea id={i} rows={3} value={f.description} onChange={set('description')} />}
              </Field>
              <div className="grid gap-3 sm:grid-cols-4">
                {costs && (
                  <>
                    <Field label="Cost" hint="Changes are kept in the cost history.">
                      {(i) => (
                        <Input
                          id={i}
                          className="num"
                          inputMode="decimal"
                          value={f.cost}
                          onChange={set('cost')}
                        />
                      )}
                    </Field>
                    <Field label="Valid until">
                      {(i) => (
                        <Input id={i} type="date" value={f.costExpiresAt} onChange={set('costExpiresAt')} />
                      )}
                    </Field>
                    <Field label="Freight / unit">
                      {(i) => (
                        <Input
                          id={i}
                          className="num"
                          inputMode="decimal"
                          value={f.freightUnit}
                          onChange={set('freightUnit')}
                        />
                      )}
                    </Field>
                  </>
                )}
                <Field label="Lead time (wk)">
                  {(i) => (
                    <Input
                      id={i}
                      className="num"
                      inputMode="numeric"
                      value={f.leadTimeWeeks}
                      onChange={set('leadTimeWeeks')}
                    />
                  )}
                </Field>
              </div>
              <Field label="Internal notes">
                {(i) => <Textarea id={i} rows={2} value={f.notes} onChange={set('notes')} />}
              </Field>
            </fieldset>
          </Section>
          <div className="space-y-4">
            {costs && <CostHistory spec={sp} />}
            <Section title="Quotes using this spec" bodyClassName="">
              {!sp.usage.quotes.length ? (
                <p className="px-4 py-4 text-ink-2">
                  Not on any quote yet. Add it from a quote with “Add specs”.
                </p>
              ) : (
                <ul className="divide-y divide-line-2">
                  {sp.usage.quotes.map((u) => (
                    <li key={u.quoteId}>
                      <Link
                        to={`/app/quotes/${u.quoteId}`}
                        className="flex items-center justify-between gap-3 px-4 py-2 hover:bg-stone"
                      >
                        <span className="min-w-0">
                          <span className="num mr-2 text-ink-2">{u.number}</span>
                          <span className="font-[560]">{u.name}</span>
                          <span className="num ml-2 text-[12px] text-ink-3">
                            {plural('line', u.lineCount)}
                          </span>
                        </span>
                        {u.isTemplate ? (
                          <Badge>Template</Badge>
                        ) : (
                          <StatusBadge status={u.status} label={QUOTE_STATUS_LABEL[u.status]} />
                        )}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
            {costs && <MasterSpecPanel spec={sp} onLink={canWrite ? () => setLinking(true) : undefined} />}
          </div>
        </div>
      )}
      {tab === 'files' && (
        <div className="pt-4">
          <Section title="Files">
            <p className="mb-3 text-[13px] text-ink-2">
              Line drawings and spec sheets marked “Spec book” are merged into the quote’s spec book.
            </p>
            <DocumentsPanel
              entityType="spec"
              entityId={sp.id}
              showSpecBookToggle
              defaultKind="line_drawing"
              readOnly={!canWrite}
            />
          </Section>
        </div>
      )}
      {tab === 'activity' && (
        <div className="pt-4">
          <Section title="Activity">
            <ActivityFeed service="quoting" path={`/specs/${sp.id}/activity`} />
          </Section>
        </div>
      )}

      {canWrite && dirty && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-paper/95 px-4 py-3 backdrop-blur lg:left-[232px]">
          <div className="mx-auto flex max-w-[1200px] items-center justify-end gap-2">
            <span className="mr-auto text-[13px] text-ink-2">
              {plural('unsaved change', Object.keys(diff).length)}
              {sp.usage.quoteCount > 0 &&
                ' — quotes keep their own copy; use “Refresh costs from library” on a quote to pull new costs.'}
            </span>
            <Button onClick={() => setF(toForm(sp))}>Discard</Button>
            <Button
              variant="primary"
              disabled={invalid}
              loading={save.isPending}
              onClick={() => save.mutate(diff)}
            >
              Save spec
            </Button>
          </div>
        </div>
      )}
      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={`Delete ${sp.code}?`}
        footer={
          <>
            <Button onClick={() => setConfirmDelete(false)}>Cancel</Button>
            <Button
              variant="danger"
              loading={del.isPending}
              disabled={sp.usage.quoteCount > 0}
              onClick={() => del.mutate()}
            >
              Delete spec
            </Button>
          </>
        }
      >
        <p className="text-ink-2">
          {sp.usage.quoteCount > 0
            ? `It’s used on ${plural('quote', sp.usage.quoteCount)}, so it can’t be deleted. Archive it instead to hide it from the library.`
            : 'The spec and its cost history are removed permanently.'}
        </p>
      </Dialog>
      <LinkMasterDialog open={linking} spec={sp} onClose={() => setLinking(false)} />
    </div>
  );
}

function CostHistory({ spec }: { spec: SpecDetail }) {
  const h = spec.costHistory;
  const pts = [...h].reverse().filter((x) => x.cost !== null);
  const w = 280;
  const ht = 56;
  const min = Math.min(...pts.map((p) => p.cost!));
  const max = Math.max(...pts.map((p) => p.cost!));
  const span = max - min || 1;
  const path = pts
    .map(
      (p, i) =>
        `${i ? 'L' : 'M'}${(i / Math.max(1, pts.length - 1)) * (w - 8) + 4},${ht - 6 - ((p.cost! - min) / span) * (ht - 14)}`,
    )
    .join(' ');
  return (
    <Section title="Cost history" bodyClassName="">
      {!h.length ? (
        <p className="px-4 py-4 text-ink-2">No costs recorded yet.</p>
      ) : (
        <>
          {pts.length > 1 && (
            <div className="flex items-center gap-3 border-b border-line-2 px-4 py-3">
              <svg
                width={w}
                height={ht}
                viewBox={`0 0 ${w} ${ht}`}
                role="img"
                aria-label="Cost over time"
                className="max-w-full"
              >
                <path
                  d={path}
                  fill="none"
                  stroke="var(--color-lacquer)"
                  strokeWidth="2"
                  strokeLinejoin="round"
                />
                {pts.map((p, i) => (
                  <circle
                    key={p.id}
                    cx={(i / Math.max(1, pts.length - 1)) * (w - 8) + 4}
                    cy={ht - 6 - ((p.cost! - min) / span) * (ht - 14)}
                    r={i === pts.length - 1 ? 3.5 : 2.5}
                    fill={i === pts.length - 1 ? 'var(--color-brass)' : 'var(--color-lacquer)'}
                  />
                ))}
              </svg>
              <div className="num text-[12px] text-ink-3">
                <div>High {money(max)}</div>
                <div>Low {money(min)}</div>
              </div>
            </div>
          )}
          <table className="grid-table text-[13px]">
            <thead>
              <tr>
                <th>Recorded</th>
                <th className="right">Cost</th>
                <th>Valid until</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {h.map((e) => (
                <tr key={e.id}>
                  <td title={dateTime(e.recordedAt)}>
                    <div className="num">{date(e.recordedAt)}</div>
                    <div className="text-[12px] text-ink-3">{e.recordedByName ?? 'Pro-Cure'}</div>
                  </td>
                  <td className="right num font-[560]">{money(e.cost)}</td>
                  <td className="num">{date(e.expiresAt)}</td>
                  <td>
                    {e.costRequestId ? (
                      <Link
                        to={`/app/cost-requests/${e.costRequestId}`}
                        className="text-lacquer hover:underline"
                      >
                        {humanize(e.source)}
                      </Link>
                    ) : (
                      humanize(e.source)
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </Section>
  );
}

function MasterSpecPanel({ spec, onLink }: { spec: SpecDetail; onLink?: () => void }) {
  const m = useQuery({
    queryKey: ['quoting', 'master-spec', spec.masterSpecId],
    queryFn: () => api.get<MasterSpecDetail>('quoting', `/master-specs/${spec.masterSpecId}`),
    enabled: !!spec.masterSpecId,
  });
  return (
    <Section
      title={spec.masterSpec ? `Master spec · ${spec.masterSpec.name}` : 'Master spec & competitors'}
      bodyClassName=""
      actions={
        onLink && (
          <Button size="sm" variant="ghost" onClick={onLink}>
            {spec.masterSpecId ? 'Change' : 'Add to master spec'}
          </Button>
        )
      }
    >
      {!spec.masterSpecId ? (
        <p className="px-4 py-4 text-ink-2">
          Group specs from competing vendors under one master spec to compare them side by side in a quote’s
          price matrix.
        </p>
      ) : !m.data ? (
        <Loading />
      ) : (
        <table className="grid-table text-[13px]">
          <tbody>
            {m.data.specs.map((x) => (
              <tr key={x.id} data-selected={x.id === spec.id || undefined}>
                <td>
                  <Link to={`/app/specs/${x.id}`} className="hover:text-lacquer hover:underline">
                    <span className="num mr-1.5 text-ink-2">{x.code}</span>
                    {x.vendorName ?? 'No vendor'}
                  </Link>
                </td>
                <td className="right num">{money(x.cost)}</td>
                <td className="right num text-ink-2">
                  {x.leadTimeWeeks === null ? '—' : `${x.leadTimeWeeks} wk`}
                </td>
                <td>
                  <CostStatusBadge status={x.costStatus} expiresAt={x.costExpiresAt} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  );
}

function LinkMasterDialog({ open, spec, onClose }: { open: boolean; spec: SpecDetail; onClose: () => void }) {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ['quoting', 'master-specs'],
    queryFn: () =>
      api.get<Page<{ id: string; name: string; specCount: number }>>('quoting', '/master-specs', {
        limit: 200,
      }),
    enabled: open,
  });
  const [target, setTarget] = useState('');
  const [name, setName] = useState('');
  useEffect(() => {
    if (open) {
      setTarget(spec.masterSpecId ?? '');
      setName(spec.name);
    }
  }, [open, spec]);
  const m = useMutation({
    mutationFn: async () => {
      let id = target;
      if (target === '__new__') {
        const ms = await api.post<{ id: string }>('quoting', '/master-specs', {
          name: name.trim(),
          category: spec.category,
        });
        id = ms.id;
      }
      return api.post('quoting', `/master-specs/${id}/specs`, { specIds: [spec.id] });
    },
    onSuccess: () => {
      toast.success('Added to master spec');
      qc.invalidateQueries({ queryKey: qk.spec(spec.id) });
      qc.invalidateQueries({ queryKey: ['quoting', 'master-spec'] });
      onClose();
    },
  });
  if (!open) return null;
  return (
    <Dialog
      open
      onClose={onClose}
      title="Add to a master spec"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!target || (target === '__new__' && !name.trim())}
            loading={m.isPending}
            onClick={() => m.mutate()}
          >
            Add to master spec
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-[13px] text-ink-2">
          Specs in the same master spec compete for one slot in a quote’s price matrix.
        </p>
        <Field label="Master spec">
          {(id) => (
            <Select
              id={id}
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder="Choose"
              options={[
                { value: '__new__', label: 'New master spec…' },
                ...(list.data?.items ?? []).map((x) => ({
                  value: x.id,
                  label: `${x.name} (${x.specCount})`,
                })),
              ]}
            />
          )}
        </Field>
        {target === '__new__' && (
          <Field label="Name">
            {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}
          </Field>
        )}
      </div>
    </Dialog>
  );
}
