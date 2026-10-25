import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BookOpen, FileUp, Plus, Tags } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import {
  Button,
  Checkbox,
  Chips,
  EmptyState,
  ErrorNote,
  Field,
  Input,
  Menu,
  PageHeader,
  SearchInput,
  Select,
  Sheet,
  Spinner,
  Textarea,
} from '@/components/ui';
import { type Column, DataTable, Pagination } from '@/components/ui/DataTable';
import { api, type Page } from '@/lib/api';
import { hasPerm, useSession } from '@/lib/auth';
import { money } from '@/lib/format';
import { useListParams, useSearchParamInput } from '@/lib/hooks';
import {
  CostStatusBadge,
  categoryLabel,
  parseNum,
  plural,
  qk,
  SPEC_CATEGORY_OPTIONS,
  useCostsVisible,
  useVendors,
} from './shared';
import type { Spec } from './types';

const DEFAULTS = { q: '', category: '', vendorId: '', costStatus: '', standard: '', limit: '50' };

export function Component() {
  const s = useSession();
  const nav = useNavigate();
  const costs = useCostsVisible();
  const [p, set] = useListParams(DEFAULTS);
  const [text, setText] = useSearchParamInput(p.q, (q) => set({ q }));
  const vendors = useVendors();
  const [sheet, setSheet] = useState<'new' | 'import' | 'standard' | null>(null);
  const query = {
    q: p.q || undefined,
    category: p.category || undefined,
    vendorId: p.vendorId || undefined,
    costStatus: p.costStatus || undefined,
    limit: p.standard ? 500 : Number(p.limit),
    offset: p.standard ? 0 : Number(p.offset),
  };
  const list = useQuery({
    queryKey: qk.specs(query),
    queryFn: () => api.get<Page<Spec>>('quoting', '/specs', query),
    placeholderData: keepPreviousData,
  });
  const rows = useMemo(
    () =>
      (list.data?.items ?? []).filter((x) =>
        p.standard === 'yes' ? !!x.brandStandardItemId : p.standard === 'no' ? !x.brandStandardItemId : true,
      ),
    [list.data, p.standard],
  );
  const canWrite = hasPerm(s, 'specs:write');
  const filtered = !!(p.q || p.category || p.vendorId || p.costStatus || p.standard);

  const cols: Column<Spec>[] = [
    {
      key: 'code',
      header: 'Code',
      width: 110,
      cell: (r) => <span className="num font-[560] whitespace-nowrap">{r.code}</span>,
    },
    {
      key: 'name',
      header: 'Spec',
      cell: (r) => (
        <div className="min-w-[240px]">
          <div className="font-[560]">{r.name}</div>
          <div className="text-[12px] text-ink-3">
            {[categoryLabel(r.category), r.finish, r.dimensions].filter(Boolean).join(' · ')}
          </div>
        </div>
      ),
    },
    {
      key: 'vendor',
      header: 'Vendor',
      cell: (r) => r.vendorName ?? <span className="text-ink-4">Not assigned</span>,
    },
    ...(costs
      ? [
          { key: 'cost', header: 'Cost', align: 'right' as const, cell: (r: Spec) => money(r.cost) },
          {
            key: 'exp',
            header: 'Cost valid until',
            cell: (r: Spec) => <CostStatusBadge status={r.costStatus} expiresAt={r.costExpiresAt} />,
          },
        ]
      : []),
    {
      key: 'lead',
      header: 'Lead time',
      align: 'right',
      cell: (r) =>
        r.leadTimeWeeks === null ? <span className="text-ink-4">—</span> : `${r.leadTimeWeeks} wk`,
    },
    { key: 'used', header: 'Used in', align: 'right', cell: (r) => <UsedIn id={r.id} /> },
  ];

  return (
    <>
      <PageHeader
        title="Spec library"
        description="Your firm’s private library of specified items: vendor, finish, dimensions and the latest vendor cost. Quotes snapshot these."
        actions={
          canWrite && (
            <>
              <Menu
                trigger={(open) => (
                  <Button icon={<FileUp className="size-4" />} onClick={open}>
                    Import
                  </Button>
                )}
                items={[
                  { label: 'Import from CSV', onSelect: () => setSheet('import') },
                  { label: 'From brand standard', onSelect: () => setSheet('standard') },
                ]}
              />
              <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setSheet('new')}>
                New spec
              </Button>
            </>
          )
        }
      >
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <SearchInput
            value={text}
            onChange={setText}
            placeholder="Search code, name, vendor, SKU"
            className="w-full sm:w-72"
          />
          <div className="w-[170px]">
            <Select
              aria-label="Category"
              value={p.category}
              onChange={(e) => set({ category: e.target.value })}
              placeholder="All categories"
              options={SPEC_CATEGORY_OPTIONS}
            />
          </div>
          <div className="w-[190px]">
            <Select
              aria-label="Vendor"
              value={p.vendorId}
              onChange={(e) => set({ vendorId: e.target.value })}
              placeholder="All vendors"
              options={(vendors.data ?? []).map((v) => ({ value: v.id, label: v.name }))}
            />
          </div>
          {costs && (
            <Chips
              value={p.costStatus || 'any'}
              onChange={(v) => set({ costStatus: v === 'any' ? '' : v })}
              options={[
                { value: 'any', label: 'Any cost' },
                { value: 'missing', label: 'Missing' },
                { value: 'expired', label: 'Expired' },
                { value: 'expiring', label: 'Expiring' },
              ]}
            />
          )}
          <Chips
            value={p.standard || 'any'}
            onChange={(v) => set({ standard: v === 'any' ? '' : v })}
            options={[
              { value: 'any', label: 'All specs' },
              { value: 'yes', label: 'Brand standard' },
              { value: 'no', label: 'Custom' },
            ]}
          />
          {filtered && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setText('');
                set({ q: '', category: '', vendorId: '', costStatus: '', standard: '' });
              }}
            >
              Clear filters
            </Button>
          )}
          <span className="num ml-auto text-[13px] text-ink-3">
            {list.data ? plural('spec', p.standard ? rows.length : list.data.total) : ''}
          </span>
        </div>
      </PageHeader>
      {list.isError ? (
        <ErrorNote error={list.error} />
      ) : (
        <div className="bg-paper [&_td:first-child]:pl-6 [&_td:last-child]:pr-6 [&_th:first-child]:pl-6 [&_th:last-child]:pr-6">
          <DataTable
            columns={cols}
            rows={list.isLoading ? undefined : rows}
            loading={list.isLoading}
            onRowClick={(r) => nav(`/app/specs/${r.id}`)}
            empty={
              <EmptyState
                icon={<Tags />}
                title={filtered ? 'No specs match these filters' : 'Your spec library is empty'}
              >
                {filtered
                  ? 'Try another category or vendor, or clear the filters.'
                  : 'Create specs one by one, import a CSV, or bring in a brand standard package.'}
              </EmptyState>
            }
            footer={
              list.data &&
              !p.standard && (
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
      <SpecFormSheet
        open={sheet === 'new'}
        onClose={() => setSheet(null)}
        onSaved={(sp) => nav(`/app/specs/${sp.id}`)}
      />
      <ImportSheet open={sheet === 'import'} onClose={() => setSheet(null)} />
      <FromStandardSheet open={sheet === 'standard'} onClose={() => setSheet(null)} />
    </>
  );
}

/** Usage count per spec (lazy; fetched for visible rows and cached). */
function UsedIn({ id }: { id: string }) {
  const q = useQuery({
    queryKey: qk.spec(id),
    queryFn: () => api.get<{ usage: { quoteCount: number } }>('quoting', `/specs/${id}`),
    staleTime: 60_000,
    meta: { silent: true },
  });
  if (!q.data) return <span className="text-ink-4">·</span>;
  const n = q.data.usage.quoteCount;
  return n ? <span className="num">{plural('quote', n)}</span> : <span className="text-ink-4">Not used</span>;
}

// ================================================================ new / edit spec
function SpecFormSheet({
  open,
  onClose,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  onSaved?: (s: Spec) => void;
}) {
  const qc = useQueryClient();
  const vendors = useVendors();
  const costs = useCostsVisible();
  const empty = {
    code: '',
    name: '',
    category: 'casegoods',
    vendorId: '',
    vendorSku: '',
    finish: '',
    dimensions: '',
    materials: '',
    description: '',
    unit: 'ea',
    cost: '',
    costExpiresAt: '',
    leadTimeWeeks: '',
  };
  const [f, setF] = useState(empty);
  const [touched, setTouched] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when the sheet opens
  useEffect(() => {
    if (open) {
      setF(empty);
      setTouched(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const set = (k: keyof typeof empty) => (e: { target: { value: string } }) =>
    setF((x) => ({ ...x, [k]: e.target.value }));
  const cost = parseNum(f.cost);
  const errors = {
    code: !f.code.trim() ? 'Code is required, e.g. TR-CG-07' : undefined,
    name: !f.name.trim() ? 'Name is required' : undefined,
    cost: cost !== null && (Number.isNaN(cost) || cost < 0) ? 'Enter a cost, or leave blank' : undefined,
  };
  const m = useMutation({
    mutationFn: () =>
      api.post<Spec>('quoting', '/specs', {
        code: f.code.trim(),
        name: f.name.trim(),
        category: f.category,
        vendorId: f.vendorId || null,
        vendorSku: f.vendorSku.trim() || null,
        finish: f.finish.trim() || null,
        dimensions: f.dimensions.trim() || null,
        materials: f.materials.trim() || null,
        description: f.description.trim() || null,
        unit: f.unit.trim() || 'ea',
        ...(costs ? { cost, costExpiresAt: f.costExpiresAt || null } : {}),
        leadTimeWeeks: parseNum(f.leadTimeWeeks),
      }),
    onSuccess: (sp) => {
      toast.success(`Spec ${sp.code} created`);
      qc.invalidateQueries({ queryKey: ['quoting', 'specs'] });
      onClose();
      onSaved?.(sp);
    },
  });
  const submit = () => {
    setTouched(true);
    if (!Object.values(errors).some(Boolean)) m.mutate();
  };
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="New spec"
      description="A reusable library item. Quotes copy it as a line you can price."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={m.isPending} onClick={submit}>
            Create spec
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="grid grid-cols-[140px_1fr] gap-3">
          <Field label="Code" error={touched ? errors.code : undefined}>
            {(id) => <Input id={id} autoFocus className="num" value={f.code} onChange={set('code')} />}
          </Field>
          <Field label="Name" error={touched ? errors.name : undefined}>
            {(id) => (
              <Input
                id={id}
                value={f.name}
                onChange={set('name')}
                placeholder="King headboard, upholstered"
              />
            )}
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Category">
            {(id) => (
              <Select id={id} value={f.category} onChange={set('category')} options={SPEC_CATEGORY_OPTIONS} />
            )}
          </Field>
          <Field label="Vendor">
            {(id) => (
              <Select
                id={id}
                value={f.vendorId}
                onChange={set('vendorId')}
                placeholder="Not assigned yet"
                options={(vendors.data ?? []).map((v) => ({ value: v.id, label: v.name }))}
              />
            )}
          </Field>
          <Field label="Vendor SKU">
            {(id) => <Input id={id} value={f.vendorSku} onChange={set('vendorSku')} />}
          </Field>
          <Field label="Unit">{(id) => <Input id={id} value={f.unit} onChange={set('unit')} />}</Field>
          <Field label="Finish">{(id) => <Input id={id} value={f.finish} onChange={set('finish')} />}</Field>
          <Field label="Dimensions">
            {(id) => (
              <Input
                id={id}
                value={f.dimensions}
                onChange={set('dimensions')}
                placeholder='80"W x 2"D x 54"H'
              />
            )}
          </Field>
        </div>
        <Field label="Materials">
          {(id) => <Input id={id} value={f.materials} onChange={set('materials')} />}
        </Field>
        <Field label="Description">
          {(id) => <Textarea id={id} rows={2} value={f.description} onChange={set('description')} />}
        </Field>
        <div className="grid gap-3 sm:grid-cols-3">
          {costs && (
            <>
              <Field label="Cost" error={touched ? errors.cost : undefined}>
                {(id) => (
                  <Input id={id} className="num" inputMode="decimal" value={f.cost} onChange={set('cost')} />
                )}
              </Field>
              <Field label="Cost valid until">
                {(id) => (
                  <Input id={id} type="date" value={f.costExpiresAt} onChange={set('costExpiresAt')} />
                )}
              </Field>
            </>
          )}
          <Field label="Lead time (weeks)">
            {(id) => (
              <Input
                id={id}
                className="num"
                inputMode="numeric"
                value={f.leadTimeWeeks}
                onChange={set('leadTimeWeeks')}
              />
            )}
          </Field>
        </div>
        <button type="submit" hidden />
      </form>
    </Sheet>
  );
}

// ================================================================ CSV import
const HEADER_MAP: Record<string, string> = {
  code: 'code',
  'spec code': 'code',
  item: 'code',
  name: 'name',
  description: 'description',
  category: 'category',
  vendor: 'vendorName',
  'vendor name': 'vendorName',
  vendorname: 'vendorName',
  'vendor id': 'vendorId',
  vendorid: 'vendorId',
  sku: 'vendorSku',
  'vendor sku': 'vendorSku',
  vendorsku: 'vendorSku',
  finish: 'finish',
  dimensions: 'dimensions',
  materials: 'materials',
  unit: 'unit',
  cost: 'cost',
  'unit cost': 'cost',
  'cost expires': 'costExpiresAt',
  'valid until': 'costExpiresAt',
  costexpiresat: 'costExpiresAt',
  'lead time': 'leadTimeWeeks',
  'lead time weeks': 'leadTimeWeeks',
  leadtimeweeks: 'leadTimeWeeks',
};

/** Minimal RFC 4180 CSV parser (quotes, escaped quotes, CRLF); also accepts tab-separated paste from Excel. */
function parseCsv(text: string): string[][] {
  const sep = text.split('\n', 1)[0]!.includes('\t') ? '\t' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (q) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === sep) {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}

function ImportSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const [result, setResult] = useState<{
    created: number;
    updated: number;
    errors: { row: number; code: string | null; errors: string[] }[];
  } | null>(null);
  useEffect(() => {
    if (open) {
      setText('');
      setResult(null);
    }
  }, [open]);
  const parsed = useMemo(() => {
    if (!text.trim()) return null;
    const rows = parseCsv(text);
    if (rows.length < 2) return { headers: [], mapped: [], records: [], unknown: [] as string[] };
    const headers = rows[0]!.map((h) => h.trim());
    const mapped = headers.map(
      (h) => HEADER_MAP[h.toLowerCase().replace(/[_-]/g, ' ').trim()] ?? HEADER_MAP[h.toLowerCase()] ?? null,
    );
    const records = rows.slice(1).map((r) => {
      const o: Record<string, string | null> = {};
      mapped.forEach((k, i) => {
        if (k) o[k] = r[i]?.trim() || null;
      });
      return o;
    });
    return { headers, mapped, records, unknown: headers.filter((_, i) => !mapped[i]) };
  }, [text]);
  const missingCols = parsed?.headers.length
    ? ['code', 'name'].filter((k) => !parsed.mapped.includes(k))
    : [];
  const imp = useMutation({
    mutationFn: () =>
      api.post<NonNullable<typeof result>>('quoting', '/specs/import', { rows: parsed!.records }),
    onSuccess: (r) => {
      setResult(r);
      qc.invalidateQueries({ queryKey: ['quoting', 'specs'] });
      if (!r.errors.length) toast.success(`Specs imported: ${r.created} created, ${r.updated} updated`);
      else toast.warning(`Imported with ${plural('error', r.errors.length)} — see the rows below`);
    },
  });
  const errByRow = new Map(result?.errors.map((e) => [e.row, e]));
  return (
    <Sheet
      open={open}
      onClose={onClose}
      width={800}
      title="Import specs from CSV"
      description="Paste from Excel or upload a .csv. Rows are matched by code: existing specs are updated, new codes are created."
      footer={
        <>
          <Button onClick={onClose}>{result ? 'Done' : 'Cancel'}</Button>
          <Button
            variant="primary"
            disabled={!parsed?.records.length || missingCols.length > 0}
            loading={imp.isPending}
            onClick={() => imp.mutate()}
          >
            {parsed?.records.length ? `Import ${plural('row', parsed.records.length)}` : 'Import'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" icon={<FileUp className="size-4" />} onClick={() => fileRef.current?.click()}>
            Choose CSV file
          </Button>
          <span className="text-[13px] text-ink-3">
            or paste below. Columns: code, name, category, vendor, sku, finish, dimensions, materials, unit,
            cost, valid until, lead time.
          </span>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv,text/plain"
            hidden
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (f) setText(await f.text());
              e.target.value = '';
              setResult(null);
            }}
          />
        </div>
        <Textarea
          rows={6}
          className="num font-mono text-[12px]"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setResult(null);
          }}
          placeholder={
            'code,name,category,vendor,cost,valid until\nTR-CG-07,Luggage bench,casegoods,Carolina Casegoods Co.,212.50,2027-03-31'
          }
        />
        {parsed && parsed.headers.length > 0 && (
          <>
            {(missingCols.length > 0 || parsed.unknown.length > 0) && (
              <div className="rounded-sm bg-warn-50 px-3 py-2 text-[13px] text-warn">
                {missingCols.length > 0 && <div>Missing required column(s): {missingCols.join(', ')}.</div>}
                {parsed.unknown.length > 0 && <div>Ignored column(s): {parsed.unknown.join(', ')}.</div>}
              </div>
            )}
            {result && (
              <div
                className={`rounded-sm px-3 py-2 text-[13px] ${result.errors.length ? 'bg-crit-50 text-crit' : 'bg-ok-50 text-ok'}`}
              >
                {result.created} created · {result.updated} updated · {plural('row', result.errors.length)}{' '}
                with errors (not imported)
              </div>
            )}
            <div className="max-h-[40vh] overflow-auto rounded-sm border border-line">
              <table className="grid-table text-[13px]">
                <thead>
                  <tr>
                    <th>Row</th>
                    {parsed.mapped.map((k, i) =>
                      // biome-ignore lint/suspicious/noArrayIndexKey: columns are positional
                      k ? <th key={`${k}${i}`}>{k}</th> : null,
                    )}
                    {result && <th>Result</th>}
                  </tr>
                </thead>
                <tbody>
                  {parsed.records.slice(0, 300).map((r, i) => {
                    const err = errByRow.get(i);
                    return (
                      // biome-ignore lint/suspicious/noArrayIndexKey: CSV rows are positional (errors reference the index)
                      <tr key={i} className={err ? 'bg-crit-50' : undefined}>
                        <td className="num text-ink-3">{i + 2}</td>
                        {parsed.mapped.map((k, j) =>
                          k ? (
                            // biome-ignore lint/suspicious/noArrayIndexKey: columns are positional
                            <td key={`${k}${j}`} className="max-w-[180px] truncate">
                              {r[k] ?? ''}
                            </td>
                          ) : null,
                        )}
                        {result && (
                          <td className={err ? 'text-crit' : 'text-ok'}>
                            {err ? err.errors.join('; ') : 'OK'}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </Sheet>
  );
}

// ================================================================ from brand standard
interface StdItem {
  id: string;
  code: string;
  area: string | null;
  category: string;
  name: string;
  finish: string | null;
  dimensions: string | null;
  approvedVendors: { vendorId: string; name: string }[];
  quantityBasis: string | null;
}

function FromStandardSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const vendors = useVendors();
  const [std, setStd] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [assign, setAssign] = useState<Record<string, string>>({});
  useEffect(() => {
    if (open) {
      setStd('');
      setPicked(new Set());
      setAssign({});
    }
  }, [open]);
  const list = useQuery({
    queryKey: ['catalog', 'brand-standards', 'lite'],
    queryFn: () =>
      api.get<Page<{ id: string; name: string; brandName: string | null; itemCount: number }>>(
        'catalog',
        '/brand-standards',
        { limit: 100 },
      ),
    enabled: open,
  });
  const detail = useQuery({
    queryKey: ['catalog', 'brand-standard', std],
    queryFn: () =>
      api.get<{ id: string; name: string; items: StdItem[] }>('catalog', `/brand-standards/${std}`),
    enabled: open && !!std,
  });
  useEffect(() => {
    const items = detail.data?.items ?? [];
    setPicked(new Set(items.map((i) => i.id)));
    setAssign(Object.fromEntries(items.map((i) => [i.id, i.approvedVendors[0]?.vendorId ?? ''])));
  }, [detail.data]);
  const m = useMutation({
    mutationFn: () =>
      api.post<{ created: number; updated: number }>('quoting', '/specs/from-brand-standard', {
        standardId: std,
        itemIds: [...picked],
        vendorAssignments: Object.fromEntries(Object.entries(assign).filter(([k, v]) => v && picked.has(k))),
      }),
    onSuccess: (r) => {
      toast.success(`Specs added from brand standard: ${r.created} created, ${r.updated} updated`);
      qc.invalidateQueries({ queryKey: ['quoting', 'specs'] });
      onClose();
      nav('/app/specs?standard=yes');
    },
  });
  const items = detail.data?.items ?? [];
  return (
    <Sheet
      open={open}
      onClose={onClose}
      width={820}
      title="Add specs from a brand standard"
      description="Brand standards are the brand’s required items. Pick the items you’ll quote and which approved vendor you’ll buy each from."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!picked.size} loading={m.isPending} onClick={() => m.mutate()}>
            {picked.size ? `Add ${plural('spec', picked.size)}` : 'Add specs'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Brand standard">
          {(id) => (
            <Select
              id={id}
              value={std}
              onChange={(e) => setStd(e.target.value)}
              placeholder="Choose a brand standard"
              options={(list.data?.items ?? []).map((x) => ({
                value: x.id,
                label: `${x.name} (${x.itemCount} items)`,
              }))}
            />
          )}
        </Field>
        {!std ? (
          <EmptyState icon={<BookOpen />} title="Choose a standard to see its items" />
        ) : detail.isLoading ? (
          <div className="flex justify-center py-8">
            <Spinner />
          </div>
        ) : (
          <div className="overflow-x-auto rounded-sm border border-line">
            <table className="grid-table text-[13px]">
              <thead>
                <tr>
                  <th style={{ width: 36 }}>
                    <Checkbox
                      label="Select all"
                      checked={items.length > 0 && items.every((i) => picked.has(i.id))}
                      indeterminate={picked.size > 0 && picked.size < items.length}
                      onChange={(v) => setPicked(new Set(v ? items.map((i) => i.id) : []))}
                    />
                  </th>
                  <th>Item</th>
                  <th>Area</th>
                  <th>Vendor</th>
                </tr>
              </thead>
              <tbody>
                {items.map((i) => (
                  <tr key={i.id} data-selected={picked.has(i.id) || undefined}>
                    <td>
                      <Checkbox
                        label={`Select ${i.code}`}
                        checked={picked.has(i.id)}
                        onChange={(v) =>
                          setPicked((p) => {
                            const n = new Set(p);
                            v ? n.add(i.id) : n.delete(i.id);
                            return n;
                          })
                        }
                      />
                    </td>
                    <td>
                      <div className="font-[560]">
                        <span className="num mr-2 text-ink-2">{i.code}</span>
                        {i.name}
                      </div>
                      <div className="text-[12px] text-ink-3">
                        {[categoryLabel(i.category), i.finish, i.quantityBasis].filter(Boolean).join(' · ')}
                      </div>
                    </td>
                    <td className="text-ink-2">{i.area ?? '—'}</td>
                    <td className="min-w-[200px]">
                      <Select
                        aria-label={`Vendor for ${i.code}`}
                        value={assign[i.id] ?? ''}
                        onChange={(e) => setAssign((a) => ({ ...a, [i.id]: e.target.value }))}
                        options={[
                          { value: '', label: 'Assign later' },
                          ...i.approvedVendors.map((v) => ({
                            value: v.vendorId,
                            label: `${v.name} (approved)`,
                          })),
                          ...(vendors.data ?? [])
                            .filter((v) => !i.approvedVendors.some((a) => a.vendorId === v.id))
                            .map((v) => ({ value: v.id, label: v.name })),
                        ]}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Sheet>
  );
}
