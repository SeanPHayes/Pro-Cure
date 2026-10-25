import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowLeft, Ban, CircleAlert, FileDown, Pencil, Send, Wallet } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { toast } from 'sonner';
import { ActivityFeed } from '@/components/shared/ActivityFeed';
import {
  Button,
  cx,
  Dialog,
  EmptyState,
  ErrorNote,
  Field,
  Input,
  Loading,
  Menu,
  Section,
  Sheet,
  StatusBadge,
  Textarea,
  TitleBlock,
} from '@/components/ui';
import { ApiError, api, documentUrl } from '@/lib/api';
import { hasPerm, useSession } from '@/lib/auth';
import { ago, date, dateTime, money } from '@/lib/format';
import {
  fk,
  InvoiceSheet,
  Money,
  RecordPaymentSheet,
  SyncBadge,
  Totals,
  useInvalidateFinance,
} from './shared';
import { type InvoiceDetail, KIND_LABEL, METHOD_LABEL, OPEN_AR } from './types';

interface ProjectContact {
  name: string;
  role: string;
  email: string | null;
}

export function Component() {
  const { id = '' } = useParams();
  const s = useSession();
  const canWrite = hasPerm(s, 'finance:write');
  const invalidate = useInvalidateFinance();
  const q = useQuery({
    queryKey: fk.invoice(id),
    queryFn: () => api.get<InvoiceDetail>('finance', `/invoices/${id}`),
  });
  const [editing, setEditing] = useState(false);
  const [paying, setPaying] = useState(false);
  const [sending, setSending] = useState(false);
  const [voiding, setVoiding] = useState(false);
  const [reason, setReason] = useState('');

  const pdf = useMutation({
    mutationFn: () => api.post<{ documentId: string }>('finance', `/invoices/${id}/pdf`),
    onSuccess: (r) => {
      window.open(documentUrl(r.documentId), '_blank', 'noopener');
      invalidate();
    },
  });
  const voidM = useMutation({
    mutationFn: () => api.post('finance', `/invoices/${id}/void`, { reason: reason.trim() || undefined }),
    onSuccess: () => {
      toast.success(`Invoice ${q.data?.number} voided`);
      setVoiding(false);
      invalidate();
    },
  });

  if (q.isLoading) return <Loading />;
  if (q.isError)
    return q.error instanceof ApiError && q.error.status === 404 ? (
      <EmptyState title="This invoice doesn’t exist" action={<BackLink />}>
        It may have been deleted, or the link is wrong.
      </EmptyState>
    ) : (
      <ErrorNote error={q.error} />
    );
  const inv = q.data!;
  const isDraft = inv.status === 'draft';
  const isVoid = inv.status === 'void';
  const isOpen = OPEN_AR.includes(inv.status) && inv.balance > 0;
  const download = () =>
    inv.documentId && !isDraft
      ? window.open(documentUrl(inv.documentId), '_blank', 'noopener')
      : pdf.mutate();

  return (
    <div className="mx-auto max-w-[1200px] space-y-4 px-4 py-5 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <BackLink />
        <div className="flex flex-wrap items-center gap-2">
          <Button
            icon={<FileDown className="size-4" />}
            loading={pdf.isPending}
            onClick={download}
            disabled={!canWrite && !inv.documentId}
          >
            Download PDF
          </Button>
          {canWrite && isDraft && (
            <Button icon={<Pencil className="size-4" />} onClick={() => setEditing(true)}>
              Edit
            </Button>
          )}
          {canWrite && isOpen && (
            <Button icon={<Wallet className="size-4" />} onClick={() => setPaying(true)}>
              Record payment
            </Button>
          )}
          {canWrite && !isVoid && inv.total > 0 && (
            <Button
              variant={isDraft ? 'primary' : 'secondary'}
              icon={<Send className="size-4" />}
              onClick={() => setSending(true)}
            >
              {isDraft ? 'Send to owner' : 'Resend to owner'}
            </Button>
          )}
          {canWrite && !isVoid && inv.amountPaid === 0 && (
            <Menu
              trigger={(toggle) => (
                <Button variant="ghost" onClick={toggle} aria-label="More actions">
                  More
                </Button>
              )}
              items={[
                {
                  label: 'Void invoice',
                  danger: true,
                  icon: <Ban className="size-4" />,
                  onSelect: () => {
                    setReason('');
                    setVoiding(true);
                  },
                },
              ]}
            />
          )}
        </div>
      </div>

      <TitleBlock
        title={
          <span className="inline-flex flex-wrap items-center gap-2.5">
            <span className="num">{inv.number}</span>
            <StatusBadge status={inv.status} />
          </span>
        }
        subtitle={
          <>
            {inv.clientName} ·{' '}
            <Link to={`/app/projects/${inv.projectId}`} className="hover:underline">
              {inv.projectNumber} {inv.projectName}
            </Link>
          </>
        }
        fields={[
          { label: 'Kind', value: KIND_LABEL[inv.kind] },
          { label: 'Issued', value: <span className="num">{date(inv.issueDate)}</span> },
          {
            label: 'Due',
            value: (
              <span className={cx('num', inv.daysOverdue > 0 && 'text-crit')}>
                {inv.terms === 'Due on receipt' ? 'On receipt' : date(inv.dueDate)}
                {inv.daysOverdue > 0 && ` · ${inv.daysOverdue}d late`}
              </span>
            ),
          },
          { label: 'Total', value: <Money value={inv.total} /> },
          {
            label: 'Balance',
            value: <Money value={inv.balance} className={inv.daysOverdue > 0 ? 'text-crit' : ''} />,
          },
        ]}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-4">
          <Section title="Lines" bodyClassName="" className="overflow-hidden">
            <div className="overflow-x-auto [&_td:first-child]:pl-4 [&_td:last-child]:pr-4 [&_th:first-child]:pl-4 [&_th:last-child]:pr-4">
              <table className="grid-table">
                <thead>
                  <tr>
                    <th>Description</th>
                    <th className="right max-sm:hidden" style={{ width: 72 }}>
                      Qty
                    </th>
                    <th className="right max-sm:hidden" style={{ width: 130 }}>
                      Unit price
                    </th>
                    <th className="right" style={{ width: 130 }}>
                      Amount
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {inv.lines.map((l) => (
                    <tr key={l.id}>
                      <td>
                        {l.description}
                        {l.quantity !== 1 && (
                          <div className="num text-[12px] text-ink-3 sm:hidden">
                            {l.quantity} × {money(l.unitPrice)}
                          </div>
                        )}
                      </td>
                      <td className="right num max-sm:hidden">{l.quantity}</td>
                      <td className="right num max-sm:hidden">{money(l.unitPrice)}</td>
                      <td className="right num">{money(l.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex flex-col gap-4 border-t border-line-2 px-4 py-4 sm:flex-row sm:justify-between">
              <div className="max-w-[48ch] space-y-1 text-[13px] text-ink-2">
                {inv.terms && <div>Terms: {inv.terms}</div>}
                {inv.poReference && <div>Owner PO: {inv.poReference}</div>}
                {inv.quoteNumber && <div>Quote: {inv.quoteNumber}</div>}
                {inv.notes && <p className="whitespace-pre-line pt-1">{inv.notes}</p>}
              </div>
              <Totals
                className="w-full sm:w-[280px]"
                rows={[
                  ['Subtotal', inv.subtotal],
                  ...(inv.tax ? ([[`Tax (${inv.taxRate}%)`, inv.tax]] as [string, number][]) : []),
                ]}
                total={['Total', inv.total]}
                extra={[
                  ...(inv.amountPaid > 0
                    ? ([['Paid', -inv.amountPaid, 'text-ink-2']] as [string, number, string][])
                    : []),
                  [<span key="b">Balance due</span>, isVoid ? 0 : inv.balance, 'font-[620] text-[15px]'],
                ]}
              />
            </div>
          </Section>

          <Section
            title="Payments"
            bodyClassName=""
            actions={
              canWrite &&
              isOpen && (
                <Button size="sm" onClick={() => setPaying(true)}>
                  Record payment
                </Button>
              )
            }
          >
            {inv.payments.length === 0 ? (
              <p className="px-4 py-5 text-ink-3">
                {isDraft
                  ? 'Send the invoice before recording payments against it.'
                  : isVoid
                    ? 'This invoice was voided.'
                    : 'No payments recorded yet. Record checks, wires and ACH as they arrive.'}
              </p>
            ) : (
              <ul className="divide-y divide-line-2">
                {inv.payments.map((p) => (
                  <li key={p.id} className="flex items-center gap-3 px-4 py-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="font-[560]">
                        {METHOD_LABEL[p.method]}
                        {p.reference && <span className="font-[400] text-ink-2"> · {p.reference}</span>}
                      </div>
                      <div className="text-[12px] text-ink-3">
                        Received {date(p.receivedAt)}
                        {p.source === 'qbo'
                          ? ' · from QuickBooks'
                          : p.createdByName
                            ? ` · recorded by ${p.createdByName}`
                            : ''}
                        {p.notes ? ` · ${p.notes}` : ''}
                      </div>
                    </div>
                    <Money value={p.amount} className="font-[560]" />
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>

        <aside className="min-w-0 space-y-4">
          <Section title="QuickBooks">
            {isDraft ? (
              <p className="text-[13px] text-ink-3">Drafts stay out of QuickBooks until they’re sent.</p>
            ) : (
              <div className="space-y-2 text-[13px]">
                <SyncBadge status={inv.qboSyncStatus} />
                {inv.qboId && (
                  <div className="text-ink-2">
                    QuickBooks id <span className="num">{inv.qboId}</span>
                  </div>
                )}
                {inv.qboSyncedAt && <div className="text-ink-3">Last synced {ago(inv.qboSyncedAt)}</div>}
                {inv.qboSyncStatus === 'pending' && (
                  <div className="text-ink-3">Goes out with the next sync (every 15 minutes).</div>
                )}
                {inv.qboError && (
                  <p className="flex items-start gap-1.5 rounded-sm bg-crit-50 px-2.5 py-2 text-crit">
                    <CircleAlert className="mt-px size-4 shrink-0" />
                    {inv.qboError}
                  </p>
                )}
                <Link
                  to="/app/finance?tab=quickbooks"
                  className="inline-block font-[560] text-lacquer hover:underline"
                >
                  Open QuickBooks sync
                </Link>
              </div>
            )}
          </Section>
          <Section title="Details">
            <dl className="space-y-2 text-[13px]">
              <Row label="Created">
                {dateTime(inv.createdAt)}
                {inv.createdByName ? ` by ${inv.createdByName}` : ''}
              </Row>
              {inv.sentAt && <Row label="Sent to owner">{dateTime(inv.sentAt)}</Row>}
              {inv.voidedAt && <Row label="Voided">{dateTime(inv.voidedAt)}</Row>}
              {inv.documentId && (
                <Row label="PDF">
                  <a
                    href={documentUrl(inv.documentId)}
                    target="_blank"
                    rel="noopener"
                    className="font-[560] text-lacquer hover:underline"
                  >
                    {inv.number}.pdf
                  </a>
                </Row>
              )}
            </dl>
          </Section>
          <Section title="Activity">
            <ActivityFeed service="finance" path={`/invoices/${inv.id}/activity`} />
          </Section>
        </aside>
      </div>

      <InvoiceSheet open={editing} onClose={() => setEditing(false)} invoice={inv} />
      <RecordPaymentSheet
        open={paying}
        onClose={() => setPaying(false)}
        target={{
          type: 'invoice',
          id: inv.id,
          number: inv.number,
          balance: inv.balance,
          party: inv.clientName,
        }}
      />
      <SendSheet open={sending} onClose={() => setSending(false)} inv={inv} />
      <Dialog
        open={voiding}
        onClose={() => setVoiding(false)}
        title={`Void ${inv.number}?`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setVoiding(false)}>
              Keep invoice
            </Button>
            <Button variant="danger" loading={voidM.isPending} onClick={() => voidM.mutate()}>
              Void invoice
            </Button>
          </>
        }
      >
        <p className="text-ink-2">
          The {money(inv.total)} balance is cleared and the invoice can’t be sent or paid.
          {inv.qboId ? ' It’s also voided in QuickBooks on the next sync.' : ''} This can’t be undone.
        </p>
        <Field label="Reason" className="mt-4" hint="Added to the invoice notes.">
          {(fid) => <Input id={fid} value={reason} onChange={(e) => setReason(e.target.value)} />}
        </Field>
      </Dialog>
    </div>
  );
}

const BackLink = () => (
  <Link
    to="/app/finance?tab=invoices"
    className="inline-flex items-center gap-1.5 text-[13px] font-[560] text-ink-2 hover:text-ink"
  >
    <ArrowLeft className="size-4" />
    Invoices
  </Link>
);

const Row = ({ label, children }: { label: string; children: ReactNode }) => (
  <div>
    <dt className="text-[12px] text-ink-3">{label}</dt>
    <dd className="mt-0.5">{children}</dd>
  </div>
);

function SendSheet({ open, onClose, inv }: { open: boolean; onClose: () => void; inv: InvoiceDetail }) {
  const invalidate = useInvalidateFinance();
  const [to, setTo] = useState('');
  const [cc, setCc] = useState('');
  const [message, setMessage] = useState('');
  const [sent, setSent] = useState<{ documentId: string; recipients: string[] } | null>(null);
  const contacts = useQuery({
    queryKey: ['finance-lookup', 'project-contacts', inv.projectId],
    queryFn: () => api.get<{ contacts?: ProjectContact[] }>('projects', `/projects/${inv.projectId}`),
    select: (d) => (d.contacts ?? []).filter((c) => ['owner_rep', 'gm'].includes(c.role) && c.email),
    enabled: open,
    retry: false,
    meta: { silent: true },
  });
  useEffect(() => {
    if (open) {
      setSent(null);
      setCc('');
      setMessage('');
    }
  }, [open]);
  useEffect(() => {
    if (open && contacts.data) setTo(contacts.data.map((c) => c.email).join(', '));
  }, [open, contacts.data]);
  const list = (v: string) =>
    v
      .split(/[,;\s]+/)
      .map((x) => x.trim())
      .filter(Boolean);
  const toList = list(to);
  const bad = [...toList, ...list(cc)].filter((e) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
  const m = useMutation({
    mutationFn: () =>
      api.post<{ documentId: string; recipients: string[] }>('finance', `/invoices/${inv.id}/send`, {
        to: toList.length ? toList : undefined,
        cc: list(cc),
        message: message.trim() || undefined,
      }),
    onSuccess: (r) => {
      toast.success(`Invoice ${inv.number} sent to owner`);
      setSent(r);
      invalidate();
    },
  });
  const resend = inv.status !== 'draft';
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={sent ? `${inv.number} sent` : resend ? 'Resend to owner' : 'Send to owner'}
      description={`${inv.number} · ${money(inv.total)} · ${inv.clientName}`}
      footer={
        sent ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              icon={<Send className="size-4" />}
              disabled={bad.length > 0}
              loading={m.isPending}
              onClick={() => m.mutate()}
            >
              {resend ? 'Resend to owner' : 'Send to owner'}
            </Button>
          </>
        )
      }
    >
      {sent ? (
        <div className="space-y-3">
          <p className="rounded-sm bg-ok-50 px-3 py-2 text-ok">
            Emailed to {sent.recipients.join(', ')} with the PDF attached. The owner can also view it in their
            portal.
          </p>
          <a
            href={documentUrl(sent.documentId)}
            target="_blank"
            rel="noopener"
            className="inline-flex items-center gap-1.5 font-[560] text-lacquer hover:underline"
          >
            <FileDown className="size-4" />
            Open {inv.number}.pdf
          </a>
        </div>
      ) : (
        <div className="space-y-4">
          {!resend && (
            <p className="text-[13px] text-ink-2">
              Sending renders the PDF, marks the invoice sent, starts its due-date clock and queues it for
              QuickBooks. After that it can’t be edited — void and reissue instead.
            </p>
          )}
          <Field
            label="To"
            hint={
              contacts.isLoading
                ? 'Looking up the project’s owner contacts…'
                : contacts.data?.length
                  ? 'The project’s owner rep and GM. Separate addresses with commas.'
                  : 'No owner contacts with an email on this project — enter at least one address.'
            }
            error={bad.length ? `Check ${bad.join(', ')}` : undefined}
          >
            {(id) => (
              <Input
                id={id}
                value={to}
                onChange={(e) => setTo(e.target.value)}
                placeholder="name@owner.com"
              />
            )}
          </Field>
          <Field label="Cc">
            {(id) => <Input id={id} value={cc} onChange={(e) => setCc(e.target.value)} />}
          </Field>
          <Field label="Message" hint="Shown above the invoice summary in the email.">
            {(id) => <Textarea id={id} value={message} onChange={(e) => setMessage(e.target.value)} />}
          </Field>
        </div>
      )}
    </Sheet>
  );
}
