import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BookOpen, FileText, ListPlus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { Button, Checkbox, cx, Field, Input, Section, Select } from '@/components/ui';
import { api, type Page } from '@/lib/api';
import { hasPerm, useSession } from '@/lib/auth';
import { date } from '@/lib/format';
import { type BrandStandard, categoryLabel, categoryOptions, useBrands } from '../../catalog/shared';
import { PdfPageViewer } from '../PdfPageViewer';
import { aiKeys, type BrandSpecItem, type BrandSpecOutput, Confidence, type Job } from '../shared';
import {
  applyErrorText,
  Banner,
  CellInput,
  CellSelect,
  formatVendors,
  parseVendors,
  Warnings,
} from './common';

type Editable = 'code' | 'area' | 'category' | 'name' | 'dimensions' | 'finish' | 'materials' | 'vendors';
interface RowState {
  accepted: boolean;
  edits: Partial<Record<Editable, string>>;
}

const fieldOf = (it: BrandSpecItem, k: Editable): string =>
  k === 'vendors' ? formatVendors(it.approvedVendors) : ((it[k] as string | null) ?? '');

/** Turn local edits into the review/edits payload shape (approved vendors as objects). */
const editsPayload = (e: RowState['edits']) => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(e)) {
    if (k === 'vendors') out.approvedVendors = parseVendors(v ?? '');
    else out[k] = v?.trim() ? v.trim() : k === 'area' ? 'General' : null;
  }
  return out;
};

export function BrandSpecReview({ job, readOnly }: { job: Job; readOnly: boolean }) {
  const s = useSession();
  const qc = useQueryClient();
  const out = job.output as unknown as BrandSpecOutput;
  const documentId = job.input.documentId as string;
  const [page, setPage] = useState(out.items[0]?.sourcePage ?? 1);
  const [activeRow, setActiveRow] = useState<number | null>(null);
  const [threshold, setThreshold] = useState('0.8');
  const [rows, setRows] = useState<RowState[]>(() => {
    const saved = new Map(
      (
        (job.review?.items as { index: number; accepted?: boolean; edits?: Record<string, unknown> }[]) ?? []
      ).map((r) => [r.index, r]),
    );
    return out.items.map((it, i) => {
      const r = saved.get(i);
      const edits: RowState['edits'] = {};
      for (const [k, v] of Object.entries(r?.edits ?? {}))
        if (k === 'approvedVendors') edits.vendors = formatVendors(v as BrandSpecItem['approvedVendors']);
        else edits[k as Editable] = (v as string | null) ?? '';
      return { accepted: r ? r.accepted !== false : it.confidence >= 0.5, edits };
    });
  });
  const [dirty, setDirty] = useState(false);
  const update = (i: number, patch: Partial<RowState>) => {
    setRows((rs) =>
      rs.map((r, j) => (j === i ? { ...r, ...patch, edits: { ...r.edits, ...patch.edits } } : r)),
    );
    setDirty(true);
  };

  const accepted = rows.filter((r) => r.accepted).length;
  const edited = rows.filter((r) => Object.keys(r.edits).length).length;

  // ---------------------------------------------------------------- apply target
  const canCatalog = hasPerm(s, 'catalog:contribute');
  const canSpecs = hasPerm(s, 'specs:write');
  const [target, setTarget] = useState<'catalog' | 'specs'>(canCatalog ? 'catalog' : 'specs');
  const inputStd = job.input.standardId as string | undefined;
  const [standardId, setStandardId] = useState(inputStd ?? '');
  const brands = useBrands();
  const drafts = useQuery({
    queryKey: ['catalog', 'standards', { mine: true, forApply: true }],
    queryFn: () => api.get<Page<BrandStandard>>('catalog', '/brand-standards', { mine: true, limit: 200 }),
    select: (d) => d.items.filter((x) => x.status === 'draft' || x.status === 'submitted'),
    enabled: canCatalog && !readOnly,
  });
  const guessBrand = useMemo(() => {
    const id = job.input.brandId as string | undefined;
    if (id) return id;
    const g = out.standard.brandGuess?.toLowerCase();
    return (
      brands.data?.find((b) => g && (g.includes(b.name.toLowerCase()) || b.name.toLowerCase().includes(g)))
        ?.id ?? ''
    );
  }, [brands.data, job.input.brandId, out.standard.brandGuess]);
  const [newStd, setNewStd] = useState<{
    brandId: string;
    name: string;
    version: string;
    effectiveDate: string;
  } | null>(null);
  const startNew = () =>
    setNewStd({
      brandId: guessBrand,
      name:
        [out.standard.brandGuess, out.standard.name].filter(Boolean).join(' – ') ||
        (job.input.standardName as string | undefined) ||
        '',
      version: out.standard.version ?? '1',
      effectiveDate: out.standard.effectiveDate ?? '',
    });

  const reviewBody = () => ({
    review: {
      items: rows.map((r, index) => ({
        index,
        accepted: r.accepted,
        ...(Object.keys(r.edits).length ? { edits: editsPayload(r.edits) } : {}),
      })),
    },
  });
  const save = useMutation({
    mutationFn: () => api.post<Job>('ai', `/jobs/${job.id}/review`, reviewBody()),
    onSuccess: (j) => {
      setDirty(false);
      qc.setQueryData(aiKeys.job(job.id), j);
      toast.success('Review saved');
    },
  });
  const [applyError, setApplyError] = useState<string | null>(
    job.applyError ? applyErrorText(new Error(job.applyError)) : null,
  );
  const apply = useMutation({
    mutationFn: async () => {
      setApplyError(null);
      await api.post('ai', `/jobs/${job.id}/review`, reviewBody());
      setDirty(false);
      let sid = standardId;
      if (target === 'catalog' && newStd) {
        const created = await api.post<BrandStandard>('catalog', '/brand-standards', {
          brandId: newStd.brandId,
          name: newStd.name.trim(),
          version: newStd.version.trim() || '1',
          effectiveDate: newStd.effectiveDate || null,
          sourceDocumentId: documentId,
        });
        sid = created.id;
        setStandardId(sid);
        setNewStd(null);
        qc.invalidateQueries({ queryKey: ['catalog', 'standards'] });
      }
      return api.post<Job>('ai', `/jobs/${job.id}/apply`, {
        target,
        ...(target === 'catalog' ? { standardId: sid } : {}),
        itemIndexes: rows.flatMap((r, i) => (r.accepted ? [i] : [])),
      });
    },
    onSuccess: (j) => {
      qc.setQueryData(aiKeys.job(job.id), j);
      qc.invalidateQueries({ queryKey: ['ai', 'jobs'] });
      qc.invalidateQueries({ queryKey: ['catalog'] });
      toast.success(
        target === 'catalog'
          ? `${accepted} items applied to the brand standard`
          : `${accepted} items added to the spec library`,
      );
    },
    onError: (e) => {
      setApplyError(applyErrorText(e));
      qc.invalidateQueries({ queryKey: aiKeys.job(job.id) });
    },
  });

  const applied = job.status === 'applied' ? job.applyResult : null;
  const targetReady =
    target === 'specs' || (newStd ? !!newStd.brandId && newStd.name.trim().length >= 2 : !!standardId);

  // ---------------------------------------------------------------- render
  const cols: { key: Editable; label: string; width: string }[] = [
    { key: 'area', label: 'Area', width: 'min-w-[130px]' },
    { key: 'category', label: 'Category', width: 'min-w-[150px]' },
    { key: 'name', label: 'Name', width: 'min-w-[260px]' },
    { key: 'dimensions', label: 'Dimensions', width: 'min-w-[150px]' },
    { key: 'finish', label: 'Finish', width: 'min-w-[220px]' },
    { key: 'materials', label: 'Materials', width: 'min-w-[220px]' },
    { key: 'vendors', label: 'Approved vendors', width: 'min-w-[280px]' },
  ];

  return (
    <div className="space-y-5">
      {applied && (
        <Banner
          tone="ok"
          title={
            applied.target === 'catalog'
              ? `${applied.applied} items applied to the brand standard`
              : `${applied.applied} items added to the spec library (${applied.created ?? 0} new, ${applied.updated ?? 0} updated)`
          }
          actions={
            applied.target === 'catalog' ? (
              <Link to={`/app/catalog/standards/${applied.standardId}`}>
                <Button size="sm" icon={<BookOpen className="size-4" />}>
                  Open brand standard
                </Button>
              </Link>
            ) : (
              <Link to="/app/specs">
                <Button size="sm">Open spec library</Button>
              </Link>
            )
          }
        >
          Applied by {job.appliedByName ?? 'someone'} {job.appliedAt ? `on ${date(job.appliedAt)}` : ''}.
        </Banner>
      )}

      <Section title="What the PDF says about itself" bodyClassName="px-4 py-3">
        <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-4">
          {[
            ['Package', out.standard.name],
            ['Brand', out.standard.brandGuess],
            ['Version', out.standard.version],
            ['Effective', out.standard.effectiveDate ? date(out.standard.effectiveDate) : null],
          ].map(([l, v]) => (
            <div key={l} className="min-w-0">
              <dt className="text-[12px] text-ink-3">{l}</dt>
              <dd className={cx('truncate', !v && 'text-ink-4')}>{v ?? 'Not found'}</dd>
            </div>
          ))}
        </dl>
      </Section>

      {!readOnly && <Warnings items={out.warnings} />}

      {!out.items.length ? (
        <Banner tone="neutral" icon={<FileText />} title="No items were found in this PDF">
          Pro-Cure looks for item codes such as “CG-101” followed by labelled lines (Dimensions:, Finish:,
          Approved Manufacturer(s):). Scanned PDFs need OCR; retry once an AI model is connected, or add items
          by hand on the brand standard.
        </Banner>
      ) : (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_400px] 2xl:grid-cols-[minmax(0,1fr)_480px]">
          <Section
            bodyClassName="p-0"
            title={
              <span>
                Extracted items{' '}
                <span className="num font-normal text-ink-3">
                  {accepted} of {rows.length} accepted{edited ? ` · ${edited} edited` : ''}
                </span>
              </span>
            }
            actions={
              !readOnly && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[13px] text-ink-2 max-sm:hidden">Accept</span>
                  <select
                    aria-label="Confidence threshold"
                    value={threshold}
                    onChange={(e) => setThreshold(e.target.value)}
                    className="h-7 rounded-xs border border-line bg-paper px-1.5 text-[13px]"
                  >
                    {['0.9', '0.8', '0.7', '0.5'].map((t) => (
                      <option key={t} value={t}>
                        ≥ {Math.round(Number(t) * 100)}%
                      </option>
                    ))}
                  </select>
                  <Button
                    size="sm"
                    onClick={() => {
                      setRows((rs) =>
                        rs.map((r, i) => ({ ...r, accepted: out.items[i]!.confidence >= Number(threshold) })),
                      );
                      setDirty(true);
                    }}
                  >
                    Apply threshold
                  </Button>
                </div>
              )
            }
          >
            <div className="max-h-[70vh] overflow-auto">
              <table className="grid-table text-[13px] [&_td]:py-1.5">
                <thead>
                  <tr>
                    <th style={{ width: 36 }} className="left-0 z-[2]">
                      {!readOnly && (
                        <Checkbox
                          label="Accept all"
                          checked={accepted === rows.length}
                          indeterminate={accepted > 0 && accepted < rows.length}
                          onChange={(v) => {
                            setRows((rs) => rs.map((r) => ({ ...r, accepted: v })));
                            setDirty(true);
                          }}
                        />
                      )}
                    </th>
                    <th className="left-[36px] z-[2] border-r border-line-2">Code</th>
                    {cols.map((c) => (
                      <th key={c.key}>{c.label}</th>
                    ))}
                    <th>Confidence</th>
                    <th>Page</th>
                  </tr>
                </thead>
                <tbody>
                  {out.items.map((it, i) => {
                    const r = rows[i]!;
                    const val = (k: Editable) => r.edits[k] ?? fieldOf(it, k);
                    return (
                      <tr
                        // biome-ignore lint/suspicious/noArrayIndexKey: extracted rows are addressed by index in the review
                        key={`${it.code}-${i}`}
                        data-selected={activeRow === i || undefined}
                        className={cx(!r.accepted && '[&_td]:text-ink-4 [&_input]:text-ink-4')}
                        onClick={() => {
                          setActiveRow(i);
                          if (it.sourcePage) setPage(it.sourcePage);
                        }}
                      >
                        <td className="sticky left-0 z-[1] bg-paper">
                          {readOnly ? (
                            <span
                              className={cx('block size-2 rounded-full', r.accepted ? 'bg-ok' : 'bg-ink-4')}
                              title={r.accepted ? 'Accepted' : 'Rejected'}
                            />
                          ) : (
                            <Checkbox
                              label={`Accept ${it.code}`}
                              checked={r.accepted}
                              onChange={(accepted) => update(i, { accepted })}
                            />
                          )}
                        </td>
                        <td className="sticky left-[36px] z-[1] min-w-[120px] border-r border-line-2 bg-paper">
                          {readOnly ? (
                            <span className="num font-[600]">{val('code')}</span>
                          ) : (
                            <CellInput
                              aria-label="Code"
                              className="num font-[600]"
                              value={val('code')}
                              changed={'code' in r.edits}
                              onChange={(v) => update(i, { edits: { code: v } })}
                            />
                          )}
                        </td>
                        {cols.map((c) => (
                          <td key={c.key} className={c.width}>
                            {readOnly ? (
                              c.key === 'category' ? (
                                categoryLabel(val(c.key))
                              ) : (
                                val(c.key) || <span className="text-ink-4">—</span>
                              )
                            ) : c.key === 'category' ? (
                              <CellSelect
                                label="Category"
                                value={val('category')}
                                changed={'category' in r.edits}
                                options={categoryOptions}
                                onChange={(v) => update(i, { edits: { category: v } })}
                              />
                            ) : (
                              <CellInput
                                aria-label={c.label}
                                value={val(c.key)}
                                placeholder="—"
                                title={val(c.key)}
                                changed={c.key in r.edits}
                                onChange={(v) => update(i, { edits: { [c.key]: v } })}
                              />
                            )}
                          </td>
                        ))}
                        <td>
                          <Confidence value={it.confidence} />
                        </td>
                        <td>
                          {it.sourcePage ? (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setActiveRow(i);
                                setPage(it.sourcePage!);
                              }}
                              className={cx(
                                'num h-6 rounded-xs px-1.5 text-[12px] font-[560]',
                                page === it.sourcePage
                                  ? 'bg-brass-100 text-brass'
                                  : 'bg-stone-2 text-ink-2 hover:bg-line',
                              )}
                              aria-label={`Show page ${it.sourcePage}`}
                            >
                              p.{it.sourcePage}
                            </button>
                          ) : (
                            <span className="text-ink-4">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Section>
          <PdfPageViewer
            documentId={documentId}
            page={page}
            pageCount={job.pages}
            onPage={setPage}
            className="h-[70vh] xl:sticky xl:top-4"
            label={activeRow !== null ? `${out.items[activeRow]!.code} on page ${page}` : undefined}
          />
        </div>
      )}

      {!readOnly && out.items.length > 0 && (
        <Section title="Apply">
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Apply to">
              {canCatalog && (
                <TargetOption
                  on={target === 'catalog'}
                  onClick={() => setTarget('catalog')}
                  title="A brand standard (shared catalog)"
                  body="Add the items to your firm’s draft package. It stays private until a Pro-Cure curator publishes it."
                />
              )}
              {canSpecs && (
                <TargetOption
                  on={target === 'specs'}
                  onClick={() => setTarget('specs')}
                  title="Your spec library"
                  body="Create private specs your firm can quote right away. Existing specs with the same code are updated."
                />
              )}
            </div>
            {target === 'catalog' &&
              (newStd ? (
                <div className="grid gap-3 rounded-sm border border-line p-3 sm:grid-cols-[1fr_2fr_120px_160px]">
                  <Field label="Brand">
                    {(id) => (
                      <Select
                        id={id}
                        value={newStd.brandId}
                        onChange={(e) => setNewStd({ ...newStd, brandId: e.target.value })}
                        placeholder="Choose a brand"
                        options={(brands.data ?? []).map((b) => ({ value: b.id, label: b.name }))}
                      />
                    )}
                  </Field>
                  <Field label="New package name">
                    {(id) => (
                      <Input
                        id={id}
                        value={newStd.name}
                        onChange={(e) => setNewStd({ ...newStd, name: e.target.value })}
                      />
                    )}
                  </Field>
                  <Field label="Version">
                    {(id) => (
                      <Input
                        id={id}
                        value={newStd.version}
                        onChange={(e) => setNewStd({ ...newStd, version: e.target.value })}
                      />
                    )}
                  </Field>
                  <Field label="Effective">
                    {(id) => (
                      <Input
                        id={id}
                        type="date"
                        value={newStd.effectiveDate}
                        onChange={(e) => setNewStd({ ...newStd, effectiveDate: e.target.value })}
                      />
                    )}
                  </Field>
                  <div className="sm:col-span-4">
                    <Button size="sm" variant="ghost" onClick={() => setNewStd(null)}>
                      Use an existing draft instead
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap items-end gap-2">
                  <Field label="Draft package" className="w-full max-w-[420px]">
                    {(id) => (
                      <Select
                        id={id}
                        value={standardId}
                        onChange={(e) => setStandardId(e.target.value)}
                        placeholder={drafts.data?.length ? 'Choose a draft' : 'Your firm has no drafts yet'}
                        options={(drafts.data ?? []).map((x) => ({
                          value: x.id,
                          label: `${x.name} (v${x.version}, ${x.itemCount} items)`,
                        }))}
                      />
                    )}
                  </Field>
                  <Button icon={<ListPlus className="size-4" />} onClick={startNew}>
                    Create a new draft
                  </Button>
                </div>
              ))}
            {applyError && (
              <Banner tone="crit" title="Not applied">
                {applyError}
              </Banner>
            )}
            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line-2 pt-3">
              {dirty && <span className="mr-auto text-[13px] text-ink-3">Unsaved review changes</span>}
              <Button
                variant="ghost"
                disabled={!dirty}
                loading={save.isPending}
                onClick={() => save.mutate()}
              >
                Save review
              </Button>
              <Button
                variant="primary"
                disabled={!accepted || !targetReady}
                loading={apply.isPending}
                onClick={() => apply.mutate()}
              >
                {target === 'catalog'
                  ? `Apply ${accepted} ${accepted === 1 ? 'item' : 'items'} to brand standard`
                  : `Add ${accepted} ${accepted === 1 ? 'item' : 'items'} to spec library`}
              </Button>
            </div>
          </div>
        </Section>
      )}
    </div>
  );
}

function TargetOption({
  on,
  onClick,
  title,
  body,
}: {
  on: boolean;
  onClick: () => void;
  title: string;
  body: string;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: card-style radio needs rich content a native radio can't hold
    <button
      type="button"
      role="radio"
      aria-checked={on}
      onClick={onClick}
      className={cx(
        'flex max-w-[380px] flex-1 basis-[280px] items-start gap-2.5 rounded-sm border p-3 text-left',
        on ? 'border-lacquer bg-lacquer-50' : 'border-line hover:border-ink-4',
      )}
    >
      <span
        className={cx(
          'mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border',
          on ? 'border-lacquer' : 'border-ink-4',
        )}
      >
        {on && <span className="size-2 rounded-full bg-lacquer" />}
      </span>
      <span>
        <span className="block font-[620]">{title}</span>
        <span className="mt-0.5 block text-[13px] text-ink-2">{body}</span>
      </span>
    </button>
  );
}
