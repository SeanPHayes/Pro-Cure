import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Lock, Plus, Search, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import {
  Button,
  Checkbox,
  Chips,
  cx,
  EmptyState,
  Field,
  Input,
  SearchInput,
  Select,
  Sheet,
  Spinner,
  Textarea,
} from '@/components/ui';
import { ApiError, api, errorMessage, type Page } from '@/lib/api';
import { date, isoToday, money, pct } from '@/lib/format';
import { useDebounced } from '@/lib/hooks';
import {
  CostStatusBadge,
  categoryLabel,
  FlagChips,
  parseNum,
  plural,
  qk,
  SPEC_CATEGORY_OPTIONS,
  useProjects,
} from '../shared';
import type { ApprovalRequest, CostRequest, Line, MarkupRule, QuoteDetail, Spec } from '../types';
import { previewMerchandise } from './calc';
import { useQuoteAction } from './data';

// ================================================================ Add specs
interface StandardLite {
  id: string;
  name: string;
  brandName: string | null;
  itemCount: number;
}

export function AddSpecsSheet({
  open,
  onClose,
  quote,
  defaultLocationId,
}: {
  open: boolean;
  onClose: () => void;
  quote: QuoteDetail;
  defaultLocationId: string | null;
}) {
  const [source, setSource] = useState<'library' | 'standard'>('library');
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('');
  const [standardId, setStandardId] = useState('');
  const dq = useDebounced(q);
  const [picked, setPicked] = useState<Map<string, Spec>>(new Map());
  const [locationId, setLocationId] = useState<string>('');
  const [mode, setMode] = useState<'per_room' | 'fixed'>('per_room');
  const [perRoom, setPerRoom] = useState<Record<string, string>>({});
  const [fixed, setFixed] = useState('1');
  const [attic, setAttic] = useState('0');

  useEffect(() => {
    if (!open) return;
    setPicked(new Map());
    setQ('');
    setLocationId(defaultLocationId ?? '');
    setMode(quote.roomTypes.length ? 'per_room' : 'fixed');
    setPerRoom(Object.fromEntries(quote.roomTypes.map((r) => [r.id, '1'])));
    setFixed('1');
    setAttic('0');
  }, [open, defaultLocationId, quote.roomTypes]);

  const specs = useQuery({
    queryKey: qk.specs({ q: dq, category, picker: true }),
    queryFn: () =>
      api.get<Page<Spec>>('quoting', '/specs', {
        q: dq || undefined,
        category: category || undefined,
        limit: 100,
      }),
    enabled: open && source === 'library',
    placeholderData: keepPreviousData,
  });
  const standards = useQuery({
    queryKey: ['catalog', 'brand-standards', 'lite'],
    queryFn: () => api.get<Page<StandardLite>>('catalog', '/brand-standards', { limit: 100 }),
    enabled: open && source === 'standard',
    meta: { silent: true },
  });
  /** Library specs created from this brand standard (brand-standard items become specs via the library). */
  const stdSpecs = useQuery({
    queryKey: qk.specs({ standardId, picker: true }),
    queryFn: async () => {
      const all = await api.get<Page<Spec>>('quoting', '/specs', { limit: 500, q: dq || undefined });
      return all.items.filter((s) => s.brandStandardId === standardId);
    },
    enabled: open && source === 'standard' && !!standardId,
  });
  const rows = source === 'library' ? specs.data?.items : stdSpecs.data;

  const add = useQuoteAction(
    quote.id,
    () =>
      api.post<Line[]>('quoting', `/quotes/${quote.id}/lines`, {
        specIds: [...picked.keys()],
        locationId: locationId && locationId !== '__unassigned__' ? locationId : null,
        qtyMode: mode,
        ...(mode === 'per_room'
          ? {
              qtyPerRoom: Object.fromEntries(
                Object.entries(perRoom)
                  .map(([k, v]) => [k, Number(v) || 0] as const)
                  .filter(([, v]) => v > 0),
              ),
            }
          : { qtyFixed: Number(fixed) || 0 }),
        atticStockPct: Math.min(100, Math.max(0, Number(attic) || 0)),
      }),
    {
      success: (r) =>
        `Added ${plural('line', r.length)} to ${quote.locations.find((l) => l.id === locationId)?.name ?? 'the quote'}`,
      onDone: onClose,
    },
  );
  const toggle = (s: Spec) =>
    setPicked((m) => {
      const n = new Map(m);
      if (n.has(s.id)) n.delete(s.id);
      else n.set(s.id, s);
      return n;
    });

  return (
    <Sheet
      open={open}
      onClose={onClose}
      width={760}
      title="Add specs"
      description="Pick specs from your library, or from a brand standard package. Each becomes a line priced at the applicable markup."
      footer={
        <>
          <span className="mr-auto self-center text-[13px] text-ink-2">
            {picked.size ? `${plural('spec', picked.size)} selected` : 'Nothing selected yet'}
          </span>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!picked.size}
            loading={add.isPending}
            onClick={() => add.mutate(undefined)}
          >
            {picked.size ? `Add ${plural('line', picked.size)}` : 'Add lines'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Chips
            value={source}
            onChange={setSource}
            options={[
              { value: 'library', label: 'Spec library' },
              { value: 'standard', label: 'Brand standards' },
            ]}
          />
          <SearchInput
            value={q}
            onChange={setQ}
            placeholder="Search code, name, vendor"
            className="min-w-[200px] flex-1"
          />
          {source === 'library' ? (
            <div className="w-44">
              <Select
                aria-label="Category"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                placeholder="All categories"
                options={SPEC_CATEGORY_OPTIONS}
              />
            </div>
          ) : (
            <div className="w-full sm:w-72">
              <Select
                aria-label="Brand standard"
                value={standardId}
                onChange={(e) => setStandardId(e.target.value)}
                placeholder="Choose a brand standard"
                options={(standards.data?.items ?? []).map((s) => ({ value: s.id, label: s.name }))}
              />
            </div>
          )}
        </div>

        <div className="max-h-[42vh] overflow-y-auto rounded-sm border border-line">
          {source === 'standard' && !standardId ? (
            <EmptyState icon={<Search />} title="Choose a brand standard">
              Items from brand standards you’ve added to your library appear here. Use “From brand standard”
              in the spec library to bring new packages in.
            </EmptyState>
          ) : (source === 'library' ? specs.isLoading : stdSpecs.isLoading) ? (
            <div className="flex justify-center py-10">
              <Spinner />
            </div>
          ) : !rows?.length ? (
            <EmptyState icon={<Search />} title="No specs match">
              {source === 'standard'
                ? 'None of this standard’s items are in your library yet. Add them from the spec library first.'
                : 'Try another search or category, or create the spec in the spec library.'}
            </EmptyState>
          ) : (
            <table className="grid-table">
              <thead>
                <tr>
                  <th style={{ width: 36 }} />
                  <th>Spec</th>
                  <th>Vendor</th>
                  <th className="right">Cost</th>
                  <th>Cost status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => (
                  <tr
                    key={s.id}
                    data-selected={picked.has(s.id) || undefined}
                    className="cursor-pointer"
                    onClick={() => toggle(s)}
                  >
                    <td>
                      <Checkbox
                        label={`Select ${s.code}`}
                        checked={picked.has(s.id)}
                        onChange={() => toggle(s)}
                      />
                    </td>
                    <td>
                      <div className="font-[560]">
                        <span className="num mr-2 text-ink-2">{s.code}</span>
                        {s.name}
                      </div>
                      <div className="text-[12px] text-ink-3">
                        {[categoryLabel(s.category), s.finish, s.dimensions].filter(Boolean).join(' · ')}
                      </div>
                    </td>
                    <td className="text-ink-2">{s.vendorName ?? <span className="text-ink-4">—</span>}</td>
                    <td className="right num">{money(s.cost)}</td>
                    <td>
                      <CostStatusBadge status={s.costStatus} expiresAt={s.costExpiresAt} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="grid gap-4 rounded-sm border border-line bg-stone p-3 sm:grid-cols-2">
          <Field label="Add to location">
            {(id) => (
              <Select
                id={id}
                value={locationId}
                onChange={(e) => setLocationId(e.target.value)}
                options={[
                  { value: '', label: 'Unassigned' },
                  ...quote.locations.map((l) => ({ value: l.id, label: l.path })),
                ]}
              />
            )}
          </Field>
          <div className="flex flex-col gap-1.5">
            <span className="text-[13px] font-[560] text-ink-2">Quantity</span>
            <Chips
              value={mode}
              onChange={setMode}
              options={[
                { value: 'per_room', label: 'Per room type' },
                { value: 'fixed', label: 'Fixed quantity' },
              ]}
            />
          </div>
          {mode === 'per_room' ? (
            <div className="sm:col-span-2">
              {quote.roomTypes.length ? (
                <div className="flex flex-wrap gap-2">
                  {quote.roomTypes.map((r) => (
                    <label
                      key={r.id}
                      className="flex items-center gap-1.5 rounded-sm border border-line bg-paper px-2 py-1"
                    >
                      <span className="text-[13px]">{r.name}</span>
                      <input
                        inputMode="decimal"
                        className="num h-7 w-12 rounded-xs border border-line px-1 text-right"
                        value={perRoom[r.id] ?? ''}
                        onChange={(e) => setPerRoom((p) => ({ ...p, [r.id]: e.target.value }))}
                      />
                      <span className="num text-[12px] text-ink-3">× {r.count}</span>
                    </label>
                  ))}
                </div>
              ) : (
                <p className="text-[13px] text-ink-2">
                  Add room types to the quote first, or use a fixed quantity.
                </p>
              )}
            </div>
          ) : (
            <Field label="Quantity per line">
              {(id) => (
                <Input
                  id={id}
                  className="num"
                  inputMode="decimal"
                  value={fixed}
                  onChange={(e) => setFixed(e.target.value)}
                />
              )}
            </Field>
          )}
          <Field label="Attic stock %" hint="Spare units the owner keeps, rounded up.">
            {(id) => (
              <Input
                id={id}
                className="num"
                inputMode="decimal"
                value={attic}
                onChange={(e) => setAttic(e.target.value)}
              />
            )}
          </Field>
        </div>
      </div>
    </Sheet>
  );
}

// ================================================================ Merchandise
interface RuleDraft {
  key: number;
  category: string;
  locationId: string;
  markup: string;
}

export function MerchandiseSheet({
  open,
  onClose,
  quote,
  lines,
}: {
  open: boolean;
  onClose: () => void;
  quote: QuoteDetail;
  lines: Line[];
}) {
  const [rules, setRules] = useState<RuleDraft[]>([]);
  const [target, setTarget] = useState('');
  const [solve, setSolve] = useState(false);
  const [respect, setRespect] = useState(true);
  useEffect(() => {
    if (!open) return;
    setRules(
      quote.markupRules.map((r, i) => ({
        key: i,
        category: r.category ?? '',
        locationId: r.locationId ?? '',
        markup: String(r.markupPct),
      })),
    );
    setTarget(quote.minMarginPct !== null ? String(Math.max(quote.minMarginPct + 2, 18)) : '20');
    setSolve(false);
    setRespect(true);
  }, [open, quote.markupRules, quote.minMarginPct]);

  const parsed: MarkupRule[] = rules
    .filter((r) => r.markup.trim() !== '' && !Number.isNaN(Number(r.markup)))
    .map((r) => ({
      category: r.category || null,
      locationId: r.locationId || null,
      markupPct: Number(r.markup),
    }));
  const ruleKey = (r: RuleDraft) => `${r.category}|${r.locationId}`;
  const dupes = new Set(rules.map(ruleKey).filter((k, i, a) => a.indexOf(k) !== i));
  const targetN = solve ? parseNum(target) : null;
  const invalidTarget = solve && (targetN === null || Number.isNaN(targetN) || targetN < 0 || targetN >= 95);
  const preview = useMemo(
    () =>
      previewMerchandise(lines, quote, parsed, {
        targetMarginPct: invalidTarget ? null : targetN,
        respectOverrides: respect,
      }),
    [lines, quote, parsed, targetN, respect, invalidTarget],
  );
  const before = quote.totals;
  const save = useQuoteAction(
    quote.id,
    () =>
      api.post<{ updatedLines: number; solvedMarkupPct: number | null }>(
        'quoting',
        `/quotes/${quote.id}/merchandise`,
        {
          rules: parsed,
          targetMarginPct: invalidTarget ? null : targetN,
          respectOverrides: respect,
          saveRules: true,
        },
      ),
    {
      success: (r) =>
        `Markups applied to ${plural('line', r.updatedLines)}${r.solvedMarkupPct !== null ? ` (solved markup ${r.solvedMarkupPct}%)` : ''}`,
      onDone: onClose,
    },
  );
  const set = (key: number, patch: Partial<RuleDraft>) =>
    setRules((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const noCost = lines.filter((l) => l.isSelected && l.unitCost === null).length;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      width={680}
      title="Merchandise"
      description="Set markups by category and location. The most specific rule wins (category + location, then location, then category). Optionally solve the rest for a target margin."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={save.isPending}
            disabled={invalidTarget || dupes.size > 0 || (!parsed.length && !solve)}
            onClick={() => save.mutate(undefined)}
          >
            Apply markups
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <section>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="font-[620]">Markup rules</h3>
            <Button
              size="sm"
              icon={<Plus className="size-3.5" />}
              onClick={() =>
                setRules((rs) => [
                  ...rs,
                  { key: Date.now(), category: '', locationId: '', markup: String(quote.defaultMarkupPct) },
                ])
              }
            >
              Add rule
            </Button>
          </div>
          {!rules.length ? (
            <p className="rounded-sm border border-dashed border-line px-3 py-4 text-ink-2">
              No rules yet — every line uses its current markup (default {pct(quote.defaultMarkupPct, 0)}).
              Add a rule such as “Seating → 28%” or “Lobby → 30%”.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-sm border border-line">
              <table className="grid-table">
                <thead>
                  <tr>
                    <th>Category</th>
                    <th>Location</th>
                    <th className="right">Markup %</th>
                    <th style={{ width: 36 }} />
                  </tr>
                </thead>
                <tbody>
                  {rules.map((r) => (
                    <tr key={r.key} className={dupes.has(ruleKey(r)) ? '[&_td]:!bg-crit-50' : undefined}>
                      <td className="min-w-[150px]">
                        <Select
                          aria-label="Category"
                          value={r.category}
                          onChange={(e) => set(r.key, { category: e.target.value })}
                          options={[{ value: '', label: 'Any category' }, ...SPEC_CATEGORY_OPTIONS]}
                        />
                      </td>
                      <td className="min-w-[150px]">
                        <Select
                          aria-label="Location"
                          value={r.locationId}
                          onChange={(e) => set(r.key, { locationId: e.target.value })}
                          options={[
                            { value: '', label: 'Any location' },
                            ...quote.locations.map((l) => ({ value: l.id, label: l.path })),
                          ]}
                        />
                      </td>
                      <td className="right">
                        <Input
                          aria-label="Markup %"
                          inputMode="decimal"
                          className="num ml-auto w-20 text-right"
                          value={r.markup}
                          onChange={(e) => set(r.key, { markup: e.target.value })}
                        />
                      </td>
                      <td>
                        <button
                          type="button"
                          aria-label="Remove rule"
                          className="grid size-7 place-items-center rounded-sm text-ink-3 hover:bg-stone-2 hover:text-crit"
                          onClick={() => setRules((rs) => rs.filter((x) => x.key !== r.key))}
                        >
                          <Trash2 className="size-4" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {dupes.size > 0 && (
          <p className="-mt-3 text-[13px] text-crit">
            Two rules target the same category and location. Remove one so it’s clear which markup applies.
          </p>
        )}
        <section className="rounded-sm border border-line p-3">
          <label className="flex items-center gap-2 font-[560]">
            <input
              type="checkbox"
              className="accent-lacquer"
              checked={solve}
              onChange={(e) => setSolve(e.target.checked)}
            />
            Solve for a target margin
          </label>
          <p className="mt-1 text-[13px] text-ink-2">
            Lines no rule covers get one markup, calculated so the whole quote lands on the target margin.
          </p>
          {solve && (
            <div className="mt-2 flex items-center gap-2 [&>div]:w-auto">
              <Input
                aria-label="Target margin %"
                inputMode="decimal"
                className="num !w-24 text-right"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
              />
              <span className="text-ink-2">% margin</span>
              {invalidTarget && (
                <span className="text-[12px] text-crit">Enter a margin between 0 and 95</span>
              )}
            </div>
          )}
          <label className="mt-3 flex items-center gap-2 text-[13px]">
            <input
              type="checkbox"
              className="accent-lacquer"
              checked={respect}
              onChange={(e) => setRespect(e.target.checked)}
            />
            Keep prices that were set by hand
          </label>
        </section>

        <section>
          <h3 className="mb-2 font-[620]">Preview</h3>
          <div className="grid grid-cols-3 gap-px overflow-hidden rounded-sm border border-line bg-line text-[13px]">
            {[
              ['', 'Now', 'After'],
              ['Sell subtotal', money(before.sellSubtotal), money(preview.sell)],
              ['Cost', money(before.costSubtotal), money(preview.cost)],
              ['Margin', pct(before.marginPct), pct(preview.marginPct)],
            ].map((row, i) => (
              <div key={row[0] || 'h'} className="contents">
                {row.map((c, j) => (
                  <div
                    // biome-ignore lint/suspicious/noArrayIndexKey: fixed 3×4 preview grid
                    key={`${i}-${j}`}
                    className={cx(
                      'bg-paper px-3 py-2',
                      j > 0 && 'num text-right',
                      i === 0 && 'bg-stone text-[12px] font-[560] text-ink-2',
                      j === 2 && i > 0 && 'font-[620]',
                    )}
                  >
                    {c}
                  </div>
                ))}
              </div>
            ))}
          </div>
          <p className="mt-2 text-[13px] text-ink-2">
            {plural('line', preview.changed)} will change price
            {preview.solvedMarkupPct !== null
              ? `; solved markup ${preview.solvedMarkupPct}% for lines without a rule`
              : ''}
            .{noCost > 0 && ` ${plural('line', noCost)} without a cost can’t be priced yet.`}
          </p>
          {solve && !invalidTarget && preview.solvedMarkupPct === null && (
            <p className="mt-1 text-[13px] text-warn">
              Every line is already covered by a rule, so there’s nothing left to solve. Remove the “Any
              category” rules you want the target margin to decide.
            </p>
          )}
        </section>
      </div>
    </Sheet>
  );
}

// ================================================================ Request pricing
export function RequestPricingSheet({
  open,
  onClose,
  quote,
  lines,
  preselected,
}: {
  open: boolean;
  onClose: () => void;
  quote: QuoteDetail;
  lines: Line[];
  preselected: Set<string>;
}) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const eligible = lines.filter((l) => !l.poId);
  const needs = (l: Line) =>
    l.unitCost === null || l.flags.includes('cost_expired') || l.flags.includes('cost_expiring');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [due, setDue] = useState('');
  const [message, setMessage] = useState('');
  // biome-ignore lint/correctness/useExhaustiveDependencies: initialize the selection when the sheet opens
  useEffect(() => {
    if (!open) return;
    const pre = [...preselected].filter((id) => eligible.some((l) => l.id === id));
    setPicked(new Set(pre.length ? pre : eligible.filter(needs).map((l) => l.id)));
    const d = new Date();
    d.setDate(d.getDate() + 7);
    setDue(d.toISOString().slice(0, 10));
    setMessage('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const byVendor = useMemo(() => {
    const m = new Map<string, { name: string; lines: Line[] }>();
    const none: Line[] = [];
    for (const l of eligible.filter((x) => picked.has(x.id))) {
      if (!l.vendorId) {
        none.push(l);
        continue;
      }
      if (!m.has(l.vendorId)) m.set(l.vendorId, { name: l.vendorName ?? 'Vendor', lines: [] });
      m.get(l.vendorId)!.lines.push(l);
    }
    return { vendors: [...m.values()], none };
  }, [eligible, picked]);
  const send = useMutation({
    mutationFn: () =>
      api.post<{ requests: CostRequest[]; skipped: { code: string; reason: string }[]; warnings: string[] }>(
        'quoting',
        `/quotes/${quote.id}/cost-requests`,
        { lineIds: [...picked], dueDate: due || null, message: message.trim() || null },
      ),
    onSuccess: (r) => {
      toast.success(`Pricing requested from ${plural('vendor', r.requests.length)}`, {
        description: (() => {
          const email = r.requests.filter((x) => !x.vendorOrgId).map((x) => x.vendorName);
          const parts = [
            email.length ? `${email.join(', ')} aren’t on the portal — send their requests by email.` : '',
            r.skipped.length ? `${plural('line', r.skipped.length)} skipped (no vendor).` : '',
          ].filter(Boolean);
          return parts.join(' ') || 'Vendors were notified in their portal.';
        })(),
        action:
          r.requests.length === 1
            ? { label: 'Open', onClick: () => nav(`/app/cost-requests/${r.requests[0]!.id}`) }
            : undefined,
      });
      qc.invalidateQueries({ queryKey: ['quoting', 'cost-requests'] });
      qc.invalidateQueries({ queryKey: qk.quote(quote.id) });
      onClose();
    },
  });
  const toggle = (id: string) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const [show, setShow] = useState<'needs' | 'all'>('needs');
  const visible = show === 'needs' ? eligible.filter((l) => needs(l) || picked.has(l.id)) : eligible;
  const reqCount = byVendor.vendors.length;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      width={720}
      title="Request pricing"
      description="Lines are packaged into one request per vendor and sent to the vendor portal (and by email when the vendor has a contact)."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!reqCount || !due}
            loading={send.isPending}
            onClick={() => send.mutate()}
          >
            {reqCount ? `Send ${plural('request', reqCount)}` : 'Send requests'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Chips
            value={show}
            onChange={setShow}
            options={[
              { value: 'needs', label: 'Missing or expired cost', count: eligible.filter(needs).length },
              { value: 'all', label: 'All lines', count: eligible.length },
            ]}
          />
          <span className="num text-[13px] text-ink-2">{plural('line', picked.size)} selected</span>
        </div>
        <div className="max-h-[34vh] overflow-y-auto rounded-sm border border-line">
          {!visible.length ? (
            <EmptyState title="Every line has a current cost">
              Switch to “All lines” to re-confirm prices with vendors anyway.
            </EmptyState>
          ) : (
            <table className="grid-table">
              <thead>
                <tr>
                  <th style={{ width: 36 }}>
                    <Checkbox
                      label="Select all"
                      checked={visible.every((l) => picked.has(l.id))}
                      indeterminate={
                        visible.some((l) => picked.has(l.id)) && !visible.every((l) => picked.has(l.id))
                      }
                      onChange={(v) =>
                        setPicked((s) => {
                          const n = new Set(s);
                          for (const l of visible) v ? n.add(l.id) : n.delete(l.id);
                          return n;
                        })
                      }
                    />
                  </th>
                  <th>Line</th>
                  <th>Vendor</th>
                  <th className="right">Qty</th>
                  <th className="right">Current cost</th>
                  <th>Flags</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((l) => (
                  <tr
                    key={l.id}
                    data-selected={picked.has(l.id) || undefined}
                    className="cursor-pointer"
                    onClick={() => toggle(l.id)}
                  >
                    <td>
                      <Checkbox
                        label={`Select ${l.code}`}
                        checked={picked.has(l.id)}
                        onChange={() => toggle(l.id)}
                      />
                    </td>
                    <td>
                      <span className="num mr-2 text-ink-2">{l.code}</span>
                      {l.name}
                    </td>
                    <td className={cx(!l.vendorId && 'text-crit')}>{l.vendorName ?? 'No vendor'}</td>
                    <td className="right num">{l.quantity.toLocaleString()}</td>
                    <td className="right num">{money(l.unitCost)}</td>
                    <td>
                      <FlagChips flags={l.flags} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <section>
          <h3 className="mb-2 font-[620]">What will be sent</h3>
          {!reqCount && !byVendor.none.length ? (
            <p className="text-ink-2">Select lines to see one request per vendor.</p>
          ) : (
            <ul className="divide-y divide-line-2 rounded-sm border border-line">
              {byVendor.vendors.map((v) => (
                <li key={v.name} className="flex items-center justify-between gap-3 px-3 py-2">
                  <span className="font-[560]">{v.name}</span>
                  <span className="num text-[13px] text-ink-2">{plural('line', v.lines.length)}</span>
                </li>
              ))}
              {byVendor.none.length > 0 && (
                <li className="flex items-start gap-2 bg-warn-50 px-3 py-2 text-[13px] text-warn">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                  {plural('line', byVendor.none.length)} without a vendor will be skipped (
                  {byVendor.none.map((l) => l.code).join(', ')}). Assign a vendor on the spec first.
                </li>
              )}
            </ul>
          )}
        </section>
        <div className="grid gap-3 sm:grid-cols-[180px_1fr]">
          <Field label="Respond by">
            {(id) => (
              <Input
                id={id}
                type="date"
                min={isoToday()}
                value={due}
                onChange={(e) => setDue(e.target.value)}
              />
            )}
          </Field>
          <Field label="Message to vendors" hint="Optional. Shown at the top of their request.">
            {(id) => (
              <Textarea
                id={id}
                rows={2}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Please confirm pricing valid through Q1 and current lead times."
              />
            )}
          </Field>
        </div>
      </div>
    </Sheet>
  );
}

// ================================================================ Send to owner
export function SendToOwnerSheet({
  open,
  onClose,
  quote,
  approvals,
}: {
  open: boolean;
  onClose: () => void;
  quote: QuoteDetail;
  approvals: ApprovalRequest[];
}) {
  const qc = useQueryClient();
  const project = useQuery({
    queryKey: ['projects', 'project', quote.projectId],
    queryFn: () =>
      api.get<{
        name: string;
        contacts: { name: string; email: string | null; role: string; visibleToClient: boolean }[];
      }>('projects', `/projects/${quote.projectId}`),
    enabled: open && !!quote.projectId,
    meta: { silent: true },
  });
  const contacts = (project.data?.contacts ?? []).filter((c) => c.email);
  const [to, setTo] = useState<Set<string>>(new Set());
  const [extra, setExtra] = useState('');
  const [message, setMessage] = useState('');
  const [blocked, setBlocked] = useState<{
    title: string;
    approvals?: { policyName: string; reason: string }[];
  } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when the sheet opens or contacts load
  useEffect(() => {
    if (open) {
      setTo(new Set(contacts.filter((c) => c.visibleToClient !== false).map((c) => c.email!.toLowerCase())));
      setMessage('');
      setExtra('');
      setBlocked(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, project.data]);
  const pending = approvals.filter((a) => a.status === 'pending');
  const belowCost = quote.totals.flagCounts.below_cost;
  const missingPrice = quote.totals.flagCounts.missing_price;
  const send = useMutation({
    mutationFn: () => {
      const emails = [
        ...to,
        ...extra
          .split(/[,\s;]+/)
          .map((x) => x.trim().toLowerCase())
          .filter(Boolean),
      ];
      return api.post<{ sentTo: string[]; warnings: string[] }>(
        'quoting',
        `/quotes/${quote.id}/send-to-client`,
        {
          message: message.trim() || null,
          contacts: emails.length ? [...new Set(emails)].map((email) => ({ email })) : undefined,
        },
      );
    },
    onSuccess: (r) => {
      toast.success('Sent to owner', {
        description: r.sentTo.length
          ? `Emailed ${r.sentTo.join(', ')}`
          : r.warnings.join(' ') || 'Visible in the owner portal.',
      });
      qc.invalidateQueries({ queryKey: ['quoting'] });
      onClose();
    },
    onError: (e) => {
      if (e instanceof ApiError && e.status === 409) {
        const d = e.detail as { approvals?: { policyName: string; reason: string }[] } | undefined;
        setBlocked({ title: e.message, approvals: d?.approvals });
        qc.invalidateQueries({ queryKey: ['quoting'] });
      } else toast.error(errorMessage(e));
    },
    meta: { silent: true },
  });
  const hardBlock = pending.length > 0 || belowCost > 0 || missingPrice > 0;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      width={560}
      title="Send to owner"
      description="The owner sees sell prices only — never cost, markup or vendors. They can approve with a typed signature or request changes."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={hardBlock}
            loading={send.isPending}
            onClick={() => send.mutate()}
          >
            Send to owner
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {hardBlock && (
          <div className="rounded-sm border border-warn/30 bg-warn-50 p-3 text-[13px]">
            <div className="flex items-center gap-2 font-[620] text-warn">
              <Lock className="size-4" />
              This quote can’t be sent yet
            </div>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-ink">
              {pending.map((a) => (
                <li key={a.id}>
                  <b className="font-[600]">{a.policyName}</b>: {a.reason} — waiting for{' '}
                  {a.approverRole.replace(/_/g, ' ')} approval.
                </li>
              ))}
              {belowCost > 0 && (
                <li>{plural('line', belowCost)} priced below cost. Fix the price or markup.</li>
              )}
              {missingPrice > 0 && <li>{plural('line', missingPrice)} have no price yet.</li>}
            </ul>
          </div>
        )}
        {blocked && (
          <div className="rounded-sm border border-crit/25 bg-crit-50 p-3 text-[13px] text-crit">
            <div className="font-[620]">{blocked.title}</div>
            {blocked.approvals?.length ? (
              <>
                <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-ink">
                  {blocked.approvals.map((a) => (
                    <li key={a.policyName}>
                      {a.policyName}: {a.reason}
                    </li>
                  ))}
                </ul>
                <p className="mt-1.5 text-ink-2">
                  Approval requests were created and routed to the approvers.
                </p>
              </>
            ) : null}
          </div>
        )}
        {!hardBlock && !quote.internalApprovedAt && (
          <p className="rounded-sm bg-info-50 px-3 py-2 text-[13px] text-info">
            Approval rules are checked when you send. If a rule needs sign-off, approval requests are created
            and the quote waits for them.
          </p>
        )}
        <Field
          label="Recipients"
          hint="Project contacts with an email. Everyone listed gets a link to the owner portal and the PDF."
        >
          {() => (
            <div className="space-y-1.5">
              {project.isLoading && <Spinner className="size-4" />}
              {contacts.map((c) => (
                <label key={c.email} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    className="accent-lacquer"
                    checked={to.has(c.email!.toLowerCase())}
                    onChange={(e) =>
                      setTo((s) => {
                        const n = new Set(s);
                        e.target.checked ? n.add(c.email!.toLowerCase()) : n.delete(c.email!.toLowerCase());
                        return n;
                      })
                    }
                  />
                  <span className="font-[560]">{c.name}</span>
                  <span className="text-ink-3">{c.email}</span>
                </label>
              ))}
              {!project.isLoading && !contacts.length && (
                <p className="text-[13px] text-ink-2">
                  No project contacts with email — add recipients below, or the quote appears in the owner
                  portal only.
                </p>
              )}
              <Input
                value={extra}
                onChange={(e) => setExtra(e.target.value)}
                placeholder="Other emails, separated by commas"
              />
            </div>
          )}
        </Field>
        <Field label="Message">
          {(id) => (
            <Textarea
              id={id}
              rows={4}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder={`Hi — attached is quote ${quote.number} for your review. You can approve it online.`}
            />
          )}
        </Field>
        <dl className="grid grid-cols-2 gap-3 rounded-sm border border-line p-3 text-[13px]">
          <div>
            <dt className="text-ink-3">Owner total</dt>
            <dd className="num text-[16px] font-[640]">{money(quote.totals.grandTotal)}</dd>
          </div>
          <div>
            <dt className="text-ink-3">Valid until</dt>
            <dd className="num font-[560]">{date(quote.validUntil)}</dd>
          </div>
        </dl>
      </div>
    </Sheet>
  );
}

// ================================================================ copy / template
export function CopyQuoteSheet({
  open,
  onClose,
  quote,
  asTemplate,
}: {
  open: boolean;
  onClose: () => void;
  quote: QuoteDetail;
  asTemplate: boolean;
}) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const projects = useProjects();
  const [name, setName] = useState('');
  const [projectId, setProjectId] = useState('');
  useEffect(() => {
    if (open) {
      setName(asTemplate ? `${quote.name} template` : `${quote.name} (copy)`);
      setProjectId(quote.projectId ?? '');
    }
  }, [open, asTemplate, quote]);
  const m = useMutation({
    mutationFn: () =>
      api.post<QuoteDetail>('quoting', `/quotes/${quote.id}/copy`, {
        name: name.trim(),
        asTemplate,
        templateName: asTemplate ? name.trim() : undefined,
        projectId: asTemplate ? null : projectId || null,
      }),
    onSuccess: (q) => {
      toast.success(asTemplate ? `Template ${q.number} saved` : `Quote copied to ${q.number}`);
      qc.invalidateQueries({ queryKey: ['quoting', 'quotes'] });
      onClose();
      nav(`/app/quotes/${q.id}`);
    },
  });
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={asTemplate ? 'Save as template' : 'Copy quote'}
      description={
        asTemplate
          ? 'Templates keep room types, locations, lines and markup rules so the next property starts 80% done.'
          : 'Copies room types, locations, lines and markups. Ordering status is reset.'
      }
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={m.isPending}
            disabled={!name.trim() || (!asTemplate && !projectId)}
            onClick={() => m.mutate()}
          >
            {asTemplate ? 'Save as template' : 'Copy quote'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label={asTemplate ? 'Template name' : 'Quote name'}>
          {(id) => <Input id={id} autoFocus value={name} onChange={(e) => setName(e.target.value)} />}
        </Field>
        {!asTemplate && (
          <Field label="Project">
            {(id) => (
              <Select
                id={id}
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                options={(projects.data ?? []).map((p) => ({ value: p.id, label: `${p.number} ${p.name}` }))}
              />
            )}
          </Field>
        )}
      </div>
    </Sheet>
  );
}
