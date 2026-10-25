import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import {
  Button,
  Checkbox,
  Dialog,
  EmptyState,
  Field,
  Input,
  SearchInput,
  Select,
  Sheet,
  Spinner,
  Textarea,
} from '@/components/ui';
import { api, type Page } from '@/lib/api';
import { money } from '@/lib/format';
import { useDebounced } from '@/lib/hooks';
import { CostStatusBadge, parseNum, plural, qk } from '../shared';
import type { Line, QuoteDetail, Spec } from '../types';
import { type LinePatch, useQuoteAction } from './data';

/** All fields of one line that don't fit the grid: description, finish, dimensions, notes, cost details. */
export function LineSheet({
  line,
  quote,
  costs,
  canEdit,
  onClose,
  onSave,
}: {
  line: Line | null;
  quote: QuoteDetail;
  costs: boolean;
  canEdit: boolean;
  onClose: () => void;
  onSave: (l: Line, p: LinePatch) => void;
}) {
  const [f, setF] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!line) return;
    setF({
      name: line.name,
      description: line.description ?? '',
      finish: line.finish ?? '',
      dimensions: line.dimensions ?? '',
      materials: line.materials ?? '',
      costExpiresAt: line.costExpiresAt ?? '',
      leadTimeWeeks: line.leadTimeWeeks === null ? '' : String(line.leadTimeWeeks),
      freightUnit: line.freightUnit === null ? '' : String(line.freightUnit),
      locationId: line.locationId ?? '',
      notes: line.notes ?? '',
      clientNotes: line.clientNotes ?? '',
    });
  }, [line]);
  if (!line) return null;
  const editable = canEdit && !line.poId;
  const set = (k: string) => (e: { target: { value: string } }) =>
    setF((x) => ({ ...x, [k]: e.target.value }));
  const save = () => {
    const s = (k: string) => (f[k]?.trim() ? f[k]!.trim() : null);
    const p: LinePatch = {};
    const text = ['description', 'finish', 'dimensions', 'materials', 'notes', 'clientNotes'] as const;
    if (f.name?.trim() && f.name.trim() !== line.name) p.name = f.name.trim();
    for (const k of text) if (s(k) !== (line[k] ?? null)) p[k] = s(k);
    if ((f.locationId || null) !== line.locationId) p.locationId = f.locationId || null;
    if (costs) {
      if (s('costExpiresAt') !== line.costExpiresAt) p.costExpiresAt = s('costExpiresAt');
      const lt = parseNum(f.leadTimeWeeks ?? '');
      if (lt !== line.leadTimeWeeks && !Number.isNaN(lt)) p.leadTimeWeeks = lt;
      const fr = parseNum(f.freightUnit ?? '');
      if (fr !== line.freightUnit && !Number.isNaN(fr)) p.freightUnit = fr;
    }
    if (Object.keys(p).length) onSave(line, p);
    onClose();
  };
  return (
    <Sheet
      open
      onClose={onClose}
      title={`${line.code} ${line.name}`}
      description={
        line.poNumber ? `On ${line.poNumber} — details are locked.` : (line.vendorName ?? undefined)
      }
      footer={
        <>
          <Button onClick={onClose}>{editable ? 'Cancel' : 'Close'}</Button>
          {editable && (
            <Button variant="primary" onClick={save}>
              Save line
            </Button>
          )}
        </>
      }
    >
      <fieldset disabled={!editable} className="space-y-4">
        <Field label="Name">{(id) => <Input id={id} value={f.name ?? ''} onChange={set('name')} />}</Field>
        <Field label="Location">
          {(id) => (
            <Select
              id={id}
              value={f.locationId ?? ''}
              onChange={set('locationId')}
              options={[
                { value: '', label: 'Unassigned' },
                ...quote.locations.map((l) => ({ value: l.id, label: l.path })),
              ]}
            />
          )}
        </Field>
        <Field label="Description">
          {(id) => <Textarea id={id} rows={2} value={f.description ?? ''} onChange={set('description')} />}
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Finish">
            {(id) => <Input id={id} value={f.finish ?? ''} onChange={set('finish')} />}
          </Field>
          <Field label="Dimensions">
            {(id) => <Input id={id} value={f.dimensions ?? ''} onChange={set('dimensions')} />}
          </Field>
        </div>
        <Field label="Materials">
          {(id) => <Input id={id} value={f.materials ?? ''} onChange={set('materials')} />}
        </Field>
        {costs && (
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Cost valid until">
              {(id) => (
                <Input id={id} type="date" value={f.costExpiresAt ?? ''} onChange={set('costExpiresAt')} />
              )}
            </Field>
            <Field label="Lead time (weeks)">
              {(id) => (
                <Input
                  id={id}
                  className="num"
                  inputMode="numeric"
                  value={f.leadTimeWeeks ?? ''}
                  onChange={set('leadTimeWeeks')}
                />
              )}
            </Field>
            <Field
              label="Freight per unit"
              hint={quote.freightMode === 'percent' ? 'Quote bills freight as a %.' : 'Added to landed cost.'}
            >
              {(id) => (
                <Input
                  id={id}
                  className="num"
                  inputMode="decimal"
                  value={f.freightUnit ?? ''}
                  onChange={set('freightUnit')}
                />
              )}
            </Field>
          </div>
        )}
        <Field label="Notes for the owner" hint="Printed on the owner’s quote under this item.">
          {(id) => <Textarea id={id} rows={2} value={f.clientNotes ?? ''} onChange={set('clientNotes')} />}
        </Field>
        <Field label="Internal notes" hint="Only your team sees these.">
          {(id) => <Textarea id={id} rows={2} value={f.notes ?? ''} onChange={set('notes')} />}
        </Field>
      </fieldset>
    </Sheet>
  );
}

/** Pick specs from other vendors to compete with a line in the price matrix. */
export function AlternatesSheet({
  line,
  quote,
  onClose,
}: {
  line: Line | null;
  quote: QuoteDetail;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (line) {
      setQ('');
      setPicked(new Set());
    }
  }, [line]);
  const specs = useQuery({
    queryKey: qk.specs({ q: dq, category: line?.category, alt: true }),
    queryFn: () =>
      api.get<Page<Spec>>('quoting', '/specs', {
        q: dq || undefined,
        category: dq ? undefined : line?.category,
        limit: 100,
      }),
    enabled: !!line,
    placeholderData: keepPreviousData,
  });
  const add = useQuoteAction(
    quote.id,
    () =>
      api.post<Line[]>('quoting', `/quotes/${quote.id}/lines/${line!.id}/alternates`, {
        specIds: [...picked],
      }),
    {
      success: (r) => `Added ${plural('competing option', r.length)} — compare them in the price matrix`,
      onDone: onClose,
    },
  );
  if (!line) return null;
  const rows = (specs.data?.items ?? []).filter((s) => s.id !== line.specId);
  return (
    <Sheet
      open
      onClose={onClose}
      width={640}
      title="Add competing vendors"
      description={`Options for ${line.code} ${line.name}. They’re added as alternates (not counted) until you select a winner in the price matrix.`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!picked.size}
            loading={add.isPending}
            onClick={() => add.mutate(undefined)}
          >
            {picked.size ? `Add ${plural('option', picked.size)}` : 'Add options'}
          </Button>
        </>
      }
    >
      <SearchInput
        value={q}
        onChange={setQ}
        placeholder="Search specs by code, name or vendor"
        className="mb-3"
      />
      {specs.isLoading ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : !rows.length ? (
        <EmptyState title="No other specs found">
          Create the competing spec in the spec library first.
        </EmptyState>
      ) : (
        <table className="grid-table">
          <tbody>
            {rows.map((s) => (
              <tr
                key={s.id}
                className="cursor-pointer"
                data-selected={picked.has(s.id) || undefined}
                onClick={() =>
                  setPicked((p) => {
                    const n = new Set(p);
                    n.has(s.id) ? n.delete(s.id) : n.add(s.id);
                    return n;
                  })
                }
              >
                <td style={{ width: 36 }}>
                  <Checkbox label={`Select ${s.code}`} checked={picked.has(s.id)} onChange={() => {}} />
                </td>
                <td>
                  <div className="font-[560]">
                    <span className="num mr-2 text-ink-2">{s.code}</span>
                    {s.name}
                  </div>
                  <div className="text-[12px] text-ink-3">{s.vendorName ?? 'No vendor'}</div>
                </td>
                <td className="right num">{money(s.cost)}</td>
                <td>
                  <CostStatusBadge status={s.costStatus} expiresAt={s.costExpiresAt} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Sheet>
  );
}

/** Bulk "set markup" / "move to location" dialog. */
export function BulkDialog({
  kind,
  count,
  quote,
  onClose,
  onApply,
  pending,
}: {
  kind: 'markup' | 'move' | 'delete' | null;
  count: number;
  quote: QuoteDetail;
  onClose: () => void;
  onApply: (v: string) => void;
  pending: boolean;
}) {
  const [v, setV] = useState('');
  useEffect(() => {
    setV(kind === 'markup' ? String(quote.defaultMarkupPct) : '');
  }, [kind, quote.defaultMarkupPct]);
  if (!kind) return null;
  const n = parseNum(v);
  const invalid = kind === 'markup' && (n === null || Number.isNaN(n));
  return (
    <Dialog
      open
      onClose={onClose}
      title={
        kind === 'markup'
          ? `Set markup on ${plural('line', count)}`
          : kind === 'move'
            ? `Move ${plural('line', count)}`
            : `Delete ${plural('line', count)}?`
      }
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant={kind === 'delete' ? 'danger' : 'primary'}
            disabled={invalid}
            loading={pending}
            onClick={() => onApply(v)}
          >
            {kind === 'markup' ? 'Set markup' : kind === 'move' ? 'Move lines' : 'Delete lines'}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!invalid) onApply(v);
        }}
      >
        {kind === 'markup' && (
          <Field label="Markup %" hint="Prices set by hand on these lines go back to markup pricing.">
            {(id) => (
              <Input
                id={id}
                autoFocus
                inputMode="decimal"
                className="num"
                value={v}
                onChange={(e) => setV(e.target.value)}
              />
            )}
          </Field>
        )}
        {kind === 'move' && (
          <Field label="Location">
            {(id) => (
              <Select
                id={id}
                value={v}
                onChange={(e) => setV(e.target.value)}
                options={[
                  { value: '', label: 'Unassigned' },
                  ...quote.locations.map((l) => ({ value: l.id, label: l.path })),
                ]}
              />
            )}
          </Field>
        )}
        {kind === 'delete' && (
          <p className="text-ink-2">The lines are removed from this quote. Library specs are not affected.</p>
        )}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
