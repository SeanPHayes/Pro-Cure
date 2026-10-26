import { useMutation } from '@tanstack/react-query';
import { Check, FileText, Paperclip, Plus, RotateCcw, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { uploadDocument } from '@/components/shared/DocumentsPanel';
import {
  Badge,
  Button,
  cx,
  Facts,
  Field,
  Input,
  Menu,
  Section,
  Select,
  Sheet,
  Spinner,
  StatusBadge,
  Textarea,
} from '@/components/ui';
import { api, documentUrl, errorMessage } from '@/lib/api';
import { hasPerm, useSession } from '@/lib/auth';
import { date, money } from '@/lib/format';
import {
  fmtAddress,
  isPendingReq,
  OrderByDate,
  PARTY_LABEL,
  REQ_LABEL,
  REQ_STATUS_LABEL,
  RiskReasons,
  relDays,
  useInvalidateOrders,
} from '../shared';
import type { Contact, PoDetail, Requirement, RequirementKind } from '../types';

const ContactBlock = ({ c }: { c: Contact | null }) =>
  !c?.name && !c?.email && !c?.phone ? (
    <span className="text-ink-4">Not set</span>
  ) : (
    <div>
      {c?.name && <div>{c.name}</div>}
      {c?.email && (
        <a href={`mailto:${c.email}`} className="block truncate text-lacquer hover:underline">
          {c.email}
        </a>
      )}
      {c?.phone && (
        <a href={`tel:${c.phone}`} className="num block text-ink-2">
          {c.phone}
        </a>
      )}
    </div>
  );

export function OverviewTab({ po, onGoTo }: { po: PoDetail; onGoTo: (t: string) => void }) {
  const pending = po.requirements.filter((r) => isPendingReq(r.status));
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
      <div className="min-w-0 space-y-4">
        <RiskReasons level={po.escalation} reasons={po.escalationReasons} scoredAt={po.riskScoredAt} />
        <RequirementsSection po={po} />
        <Section
          title="Shipments"
          bodyClassName=""
          actions={
            <button
              type="button"
              onClick={() => onGoTo('shipments')}
              className="text-[13px] font-[560] text-lacquer hover:underline"
            >
              Manage shipments
            </button>
          }
        >
          <ul className="divide-y divide-line-2">
            {po.shipments.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5">
                <span className="font-[620]">
                  Shipment {s.label}
                  {s.note && <span className="ml-1.5 font-[480] text-ink-2">{s.note}</span>}
                </span>
                <StatusBadge status={s.status} />
                <span className="num ml-auto text-[13px] text-ink-2">
                  {s.deliveredAt
                    ? `Delivered ${date(s.deliveredAt)}`
                    : s.estimatedShipDate
                      ? `Ships ${date(s.estimatedShipDate)} (${relDays(s.estimatedShipDate)})`
                      : 'Ship date not set'}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      </div>
      <div className="min-w-0 space-y-4">
        <Section title="Schedule">
          <Facts
            cols={2}
            items={[
              {
                label: 'Requested delivery',
                value: <span className="num">{date(po.requestedDeliveryDate)}</span>,
              },
              {
                label: 'Order-by date',
                value: <OrderByDate value={po.releaseByDate} pending={pending.length} />,
              },
              {
                label: 'Lead time',
                value:
                  po.leadTimeWeeks !== null ? (
                    <span className="num">{po.leadTimeWeeks} weeks</span>
                  ) : (
                    'Unknown'
                  ),
              },
              {
                label: 'Transit',
                value: (
                  <span className="num">
                    {po.transitDays ?? '—'} days · {po.origin === 'international' ? 'Import' : 'Domestic'}
                  </span>
                ),
              },
              {
                label: 'Issued',
                value: po.issuedAt ? `${date(po.issuedAt)} by ${po.issuedByName ?? '—'}` : 'Not yet',
              },
              { label: 'Acknowledged', value: po.acknowledgedAt ? date(po.acknowledgedAt) : 'Not yet' },
            ]}
          />
          <p className="mt-3 text-[12px] text-ink-3">
            Order-by = requested delivery − lead time − transit: the last day every requirement must be done
            for production to meet the delivery date.
          </p>
        </Section>
        <Section title="Vendor">
          <Facts
            items={[
              { label: 'Contact', value: <ContactBlock c={po.vendorContact} /> },
              { label: 'Payment terms', value: po.paymentTerms },
              { label: 'Freight terms', value: po.freightTerms },
              { label: 'Ship method', value: po.shipMethod },
              {
                label: 'Deposit',
                value: po.depositPct
                  ? `${po.depositPct}% · ${money((po.total * po.depositPct) / 100)}`
                  : 'None',
              },
            ]}
          />
        </Section>
        <Section title="Delivery">
          <Facts
            items={[
              {
                label: 'Ship to',
                value: <span className="whitespace-pre-line">{fmtAddress(po.shipTo, true) || '—'}</span>,
              },
              { label: '24-hour contact', value: <ContactBlock c={po.contact24h} /> },
            ]}
          />
        </Section>
        {(po.vendorNotes || po.notes) && (
          <Section title="Notes">
            <Facts
              items={[
                ...(po.vendorNotes
                  ? [
                      {
                        label: 'On the PO (vendor sees)',
                        value: <span className="whitespace-pre-wrap">{po.vendorNotes}</span>,
                      },
                    ]
                  : []),
                ...(po.notes
                  ? [{ label: 'Internal', value: <span className="whitespace-pre-wrap">{po.notes}</span> }]
                  : []),
              ]}
            />
          </Section>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ requirements checklist
const ADDABLE: RequirementKind[] = [
  'shop_drawing_approval',
  'finish_sample_approval',
  'cfa',
  'deposit',
  'credit_approval',
  'other',
];

function RequirementsSection({ po }: { po: PoDetail }) {
  const s = useSession();
  const canWrite = hasPerm(s, 'orders:write') && po.status !== 'cancelled';
  const invalidate = useInvalidateOrders();
  const open = po.requirements.filter((r) => isPendingReq(r.status)).length;
  const add = useMutation({
    mutationFn: (kind: RequirementKind) =>
      api.post('orders', `/purchase-orders/${po.id}/requirements`, { kind }),
    onSuccess: () => {
      toast.success('Requirement added');
      invalidate();
    },
  });
  return (
    <Section
      title={
        <span>
          Pre-order requirements{' '}
          <span className={cx('num ml-1 font-[520]', open ? 'text-warn' : 'text-ok')}>
            {open ? `${open} open` : 'all done'}
          </span>
        </span>
      }
      bodyClassName=""
      actions={
        canWrite && (
          <Menu
            trigger={(toggle) => (
              <Button
                size="sm"
                variant="ghost"
                icon={<Plus className="size-3.5" />}
                onClick={toggle}
                loading={add.isPending}
              >
                Add requirement
              </Button>
            )}
            items={ADDABLE.map((k) => ({ label: REQ_LABEL[k], onSelect: () => add.mutate(k) }))}
          />
        )
      }
    >
      {!po.requirements.length ? (
        <p className="px-4 py-4 text-ink-2">
          No requirements: production can start as soon as the order is issued.
        </p>
      ) : (
        <ul className="divide-y divide-line-2">
          {po.requirements.map((r) => (
            <RequirementRow key={r.id} po={po} r={r} canWrite={canWrite} />
          ))}
        </ul>
      )}
    </Section>
  );
}

function RequirementRow({ po, r, canWrite }: { po: PoDetail; r: Requirement; canWrite: boolean }) {
  const invalidate = useInvalidateOrders();
  const file = useRef<HTMLInputElement>(null);
  const done = r.status === 'approved' || r.status === 'waived';
  const due = r.dueDate ?? po.releaseByDate;
  const overdue = !done && r.overdue;
  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.patch('orders', `/purchase-orders/${po.id}/requirements/${r.id}`, body),
    onSuccess: (_d, body) => {
      toast.success(
        body.status === 'approved'
          ? `${r.label} marked complete`
          : body.status === 'waived'
            ? `${r.label} waived`
            : body.status === 'pending'
              ? `${r.label} reopened`
              : body.status === 'rejected'
                ? `${r.label} sent back`
                : 'Document attached',
      );
      invalidate();
    },
  });
  const upload = useMutation({
    mutationFn: async (f: File) => {
      const kind =
        r.kind === 'shop_drawing_approval'
          ? 'shop_drawing'
          : r.kind === 'finish_sample_approval'
            ? 'finish_sample'
            : r.kind === 'cfa'
              ? 'cfa'
              : 'other';
      const d = await uploadDocument(f, {
        entityType: 'purchase_order',
        entityId: po.id,
        kind,
        visibility: po.vendorOrgId ? 'vendor' : 'internal',
        vendorOrgId: po.vendorOrgId,
      });
      return api.patch('orders', `/purchase-orders/${po.id}/requirements/${r.id}`, {
        documentId: d.id,
        ...(r.status === 'pending' && r.party !== 'internal' ? { status: 'submitted' } : {}),
      });
    },
    onSuccess: () => {
      toast.success('Document attached');
      invalidate();
    },
    onError: (e) => toast.error(`Upload failed: ${errorMessage(e)}`),
  });
  const busy = patch.isPending || upload.isPending;

  return (
    <li className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 px-4 py-3 sm:grid-cols-[auto_minmax(0,1fr)_auto]">
      <span
        className={cx(
          'mt-0.5 grid size-5 place-items-center rounded-full border',
          done ? 'border-ok bg-ok text-white' : overdue ? 'border-crit bg-crit-50' : 'border-line bg-paper',
        )}
        aria-hidden
      >
        {done && <Check className="size-3" strokeWidth={3} />}
      </span>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className={cx('font-[560]', r.status === 'waived' && 'text-ink-3 line-through')}>
            {r.label}
          </span>
          <Badge tone={r.party === 'internal' ? 'neutral' : r.party === 'client' ? 'brass' : 'info'}>
            {PARTY_LABEL[r.party]}
          </Badge>
          {!done && <StatusBadge status={r.status} label={REQ_STATUS_LABEL[r.status]} />}
        </div>
        <div className="mt-0.5 flex flex-wrap gap-x-3 text-[12.5px] text-ink-3">
          {done ? (
            <span>
              {REQ_STATUS_LABEL[r.status]} {r.decidedAt && date(r.decidedAt)}
              {r.decidedByName && ` by ${r.decidedByName}`}
            </span>
          ) : (
            due && (
              <span className={cx('num', overdue && 'font-[560] text-crit')}>
                Due {date(due)} · {overdue ? `${relDays(due)}` : relDays(due)}
                {!r.dueDate && ' (order-by date)'}
              </span>
            )
          )}
          {r.submittedAt && !done && <span>Submitted {date(r.submittedAt)}</span>}
          {r.documentId && (
            <a
              href={documentUrl(r.documentId)}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 font-[560] text-lacquer hover:underline"
            >
              <FileText className="size-3.5" />
              View document
            </a>
          )}
        </div>
        {r.note && <p className="mt-1 text-[13px] text-ink-2">{r.note}</p>}
      </div>
      {canWrite && (
        <div className="col-span-2 flex flex-wrap items-center gap-1.5 sm:col-span-1 sm:justify-end">
          {busy && <Spinner className="size-4" />}
          {!done ? (
            <>
              <Button
                size="sm"
                variant={r.status === 'submitted' ? 'primary' : 'secondary'}
                icon={<Check className="size-3.5" />}
                disabled={busy}
                onClick={() => patch.mutate({ status: 'approved' })}
              >
                {r.status === 'submitted' ? 'Approve' : 'Mark complete'}
              </Button>
              <Menu
                trigger={(toggle) => (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={toggle}
                    disabled={busy}
                    aria-label={`More actions for ${r.label}`}
                  >
                    More
                  </Button>
                )}
                items={[
                  {
                    label: r.documentId ? 'Replace document' : 'Upload document',
                    icon: <Upload className="size-4" />,
                    onSelect: () => file.current?.click(),
                  },
                  ...(r.status === 'submitted'
                    ? [{ label: 'Send back (reject)', onSelect: () => patch.mutate({ status: 'rejected' }) }]
                    : []),
                  { label: 'Waive', onSelect: () => patch.mutate({ status: 'waived' }) },
                ]}
              />
            </>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              icon={<RotateCcw className="size-3.5" />}
              disabled={busy}
              onClick={() => patch.mutate({ status: 'pending' })}
            >
              Reopen
            </Button>
          )}
          <input
            ref={file}
            type="file"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) upload.mutate(f);
              e.target.value = '';
            }}
          />
        </div>
      )}
      {!canWrite && r.documentId && <Paperclip className="size-4 text-ink-3" />}
    </li>
  );
}

// ------------------------------------------------------------------ edit order details
export function EditOrderSheet({ po, open, onClose }: { po: PoDetail; open: boolean; onClose: () => void }) {
  const invalidate = useInvalidateOrders();
  const [f, setF] = useState(() => init(po));
  const [lastId, setLastId] = useState(`${po.id}:${po.version}`);
  if (open && lastId !== `${po.id}:${po.version}`) {
    setLastId(`${po.id}:${po.version}`);
    setF(init(po));
  }
  const set = (k: keyof ReturnType<typeof init>) => (e: { target: { value: string } }) =>
    setF((x) => ({ ...x, [k]: e.target.value }));
  const num = (v: string) => (v.trim() === '' ? null : Number(v));
  const m = useMutation({
    mutationFn: () =>
      api.patch(
        'orders',
        `/purchase-orders/${po.id}`,
        {
          requestedDeliveryDate: f.requestedDeliveryDate || null,
          leadTimeWeeks: num(f.leadTimeWeeks),
          transitDays: num(f.transitDays),
          origin: f.origin,
          paymentTerms: f.paymentTerms || null,
          freightTerms: f.freightTerms || null,
          shipMethod: f.shipMethod || null,
          depositPct: Number(f.depositPct || 0),
          freight: Number(f.freight || 0),
          tax: Number(f.tax || 0),
          vendorNotes: f.vendorNotes || null,
          notes: f.notes || null,
          vendorContact: { name: f.vcName || null, email: f.vcEmail || null, phone: f.vcPhone || null },
          contact24h: { name: f.c24Name || null, email: f.c24Email || null, phone: f.c24Phone || null },
          shipTo: {
            ...po.shipTo,
            name: f.stName,
            line1: f.stLine1,
            city: f.stCity,
            region: f.stRegion,
            postalCode: f.stPostal,
          },
        },
        { 'if-match': `"${po.version}"` },
      ),
    onSuccess: () => {
      toast.success(
        po.status === 'draft' ? 'Order details saved' : 'Order details saved — issue a revision to send them',
      );
      invalidate();
      onClose();
    },
  });
  const text = (label: string, k: keyof ReturnType<typeof init>, type = 'text', hint?: string) => (
    <Field label={label} hint={hint}>
      {(id) => <Input id={id} type={type} value={f[k]} onChange={set(k)} />}
    </Field>
  );
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={`Edit ${po.number}`}
      description={
        po.status === 'draft'
          ? 'Changes apply to the draft before it is issued.'
          : 'This order is issued: changes are held as unissued until you issue a revision to the vendor.'
      }
      width={620}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={m.isPending} onClick={() => m.mutate()}>
            Save changes
          </Button>
        </>
      }
    >
      <div className="space-y-6">
        <fieldset className="grid gap-3 sm:grid-cols-2">
          <legend className="mb-2 font-[620]">Schedule</legend>
          {text('Requested delivery', 'requestedDeliveryDate', 'date')}
          <Field label="Origin">
            {(id) => (
              <Select
                id={id}
                value={f.origin}
                onChange={set('origin')}
                options={[
                  { value: 'domestic', label: 'Domestic' },
                  { value: 'international', label: 'International (import)' },
                ]}
              />
            )}
          </Field>
          {text('Lead time (weeks)', 'leadTimeWeeks', 'number')}
          {text('Transit (days)', 'transitDays', 'number')}
        </fieldset>
        <fieldset className="grid gap-3 sm:grid-cols-2">
          <legend className="mb-2 font-[620]">Terms</legend>
          {text('Payment terms', 'paymentTerms')}
          {text('Freight terms', 'freightTerms')}
          {text('Ship method', 'shipMethod')}
          {text('Deposit %', 'depositPct', 'number')}
          {text('Freight ($)', 'freight', 'number')}
          {text('Tax ($)', 'tax', 'number')}
        </fieldset>
        <fieldset className="grid gap-3 sm:grid-cols-3">
          <legend className="mb-2 font-[620]">Vendor contact</legend>
          {text('Name', 'vcName')}
          {text('Email', 'vcEmail', 'email')}
          {text('Phone', 'vcPhone', 'tel')}
        </fieldset>
        <fieldset className="grid gap-3 sm:grid-cols-2">
          <legend className="mb-2 font-[620]">Ship to</legend>
          <div className="sm:col-span-2">{text('Name', 'stName')}</div>
          <div className="sm:col-span-2">{text('Street', 'stLine1')}</div>
          {text('City', 'stCity')}
          <div className="grid grid-cols-2 gap-3">
            {text('State', 'stRegion')}
            {text('ZIP', 'stPostal')}
          </div>
        </fieldset>
        <fieldset className="grid gap-3 sm:grid-cols-3">
          <legend className="mb-2 font-[620]">24-hour contact</legend>
          {text('Name', 'c24Name')}
          {text('Email', 'c24Email', 'email')}
          {text('Phone', 'c24Phone', 'tel')}
        </fieldset>
        <Field label="Notes on the PO" hint="Printed on the PO and visible to the vendor.">
          {(id) => <Textarea id={id} rows={3} value={f.vendorNotes} onChange={set('vendorNotes')} />}
        </Field>
        <Field label="Internal notes" hint="Only your team sees these.">
          {(id) => <Textarea id={id} rows={3} value={f.notes} onChange={set('notes')} />}
        </Field>
      </div>
    </Sheet>
  );
}

function init(po: PoDetail) {
  const s = (v: unknown) => (v === null || v === undefined ? '' : String(v));
  return {
    requestedDeliveryDate: s(po.requestedDeliveryDate),
    leadTimeWeeks: s(po.leadTimeWeeks),
    transitDays: s(po.transitDays),
    origin: po.origin,
    paymentTerms: s(po.paymentTerms),
    freightTerms: s(po.freightTerms),
    shipMethod: s(po.shipMethod),
    depositPct: s(po.depositPct),
    freight: s(po.freight),
    tax: s(po.tax),
    vendorNotes: s(po.vendorNotes),
    notes: s(po.notes),
    vcName: s(po.vendorContact?.name),
    vcEmail: s(po.vendorContact?.email),
    vcPhone: s(po.vendorContact?.phone),
    c24Name: s(po.contact24h?.name),
    c24Email: s(po.contact24h?.email),
    c24Phone: s(po.contact24h?.phone),
    stName: s(po.shipTo?.name),
    stLine1: s(po.shipTo?.line1),
    stCity: s(po.shipTo?.city),
    stRegion: s(po.shipTo?.region),
    stPostal: s(po.shipTo?.postalCode),
  } as Record<string, string> & { origin: 'domestic' | 'international' };
}
