import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Check, CheckCircle2, ChevronLeft, FileText, Pencil, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { toast } from 'sonner';
import { DocumentsPanel } from '@/components/shared/DocumentsPanel';
import { ThreadPanel } from '@/components/shared/ThreadPanel';
import {
  Button,
  cx,
  Dialog,
  EmptyState,
  ErrorNote,
  Input,
  Loading,
  ProgressBar,
  Section,
  Spinner,
  StatusBadge,
} from '@/components/ui';
import type { SpecChanges, VendorCostRequestDetail, VendorCostRequestLine } from '@/features/quoting/types';
import { DueLabel, needsResponse, VENDOR_STATUS } from '@/features/quoting/vendorShared';
import { ApiError, api, documentUrl, errorMessage } from '@/lib/api';
import { useMe } from '@/lib/auth';
import { dateTime, isoToday } from '@/lib/format';

const SPEC_FIELDS = [
  { key: 'name', label: 'Name' },
  { key: 'dimensions', label: 'Dimensions' },
  { key: 'finish', label: 'Finish' },
  { key: 'materials', label: 'Materials' },
] as const;

export function Component() {
  const { id = '' } = useParams();
  const s = useMe();
  const qc = useQueryClient();
  const key = ['vendor', 'cost-request', id];
  const q = useQuery({
    queryKey: key,
    queryFn: () => api.get<VendorCostRequestDetail>('quoting', `/vendor/cost-requests/${id}`),
  });
  const [confirm, setConfirm] = useState(false);
  const submit = useMutation({
    mutationFn: () => api.post<VendorCostRequestDetail>('quoting', `/vendor/cost-requests/${id}/submit`),
    onSuccess: (d) => {
      qc.setQueryData(key, d);
      qc.invalidateQueries({ queryKey: ['vendor', 'cost-requests'] });
      setConfirm(false);
      toast.success('Pricing submitted', { description: 'The buyer has been notified. Thank you!' });
    },
  });
  const firm = s.contexts.find((c) => c.tenantId === s.context.tenantId)?.tenantName ?? 'The buyer';

  if (q.isLoading) return <Loading label="Loading pricing request" />;
  if (q.isError || !q.data)
    return q.error instanceof ApiError && q.error.status === 404 ? (
      <EmptyState
        title="This pricing request isn’t available"
        action={
          <Link to="/vendor/cost-requests" className="font-[560] text-lacquer hover:underline">
            See your pricing requests
          </Link>
        }
      >
        It may have been withdrawn, or it was sent to a different company account.
      </EmptyState>
    ) : (
      <ErrorNote error={q.error} />
    );
  const d = q.data;
  const editable = ['sent', 'viewed', 'responded'].includes(d.status);
  const done = d.lines.filter((l) => l.respondedAt).length;
  const submitted = !needsResponse(d) && d.status !== 'closed';

  return (
    <div className="mx-auto max-w-[1100px] px-4 py-5 sm:px-6">
      <Link
        to="/vendor/cost-requests"
        className="inline-flex items-center gap-1 text-[13px] text-ink-2 hover:text-ink"
      >
        <ChevronLeft className="size-4" />
        Pricing requests
      </Link>
      <div className="mt-3 rounded-md border border-line bg-paper p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="num text-[13px] text-ink-3">{d.number}</div>
            <h1 className="text-[22px] font-[640]">{d.projectName ?? 'Hotel project'}</h1>
            <p className="mt-1 text-ink-2">
              {firm} asked you to price {d.lineCount} {d.lineCount === 1 ? 'item' : 'items'}.
            </p>
          </div>
          <div className="flex flex-wrap items-start gap-6 text-[13px]">
            <div>
              <div className="text-ink-3">Status</div>
              <StatusBadge status={d.status === 'sent' ? 'open' : d.status} label={VENDOR_STATUS[d.status]} />
            </div>
            <div>
              <div className="text-ink-3">Please respond by</div>
              <div className="font-[560]">
                <DueLabel r={d} />
              </div>
            </div>
            {d.documentId && (
              <a
                href={documentUrl(d.documentId)}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 font-[560] text-lacquer hover:underline"
              >
                <FileText className="size-4" />
                Request PDF
              </a>
            )}
          </div>
        </div>
        {d.message && (
          <blockquote className="mt-4 border-l-2 border-brass pl-3 text-ink">
            <div className="text-[12px] text-ink-3">Message from {firm}</div>
            {d.message}
          </blockquote>
        )}
      </div>

      {submitted && (
        <div className="mt-4 flex items-start gap-2 rounded-sm border border-ok/25 bg-ok-50 px-4 py-3 text-ok">
          <CheckCircle2 className="mt-0.5 size-5 shrink-0" />
          <div>
            <div className="font-[620]">
              Your pricing was submitted{d.respondedAt ? ` ${dateTime(d.respondedAt)}` : ''}.
            </div>
            <div className="text-[13px] text-ink-2">
              {editable
                ? `You can still change a price below — ${firm} sees the update.`
                : `${firm} has closed this request.`}
            </div>
          </div>
        </div>
      )}

      {editable && (
        <div className="sticky top-14 z-10 mt-4 flex flex-wrap items-center gap-4 rounded-md border border-line bg-paper/95 px-4 py-3 backdrop-blur">
          <div className="min-w-[200px] flex-1">
            <div className="mb-1 flex justify-between text-[13px]">
              <span className="font-[600]">
                {done} of {d.lineCount} items priced
              </span>
              <span className="text-ink-3">Saved automatically</span>
            </div>
            <ProgressBar
              value={(done / Math.max(1, d.lineCount)) * 100}
              tone={done === d.lineCount ? 'ok' : 'brass'}
            />
          </div>
          <Button variant="primary" disabled={!done} onClick={() => setConfirm(true)}>
            {d.status === 'responded' ? 'Submit updated pricing' : 'Submit pricing'}
          </Button>
        </div>
      )}

      <div className="mt-4 space-y-3">
        {d.lines.map((l, i) => (
          <LineForm
            key={l.id}
            index={i}
            line={l}
            reqId={d.id}
            editable={editable}
            onSaved={(nd) => qc.setQueryData(key, nd)}
          />
        ))}
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Section title="Attachments">
          <p className="mb-3 text-[13px] text-ink-2">
            Attach your formal quote, spec sheets or drawings. {firm} will see them.
          </p>
          <DocumentsPanel
            entityType="cost_request"
            entityId={d.id}
            visibility="vendor"
            vendorOrgId={s.context.orgId}
          />
        </Section>
        <Section title={`Messages with ${firm}`}>
          <ThreadPanel
            entityType="cost_request"
            entityId={d.id}
            visibility="vendor"
            vendorOrgId={s.context.orgId}
            emptyHint={`Questions about an item? Ask ${firm} here.`}
          />
        </Section>
      </div>

      <Dialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Submit your pricing?"
        footer={
          <>
            <Button onClick={() => setConfirm(false)}>Keep editing</Button>
            <Button variant="primary" loading={submit.isPending} onClick={() => submit.mutate()}>
              Submit pricing
            </Button>
          </>
        }
      >
        <p className="text-ink-2">
          {firm} will be notified that your prices are ready.
          {done < d.lineCount && (
            <>
              {' '}
              <b className="font-[600] text-warn">
                {d.lineCount - done} {d.lineCount - done === 1 ? 'item has' : 'items have'} no price yet
              </b>{' '}
              — they’ll be treated as not quoted.
            </>
          )}
        </p>
      </Dialog>
    </div>
  );
}

function LineForm({
  line,
  index,
  reqId,
  editable,
  onSaved,
}: {
  line: VendorCostRequestLine;
  index: number;
  reqId: string;
  editable: boolean;
  onSaved: (d: VendorCostRequestDetail) => void;
}) {
  const [cost, setCost] = useState(line.responseCost === null ? '' : String(line.responseCost));
  const [exp, setExp] = useState(line.responseExpiresAt ?? '');
  const [lead, setLead] = useState(
    line.responseLeadTimeWeeks === null ? '' : String(line.responseLeadTimeWeeks),
  );
  const [notes, setNotes] = useState(line.responseNotes ?? '');
  const [changes, setChanges] = useState<SpecChanges>(line.responseSpecChanges ?? {});
  const [editing, setEditing] = useState<string | null>(null);
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>(
    line.respondedAt ? 'saved' : 'idle',
  );
  const [err, setErr] = useState<string | null>(null);
  const last = useRef<string>('');

  const costN = cost.trim() === '' ? null : Number(cost.replace(/[$,\s]/g, ''));
  const leadN = lead.trim() === '' ? null : Number(lead);
  const invalid =
    (costN !== null && (Number.isNaN(costN) || costN < 0)) ||
    (leadN !== null && (Number.isNaN(leadN) || leadN < 0 || leadN > 260));

  const save = useMutation({
    mutationFn: (body: object) =>
      api.put<VendorCostRequestDetail>('quoting', `/vendor/cost-requests/${reqId}/lines/${line.id}`, body),
    onMutate: () => setState('saving'),
    onSuccess: (d) => {
      setState('saved');
      setErr(null);
      onSaved(d);
    },
    onError: (e) => {
      setState('error');
      setErr(errorMessage(e));
    },
    meta: { silent: true },
  });
  const persist = (over?: Partial<{ changes: SpecChanges }>) => {
    if (!editable || invalid) return;
    if (
      costN === null &&
      !line.respondedAt &&
      !lead &&
      !notes &&
      !Object.keys(over?.changes ?? changes).length
    )
      return;
    const body = {
      cost: costN,
      expiresAt: exp || null,
      leadTimeWeeks: leadN,
      notes: notes.trim() || null,
      specChanges: over?.changes ?? changes,
    };
    const sig = JSON.stringify(body);
    if (sig === last.current) return;
    last.current = sig;
    save.mutate(body);
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: remember the saved state once, on mount
  useEffect(() => {
    last.current = line.respondedAt
      ? JSON.stringify({
          cost: line.responseCost,
          expiresAt: line.responseExpiresAt,
          leadTimeWeeks: line.responseLeadTimeWeeks,
          notes: line.responseNotes,
          specChanges: line.responseSpecChanges ?? {},
        })
      : '';
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const current = (k: string) => (line as unknown as Record<string, string | null>)[k] ?? null;
  return (
    <section className={cx('rounded-md border bg-paper', state === 'saved' ? 'border-ok/30' : 'border-line')}>
      <div className="grid gap-4 p-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        <div className="min-w-0">
          <div className="flex items-start gap-2">
            <span className="num mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-stone-2 text-[12px] font-[600] text-ink-2">
              {index + 1}
            </span>
            <div className="min-w-0">
              <div className="num text-[12px] text-ink-3">
                {line.code}
                {line.vendorSku ? ` · your SKU ${line.vendorSku}` : ''}
              </div>
              <div className="font-[620]">{line.name}</div>
            </div>
          </div>
          <dl className="mt-3 space-y-1.5 text-[13px]">
            <div className="flex gap-2">
              <dt className="w-24 shrink-0 text-ink-3">Quantity</dt>
              <dd className="num font-[600]">{line.quantity.toLocaleString()}</dd>
            </div>
            {SPEC_FIELDS.filter((f) => f.key !== 'name' || changes.name).map((f) => {
              const ch = changes[f.key];
              const value = current(f.key);
              return (
                <div key={f.key} className="flex gap-2">
                  <dt className="w-24 shrink-0 text-ink-3">{f.label}</dt>
                  <dd className="min-w-0 flex-1">
                    {editing === f.key ? (
                      <SpecEdit
                        initial={ch?.to ?? value ?? ''}
                        onCancel={() => setEditing(null)}
                        onSave={(to) => {
                          const next = { ...changes };
                          if (to.trim() === (value ?? '').trim()) delete next[f.key];
                          else next[f.key] = { from: value, to: to.trim() || null };
                          setChanges(next);
                          setEditing(null);
                          persist({ changes: next });
                        }}
                      />
                    ) : ch ? (
                      <span className="flex flex-wrap items-center gap-x-1.5">
                        <s className="text-ink-3">{ch.from ?? '—'}</s>
                        <ArrowRight className="size-3.5 text-brass" />
                        <span className="font-[600]">{ch.to ?? '—'}</span>
                        {editable && (
                          <button
                            type="button"
                            className="text-[12px] text-ink-3 hover:text-crit"
                            onClick={() => {
                              const next = { ...changes };
                              delete next[f.key];
                              setChanges(next);
                              persist({ changes: next });
                            }}
                          >
                            Undo
                          </button>
                        )}
                      </span>
                    ) : (
                      <span className="text-ink">
                        {value ?? <span className="text-ink-4">Not specified</span>}
                      </span>
                    )}
                  </dd>
                </div>
              );
            })}
            {line.description && <p className="pt-1 text-ink-2">{line.description}</p>}
          </dl>
          {editable && !editing && (
            <div className="mt-2 flex flex-wrap items-center gap-1 text-[12px]">
              <span className="text-ink-3">Suggest a spec correction:</span>
              {SPEC_FIELDS.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  className="inline-flex items-center gap-1 rounded-xs px-1.5 py-0.5 font-[560] text-lacquer hover:bg-lacquer-50"
                  onClick={() => setEditing(f.key)}
                >
                  <Pencil className="size-3" />
                  {f.label}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="rounded-sm bg-stone p-3">
          <div className="grid gap-3 sm:grid-cols-3">
            {/* biome-ignore lint/a11y/noLabelWithoutControl: wraps the Input component */}
            <label className="flex flex-col gap-1 text-[13px]">
              <span className="font-[560] text-ink-2">Unit cost (USD)</span>
              <div className="relative">
                <span className="pointer-events-none absolute top-2 left-2.5 text-ink-3">$</span>
                <Input
                  aria-label={`Unit cost for ${line.code}`}
                  disabled={!editable}
                  inputMode="decimal"
                  className="num pl-6 text-right"
                  value={cost}
                  placeholder="0.00"
                  onChange={(e) => setCost(e.target.value)}
                  onBlur={() => persist()}
                />
              </div>
            </label>
            {/* biome-ignore lint/a11y/noLabelWithoutControl: wraps the Input component */}
            <label className="flex flex-col gap-1 text-[13px]">
              <span className="font-[560] text-ink-2">Price valid until</span>
              <Input
                aria-label={`Price valid until for ${line.code}`}
                disabled={!editable}
                type="date"
                min={isoToday()}
                value={exp}
                onChange={(e) => setExp(e.target.value)}
                onBlur={() => persist()}
              />
            </label>
            {/* biome-ignore lint/a11y/noLabelWithoutControl: wraps the Input component */}
            <label className="flex flex-col gap-1 text-[13px]">
              <span className="font-[560] text-ink-2">Lead time (weeks)</span>
              <Input
                aria-label={`Lead time for ${line.code}`}
                disabled={!editable}
                inputMode="numeric"
                className="num text-right"
                value={lead}
                placeholder="e.g. 12"
                onChange={(e) => setLead(e.target.value)}
                onBlur={() => persist()}
              />
            </label>
          </div>
          {/* biome-ignore lint/a11y/noLabelWithoutControl: wraps the Input component */}
          <label className="mt-3 flex flex-col gap-1 text-[13px]">
            <span className="font-[560] text-ink-2">Notes (optional)</span>
            <Input
              disabled={!editable}
              value={notes}
              placeholder="Minimums, freight terms, substitutions…"
              onChange={(e) => setNotes(e.target.value)}
              onBlur={() => persist()}
            />
          </label>
          <div className="mt-2 flex min-h-5 items-center justify-between gap-2 text-[12px]">
            <span className="num text-ink-2">
              {costN !== null &&
                !Number.isNaN(costN) &&
                `Extended: ${(costN * line.quantity).toLocaleString('en-US', { style: 'currency', currency: 'USD' })}`}
            </span>
            {invalid ? (
              <span className="text-crit">Enter numbers only (cost ≥ 0, lead time in weeks).</span>
            ) : state === 'saving' ? (
              <span className="inline-flex items-center gap-1 text-ink-3">
                <Spinner className="size-3.5" />
                Saving
              </span>
            ) : state === 'saved' ? (
              <span className="inline-flex items-center gap-1 font-[560] text-ok">
                <Check className="size-3.5" />
                Saved
              </span>
            ) : state === 'error' ? (
              <span className="text-crit">{err ?? 'Couldn’t save — try again.'}</span>
            ) : (
              <span className="text-ink-3">Not priced yet</span>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function SpecEdit({
  initial,
  onSave,
  onCancel,
}: {
  initial: string;
  onSave: (v: string) => void;
  onCancel: () => void;
}) {
  const [v, setV] = useState(initial);
  return (
    <span className="flex items-center gap-1">
      <Input
        autoFocus
        className="!h-8"
        value={v}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onSave(v);
          if (e.key === 'Escape') onCancel();
        }}
      />
      <button
        type="button"
        aria-label="Save correction"
        className="grid size-8 place-items-center rounded-sm bg-lacquer text-white"
        onClick={() => onSave(v)}
      >
        <Check className="size-4" />
      </button>
      <button
        type="button"
        aria-label="Cancel"
        className="grid size-8 place-items-center rounded-sm text-ink-3 hover:bg-stone-2"
        onClick={onCancel}
      >
        <X className="size-4" />
      </button>
    </span>
  );
}
