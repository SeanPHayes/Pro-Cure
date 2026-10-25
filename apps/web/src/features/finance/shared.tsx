import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Plus, Trash2 } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Badge, Button, Chips, cx, Field, IconButton, Input, Select, Sheet, Textarea } from '@/components/ui';
import { ApiError, api, errorMessage, type Page } from '@/lib/api';
import { date, isoToday, money } from '@/lib/format';
import {
  BILL_KINDS,
  type BillPayment,
  type InvoiceDetail,
  type InvoiceKind,
  KIND_LABEL,
  METHOD_LABEL,
  PAYMENT_METHODS,
  type Payment,
  type PaymentMethod,
  type SyncStatus,
  type VendorBill,
} from './types';

// ------------------------------------------------------------------ query keys & lookups
export const fk = {
  all: ['finance'] as const,
  invoices: (q?: object) => ['finance', 'invoices', q ?? {}] as const,
  invoice: (id: string) => ['finance', 'invoice', id] as const,
  bills: (q?: object) => ['finance', 'bills', q ?? {}] as const,
  portfolio: ['finance', 'portfolio'] as const,
  projectFin: (id: string) => ['finance', 'project', id] as const,
  qbo: ['finance', 'qbo'] as const,
  qboLog: (q?: object) => ['finance', 'qbo-log', q ?? {}] as const,
};

export interface ProjectLite {
  id: string;
  number: string;
  name: string;
  clientOrgId: string | null;
  status: string;
}
export interface VendorLite {
  id: string;
  name: string;
}

export const useProjectsLite = () =>
  useQuery({
    queryKey: ['finance-lookup', 'projects'],
    queryFn: () => api.get<Page<ProjectLite>>('projects', '/projects', { limit: 200, sort: 'number' }),
    select: (d) => d.items,
    staleTime: 60_000,
    meta: { silent: true },
  });

export const useVendorsLite = () =>
  useQuery({
    queryKey: ['finance-lookup', 'vendors'],
    queryFn: () => api.get<Page<VendorLite>>('catalog', '/vendors', { limit: 200 }),
    select: (d) => d.items,
    staleTime: 60_000,
    meta: { silent: true },
  });

/** After any money movement: refresh every finance view (lists, records, portfolio, QuickBooks counts). */
export const useInvalidateFinance = () => {
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: fk.all }),
      qc.invalidateQueries({ queryKey: ['activity', 'finance'] }),
      qc.invalidateQueries({ queryKey: ['client-invoices'] }),
    ]);
};

// ------------------------------------------------------------------ small display bits
export const Money = ({
  value,
  className,
  muted0,
}: {
  value: number | null | undefined;
  className?: string;
  /** Render zero in a muted tone (keeps busy tables calm). */
  muted0?: boolean;
}) => (
  <span className={cx('num whitespace-nowrap', muted0 && !value && 'text-ink-4', className)}>
    {money(value)}
  </span>
);

const SYNC_LABEL: Record<SyncStatus, { label: string; tone: 'neutral' | 'warn' | 'ok' | 'crit' }> = {
  not_synced: { label: 'Not in QuickBooks', tone: 'neutral' },
  pending: { label: 'Sync pending', tone: 'warn' },
  synced: { label: 'In QuickBooks', tone: 'ok' },
  error: { label: 'Sync error', tone: 'crit' },
};

export function SyncBadge({ status, error }: { status: SyncStatus; error?: string | null }) {
  const s = SYNC_LABEL[status];
  return (
    <span title={error ?? undefined}>
      <Badge tone={s.tone}>{s.label}</Badge>
    </span>
  );
}

export const KindLabel = ({ kind }: { kind: InvoiceKind }) => <>{KIND_LABEL[kind]}</>;

/** Upstream services that were unreachable — kept quiet: one line, small type. */
export function Warnings({ warnings, className }: { warnings?: string[]; className?: string }) {
  if (!warnings?.length) return null;
  const services = [...new Set(warnings.map((w) => w.split(' ')[0]))];
  return (
    <p
      className={cx('flex items-start gap-1.5 text-[12px] text-ink-3', className)}
      title={warnings.join('\n')}
    >
      <AlertTriangle className="mt-px size-3.5 shrink-0 text-warn" />
      <span>
        Partial figures: {services.join(' and ')} {services.length === 1 ? 'is' : 'are'} unavailable, so
        contract value, committed cost and margin may read low until{' '}
        {services.length === 1 ? 'it’s' : 'they’re'} back.
      </span>
    </p>
  );
}

/** Fetch a file with the session token and hand it to the browser as a download. */
export async function downloadAuthed(
  path: string,
  filename: string,
  query?: Record<string, string | undefined>,
) {
  const res = await api.raw('finance', path, query);
  const blob = await res.blob();
  const cd = res.headers.get('content-disposition');
  const name = cd?.match(/filename="?([^"]+)"?/)?.[1] ?? filename;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const n = (v: string) => (v.trim() === '' ? Number.NaN : Number(v));

// ------------------------------------------------------------------ record payment (invoice or bill)
export function RecordPaymentSheet({
  open,
  onClose,
  target,
}: {
  open: boolean;
  onClose: () => void;
  target:
    | { type: 'invoice'; id: string; number: string; balance: number; party: string }
    | { type: 'bill'; id: string; number: string; balance: number; party: string }
    | null;
}) {
  const invalidate = useInvalidateFinance();
  const [amount, setAmount] = useState('');
  const [on, setOn] = useState(isoToday());
  const [method, setMethod] = useState<PaymentMethod>('ach');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  useEffect(() => {
    if (open && target) {
      setAmount(target.balance > 0 ? target.balance.toFixed(2) : '');
      setOn(isoToday());
      setMethod(target.type === 'invoice' ? 'check' : 'ach');
      setReference('');
      setNotes('');
    }
  }, [open, target]);
  const amt = n(amount);
  const tooMuch = !!target && amt > target.balance + 0.004;
  const valid = !!target && amt > 0 && !tooMuch && !!on;
  const m = useMutation({
    mutationFn: (): Promise<unknown> =>
      target!.type === 'invoice'
        ? api.post<{ payment: Payment }>('finance', `/invoices/${target!.id}/payments`, {
            amount: amt,
            receivedAt: on,
            method,
            reference: reference.trim() || null,
            notes: notes.trim() || null,
          })
        : api.post<{ payment: BillPayment }>('finance', `/bills/${target!.id}/payments`, {
            amount: amt,
            paidAt: on,
            method,
            reference: reference.trim() || null,
          }),
    onSuccess: () => {
      toast.success(`Payment recorded on ${target!.number}`);
      invalidate();
      onClose();
    },
  });
  if (!target) return null;
  const isInv = target.type === 'invoice';
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Record payment"
      description={`${target.number} · ${target.party} · ${money(target.balance)} open`}
      width={440}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!valid} loading={m.isPending} onClick={() => m.mutate()}>
            Record payment
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) m.mutate();
        }}
      >
        <Field
          label={isInv ? 'Amount received' : 'Amount paid'}
          error={tooMuch ? `That’s more than the ${money(target.balance)} open balance.` : undefined}
          hint={amt > 0 && amt < target.balance ? `Leaves ${money(target.balance - amt)} open.` : undefined}
        >
          {(id) => (
            <Input
              id={id}
              inputMode="decimal"
              className="num text-right"
              value={amount}
              autoFocus
              onChange={(e) => setAmount(e.target.value)}
            />
          )}
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={isInv ? 'Received on' : 'Paid on'}>
            {(id) => <Input id={id} type="date" value={on} onChange={(e) => setOn(e.target.value)} />}
          </Field>
          <Field label="Method">
            {(id) => (
              <Select
                id={id}
                value={method}
                onChange={(e) => setMethod(e.target.value as PaymentMethod)}
                options={PAYMENT_METHODS.map((v) => ({ value: v, label: METHOD_LABEL[v] }))}
              />
            )}
          </Field>
        </div>
        <Field label="Reference" hint="Check number, wire confirmation or ACH trace.">
          {(id) => <Input id={id} value={reference} onChange={(e) => setReference(e.target.value)} />}
        </Field>
        {isInv && (
          <Field label="Notes">
            {(id) => <Textarea id={id} value={notes} onChange={(e) => setNotes(e.target.value)} />}
          </Field>
        )}
        <button type="submit" hidden />
      </form>
    </Sheet>
  );
}

// ------------------------------------------------------------------ invoice editor (manual lines / from quote)
interface LineDraft {
  key: number;
  description: string;
  quantity: string;
  unitPrice: string;
}
let lineKey = 0;
const blankLine = (): LineDraft => ({ key: ++lineKey, description: '', quantity: '1', unitPrice: '' });

interface QuoteRow {
  id: string;
  number: string;
  name: string;
  status: string;
  totals?: { grandTotal: number; sellSubtotal: number };
}

export function InvoiceSheet({
  open,
  onClose,
  invoice,
  defaultProjectId,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  /** Edit an existing draft when given; otherwise create. */
  invoice?: InvoiceDetail | null;
  defaultProjectId?: string;
  onSaved?: (inv: InvoiceDetail) => void;
}) {
  const editing = !!invoice;
  const invalidate = useInvalidateFinance();
  const projects = useProjectsLite();
  const [mode, setMode] = useState<'manual' | 'quote'>('manual');
  const [projectId, setProjectId] = useState('');
  const [kind, setKind] = useState<InvoiceKind>('progress');
  const [issueDate, setIssueDate] = useState(isoToday());
  const [dueInDays, setDueInDays] = useState('30');
  const [po, setPo] = useState('');
  const [notes, setNotes] = useState('');
  const [taxRate, setTaxRate] = useState('0');
  const [lines, setLines] = useState<LineDraft[]>([blankLine()]);
  // from quote
  const [quoteId, setQuoteId] = useState('');
  const [qKind, setQKind] = useState<'deposit' | 'progress' | 'final'>('deposit');
  const [percent, setPercent] = useState('50');

  useEffect(() => {
    if (!open) return;
    if (invoice) {
      setMode('manual');
      setProjectId(invoice.projectId);
      setKind(invoice.kind);
      setIssueDate(invoice.issueDate);
      const d = Math.round((Date.parse(invoice.dueDate) - Date.parse(invoice.issueDate)) / 86_400_000);
      setDueInDays(String(Math.max(0, d)));
      setPo(invoice.poReference ?? '');
      setNotes(invoice.notes ?? '');
      setTaxRate(String(invoice.taxRate));
      setLines(
        invoice.lines.map((l) => ({
          key: ++lineKey,
          description: l.description,
          quantity: String(l.quantity),
          unitPrice: String(l.unitPrice),
        })),
      );
    } else {
      setMode('manual');
      setProjectId(defaultProjectId ?? '');
      setKind('progress');
      setIssueDate(isoToday());
      setDueInDays('30');
      setPo('');
      setNotes('');
      setTaxRate('0');
      setLines([blankLine()]);
      setQuoteId('');
      setQKind('deposit');
      setPercent('50');
    }
  }, [open, invoice, defaultProjectId]);

  const quotes = useQuery({
    queryKey: ['finance-lookup', 'approved-quotes', projectId],
    // The quotes list filters on one status at a time; approved and ordered quotes can both be billed.
    queryFn: async () => {
      const [approved, ordered] = await Promise.all(
        ['client_approved', 'ordered'].map((status) =>
          api.get<Page<QuoteRow>>('quoting', '/quotes', { projectId, status, limit: 50 }),
        ),
      );
      const items = [...approved!.items, ...ordered!.items];
      return { ...approved!, items, total: items.length };
    },
    enabled: open && mode === 'quote' && !!projectId,
    retry: false,
    meta: { silent: true },
  });
  const quotingDown = quotes.isError && !(quotes.error instanceof ApiError && quotes.error.status < 500);

  const priced = lines.map((l) => {
    const q = n(l.quantity);
    const u = n(l.unitPrice);
    return { ...l, q, u, amount: Number.isFinite(q * u) ? Math.round(q * u * 100) / 100 : 0 };
  });
  const subtotal = priced.reduce((s, l) => s + l.amount, 0);
  const tax = Math.round(subtotal * (n(taxRate) || 0)) / 100;
  const manualValid =
    !!projectId &&
    priced.length > 0 &&
    priced.every((l) => l.description.trim() && Number.isFinite(l.q) && Number.isFinite(l.u));
  const quoteValid = !!projectId && !!quoteId && (qKind === 'final' || (n(percent) > 0 && n(percent) <= 100));

  const project = projects.data?.find((p) => p.id === projectId);
  const save = useMutation({
    mutationFn: async () => {
      const header = {
        issueDate,
        dueInDays: Number(dueInDays) || 0,
        poReference: po.trim() || null,
        notes: notes.trim() || null,
        taxRate: n(taxRate) || 0,
      };
      const body = {
        ...header,
        kind,
        lines: priced.map((l) => ({ description: l.description.trim(), quantity: l.q, unitPrice: l.u })),
      };
      if (editing) return api.patch<InvoiceDetail>('finance', `/invoices/${invoice!.id}`, body);
      if (mode === 'quote')
        return api.post<InvoiceDetail>('finance', '/invoices/from-quote', {
          projectId,
          quoteId,
          kind: qKind,
          percent: qKind === 'final' ? undefined : n(percent),
          dueInDays: header.dueInDays,
          poReference: header.poReference,
          notes: header.notes,
          taxRate: header.taxRate,
        });
      return api.post<InvoiceDetail>('finance', '/invoices', { projectId, ...body });
    },
    onSuccess: (inv) => {
      toast.success(editing ? `Invoice ${inv.number} saved` : `Draft invoice ${inv.number} created`);
      invalidate();
      onClose();
      onSaved?.(inv);
    },
  });

  const setLine = (key: number, patch: Partial<LineDraft>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const valid = mode === 'manual' ? manualValid : quoteValid;
  return (
    <Sheet
      open={open}
      onClose={onClose}
      width={720}
      title={editing ? `Edit ${invoice!.number}` : 'New invoice'}
      description={
        editing
          ? 'Drafts can be changed freely until they’re sent to the owner.'
          : 'Invoices start as drafts. Nothing reaches the owner until you send it.'
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!valid} loading={save.isPending} onClick={() => save.mutate()}>
            {editing ? 'Save invoice' : 'Create draft invoice'}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {!editing && (
          <Chips
            value={mode}
            onChange={setMode}
            options={[
              { value: 'manual', label: 'Enter lines' },
              { value: 'quote', label: 'From approved quote' },
            ]}
          />
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Project"
            hint={project && !project.clientOrgId ? 'This project has no owner organization yet.' : undefined}
          >
            {(id) => (
              <Select
                id={id}
                value={projectId}
                disabled={editing}
                onChange={(e) => {
                  setProjectId(e.target.value);
                  setQuoteId('');
                }}
                placeholder={projects.isLoading ? 'Loading projects…' : 'Choose a project'}
                options={(projects.data ?? [])
                  .filter((p) => editing || p.status !== 'cancelled')
                  .map((p) => ({ value: p.id, label: `${p.number} · ${p.name}` }))}
              />
            )}
          </Field>
          {mode === 'manual' ? (
            <Field label="Kind">
              {(id) => (
                <Select
                  id={id}
                  value={kind}
                  onChange={(e) => setKind(e.target.value as InvoiceKind)}
                  options={(Object.keys(KIND_LABEL) as InvoiceKind[]).map((k) => ({
                    value: k,
                    label: KIND_LABEL[k],
                  }))}
                />
              )}
            </Field>
          ) : (
            <Field label="Kind">
              {(id) => (
                <Select
                  id={id}
                  value={qKind}
                  onChange={(e) => {
                    const k = e.target.value as typeof qKind;
                    setQKind(k);
                    setPercent(k === 'deposit' ? '50' : '25');
                    setDueInDays(k === 'deposit' ? '0' : '30');
                  }}
                  options={[
                    { value: 'deposit', label: 'Deposit (percent of quote)' },
                    { value: 'progress', label: 'Progress (percent of quote)' },
                    { value: 'final', label: 'Final (remaining balance)' },
                  ]}
                />
              )}
            </Field>
          )}
        </div>

        {mode === 'quote' && !editing && (
          <div className="space-y-3 rounded-sm border border-line-2 bg-stone p-3">
            {!projectId ? (
              <p className="text-ink-2">Choose a project to see its client-approved quotes.</p>
            ) : quotes.isLoading ? (
              <p className="text-ink-3">Looking for approved quotes…</p>
            ) : quotes.isError ? (
              <p className="text-ink-2">
                {quotingDown
                  ? 'Quoting can’t be reached right now, so approved quotes can’t be listed. '
                  : `Couldn’t load quotes (${errorMessage(quotes.error)}). `}
                Use <strong className="font-[560]">Enter lines</strong> to bill this project manually instead.
              </p>
            ) : !quotes.data?.items.length ? (
              <p className="text-ink-2">
                This project has no client-approved quotes yet. Once the owner approves a quote you can bill
                its deposit here, or use <strong className="font-[560]">Enter lines</strong> now.
              </p>
            ) : (
              <>
                <Field label="Approved quote">
                  {(id) => (
                    <Select
                      id={id}
                      value={quoteId}
                      onChange={(e) => setQuoteId(e.target.value)}
                      placeholder="Choose a quote"
                      options={quotes.data.items.map((q) => ({
                        value: q.id,
                        label: `${q.number} · ${q.name}${q.totals ? ` · ${money(q.totals.grandTotal)}` : ''}`,
                      }))}
                    />
                  )}
                </Field>
                {qKind !== 'final' ? (
                  <Field label="Percent of quote sell total" className="max-w-[200px]">
                    {(id) => (
                      <Input
                        id={id}
                        inputMode="decimal"
                        className="num text-right"
                        value={percent}
                        onChange={(e) => setPercent(e.target.value)}
                      />
                    )}
                  </Field>
                ) : (
                  <p className="text-[13px] text-ink-2">
                    Bills the quote’s sell total less every earlier deposit and progress invoice.
                  </p>
                )}
              </>
            )}
          </div>
        )}

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {mode === 'manual' && (
            <Field label="Issue date">
              {(id) => (
                <Input id={id} type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} />
              )}
            </Field>
          )}
          <Field label="Due in (days)" hint={Number(dueInDays) === 0 ? 'Due on receipt' : undefined}>
            {(id) => (
              <Input
                id={id}
                inputMode="numeric"
                className="num text-right"
                value={dueInDays}
                onChange={(e) => setDueInDays(e.target.value.replace(/\D/g, ''))}
              />
            )}
          </Field>
          <Field label="Owner PO">
            {(id) => <Input id={id} value={po} onChange={(e) => setPo(e.target.value)} />}
          </Field>
          <Field label="Tax rate (%)">
            {(id) => (
              <Input
                id={id}
                inputMode="decimal"
                className="num text-right"
                value={taxRate}
                onChange={(e) => setTaxRate(e.target.value)}
              />
            )}
          </Field>
        </div>

        {mode === 'manual' && (
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <h3 className="text-[13px] font-[560] text-ink-2">Lines</h3>
              <Button
                size="sm"
                variant="ghost"
                icon={<Plus className="size-3.5" />}
                onClick={() => setLines((ls) => [...ls, blankLine()])}
              >
                Add line
              </Button>
            </div>
            <div className="overflow-x-auto rounded-sm border border-line">
              <table className="grid-table min-w-[560px]">
                <thead>
                  <tr>
                    <th>Description</th>
                    <th className="right" style={{ width: 80 }}>
                      Qty
                    </th>
                    <th className="right" style={{ width: 130 }}>
                      Unit price
                    </th>
                    <th className="right" style={{ width: 120 }}>
                      Amount
                    </th>
                    <th style={{ width: 40 }} />
                  </tr>
                </thead>
                <tbody>
                  {priced.map((l, i) => (
                    <tr key={l.key}>
                      <td>
                        <Input
                          aria-label={`Line ${i + 1} description`}
                          value={l.description}
                          placeholder="e.g. Casegoods — 40% on production release"
                          onChange={(e) => setLine(l.key, { description: e.target.value })}
                        />
                      </td>
                      <td>
                        <Input
                          aria-label={`Line ${i + 1} quantity`}
                          inputMode="decimal"
                          className="num text-right"
                          value={l.quantity}
                          onChange={(e) => setLine(l.key, { quantity: e.target.value })}
                        />
                      </td>
                      <td>
                        <Input
                          aria-label={`Line ${i + 1} unit price`}
                          inputMode="decimal"
                          className="num text-right"
                          value={l.unitPrice}
                          placeholder="0.00"
                          onChange={(e) => setLine(l.key, { unitPrice: e.target.value })}
                        />
                      </td>
                      <td className="right">
                        <Money value={l.amount} muted0 />
                      </td>
                      <td>
                        <IconButton
                          label={`Remove line ${i + 1}`}
                          disabled={lines.length === 1}
                          onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                        >
                          <Trash2 className="size-4" />
                        </IconButton>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Totals
              className="mt-3 ml-auto max-w-[280px]"
              rows={[
                ['Subtotal', subtotal],
                ...(tax ? ([[`Tax (${n(taxRate)}%)`, tax]] as [string, number][]) : []),
              ]}
              total={['Total', subtotal + tax]}
            />
          </div>
        )}

        <Field label="Notes to the owner" hint="Printed on the invoice.">
          {(id) => <Textarea id={id} value={notes} onChange={(e) => setNotes(e.target.value)} />}
        </Field>
      </div>
    </Sheet>
  );
}

/** Ruled totals block: label/amount pairs with a heavier final row. */
export function Totals({
  rows,
  total,
  extra,
  className,
}: {
  rows: [string, number][];
  total: [string, number];
  extra?: [ReactNode, number, string?][];
  className?: string;
}) {
  return (
    <dl className={cx('text-[13.5px]', className)}>
      {rows.map(([l, v]) => (
        <div key={l} className="flex justify-between gap-6 py-1 text-ink-2">
          <dt>{l}</dt>
          <dd className="num">{money(v)}</dd>
        </div>
      ))}
      <div className="mt-1 flex justify-between gap-6 border-t border-ink py-1.5 font-[620]">
        <dt>{total[0]}</dt>
        <dd className="num">{money(total[1])}</dd>
      </div>
      {extra?.map(([l, v, cls]) => (
        <div
          key={typeof l === 'string' ? l : String(v)}
          className={cx('flex justify-between gap-6 py-1', cls)}
        >
          <dt>{l}</dt>
          <dd className="num">{money(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

// ------------------------------------------------------------------ vendor bill editor
export function BillSheet({
  open,
  onClose,
  defaultProjectId,
}: {
  open: boolean;
  onClose: () => void;
  defaultProjectId?: string;
}) {
  const invalidate = useInvalidateFinance();
  const projects = useProjectsLite();
  const vendors = useVendorsLite();
  const [f, setF] = useState({
    projectId: '',
    vendorId: '',
    number: '',
    kind: 'balance',
    billDate: isoToday(),
    dueDate: '',
    amount: '',
    poNumber: '',
    status: 'open',
    notes: '',
  });
  useEffect(() => {
    if (open)
      setF({
        projectId: defaultProjectId ?? '',
        vendorId: '',
        number: '',
        kind: 'balance',
        billDate: isoToday(),
        dueDate: '',
        amount: '',
        poNumber: '',
        status: 'open',
        notes: '',
      });
  }, [open, defaultProjectId]);
  const set = (patch: Partial<typeof f>) => setF((x) => ({ ...x, ...patch }));
  const amt = n(f.amount);
  const dueBefore = !!f.dueDate && f.dueDate < f.billDate;
  const valid = !!f.projectId && !!f.vendorId && !!f.number.trim() && amt > 0 && !dueBefore;
  const m = useMutation({
    mutationFn: () =>
      api.post<VendorBill>('finance', '/bills', {
        projectId: f.projectId,
        vendorId: f.vendorId,
        vendorName: vendors.data?.find((v) => v.id === f.vendorId)?.name,
        number: f.number.trim(),
        kind: f.kind,
        status: f.status,
        billDate: f.billDate,
        dueDate: f.dueDate || undefined,
        amount: amt,
        poNumber: f.poNumber.trim() || null,
        notes: f.notes.trim() || null,
      }),
    onSuccess: (b) => {
      toast.success(`Bill ${b.number} entered`);
      invalidate();
      onClose();
    },
  });
  const options = useMemo(
    () => ({
      projects: (projects.data ?? []).map((p) => ({ value: p.id, label: `${p.number} · ${p.name}` })),
      vendors: (vendors.data ?? []).map((v) => ({ value: v.id, label: v.name })),
    }),
    [projects.data, vendors.data],
  );
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Enter vendor bill"
      description="Deposit bills are created automatically when a purchase order is issued; enter balance, freight and other bills here."
      width={520}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!valid} loading={m.isPending} onClick={() => m.mutate()}>
            Enter bill
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Project">
          {(id) => (
            <Select
              id={id}
              value={f.projectId}
              onChange={(e) => set({ projectId: e.target.value })}
              placeholder="Choose a project"
              options={options.projects}
            />
          )}
        </Field>
        <Field label="Vendor">
          {(id) => (
            <Select
              id={id}
              value={f.vendorId}
              onChange={(e) => set({ vendorId: e.target.value })}
              placeholder={vendors.isLoading ? 'Loading vendors…' : 'Choose a vendor'}
              options={options.vendors}
            />
          )}
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Vendor invoice number">
            {(id) => <Input id={id} value={f.number} onChange={(e) => set({ number: e.target.value })} />}
          </Field>
          <Field label="PO number">
            {(id) => (
              <Input
                id={id}
                value={f.poNumber}
                placeholder="PO-26-0001"
                onChange={(e) => set({ poNumber: e.target.value })}
              />
            )}
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Kind">
            {(id) => (
              <Select
                id={id}
                value={f.kind}
                onChange={(e) => set({ kind: e.target.value })}
                options={BILL_KINDS.map((k) => ({ value: k, label: k[0]!.toUpperCase() + k.slice(1) }))}
              />
            )}
          </Field>
          <Field label="Amount">
            {(id) => (
              <Input
                id={id}
                inputMode="decimal"
                className="num text-right"
                placeholder="0.00"
                value={f.amount}
                onChange={(e) => set({ amount: e.target.value })}
              />
            )}
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Bill date">
            {(id) => (
              <Input
                id={id}
                type="date"
                value={f.billDate}
                onChange={(e) => set({ billDate: e.target.value })}
              />
            )}
          </Field>
          <Field
            label="Due date"
            hint={!f.dueDate ? 'Leave blank to use the vendor’s payment terms.' : undefined}
            error={dueBefore ? 'Due date can’t be before the bill date.' : undefined}
          >
            {(id) => (
              <Input
                id={id}
                type="date"
                value={f.dueDate}
                onChange={(e) => set({ dueDate: e.target.value })}
              />
            )}
          </Field>
        </div>
        <Field label="Payment">
          {(id) => (
            <Select
              id={id}
              value={f.status}
              onChange={(e) => set({ status: e.target.value })}
              options={[
                { value: 'open', label: 'Open — not yet scheduled' },
                { value: 'scheduled', label: 'Scheduled for payment' },
              ]}
            />
          )}
        </Field>
        <Field label="Notes">
          {(id) => <Textarea id={id} value={f.notes} onChange={(e) => set({ notes: e.target.value })} />}
        </Field>
      </div>
    </Sheet>
  );
}

export const dueTone = (d: string, open: boolean) => {
  if (!open) return 'text-ink-2';
  const days = Math.round((Date.parse(d) - Date.parse(isoToday())) / 86_400_000);
  return days < 0 ? 'text-crit' : days <= 7 ? 'text-warn' : 'text-ink-2';
};

export const dueNote = (d: string, open: boolean) => {
  if (!open) return null;
  const days = Math.round((Date.parse(d) - Date.parse(isoToday())) / 86_400_000);
  if (days < 0) return `${-days} ${days === -1 ? 'day' : 'days'} late`;
  if (days === 0) return 'Due today';
  if (days <= 14) return `In ${days} ${days === 1 ? 'day' : 'days'}`;
  return null;
};

export { date };
