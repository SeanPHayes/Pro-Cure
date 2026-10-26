import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CalendarCheck,
  Check,
  ChevronLeft,
  CircleAlert,
  FileDown,
  FileText,
  Truck,
  Upload,
} from 'lucide-react';
import { useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { toast } from 'sonner';
import { uploadDocument } from '@/components/shared/DocumentsPanel';
import { ThreadPanel } from '@/components/shared/ThreadPanel';
import {
  Button,
  cx,
  EmptyState,
  ErrorNote,
  Facts,
  Field,
  Input,
  Loading,
  Section,
  Sheet,
  StatusBadge,
  Textarea,
} from '@/components/ui';
import { ChangeList } from '@/features/orders/po/RevisionsTab';
import { fmtAddress, relDays, SHIPPED, ShipmentSteps, TrackingLink } from '@/features/orders/shared';
import type { VendorPo, VendorRequirement, VendorShipment } from '@/features/orders/types';
import { ApiError, api, documentUrl, errorMessage } from '@/lib/api';
import { useMe } from '@/lib/auth';
import { count, date, dateTime, isoToday, money } from '@/lib/format';
import { VENDOR_STATUS_LABEL } from './VendorOrders';

const REQ_HELP: Record<string, string> = {
  order_acknowledgement: 'Confirm you received the order and give your ship date.',
  shop_drawing_approval: 'Upload shop drawings. The owner reviews and approves them before production.',
  finish_sample_approval: 'Upload photos or a spec of the finish samples for the owner to approve.',
  cfa: 'Upload the cutting for approval (CFA) for the owner to approve.',
  other: 'Upload the requested document.',
};
const REQ_STATE: Record<string, { label: string; tone: string }> = {
  pending: { label: 'Waiting for you', tone: 'text-brass' },
  submitted: { label: 'Sent, under review', tone: 'text-info' },
  approved: { label: 'Approved', tone: 'text-ok' },
  rejected: { label: 'Changes requested', tone: 'text-crit' },
  waived: { label: 'Not needed', tone: 'text-ink-3' },
};

export function Component() {
  const { id = '' } = useParams();
  const s = useMe();
  const qc = useQueryClient();
  const firm = s.contexts.find((c) => c.tenantId === s.context.tenantId)?.tenantName ?? 'your client';
  const key = ['vendor', 'po', id];
  const q = useQuery({
    queryKey: key,
    queryFn: () => api.get<VendorPo>('orders', `/vendor/purchase-orders/${id}`),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['vendor'] });
  const [ack, setAck] = useState(false);
  const [confirm, setConfirm] = useState<VendorShipment | null>(null);
  const [track, setTrack] = useState<VendorShipment | null>(null);

  if (q.isLoading) return <Loading label="Loading purchase order" />;
  if (q.isError)
    return q.error instanceof ApiError && q.error.status === 404 ? (
      <EmptyState
        title="We couldn’t find this order"
        action={
          <Link to="/vendor/orders" className="font-[560] text-lacquer hover:underline">
            Back to your orders
          </Link>
        }
      >
        It may have been cancelled, or it belongs to another company account.
      </EmptyState>
    ) : (
      <ErrorNote error={q.error} />
    );
  const po = q.data!;
  const needsAck = !po.acknowledgedAt && po.status === 'issued';
  const latest = po.revisions[0];
  const closed = po.status === 'cancelled' || po.status === 'closed';

  return (
    <div className="mx-auto max-w-[1080px] px-4 py-6 sm:px-6">
      <Link
        to="/vendor/orders"
        className="inline-flex items-center gap-1 text-[13px] text-ink-2 hover:text-ink"
      >
        <ChevronLeft className="size-4" />
        Purchase orders
      </Link>
      <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[24px] leading-tight font-[640]">
            <span className="num">{po.number}</span>
            {po.revision > 0 && (
              <span className="num ml-2 text-[16px] font-[520] text-ink-3">Revision {po.revision}</span>
            )}
          </h1>
          <p className="mt-0.5 text-ink-2">
            {po.projectName} · from {firm}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={po.status} label={VENDOR_STATUS_LABEL[po.status]} />
          {latest?.documentId && (
            <Button
              icon={<FileDown className="size-4" />}
              onClick={() => window.open(documentUrl(latest.documentId!), '_blank', 'noopener')}
            >
              {latest.revision > 0 ? `Download revision ${latest.revision} PDF` : 'Download PO PDF'}
            </Button>
          )}
        </div>
      </div>

      {po.status === 'cancelled' && (
        <p className="mt-4 rounded-md border border-crit/30 bg-crit-50 px-4 py-3 text-crit">
          This order was cancelled. Please stop production and message {firm} below if anything is already
          made.
        </p>
      )}

      {needsAck && (
        <div className="mt-5 flex flex-wrap items-center gap-4 rounded-md border border-brass/50 bg-brass-50 px-4 py-4">
          <CircleAlert className="size-5 shrink-0 text-brass" />
          <div className="min-w-0 flex-1">
            <p className="font-[620]">Please acknowledge this order</p>
            <p className="text-ink-2">
              Check the items, quantities and costs below, then confirm with your estimated ship date
              {po.shipments.length > 1 ? ' for each shipment' : ''}.
              {po.releaseByDate && ' Production needs to start on time to meet the requested delivery.'}
            </p>
          </div>
          <Button variant="primary" icon={<Check className="size-4" />} onClick={() => setAck(true)}>
            Acknowledge order
          </Button>
        </div>
      )}

      {latest && latest.revision > 0 && latest.changes.length > 0 && (
        <Section className="mt-5" title={`What changed in revision ${latest.revision}`} bodyClassName="">
          <p className="border-b border-line-2 px-4 py-2 text-[13px] text-ink-2">
            Issued {dateTime(latest.issuedAt)}. The revision PDF has these changes highlighted.
          </p>
          <ChangeList changes={latest.changes} />
        </Section>
      )}

      <div className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-4">
          <Section
            title={po.shipments.length > 1 ? `Shipments (${po.shipments.length})` : 'Shipment'}
            bodyClassName=""
          >
            <ul className="divide-y divide-line-2">
              {po.shipments.map((sh) => (
                <li key={sh.id} className="space-y-3 px-4 py-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="font-[620]">
                      {po.shipments.length > 1 ? `Shipment ${sh.label}` : 'Your shipment'}
                      {sh.note && <span className="ml-2 font-[480] text-ink-2">{sh.note}</span>}
                    </div>
                    {!closed && !SHIPPED.includes(sh.status) && (
                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          variant={sh.confirmationPending ? 'primary' : 'secondary'}
                          icon={<CalendarCheck className="size-3.5" />}
                          onClick={() => setConfirm(sh)}
                        >
                          Confirm ship date
                        </Button>
                        <Button size="sm" icon={<Truck className="size-3.5" />} onClick={() => setTrack(sh)}>
                          Add tracking
                        </Button>
                      </div>
                    )}
                  </div>
                  {sh.confirmationPending && (
                    <p className="rounded-sm bg-brass-50 px-3 py-2 text-[13px]">
                      <span className="font-[620]">{firm} asked you to confirm this ship date</span>
                      {sh.lastConfirmationRequestedAt && ` on ${date(sh.lastConfirmationRequestedAt)}`}. Tell
                      them it’s on track, or give the new date.
                    </p>
                  )}
                  <div className="overflow-x-auto">
                    <ShipmentSteps status={sh.status} />
                  </div>
                  <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
                    <div>
                      <dt className="text-[12px] text-ink-3">Needed on site by</dt>
                      <dd className="num font-[560]">{date(sh.requestedDeliveryDate)}</dd>
                    </div>
                    <div>
                      <dt className="text-[12px] text-ink-3">
                        {sh.actualShipDate ? 'Shipped' : 'Your ship date'}
                      </dt>
                      <dd className="num font-[560]">{date(sh.actualShipDate ?? sh.estimatedShipDate)}</dd>
                      {!sh.actualShipDate && sh.estimatedShipDate && (
                        <dd className="text-[12px] text-ink-3">
                          {relDays(sh.estimatedShipDate)}
                          {sh.lastConfirmedAt && ` · confirmed ${date(sh.lastConfirmedAt)}`}
                        </dd>
                      )}
                      {!sh.estimatedShipDate && <dd className="text-[12px] text-brass">Not given yet</dd>}
                    </div>
                    <div>
                      <dt className="text-[12px] text-ink-3">
                        {sh.deliveredAt ? 'Delivered' : 'Expected delivery'}
                      </dt>
                      <dd className="num font-[560]">{date(sh.deliveredAt ?? sh.estimatedDeliveryDate)}</dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-[12px] text-ink-3">Tracking</dt>
                      <dd className="text-[13px]">
                        <TrackingLink carrier={sh.carrier} number={sh.trackingNumber} url={sh.trackingUrl} />
                      </dd>
                    </div>
                  </dl>
                  {po.shipments.length > 1 && (
                    <p className="text-[13px] text-ink-2">
                      Carries {sh.lines.map((l) => `${l.code} ×${l.quantity}`).join(', ')}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </Section>

          <RequirementsSection po={po} firm={firm} onAck={() => setAck(true)} disabled={closed} />

          <Section title="Items on this order" bodyClassName="">
            <div className="overflow-x-auto">
              <table className="grid-table">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th className="right">Qty</th>
                    <th className="right">Unit cost</th>
                    <th className="right">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {po.lines.map((l) => (
                    <tr key={l.id}>
                      <td>
                        <div className="min-w-[220px]">
                          <span className="num text-[12px] text-ink-3">{l.code}</span>{' '}
                          <span className="font-[560]">{l.name}</span>
                        </div>
                        <div className="text-[12px] text-ink-3">
                          {[l.vendorSku && `Your SKU ${l.vendorSku}`, l.finish, l.dimensions]
                            .filter(Boolean)
                            .join(' · ')}
                        </div>
                      </td>
                      <td className="right num">{count(l.quantity)}</td>
                      <td className="right num">{money(l.unitCost)}</td>
                      <td className="right num font-[560]">{money(l.extended)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  {[
                    ['Subtotal', po.subtotal],
                    ...(po.freight ? [['Freight', po.freight]] : []),
                    ...(po.tax ? [['Tax', po.tax]] : []),
                    ['Order total', po.total],
                  ].map(([label, v], i, a) => (
                    <tr key={label as string}>
                      <td
                        colSpan={3}
                        className={cx(
                          'right !border-b-0 py-1.5 text-ink-2',
                          i === a.length - 1 && 'font-[620] text-ink',
                        )}
                      >
                        {label}
                      </td>
                      <td className={cx('right num !border-b-0 py-1.5', i === a.length - 1 && 'font-[640]')}>
                        {money(v as number)}
                      </td>
                    </tr>
                  ))}
                </tfoot>
              </table>
            </div>
          </Section>

          <Section title={`Messages with ${firm}`}>
            <ThreadPanel
              entityType="purchase_order"
              entityId={po.id}
              visibility="vendor"
              vendorOrgId={s.context.orgId}
              emptyHint={`Questions about this order? Message ${firm} here; they get notified straight away.`}
            />
          </Section>
        </div>

        <div className="min-w-0 space-y-4">
          <Section title="Ship to">
            <p className="whitespace-pre-line">{fmtAddress(po.shipTo, true) || '—'}</p>
            {po.contact24h?.name && (
              <div className="mt-3">
                <div className="text-[12px] text-ink-3">24-hour delivery contact</div>
                <div>{po.contact24h.name}</div>
                {po.contact24h.phone && (
                  <a href={`tel:${po.contact24h.phone}`} className="num block text-lacquer">
                    {po.contact24h.phone}
                  </a>
                )}
                {po.contact24h.email && (
                  <a href={`mailto:${po.contact24h.email}`} className="block truncate text-lacquer">
                    {po.contact24h.email}
                  </a>
                )}
              </div>
            )}
          </Section>
          <Section title="Terms">
            <Facts
              items={[
                { label: 'Order date', value: date(po.orderDate) },
                { label: 'Payment', value: po.paymentTerms },
                { label: 'Freight', value: po.freightTerms },
                { label: 'Ship method', value: po.shipMethod },
                ...(po.depositPct ? [{ label: 'Deposit', value: `${po.depositPct}% of the order` }] : []),
              ]}
            />
          </Section>
          {po.vendorNotes && (
            <Section title="Notes from the buyer">
              <p className="whitespace-pre-wrap">{po.vendorNotes}</p>
            </Section>
          )}
          <Section title="Bill to">
            <p className="whitespace-pre-line text-[13px]">{fmtAddress(po.billTo, true) || '—'}</p>
          </Section>
          {po.revisions.length > 1 && (
            <Section title="Order history" bodyClassName="">
              <ul className="divide-y divide-line-2">
                {po.revisions.map((r) => (
                  <li
                    key={r.revision}
                    className="flex items-center justify-between gap-2 px-4 py-2 text-[13px]"
                  >
                    <span>
                      {r.revision === 0 ? 'Original order' : `Revision ${r.revision}`}
                      <span className="text-ink-3"> · {date(r.issuedAt)}</span>
                    </span>
                    {r.documentId && (
                      <a
                        href={documentUrl(r.documentId)}
                        target="_blank"
                        rel="noreferrer"
                        className="font-[560] text-lacquer hover:underline"
                      >
                        PDF
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </div>
      </div>

      {ack && <AcknowledgeSheet po={po} onClose={() => setAck(false)} onDone={refresh} />}
      {confirm && <ConfirmSheet po={po} sh={confirm} onClose={() => setConfirm(null)} onDone={refresh} />}
      {track && <TrackingSheet po={po} sh={track} onClose={() => setTrack(null)} onDone={refresh} />}
    </div>
  );
}

// ------------------------------------------------------------------ requirements / submittals
function RequirementsSection({
  po,
  firm,
  onAck,
  disabled,
}: {
  po: VendorPo;
  firm: string;
  onAck: () => void;
  disabled: boolean;
}) {
  if (!po.requirements.length) return null;
  return (
    <Section title="What we need from you before production" bodyClassName="">
      <ul className="divide-y divide-line-2">
        {po.requirements.map((r) => (
          <RequirementItem key={r.id} po={po} r={r} firm={firm} onAck={onAck} disabled={disabled} />
        ))}
      </ul>
    </Section>
  );
}

function RequirementItem({
  po,
  r,
  firm,
  onAck,
  disabled,
}: {
  po: VendorPo;
  r: VendorRequirement;
  firm: string;
  onAck: () => void;
  disabled: boolean;
}) {
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [note, setNote] = useState('');
  const st = REQ_STATE[r.status] ?? { label: r.status, tone: 'text-ink-2' };
  const isAck = r.kind === 'order_acknowledgement';
  const canSubmit =
    !isAck && !disabled && (r.status === 'pending' || r.status === 'rejected' || r.status === 'submitted');
  const submit = useMutation({
    mutationFn: async () => {
      const kind =
        r.kind === 'shop_drawing_approval'
          ? 'shop_drawing'
          : r.kind === 'finish_sample_approval'
            ? 'finish_sample'
            : r.kind === 'cfa'
              ? 'cfa'
              : 'other';
      const doc = await uploadDocument(file!, {
        entityType: 'purchase_order',
        entityId: po.id,
        kind,
        visibility: 'vendor',
      });
      return api.post('orders', `/vendor/purchase-orders/${po.id}/requirements/${r.id}/submit`, {
        documentId: doc.id,
        note: note.trim() || undefined,
      });
    },
    onSuccess: () => {
      toast.success(`${r.label} sent for review`, { description: `${firm} has been notified.` });
      setFile(null);
      setNote('');
      qc.invalidateQueries({ queryKey: ['vendor'] });
    },
    onError: (e) => toast.error(`Couldn’t send: ${errorMessage(e)}`),
  });
  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-[560]">{r.label}</div>
          <div className="text-[13px] text-ink-2">{REQ_HELP[r.kind] ?? REQ_HELP.other}</div>
        </div>
        <span className={cx('text-[13px] font-[620] whitespace-nowrap', st.tone)}>{st.label}</span>
      </div>
      {r.dueDate && r.status === 'pending' && (
        <p className="num mt-1 text-[12.5px] text-ink-3">
          Due {date(r.dueDate)} ({relDays(r.dueDate)})
        </p>
      )}
      {r.documentId && (
        <a
          href={documentUrl(r.documentId)}
          target="_blank"
          rel="noreferrer"
          className="mt-1 inline-flex items-center gap-1 text-[13px] font-[560] text-lacquer hover:underline"
        >
          <FileText className="size-3.5" />
          {r.status === 'submitted' ? 'What you sent' : 'Document'}
          {r.submittedAt && <span className="font-[480] text-ink-3"> · {date(r.submittedAt)}</span>}
        </a>
      )}
      {r.note && r.status === 'rejected' && (
        <p className="mt-1 rounded-sm bg-crit-50 px-2.5 py-1.5 text-[13px] text-crit">Feedback: {r.note}</p>
      )}
      {isAck && r.status === 'pending' && !disabled && (
        <Button size="sm" variant="primary" className="mt-2" onClick={onAck}>
          Acknowledge order
        </Button>
      )}
      {canSubmit && (
        <div className="mt-2 space-y-2 rounded-sm border border-dashed border-line p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" icon={<Upload className="size-3.5" />} onClick={() => input.current?.click()}>
              {file
                ? 'Choose a different file'
                : r.status === 'submitted'
                  ? 'Send an updated file'
                  : 'Choose file'}
            </Button>
            <span className="min-w-0 truncate text-[13px] text-ink-2">
              {file?.name ?? 'PDF, image or CAD file'}
            </span>
            <input ref={input} type="file" hidden onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </div>
          {file && (
            <>
              <Input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Note for the reviewer (optional), e.g. Rev B with the corrected bench depth"
                aria-label="Note"
              />
              <Button size="sm" variant="primary" loading={submit.isPending} onClick={() => submit.mutate()}>
                Send for review
              </Button>
            </>
          )}
        </div>
      )}
    </li>
  );
}

// ------------------------------------------------------------------ sheets
function AcknowledgeSheet({
  po,
  onClose,
  onDone,
}: {
  po: VendorPo;
  onClose: () => void;
  onDone: () => void;
}) {
  const open = po.shipments.filter((x) => !SHIPPED.includes(x.status));
  const [dates, setDates] = useState<Record<string, string>>(
    Object.fromEntries(open.map((x) => [x.id, x.estimatedShipDate ?? ''])),
  );
  const [note, setNote] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const missing = open.some((x) => !dates[x.id]);
  const m = useMutation({
    mutationFn: async () => {
      const documentId = file
        ? (
            await uploadDocument(file, {
              entityType: 'purchase_order',
              entityId: po.id,
              kind: 'other',
              visibility: 'vendor',
            })
          ).id
        : undefined;
      return api.post('orders', `/vendor/purchase-orders/${po.id}/acknowledge`, {
        shipments: open.map((x) => ({ shipmentId: x.id, estimatedShipDate: dates[x.id] })),
        note: note.trim() || undefined,
        documentId,
      });
    },
    onSuccess: () => {
      toast.success('Order acknowledged', {
        description: 'Thanks. The buyer has been notified with your ship dates.',
      });
      onDone();
      onClose();
    },
  });
  return (
    <Sheet
      open
      onClose={onClose}
      title={`Acknowledge ${po.number}`}
      description="Confirm you’ve received this order and when it will ship."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={m.isPending} disabled={missing} onClick={() => m.mutate()}>
            Acknowledge order
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="space-y-3">
          {open.map((x) => (
            <Field
              key={x.id}
              label={
                open.length > 1
                  ? `Ship date for shipment ${x.label}${x.note ? ` (${x.note})` : ''}`
                  : 'Estimated ship date'
              }
              hint={
                x.requestedDeliveryDate ? `Needed on site by ${date(x.requestedDeliveryDate)}.` : undefined
              }
            >
              {(id) => (
                <Input
                  id={id}
                  type="date"
                  min={isoToday()}
                  value={dates[x.id] ?? ''}
                  onChange={(e) => setDates((d) => ({ ...d, [x.id]: e.target.value }))}
                />
              )}
            </Field>
          ))}
        </div>
        <Field label="Note (optional)">
          {(id) => (
            <Textarea
              id={id}
              rows={3}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. Production slot confirmed for week 46."
            />
          )}
        </Field>
        <Field
          label="Your acknowledgement document (optional)"
          hint="If your system produces a sales order acknowledgement, attach it here."
        >
          {(id) => (
            <input
              id={id}
              type="file"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="block w-full text-[13px] text-ink-2 file:mr-3 file:rounded-sm file:border file:border-line file:bg-paper file:px-3 file:py-1.5 file:font-[560]"
            />
          )}
        </Field>
      </div>
    </Sheet>
  );
}

function ConfirmSheet({
  po,
  sh,
  onClose,
  onDone,
}: {
  po: VendorPo;
  sh: VendorShipment;
  onClose: () => void;
  onDone: () => void;
}) {
  const [onTrack, setOnTrack] = useState(true);
  const [newDate, setNewDate] = useState('');
  const [note, setNote] = useState('');
  const m = useMutation({
    mutationFn: () =>
      api.post('orders', `/vendor/shipments/${sh.id}/confirm`, {
        onTrack,
        newShipDate: onTrack ? undefined : newDate,
        note: note.trim() || undefined,
      }),
    onSuccess: () => {
      toast.success(onTrack ? 'Ship date confirmed' : 'New ship date sent');
      onDone();
      onClose();
    },
  });
  const invalid = !onTrack && (!newDate || !note.trim());
  return (
    <Sheet
      open
      onClose={onClose}
      title="Confirm ship date"
      description={`${po.number}${po.shipments.length > 1 ? ` shipment ${sh.label}` : ''} · currently ${sh.estimatedShipDate ? date(sh.estimatedShipDate) : 'no date given'}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={m.isPending} disabled={invalid} onClick={() => m.mutate()}>
            {onTrack ? 'Confirm ship date' : 'Send new ship date'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <fieldset className="space-y-2">
          <legend className="sr-only">Is the ship date on track?</legend>
          {[
            {
              v: true,
              label: `Yes, it will ship ${sh.estimatedShipDate ? `on ${date(sh.estimatedShipDate)}` : 'as planned'}`,
            },
            { v: false, label: 'No, the ship date has changed' },
          ].map((o) => (
            <label
              key={String(o.v)}
              className={cx(
                'flex cursor-pointer items-center gap-3 rounded-sm border px-3 py-2.5',
                onTrack === o.v ? 'border-lacquer bg-lacquer-50' : 'border-line hover:bg-stone',
              )}
            >
              <input
                type="radio"
                name="ontrack"
                className="accent-lacquer"
                checked={onTrack === o.v}
                onChange={() => setOnTrack(o.v)}
              />
              {o.label}
            </label>
          ))}
        </fieldset>
        {!onTrack && (
          <>
            <Field
              label="New ship date"
              hint={
                sh.requestedDeliveryDate ? `Needed on site by ${date(sh.requestedDeliveryDate)}.` : undefined
              }
            >
              {(id) => (
                <Input id={id} type="date" value={newDate} onChange={(e) => setNewDate(e.target.value)} />
              )}
            </Field>
            <Field label="Reason" hint="Helps the buyer plan around it, e.g. a material delay.">
              {(id) => <Textarea id={id} rows={3} value={note} onChange={(e) => setNote(e.target.value)} />}
            </Field>
          </>
        )}
        {onTrack && (
          <Field label="Note (optional)">
            {(id) => <Textarea id={id} rows={2} value={note} onChange={(e) => setNote(e.target.value)} />}
          </Field>
        )}
      </div>
    </Sheet>
  );
}

function TrackingSheet({
  po,
  sh,
  onClose,
  onDone,
}: {
  po: VendorPo;
  sh: VendorShipment;
  onClose: () => void;
  onDone: () => void;
}) {
  const [carrier, setCarrier] = useState(sh.carrier ?? '');
  const [num, setNum] = useState(sh.trackingNumber ?? '');
  const [shipDate, setShipDate] = useState(isoToday());
  const [url, setUrl] = useState('');
  const m = useMutation({
    mutationFn: () =>
      api.post('orders', `/vendor/shipments/${sh.id}/tracking`, {
        carrier: carrier.trim(),
        trackingNumber: num.trim(),
        shipDate: shipDate || null,
        trackingUrl: url.trim() || undefined,
      }),
    onSuccess: () => {
      toast.success('Tracking added', { description: 'The buyer and the delivery site have been notified.' });
      onDone();
      onClose();
    },
  });
  return (
    <Sheet
      open
      onClose={onClose}
      title="Add tracking"
      description={`${po.number}${po.shipments.length > 1 ? ` shipment ${sh.label}` : ''}: add this once it has left your dock.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={m.isPending}
            disabled={!carrier.trim() || !num.trim()}
            onClick={() => m.mutate()}
          >
            Add tracking
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Carrier">
          {(id) => (
            <Input
              id={id}
              value={carrier}
              onChange={(e) => setCarrier(e.target.value)}
              placeholder="e.g. Estes Express, UPS Freight, FedEx"
            />
          )}
        </Field>
        <Field label="Tracking or PRO number">
          {(id) => <Input id={id} value={num} onChange={(e) => setNum(e.target.value)} />}
        </Field>
        <Field label="Ship date">
          {(id) => (
            <Input id={id} type="date" value={shipDate} onChange={(e) => setShipDate(e.target.value)} />
          )}
        </Field>
        <Field label="Tracking link (optional)" hint="We fill this in for common carriers.">
          {(id) => (
            <Input id={id} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" />
          )}
        </Field>
      </div>
    </Sheet>
  );
}
