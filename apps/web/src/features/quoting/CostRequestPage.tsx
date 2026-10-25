import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, BellRing, CheckCircle2, FileText, Pencil, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { DocumentsPanel, uploadDocument } from '@/components/shared/DocumentsPanel';
import { ThreadPanel } from '@/components/shared/ThreadPanel';
import {
  Badge,
  Button,
  Checkbox,
  cx,
  Dialog,
  EmptyState,
  Field,
  Input,
  Loading,
  Section,
  StatusBadge,
  Tabs,
  Textarea,
  TitleBlock,
} from '@/components/ui';
import { api, documentUrl } from '@/lib/api';
import { hasPerm, useSession } from '@/lib/auth';
import { ago, date, dateTime, humanize, money, relativeDue } from '@/lib/format';
import { BackLink, MarginCell, parseNum, plural, qk, RecordError } from './shared';
import type { CompareRow, CostRequestDetail, CostRequestLine } from './types';

const FIELD_LABEL: Record<string, string> = {
  cost: 'Unit cost',
  leadTimeWeeks: 'Lead time',
  name: 'Name',
  description: 'Description',
  vendorSku: 'Vendor SKU',
  finish: 'Finish',
  dimensions: 'Dimensions',
  materials: 'Materials',
};

export function Component() {
  const { id = '' } = useParams();
  const s = useSession();
  const qc = useQueryClient();
  const nav = useNavigate();
  const [tab, setTab] = useState<'compare' | 'files' | 'messages'>('compare');
  const cr = useQuery({
    queryKey: qk.costRequest(id),
    queryFn: () => api.get<CostRequestDetail>('quoting', `/cost-requests/${id}`),
  });
  const cmp = useQuery({
    queryKey: qk.compare(id),
    queryFn: () => api.get<{ rows: CompareRow[] }>('quoting', `/cost-requests/${id}/compare`),
    enabled: !!cr.data,
  });
  const canWrite = hasPerm(s, 'cost_requests:write') && hasPerm(s, 'quotes:write');
  const canSpec = hasPerm(s, 'specs:write');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [toSpec, setToSpec] = useState(false);
  const [specChanges, setSpecChanges] = useState(true);
  const [manual, setManual] = useState<CostRequestLine | null>(null);
  const [closing, setClosing] = useState(false);
  const rows = cmp.data?.rows ?? [];
  const applicable = rows.filter((r) => r.line.respondedAt && !r.line.appliedAt && !r.quoteLine?.poId);
  // biome-ignore lint/correctness/useExhaustiveDependencies: preselect only when compare data loads
  useEffect(() => {
    setPicked(new Set(applicable.map((r) => r.costRequestLineId)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cmp.data]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: qk.costRequest(id) });
    qc.invalidateQueries({ queryKey: qk.compare(id) });
    qc.invalidateQueries({ queryKey: ['quoting', 'cost-requests'] });
    if (cr.data) {
      qc.invalidateQueries({ queryKey: qk.quote(cr.data.quoteId) });
      qc.invalidateQueries({ queryKey: qk.lines(cr.data.quoteId) });
      qc.invalidateQueries({ queryKey: qk.summary(cr.data.quoteId) });
    }
  };
  const apply = useMutation({
    mutationFn: () =>
      api.post<{ applied: number; skipped: { reason: string }[]; specsUpdated: number }>(
        'quoting',
        `/cost-requests/${id}/apply`,
        {
          lineIds: [...picked],
          applyToSpec: toSpec,
          applySpecChanges: specChanges,
        },
      ),
    onSuccess: (r) => {
      toast.success(
        `Applied ${plural('price', r.applied)}${r.specsUpdated ? ` · ${plural('library spec', r.specsUpdated)} updated` : ''}`,
        {
          description: r.skipped.length ? r.skipped.map((x) => x.reason).join(' · ') : undefined,
        },
      );
      refresh();
    },
  });
  const remind = useMutation({
    mutationFn: () => api.post('quoting', `/cost-requests/${id}/remind`, {}),
    onSuccess: () => {
      toast.success('Reminder sent');
      refresh();
    },
  });
  const close = useMutation({
    mutationFn: () => api.post('quoting', `/cost-requests/${id}/close`),
    onSuccess: () => {
      toast.success('Cost request closed');
      setClosing(false);
      refresh();
    },
  });
  const file = useRef<HTMLInputElement>(null);
  const ai = useMutation({
    mutationFn: async (f: File) => {
      const d = cr.data!;
      const doc = await uploadDocument(f, {
        entityType: 'cost_request',
        entityId: d.id,
        kind: 'other',
        visibility: 'internal',
      });
      return api.post<{ id: string }>('ai', '/jobs/vendor-quote', {
        documentId: doc.id,
        costRequestId: d.id,
      });
    },
    onSuccess: (j) => {
      toast.success('Reading the vendor’s PDF with AI', {
        description: 'You’ll review the extracted prices before anything is applied.',
        action: { label: 'Open', onClick: () => nav(`/app/ai/jobs/${j.id}`) },
      });
      nav(`/app/ai/jobs/${j.id}`);
    },
  });

  if (cr.isLoading) return <Loading label="Loading cost request" />;
  if (cr.isError || !cr.data)
    return (
      <RecordError
        error={cr.error}
        what="cost request"
        back={{ to: '/app/cost-requests', label: 'Back to cost requests' }}
      />
    );
  const d = cr.data;
  const open = ['sent', 'viewed', 'responded', 'partially_applied'].includes(d.status);
  const waiting = d.status === 'sent' || d.status === 'viewed';
  const allSel = applicable.length > 0 && applicable.every((r) => picked.has(r.costRequestLineId));

  return (
    <div className="px-4 py-4 sm:px-6">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <BackLink to="/app/cost-requests">Cost requests</BackLink>
        {canWrite && (
          <div className="flex flex-wrap gap-2">
            {d.documentId && (
              <Button
                size="sm"
                icon={<FileText className="size-4" />}
                onClick={() => window.open(documentUrl(d.documentId!), '_blank')}
              >
                Request PDF
              </Button>
            )}
            {waiting && (
              <Button
                size="sm"
                icon={<BellRing className="size-4" />}
                loading={remind.isPending}
                disabled={!d.vendorEmail}
                title={d.vendorEmail ? `Email ${d.vendorEmail}` : 'The vendor has no contact email on file'}
                onClick={() => remind.mutate()}
              >
                Remind vendor
              </Button>
            )}
            {open && hasPerm(s, 'ai:use') && (
              <>
                <Button
                  size="sm"
                  icon={<Sparkles className="size-4" />}
                  loading={ai.isPending}
                  onClick={() => file.current?.click()}
                >
                  Read the vendor’s PDF quote with AI
                </Button>
                <input
                  ref={file}
                  type="file"
                  accept="application/pdf"
                  hidden
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) ai.mutate(f);
                    e.target.value = '';
                  }}
                />
              </>
            )}
            {open && (
              <Button size="sm" variant="ghost" onClick={() => setClosing(true)}>
                Close request
              </Button>
            )}
          </div>
        )}
      </div>
      <TitleBlock
        title={`${d.number} · ${d.vendorName ?? 'Vendor'}`}
        subtitle={
          <Link to={`/app/quotes/${d.quoteId}`} className="hover:text-lacquer hover:underline">
            {d.quoteNumber} {d.quoteName}
          </Link>
        }
        fields={[
          { label: 'Status', value: <StatusBadge status={d.status} /> },
          {
            label: 'Due',
            value: (
              <span className="num">
                {date(d.dueDate)}
                {waiting && d.dueDate && (
                  <span className="ml-1.5 font-[480] text-ink-3">{relativeDue(d.dueDate)}</span>
                )}
              </span>
            ),
          },
          { label: 'Sent', value: <span title={dateTime(d.sentAt)}>{ago(d.sentAt)}</span> },
          {
            label: 'Viewed',
            value: d.viewedAt ? <span title={dateTime(d.viewedAt)}>{ago(d.viewedAt)}</span> : 'Not yet',
          },
          {
            label: 'Responded',
            value: (
              <span className="num">
                {d.respondedLineCount}/{d.lineCount}
                {d.respondedAt && <span className="ml-1.5 font-[480] text-ink-3">{ago(d.respondedAt)}</span>}
              </span>
            ),
          },
        ]}
      />
      {d.message && (
        <p className="mt-3 rounded-sm border border-line bg-paper px-3 py-2 text-[13px] text-ink-2">
          <span className="font-[560] text-ink">Your message:</span> {d.message}
        </p>
      )}
      {!d.vendorOrgId && (
        <p className="mt-3 rounded-sm bg-warn-50 px-3 py-2 text-[13px] text-warn">
          This vendor isn’t on the vendor portal. Enter prices they send by phone or email with “Enter
          response”, or read their PDF with AI.
        </p>
      )}

      <Tabs
        className="mt-5 border-b border-line"
        value={tab}
        onChange={(v) => setTab(v as typeof tab)}
        items={[
          { value: 'compare', label: 'Compare & apply', count: applicable.length || undefined },
          { value: 'files', label: 'Files' },
          ...(d.vendorOrgId ? [{ value: 'messages', label: 'Messages with vendor' }] : []),
        ]}
      />
      <div className="pt-4">
        {tab === 'compare' &&
          (cmp.isLoading ? (
            <Loading />
          ) : (
            <Section bodyClassName="" title="Line by line">
              {applicable.length > 0 && canWrite && (
                <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-line-2 bg-brass-50 px-4 py-2.5 text-[13px]">
                  {/* biome-ignore lint/a11y/noLabelWithoutControl: wraps the Checkbox input */}
                  <label className="flex items-center gap-2 font-[560]">
                    <Checkbox
                      label="Select all responses"
                      checked={allSel}
                      indeterminate={!allSel && picked.size > 0}
                      onChange={(v) =>
                        setPicked(new Set(v ? applicable.map((r) => r.costRequestLineId) : []))
                      }
                    />
                    {picked.size} of {applicable.length} responses selected
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      className="accent-lacquer"
                      checked={specChanges}
                      onChange={(e) => setSpecChanges(e.target.checked)}
                    />
                    Accept the vendor’s spec corrections
                  </label>
                  {canSpec && (
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        className="accent-lacquer"
                        checked={toSpec}
                        onChange={(e) => setToSpec(e.target.checked)}
                      />
                      Also update the library spec (cost history)
                    </label>
                  )}
                  <Button
                    size="sm"
                    variant="primary"
                    className="ml-auto"
                    disabled={!picked.size}
                    loading={apply.isPending}
                    onClick={() => apply.mutate()}
                  >
                    {picked.size ? `Apply ${plural('price', picked.size)}` : 'Apply prices'}
                  </Button>
                </div>
              )}
              {!rows.length ? (
                <EmptyState title="No lines on this request" />
              ) : (
                <ul className="divide-y divide-line-2">
                  {rows.map((r) => (
                    <CompareItem
                      key={r.costRequestLineId}
                      row={r}
                      checked={picked.has(r.costRequestLineId)}
                      selectable={canWrite && applicable.includes(r)}
                      onCheck={(v) =>
                        setPicked((p) => {
                          const n = new Set(p);
                          v ? n.add(r.costRequestLineId) : n.delete(r.costRequestLineId);
                          return n;
                        })
                      }
                      onManual={canWrite && d.status !== 'closed' ? () => setManual(r.line) : undefined}
                    />
                  ))}
                </ul>
              )}
            </Section>
          ))}
        {tab === 'files' && (
          <Section title="Files">
            <DocumentsPanel
              entityType="cost_request"
              entityId={d.id}
              visibility={d.vendorOrgId ? 'vendor' : 'internal'}
              vendorOrgId={d.vendorOrgId}
            />
          </Section>
        )}
        {tab === 'messages' && d.vendorOrgId && (
          <Section title={`Messages with ${d.vendorName ?? 'the vendor'}`}>
            <ThreadPanel
              entityType="cost_request"
              entityId={d.id}
              visibility="vendor"
              vendorOrgId={d.vendorOrgId}
              allowEmail
              emptyHint="The vendor sees these messages in their portal. Use it for clarifications about this request."
            />
          </Section>
        )}
      </div>
      <ManualResponseDialog line={manual} crId={d.id} onClose={() => setManual(null)} onSaved={refresh} />
      <Dialog
        open={closing}
        onClose={() => setClosing(false)}
        title={`Close ${d.number}?`}
        footer={
          <>
            <Button onClick={() => setClosing(false)}>Cancel</Button>
            <Button variant="danger" loading={close.isPending} onClick={() => close.mutate()}>
              Close request
            </Button>
          </>
        }
      >
        <p className="text-ink-2">
          The vendor can no longer respond. Responses already received stay here and can still be applied.
        </p>
      </Dialog>
    </div>
  );
}

const show = (v: unknown, field: string) =>
  v === null || v === undefined || v === ''
    ? '—'
    : field === 'cost'
      ? money(v as number)
      : field === 'leadTimeWeeks'
        ? `${v} wk`
        : String(v);

function CompareItem({
  row,
  checked,
  selectable,
  onCheck,
  onManual,
}: {
  row: CompareRow;
  checked: boolean;
  selectable: boolean;
  onCheck: (v: boolean) => void;
  onManual?: () => void;
}) {
  const l = row.line;
  const v = row.vendorResponse;
  const base = row.quoteLine?.unitCost ?? row.librarySpec?.cost ?? l.currentCost;
  const delta = v.cost !== null && base ? ((v.cost - base) / base) * 100 : null;
  const specDiffs = row.differences.filter((x) => x.field !== 'cost' && x.field !== 'leadTimeWeeks');
  return (
    <li className={cx('px-4 py-3', checked && 'bg-brass-50/50')}>
      <div className="flex items-start gap-3">
        <div className="pt-0.5">
          {selectable ? (
            <Checkbox label={`Select ${l.code}`} checked={checked} onChange={onCheck} />
          ) : (
            <span className="block size-4" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div className="min-w-0">
              <span className="num mr-2 font-[600] text-ink-2">{l.code}</span>
              <span className="font-[560]">{l.name}</span>
              <span className="num ml-2 text-[12px] text-ink-3">× {l.quantity.toLocaleString()}</span>
            </div>
            <div className="flex items-center gap-2">
              {l.appliedAt ? (
                <Badge tone="ok">
                  <CheckCircle2 className="size-3.5" />
                  Applied {ago(l.appliedAt)}
                  {l.appliedToSpec ? ' · library updated' : ''}
                </Badge>
              ) : !l.respondedAt ? (
                <Badge tone="neutral">Waiting for vendor</Badge>
              ) : (
                <Badge tone="brass">
                  {v.source === 'manual'
                    ? 'Entered by staff'
                    : v.source === 'ai_pdf'
                      ? 'Read from PDF'
                      : 'From portal'}{' '}
                  {ago(v.respondedAt)}
                </Badge>
              )}
              {row.quoteLine?.poId && <Badge tone="neutral">Ordered — can’t apply</Badge>}
              {onManual && (
                <Button size="sm" variant="ghost" icon={<Pencil className="size-3.5" />} onClick={onManual}>
                  {l.respondedAt ? 'Edit response' : 'Enter response'}
                </Button>
              )}
            </div>
          </div>

          {l.respondedAt && (
            <div className="mt-2 grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
              <div className="overflow-x-auto rounded-sm border border-line">
                <table className="w-full text-[13px]">
                  <thead className="bg-stone text-[12px] text-ink-2">
                    <tr>
                      <th className="px-2.5 py-1.5 text-left font-[560]" />
                      <th className="px-2.5 py-1.5 text-right font-[560]">Vendor</th>
                      <th className="px-2.5 py-1.5 text-right font-[560]">Library</th>
                      <th className="px-2.5 py-1.5 text-right font-[560]">Quote</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-t border-line-2">
                      <td className="px-2.5 py-1.5 text-ink-2">Unit cost</td>
                      <td className="num px-2.5 py-1.5 text-right font-[620]">
                        {money(v.cost)}
                        {delta !== null && Math.abs(delta) >= 0.05 && (
                          <span className={cx('ml-1.5 text-[12px]', delta > 0 ? 'text-crit' : 'text-ok')}>
                            {delta > 0 ? '+' : ''}
                            {delta.toFixed(1)}%
                          </span>
                        )}
                      </td>
                      <td className="num px-2.5 py-1.5 text-right text-ink-2">
                        {money(row.librarySpec?.cost)}
                      </td>
                      <td className="num px-2.5 py-1.5 text-right text-ink-2">
                        {money(row.quoteLine?.unitCost)}
                      </td>
                    </tr>
                    <tr className="border-t border-line-2">
                      <td className="px-2.5 py-1.5 text-ink-2">Valid until</td>
                      <td className="num px-2.5 py-1.5 text-right">{date(v.expiresAt)}</td>
                      <td className="num px-2.5 py-1.5 text-right text-ink-2">
                        {date(row.librarySpec?.costExpiresAt)}
                      </td>
                      <td className="num px-2.5 py-1.5 text-right text-ink-2">
                        {date(row.quoteLine?.costExpiresAt)}
                      </td>
                    </tr>
                    <tr className="border-t border-line-2">
                      <td className="px-2.5 py-1.5 text-ink-2">Lead time</td>
                      <td className="num px-2.5 py-1.5 text-right">
                        {show(v.leadTimeWeeks, 'leadTimeWeeks')}
                      </td>
                      <td className="num px-2.5 py-1.5 text-right text-ink-2">
                        {show(row.librarySpec?.leadTimeWeeks, 'leadTimeWeeks')}
                      </td>
                      <td className="num px-2.5 py-1.5 text-right text-ink-2">
                        {show(row.quoteLine?.leadTimeWeeks, 'leadTimeWeeks')}
                      </td>
                    </tr>
                    {row.quoteLine && (
                      <tr className="border-t border-line-2">
                        <td className="px-2.5 py-1.5 text-ink-2">Margin</td>
                        <td className="px-2.5 py-1.5 text-right">
                          <MarginCell value={row.projectedMarginPct} />
                        </td>
                        <td />
                        <td className="px-2.5 py-1.5 text-right text-ink-2">
                          <MarginCell value={row.quoteLine.marginPct} />
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div className="space-y-2 text-[13px]">
                {specDiffs.length > 0 ? (
                  <div className="rounded-sm border border-brass/30 bg-brass-50 px-3 py-2">
                    <div className="mb-1 font-[600]">Spec corrections from the vendor</div>
                    <ul className="space-y-1">
                      {specDiffs.map((x) => (
                        <li key={x.field} className="flex flex-wrap items-baseline gap-x-2">
                          <span className="w-24 shrink-0 text-ink-2">
                            {FIELD_LABEL[x.field] ?? humanize(x.field)}
                          </span>
                          <s className="text-ink-3">{show(x.quote ?? x.library, x.field)}</s>
                          <ArrowRight className="size-3.5 self-center text-brass" />
                          <span className="font-[600]">{show(x.vendor, x.field)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <p className="text-ink-3">No spec changes suggested.</p>
                )}
                {v.notes && (
                  <p className="rounded-sm bg-stone px-3 py-2">
                    <span className="font-[560]">Vendor note:</span> {v.notes}
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

function ManualResponseDialog({
  line,
  crId,
  onClose,
  onSaved,
}: {
  line: CostRequestLine | null;
  crId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [cost, setCost] = useState('');
  const [exp, setExp] = useState('');
  const [lead, setLead] = useState('');
  const [notes, setNotes] = useState('');
  useEffect(() => {
    if (!line) return;
    setCost(line.responseCost === null ? '' : String(line.responseCost));
    setExp(line.responseExpiresAt ?? '');
    setLead(line.responseLeadTimeWeeks === null ? '' : String(line.responseLeadTimeWeeks));
    setNotes(line.responseNotes ?? '');
  }, [line]);
  const n = parseNum(cost);
  const bad = n !== null && (Number.isNaN(n) || n < 0);
  const save = useMutation({
    mutationFn: () =>
      api.put('quoting', `/cost-requests/${crId}/lines/${line!.id}/response`, {
        cost: n,
        expiresAt: exp || null,
        leadTimeWeeks: parseNum(lead),
        notes: notes.trim() || null,
      }),
    onSuccess: () => {
      toast.success(`Response saved for ${line!.code}`);
      onSaved();
      onClose();
    },
  });
  const memo = useMemo(() => line, [line]);
  if (!memo) return null;
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Enter response for ${memo.code}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={bad} loading={save.isPending} onClick={() => save.mutate()}>
            Save response
          </Button>
        </>
      }
    >
      <p className="mb-3 text-[13px] text-ink-2">
        For prices the vendor gave by phone or email. It’s recorded as entered by staff.
      </p>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Unit cost" error={bad ? 'Enter a number' : undefined}>
          {(id) => (
            <Input
              id={id}
              autoFocus
              className="num"
              inputMode="decimal"
              value={cost}
              onChange={(e) => setCost(e.target.value)}
            />
          )}
        </Field>
        <Field label="Valid until">
          {(id) => <Input id={id} type="date" value={exp} onChange={(e) => setExp(e.target.value)} />}
        </Field>
        <Field label="Lead time (wk)">
          {(id) => (
            <Input
              id={id}
              className="num"
              inputMode="numeric"
              value={lead}
              onChange={(e) => setLead(e.target.value)}
            />
          )}
        </Field>
      </div>
      <Field label="Notes" className="mt-3">
        {(id) => <Textarea id={id} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />}
      </Field>
    </Dialog>
  );
}
