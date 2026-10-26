import { useMutation, useQuery } from '@tanstack/react-query';
import { CalendarClock, MailQuestion, PackageCheck, Scissors, Split, Truck } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { uploadDocument } from '@/components/shared/DocumentsPanel';
import { Button, cx, Field, Input, Menu, Select, Sheet, Textarea } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { hasPerm, useSession } from '@/lib/auth';
import { ago, count, date, dateTime, isoToday } from '@/lib/format';
import {
  etaOf,
  FilePicker,
  humanReason,
  isModelReason,
  lateness,
  RiskMark,
  relDays,
  SHIPPED,
  ShipmentSteps,
  TrackingLink,
  useInvalidateOrders,
} from '../shared';
import type { Confirmation, PoDetail, Shipment, StorageLocation } from '../types';

type Action = 'dates' | 'split' | 'tracking' | 'receive' | 'confirm' | null;

export function ShipmentsTab({ po }: { po: PoDetail }) {
  const s = useSession();
  const canWrite = hasPerm(s, 'logistics:write') && po.status !== 'cancelled';
  const [action, setAction] = useState<{ kind: Action; shipment: Shipment | null }>({
    kind: null,
    shipment: null,
  });
  const close = () => setAction({ kind: null, shipment: null });
  const unallocated = po.lines
    .map((l) => ({ l, left: l.quantity - (l.allocatedQty ?? l.quantity) }))
    .filter((x) => x.left > 0);

  return (
    <div className="space-y-4">
      {unallocated.length > 0 && (
        <p className="rounded-sm border border-warn/30 bg-warn-50 px-3 py-2 text-[13px] text-warn">
          {unallocated.length === 1 ? '1 line has' : `${unallocated.length} lines have`} quantities not on any
          shipment: {unallocated.map((x) => `${x.l.code} ×${x.left}`).join(', ')}.
        </p>
      )}
      {po.shipments.map((sh) => (
        <ShipmentCard
          key={sh.id}
          po={po}
          sh={sh}
          canWrite={canWrite}
          onAction={(kind) => setAction({ kind, shipment: sh })}
        />
      ))}
      {action.shipment && action.kind === 'dates' && (
        <DatesSheet po={po} sh={action.shipment} onClose={close} />
      )}
      {action.shipment && action.kind === 'split' && <SplitSheet sh={action.shipment} onClose={close} />}
      {action.shipment && action.kind === 'tracking' && (
        <TrackingSheet sh={action.shipment} onClose={close} />
      )}
      {action.shipment && action.kind === 'receive' && (
        <ReceiveSheet po={po} sh={action.shipment} onClose={close} />
      )}
      {action.shipment && action.kind === 'confirm' && (
        <RequestConfirmationSheet po={po} sh={action.shipment} onClose={close} />
      )}
    </div>
  );
}

function ShipmentCard({
  po,
  sh,
  canWrite,
  onAction,
}: {
  po: PoDetail;
  sh: Shipment;
  canWrite: boolean;
  onAction: (a: Action) => void;
}) {
  const invalidate = useInvalidateOrders();
  const [showHistory, setShowHistory] = useState(false);
  const shipped = SHIPPED.includes(sh.status);
  const delivered = sh.status === 'delivered';
  const eta = etaOf(sh, po.transitDays);
  const late = delivered
    ? lateness(sh.deliveredAt, sh.requestedDeliveryDate)
    : lateness(eta, sh.requestedDeliveryDate);
  const unconfirmed =
    !shipped && (!sh.lastConfirmedAt || (sh.lastConfirmationRequestedAt ?? '') > sh.lastConfirmedAt);
  const deliver = useMutation({
    mutationFn: () => api.post('orders', `/shipments/${sh.id}/deliver`, {}),
    onSuccess: () => {
      toast.success(`Shipment ${sh.label} marked delivered`);
      invalidate();
    },
  });
  const units = (sh.lines ?? []).reduce((a, l) => a + l.quantity, 0);

  return (
    <section className="rounded-md border border-line bg-paper">
      <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-line-2 px-4 py-2.5">
        <h2 className="flex flex-wrap items-center gap-2 text-[14px] font-[620]">
          Shipment {sh.label}
          {sh.note && <span className="font-[480] text-ink-2">{sh.note}</span>}
          <RiskMark level={sh.escalation} reasons={sh.escalationReasons} score={sh.riskScore} />
        </h2>
        {canWrite && (
          <div className="flex flex-wrap items-center gap-1.5">
            {!delivered && !shipped && (
              <Button size="sm" icon={<Truck className="size-3.5" />} onClick={() => onAction('tracking')}>
                Add tracking
              </Button>
            )}
            {!delivered && (
              <Button
                size="sm"
                variant={shipped ? 'primary' : 'secondary'}
                icon={<PackageCheck className="size-3.5" />}
                onClick={() => onAction('receive')}
              >
                Receive
              </Button>
            )}
            {delivered && (
              <Button
                size="sm"
                icon={<PackageCheck className="size-3.5" />}
                onClick={() => onAction('receive')}
              >
                Receive more
              </Button>
            )}
            <Menu
              trigger={(toggle) => (
                <Button size="sm" variant="ghost" onClick={toggle}>
                  More
                </Button>
              )}
              items={[
                {
                  label: 'Edit dates',
                  icon: <CalendarClock className="size-4" />,
                  onSelect: () => onAction('dates'),
                  disabled: delivered,
                },
                {
                  label: 'Request ship-date confirmation',
                  icon: <MailQuestion className="size-4" />,
                  onSelect: () => onAction('confirm'),
                  disabled: shipped || po.status === 'draft',
                },
                {
                  label: 'Split shipment',
                  icon: <Split className="size-4" />,
                  onSelect: () => onAction('split'),
                  disabled: shipped,
                },
                ...(shipped && !delivered
                  ? [
                      {
                        label: 'Update tracking',
                        icon: <Truck className="size-4" />,
                        onSelect: () => onAction('tracking'),
                      },
                    ]
                  : []),
                'divider' as const,
                {
                  label: 'Mark delivered (no receipt)',
                  onSelect: () => deliver.mutate(),
                  disabled: delivered,
                },
              ]}
            />
          </div>
        )}
      </header>
      <div className="space-y-4 p-4">
        <div className="overflow-x-auto pb-1">
          <span className="hidden sm:block">
            <ShipmentSteps status={sh.status} />
          </span>
          <span className="sm:hidden">
            <ShipmentSteps status={sh.status} compact />
          </span>
        </div>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-5">
          <Fact label="Requested delivery" value={date(sh.requestedDeliveryDate)} />
          <Fact
            label={sh.actualShipDate ? 'Shipped' : 'Estimated ship'}
            value={date(sh.actualShipDate ?? sh.estimatedShipDate)}
            note={
              sh.actualShipDate
                ? undefined
                : sh.estimatedShipDate
                  ? `${relDays(sh.estimatedShipDate)}${unconfirmed ? ' · unconfirmed' : ' · confirmed'}`
                  : 'Not set'
            }
            noteTone={unconfirmed && sh.estimatedShipDate ? 'warn' : undefined}
          />
          <Fact
            label={delivered ? 'Delivered' : 'Estimated delivery'}
            value={date(delivered ? sh.deliveredAt : eta)}
            note={
              late === null
                ? undefined
                : late > 0
                  ? `${late} ${late === 1 ? 'day' : 'days'} late`
                  : late < 0
                    ? `${-late} ${late === -1 ? 'day' : 'days'} early`
                    : 'On the requested date'
            }
            noteTone={late !== null && late > 0 ? 'crit' : 'ok'}
          />
          <Fact
            label="Original ship date"
            value={date(sh.originalShipDate)}
            note={
              sh.shipDateChanges
                ? `Changed ${sh.shipDateChanges} ${sh.shipDateChanges === 1 ? 'time' : 'times'}`
                : 'No changes'
            }
            noteTone={sh.shipDateChanges >= 2 ? 'warn' : undefined}
          />
          <Fact
            label="Carrier & tracking"
            value={<TrackingLink carrier={sh.carrier} number={sh.trackingNumber} url={sh.trackingUrl} />}
            note={
              [
                sh.trackingStatus?.replace(/_/g, ' '),
                sh.origin === 'international' ? 'Import' : null,
                sh.shipMethod,
              ]
                .filter(Boolean)
                .join(' · ') || undefined
            }
          />
        </dl>
        {sh.escalationReasons.length > 0 && sh.escalation !== 'none' && (
          <ul className="space-y-0.5 text-[13px] text-ink-2">
            {sh.escalationReasons.map((r) => (
              <li key={r} className="flex gap-2">
                <span className="mt-[7px] size-1.5 shrink-0 rounded-full bg-risk" />
                <span>
                  {isModelReason(r) && <span className="text-ink-3">Risk model: </span>}
                  {humanReason(r)}
                </span>
              </li>
            ))}
          </ul>
        )}
        <details className="group rounded-sm border border-line-2">
          <summary className="flex cursor-pointer items-center justify-between px-3 py-2 text-[13px] font-[560] text-ink-2 hover:bg-stone">
            <span>
              {sh.lines?.length ?? 0} lines · <span className="num">{count(units)}</span> units on this
              shipment
            </span>
            <span className="text-ink-3 group-open:hidden">Show</span>
            <span className="hidden text-ink-3 group-open:inline">Hide</span>
          </summary>
          <table className="grid-table">
            <thead>
              <tr>
                <th>Code</th>
                <th>Item</th>
                <th className="right">On shipment</th>
                <th className="right">Ordered</th>
              </tr>
            </thead>
            <tbody>
              {(sh.lines ?? []).map((l) => (
                <tr key={l.id}>
                  <td className="num whitespace-nowrap text-ink-2">{l.code}</td>
                  <td>{l.name}</td>
                  <td className="right num font-[560]">{count(l.quantity)}</td>
                  <td className="right num text-ink-3">
                    {count(po.lines.find((x) => x.id === l.poLineId)?.quantity)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
        <div>
          <button
            type="button"
            onClick={() => setShowHistory((v) => !v)}
            className="text-[13px] font-[560] text-lacquer hover:underline"
            aria-expanded={showHistory}
          >
            {showHistory ? 'Hide ship-date confirmations' : 'Ship-date confirmations'}
          </button>
          {sh.lastConfirmationRequestedAt && unconfirmed && (
            <span className="ml-2 text-[12.5px] text-warn">
              Requested {ago(sh.lastConfirmationRequestedAt)}, no answer yet
            </span>
          )}
          {showHistory && <Confirmations shipmentId={sh.id} />}
        </div>
      </div>
    </section>
  );
}

const Fact = ({
  label,
  value,
  note,
  noteTone,
}: {
  label: string;
  value: React.ReactNode;
  note?: string;
  noteTone?: 'crit' | 'warn' | 'ok';
}) => (
  <div className="min-w-0">
    <dt className="text-[12px] text-ink-3">{label}</dt>
    <dd className="num mt-0.5 font-[560]">{value}</dd>
    {note && (
      <dd
        className={cx(
          'text-[12px]',
          noteTone === 'crit'
            ? 'font-[560] text-crit'
            : noteTone === 'warn'
              ? 'text-warn'
              : noteTone === 'ok'
                ? 'text-ok'
                : 'text-ink-3',
        )}
      >
        {note}
      </dd>
    )}
  </div>
);

function Confirmations({ shipmentId }: { shipmentId: string }) {
  const q = useQuery({
    queryKey: ['orders', 'confirmations', shipmentId],
    queryFn: () => api.get<Confirmation[]>('orders', `/shipments/${shipmentId}/confirmations`),
  });
  if (q.isLoading) return <p className="mt-2 text-ink-3">Loading…</p>;
  if (!q.data?.length)
    return <p className="mt-2 text-[13px] text-ink-3">No confirmations requested or received yet.</p>;
  return (
    <ul className="mt-2 space-y-2 border-l border-line pl-4">
      {q.data.map((c) => (
        <li key={c.id} className="text-[13px]">
          <div>
            {c.respondedAt ? (
              <>
                <span className="font-[560]">{c.respondedByName ?? 'Vendor'}</span>{' '}
                {c.response === 'changed' ? (
                  <>
                    moved the ship date{' '}
                    <span className="num">
                      {date(c.previousDate)} → <span className="font-[560] text-warn">{date(c.newDate)}</span>
                    </span>
                  </>
                ) : (
                  <>
                    confirmed <span className="num font-[560]">{date(c.newDate ?? c.previousDate)}</span> is
                    on track
                  </>
                )}
              </>
            ) : (
              <span className="text-warn">Confirmation requested, waiting for the vendor</span>
            )}
            <span className="text-ink-3"> · {dateTime(c.respondedAt ?? c.requestedAt)}</span>
          </div>
          {c.note && <p className="text-ink-2">“{c.note}”</p>}
        </li>
      ))}
    </ul>
  );
}

// ------------------------------------------------------------------ sheets
function DatesSheet({ po, sh, onClose }: { po: PoDetail; sh: Shipment; onClose: () => void }) {
  const invalidate = useInvalidateOrders();
  const [f, setF] = useState({
    note: sh.note ?? '',
    requestedDeliveryDate: sh.requestedDeliveryDate ?? '',
    estimatedShipDate: sh.estimatedShipDate ?? '',
    estimatedDeliveryDate: sh.estimatedDeliveryDate ?? '',
    destination: sh.destination,
  });
  const m = useMutation({
    mutationFn: () =>
      api.patch('orders', `/shipments/${sh.id}`, {
        note: f.note || null,
        requestedDeliveryDate: f.requestedDeliveryDate || null,
        ...(f.estimatedShipDate !== (sh.estimatedShipDate ?? '')
          ? { estimatedShipDate: f.estimatedShipDate || null }
          : {}),
        estimatedDeliveryDate: f.estimatedDeliveryDate || null,
        destination: f.destination,
      }),
    onSuccess: () => {
      toast.success(`Shipment ${sh.label} updated`);
      invalidate();
      onClose();
    },
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF((x) => ({ ...x, [k]: e.target.value }));
  return (
    <Sheet
      open
      onClose={onClose}
      title={`Edit shipment ${sh.label}`}
      description={`${po.number} · ${po.vendorName}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={m.isPending} onClick={() => m.mutate()}>
            Save dates
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Label note" hint="What this shipment covers, e.g. “Floors 3–4”.">
          {(id) => <Input id={id} value={f.note} onChange={set('note')} />}
        </Field>
        <Field label="Requested delivery">
          {(id) => (
            <Input
              id={id}
              type="date"
              value={f.requestedDeliveryDate}
              onChange={set('requestedDeliveryDate')}
            />
          )}
        </Field>
        <Field
          label="Estimated ship date"
          hint={
            sh.originalShipDate
              ? `Originally ${date(sh.originalShipDate)}. Moving it later counts as a slip.`
              : undefined
          }
        >
          {(id) => (
            <Input id={id} type="date" value={f.estimatedShipDate} onChange={set('estimatedShipDate')} />
          )}
        </Field>
        <Field
          label="Estimated delivery"
          hint={`Leave empty to use ship date + ${po.transitDays ?? 5} days transit.`}
        >
          {(id) => (
            <Input
              id={id}
              type="date"
              value={f.estimatedDeliveryDate}
              onChange={set('estimatedDeliveryDate')}
            />
          )}
        </Field>
        <Field label="Deliver to">
          {(id) => (
            <Select
              id={id}
              value={f.destination}
              onChange={set('destination')}
              options={[
                { value: 'site', label: 'Hotel site' },
                { value: 'warehouse', label: 'Warehouse' },
              ]}
            />
          )}
        </Field>
      </div>
    </Sheet>
  );
}

function SplitSheet({ sh, onClose }: { sh: Shipment; onClose: () => void }) {
  const invalidate = useInvalidateOrders();
  const [qty, setQty] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [rdd, setRdd] = useState(sh.requestedDeliveryDate ?? '');
  const [esd, setEsd] = useState(sh.estimatedShipDate ?? '');
  const lines = (sh.lines ?? []).map((l) => ({ ...l, take: Number(qty[l.poLineId] || 0) }));
  const moving = lines.filter((l) => l.take > 0);
  const invalid = lines.some((l) => l.take < 0 || l.take > l.quantity || !Number.isFinite(l.take));
  const m = useMutation({
    mutationFn: () =>
      api.post<{ created: Shipment }>('orders', `/shipments/${sh.id}/split`, {
        note: note || null,
        requestedDeliveryDate: rdd || null,
        estimatedShipDate: esd || null,
        lines: moving.map((l) => ({ poLineId: l.poLineId, quantity: l.take })),
      }),
    onSuccess: (r) => {
      toast.success(`Shipment ${r.created.label} created`, {
        description: `${moving.reduce((a, l) => a + l.take, 0)} units moved from shipment ${sh.label}.`,
      });
      invalidate();
      onClose();
    },
  });
  const fill = (frac: number) =>
    setQty(Object.fromEntries(lines.map((l) => [l.poLineId, String(Math.floor(l.quantity * frac))])));
  return (
    <Sheet
      open
      onClose={onClose}
      width={640}
      title={`Split shipment ${sh.label}`}
      description="Move quantities to a new shipment, e.g. for a phased, floor-by-floor renovation."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon={<Scissors className="size-4" />}
            loading={m.isPending}
            disabled={!moving.length || invalid}
            onClick={() => m.mutate()}
          >
            Split shipment
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="sm:col-span-3">
            <Field
              label="New shipment covers"
              hint="Shown on the PO, to the vendor and to the site, e.g. “Floors 3–4”."
            >
              {(id) => (
                <Input
                  id={id}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Floors 3–4"
                />
              )}
            </Field>
          </div>
          <Field label="Requested delivery">
            {(id) => <Input id={id} type="date" value={rdd} onChange={(e) => setRdd(e.target.value)} />}
          </Field>
          <Field label="Estimated ship date">
            {(id) => <Input id={id} type="date" value={esd} onChange={(e) => setEsd(e.target.value)} />}
          </Field>
        </div>
        <div>
          <div className="mb-2 flex items-center justify-between gap-2">
            <h3 className="font-[620]">Quantities to move</h3>
            <div className="flex gap-1">
              <Button size="sm" variant="ghost" onClick={() => fill(0.5)}>
                Half of each
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setQty({})}>
                Clear
              </Button>
            </div>
          </div>
          <div className="overflow-x-auto rounded-sm border border-line">
            <table className="grid-table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th className="right">On {sh.label}</th>
                  <th className="right">Move</th>
                  <th className="right">Stays</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.poLineId}>
                    <td>
                      <div className="num text-[12px] text-ink-3">{l.code}</div>
                      <div className="min-w-[160px]">{l.name}</div>
                    </td>
                    <td className="right num">{l.quantity}</td>
                    <td className="right">
                      <input
                        aria-label={`Quantity of ${l.code} to move`}
                        inputMode="numeric"
                        value={qty[l.poLineId] ?? ''}
                        placeholder="0"
                        onChange={(e) => setQty((x) => ({ ...x, [l.poLineId]: e.target.value }))}
                        className={cx(
                          'num h-8 w-20 rounded-xs border bg-paper px-2 text-right focus:border-lacquer focus:outline-none',
                          l.take > l.quantity || l.take < 0 ? 'border-crit' : 'border-line',
                        )}
                      />
                    </td>
                    <td className={cx('right num', l.take > l.quantity ? 'text-crit' : 'text-ink-2')}>
                      {l.quantity - l.take}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </Sheet>
  );
}

function TrackingSheet({ sh, onClose }: { sh: Shipment; onClose: () => void }) {
  const invalidate = useInvalidateOrders();
  const [carrier, setCarrier] = useState(sh.carrier ?? '');
  const [num, setNum] = useState(sh.trackingNumber ?? '');
  const [url, setUrl] = useState(sh.trackingUrl ?? '');
  const [shipDate, setShipDate] = useState(sh.actualShipDate ?? isoToday());
  const m = useMutation({
    mutationFn: () =>
      api.patch('orders', `/shipments/${sh.id}`, {
        carrier: carrier.trim(),
        trackingNumber: num.trim(),
        trackingUrl: url.trim() || null,
        actualShipDate: shipDate || null,
      }),
    onSuccess: () => {
      toast.success(`Tracking added to shipment ${sh.label}`, {
        description: 'Delivery recipients were notified.',
      });
      invalidate();
      onClose();
    },
  });
  return (
    <Sheet
      open
      onClose={onClose}
      title={`Add tracking to shipment ${sh.label}`}
      description="Marks the shipment shipped and emails the delivery recipients."
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
              placeholder="e.g. Estes Express, UPS Freight"
            />
          )}
        </Field>
        <Field label="Tracking or PRO number">
          {(id) => <Input id={id} value={num} onChange={(e) => setNum(e.target.value)} />}
        </Field>
        <Field label="Tracking link (optional)">
          {(id) => (
            <Input id={id} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" />
          )}
        </Field>
        <Field label="Ship date">
          {(id) => (
            <Input id={id} type="date" value={shipDate} onChange={(e) => setShipDate(e.target.value)} />
          )}
        </Field>
      </div>
    </Sheet>
  );
}

function RequestConfirmationSheet({ po, sh, onClose }: { po: PoDetail; sh: Shipment; onClose: () => void }) {
  const invalidate = useInvalidateOrders();
  const [message, setMessage] = useState('');
  const m = useMutation({
    mutationFn: () =>
      api.post('orders', `/shipments/${sh.id}/request-confirmation`, {
        message: message.trim() || undefined,
      }),
    onSuccess: () => {
      toast.success('Ship-date confirmation requested', {
        description: `${po.vendorName} was emailed a link to confirm or update shipment ${sh.label}.`,
      });
      invalidate();
      onClose();
    },
  });
  return (
    <Sheet
      open
      onClose={onClose}
      title="Request ship-date confirmation"
      description={`${po.number} shipment ${sh.label} · currently ${sh.estimatedShipDate ? date(sh.estimatedShipDate) : 'no ship date'}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={m.isPending} onClick={() => m.mutate()}>
            Request confirmation
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-ink-2">
          {po.vendorContact?.email ? (
            <>
              We’ll email <span className="font-[560] text-ink">{po.vendorContact.email}</span>
            </>
          ) : (
            'We’ll email the vendor'
          )}{' '}
          asking them to confirm the ship date is on track or give a new one. Their answer updates this
          shipment.
        </p>
        <Field label="Message (optional)">
          {(id) => (
            <Textarea
              id={id}
              rows={3}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="e.g. The site needs these on the dock by the 12th for the floor 3 turnover."
            />
          )}
        </Field>
      </div>
    </Sheet>
  );
}

// ------------------------------------------------------------------ receive
function ReceiveSheet({ po, sh, onClose }: { po: PoDetail; sh: Shipment; onClose: () => void }) {
  const invalidate = useInvalidateOrders();
  const nav = useNavigate();
  const locations = useQuery({
    queryKey: ['orders', 'locations', { projectId: po.projectId }],
    queryFn: () => api.get<StorageLocation[]>('orders', '/storage-locations', { projectId: po.projectId }),
  });
  const [rows, setRows] = useState<Record<string, { rec: string; dmg: string }>>(() =>
    Object.fromEntries((sh.lines ?? []).map((l) => [l.poLineId, { rec: String(l.quantity), dmg: '0' }])),
  );
  const [loc, setLoc] = useState(sh.storageLocationId ?? '');
  const [condition, setCondition] = useState('');
  const [notes, setNotes] = useState('');
  const [photos, setPhotos] = useState<File[]>([]);
  const parsed = (sh.lines ?? []).map((l) => ({
    ...l,
    rec: Number(rows[l.poLineId]?.rec || 0),
    dmg: Number(rows[l.poLineId]?.dmg || 0),
  }));
  const damaged = parsed.reduce((a, l) => a + l.dmg, 0);
  const invalid = parsed.some((l) => l.dmg > l.rec || l.rec < 0 || l.rec > l.quantity);

  const m = useMutation({
    mutationFn: async () => {
      const ids: string[] = [];
      for (const f of photos) {
        const d = await uploadDocument(f, {
          entityType: 'purchase_order',
          entityId: po.id,
          kind: 'photo',
          // Damage photos back the vendor claim: share them with the vendor when they are on the portal.
          visibility: po.vendorOrgId ? 'vendor' : 'internal',
          vendorOrgId: po.vendorOrgId,
        });
        ids.push(d.id);
      }
      return api.post<{ claimId: string | null }>('orders', `/shipments/${sh.id}/receive`, {
        storageLocationId: loc || null,
        lines: parsed
          .filter((l) => l.rec > 0 || l.dmg > 0)
          .map((l) => ({
            poLineId: l.poLineId,
            qtyReceived: l.rec,
            qtyDamaged: l.dmg,
          })),
        condition: condition || undefined,
        notes: notes.trim() || null,
        photoDocumentIds: ids,
      });
    },
    onSuccess: (r) => {
      invalidate();
      onClose();
      if (r.claimId)
        toast.warning(`Shipment ${sh.label} received with damage`, {
          description: (
            <span>
              A damage claim was opened.{' '}
              <a
                href={`/app/claims/${r.claimId}`}
                onClick={(e) => {
                  e.preventDefault();
                  nav(`/app/claims/${r.claimId}`);
                }}
                className="font-[560] text-lacquer underline"
              >
                Open the claim
              </a>
            </span>
          ),
          duration: 12_000,
        });
      else toast.success(`Shipment ${sh.label} received`);
    },
    onError: (e) => toast.error(`Receiving failed: ${errorMessage(e)}`),
  });

  return (
    <Sheet
      open
      onClose={onClose}
      width={680}
      title={`Receive shipment ${sh.label}`}
      description={`${po.number} · ${po.vendorName}${sh.note ? ` · ${sh.note}` : ''}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={m.isPending} disabled={invalid} onClick={() => m.mutate()}>
            {damaged ? 'Receive and open claim' : 'Receive shipment'}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="overflow-x-auto rounded-sm border border-line">
          <table className="grid-table">
            <thead>
              <tr>
                <th>Item</th>
                <th className="right">Expected</th>
                <th className="right">Received</th>
                <th className="right">Damaged</th>
              </tr>
            </thead>
            <tbody>
              {parsed.map((l) => (
                <tr key={l.poLineId}>
                  <td>
                    <div className="num text-[12px] text-ink-3">{l.code}</div>
                    <div className="min-w-[160px]">{l.name}</div>
                  </td>
                  <td className="right num text-ink-2">{l.quantity}</td>
                  {(['rec', 'dmg'] as const).map((k) => (
                    <td key={k} className="right">
                      <input
                        aria-label={`${k === 'rec' ? 'Received' : 'Damaged'} quantity of ${l.code}`}
                        inputMode="numeric"
                        value={rows[l.poLineId]?.[k] ?? ''}
                        onChange={(e) =>
                          setRows((x) => ({ ...x, [l.poLineId]: { ...x[l.poLineId]!, [k]: e.target.value } }))
                        }
                        className={cx(
                          'num h-8 w-20 rounded-xs border bg-paper px-2 text-right focus:border-lacquer focus:outline-none',
                          (k === 'dmg' && l.dmg > l.rec) || (k === 'rec' && l.rec > l.quantity)
                            ? 'border-crit'
                            : k === 'dmg' && l.dmg > 0
                              ? 'border-risk bg-risk-50'
                              : 'border-line',
                        )}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {damaged > 0 && (
          <p className="rounded-sm border border-risk/30 bg-risk-50 px-3 py-2 text-[13px] text-risk">
            {damaged} damaged {damaged === 1 ? 'unit' : 'units'}: a damage claim against {po.vendorName} opens
            automatically with these photos and notes.
          </p>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Storage location">
            {(id) => (
              <Select
                id={id}
                value={loc}
                onChange={(e) => setLoc(e.target.value)}
                placeholder="Not stored (delivered to install)"
                options={(locations.data ?? []).map((x) => ({
                  value: x.id,
                  label: `${x.name} · ${x.kind === 'on_site' ? 'on site' : x.kind}`,
                }))}
              />
            )}
          </Field>
          <Field label="Condition">
            {(id) => (
              <Select
                id={id}
                value={condition}
                onChange={(e) => setCondition(e.target.value)}
                placeholder="Work it out from the quantities"
                options={[
                  { value: 'good', label: 'Good' },
                  { value: 'partial', label: 'Partial (short)' },
                  { value: 'damaged', label: 'Damaged' },
                ]}
              />
            )}
          </Field>
        </div>
        <Field label="Notes">
          {(id) => (
            <Textarea
              id={id}
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. Two cartons crushed at the corner; noted on the BOL."
            />
          )}
        </Field>
        <Field label="Photos">{() => <FilePicker files={photos} onChange={setPhotos} />}</Field>
      </div>
    </Sheet>
  );
}
