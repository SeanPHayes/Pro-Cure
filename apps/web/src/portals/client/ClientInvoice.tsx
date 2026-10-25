import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, CircleCheck, FileDown, Landmark, Mail, Phone } from 'lucide-react';
import { Link, useParams } from 'react-router';
import { cx, EmptyState, ErrorNote, Loading, Section, StatusBadge, TitleBlock } from '@/components/ui';
import type { ClientInvoiceDetail } from '@/features/finance/types';
import { METHOD_LABEL } from '@/features/finance/types';
import { ApiError, api, documentUrl } from '@/lib/api';
import { useMe } from '@/lib/auth';
import { date, dateLong, daysFromToday, money } from '@/lib/format';
import { OWNER_KIND_LABEL, OWNER_STATUS_LABEL } from './ClientInvoices';

interface Org {
  id: string;
  name: string;
  legalName: string | null;
  phone: string | null;
  email: string | null;
  address: { line1?: string; line2?: string; city?: string; region?: string; postalCode?: string } | null;
}

const OPEN = ['sent', 'partially_paid', 'overdue'];

export function Component() {
  const { id = '' } = useParams();
  const s = useMe();
  const q = useQuery({
    queryKey: ['client-invoice', id],
    queryFn: () => api.get<ClientInvoiceDetail>('finance', `/client/invoices/${id}`),
  });
  // The procurement firm's org record (the tenant) carries the remit-to address.
  const firm = useQuery({
    queryKey: ['client-firm', s.context.tenantId],
    queryFn: () => api.get<Org>('identity', `/orgs/${s.context.tenantId}`),
    retry: false,
    meta: { silent: true },
  });

  if (q.isLoading) return <Loading />;
  if (q.isError)
    return q.error instanceof ApiError && q.error.status === 404 ? (
      <EmptyState
        title="We couldn’t find this invoice"
        action={
          <Link to="/portal/invoices" className="font-[560] text-lacquer hover:underline">
            See all invoices
          </Link>
        }
      >
        It may have been cancelled, or the link may belong to another organization.
      </EmptyState>
    ) : (
      <ErrorNote error={q.error} />
    );
  const inv = q.data!;
  const isOpen = OPEN.includes(inv.status) && inv.balance > 0;
  const late = isOpen ? -(daysFromToday(inv.dueDate) ?? 0) : 0;
  const tenantName =
    firm.data?.name ??
    s.contexts.find((c) => c.tenantId === s.context.tenantId)?.tenantName ??
    'Your procurement team';
  const addr = firm.data?.address;
  const addrLines = addr
    ? [
        addr.line1,
        addr.line2,
        [addr.city, [addr.region, addr.postalCode].filter(Boolean).join(' ')].filter(Boolean).join(', '),
      ].filter(Boolean)
    : [];

  return (
    <div className="mx-auto max-w-[1100px] space-y-4 px-4 py-5 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link
          to="/portal/invoices"
          className="inline-flex items-center gap-1 text-[13px] font-[560] text-ink-2 hover:text-ink"
        >
          <ChevronLeft className="size-4" />
          All invoices
        </Link>
        {inv.documentId && (
          <a
            href={documentUrl(inv.documentId, true)}
            className="inline-flex h-9 items-center gap-2 rounded-sm bg-lacquer px-3.5 font-[560] text-white hover:bg-lacquer-700"
          >
            <FileDown className="size-4" />
            Download PDF
          </a>
        )}
      </div>

      <TitleBlock
        title={
          <span className="inline-flex flex-wrap items-center gap-2.5">
            <span className="num">{inv.number}</span>
            <StatusBadge status={inv.status} label={OWNER_STATUS_LABEL[inv.status]} />
          </span>
        }
        subtitle={inv.projectName}
        fields={[
          { label: 'Type', value: OWNER_KIND_LABEL[inv.kind] },
          { label: 'Invoice date', value: <span className="num">{date(inv.issueDate)}</span> },
          {
            label: 'Due',
            value: (
              <span className={cx('num', late > 0 && 'text-crit')}>
                {inv.terms === 'Due on receipt' ? 'On receipt' : date(inv.dueDate)}
              </span>
            ),
          },
          {
            label: 'Balance due',
            value: (
              <span className={cx('num', late > 0 && 'text-crit')}>
                {money(inv.status === 'void' ? 0 : inv.balance)}
              </span>
            ),
          },
        ]}
      />

      {inv.status === 'paid' && (
        <p className="flex items-center gap-2 rounded-sm border border-ok/20 bg-ok-50 px-3 py-2 text-ok">
          <CircleCheck className="size-4" />
          Paid in full — thank you.
        </p>
      )}
      {inv.status === 'void' && (
        <p className="rounded-sm border border-line bg-stone-2 px-3 py-2 text-ink-2">
          This invoice was cancelled and nothing is owed on it. If you already paid it, contact {tenantName}{' '}
          and they’ll apply the payment to another invoice.
        </p>
      )}
      {late > 0 && (
        <p className="rounded-sm border border-crit/20 bg-crit-50 px-3 py-2 text-crit">
          This invoice was due {dateLong(inv.dueDate)} ({late} {late === 1 ? 'day' : 'days'} ago). If payment
          is already on its way, you can ignore this — it can take a few days to show here.
        </p>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-4">
          <Section title="What this invoice covers" bodyClassName="" className="overflow-hidden">
            <div className="overflow-x-auto [&_td:first-child]:pl-4 [&_td:last-child]:pr-4 [&_th:first-child]:pl-4 [&_th:last-child]:pr-4">
              <table className="grid-table">
                <thead>
                  <tr>
                    <th>Description</th>
                    <th className="right max-sm:hidden" style={{ width: 64 }}>
                      Qty
                    </th>
                    <th className="right max-sm:hidden" style={{ width: 120 }}>
                      Unit price
                    </th>
                    <th className="right" style={{ width: 120 }}>
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
              <div className="max-w-[46ch] space-y-1 text-[13px] text-ink-2">
                <div>Terms: {inv.terms}</div>
                {inv.poReference && <div>Your PO: {inv.poReference}</div>}
                {inv.notes && <p className="whitespace-pre-line pt-1">{inv.notes}</p>}
              </div>
              <dl className="w-full text-[13.5px] sm:w-[260px]">
                <Line label="Subtotal" value={inv.subtotal} />
                {inv.tax > 0 && <Line label={`Tax (${inv.taxRate}%)`} value={inv.tax} />}
                <div className="mt-1 flex justify-between border-t border-ink py-1.5 font-[620]">
                  <dt>Total</dt>
                  <dd className="num">{money(inv.total)}</dd>
                </div>
                {inv.amountPaid > 0 && <Line label="Paid" value={-inv.amountPaid} />}
                <div className="flex justify-between py-1 text-[15px] font-[620]">
                  <dt>Balance due</dt>
                  <dd className="num">{money(inv.status === 'void' ? 0 : inv.balance)}</dd>
                </div>
              </dl>
            </div>
          </Section>

          <Section title="Payments received" bodyClassName="">
            {inv.payments.length === 0 ? (
              <p className="px-4 py-5 text-ink-3">
                No payments recorded yet. Payments usually appear here within two business days of arriving.
              </p>
            ) : (
              <ul className="divide-y divide-line-2">
                {inv.payments.map((p) => (
                  <li key={p.id} className="flex items-center gap-3 px-4 py-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="font-[560]">{dateLong(p.receivedAt)}</div>
                      <div className="text-[12px] text-ink-3">
                        {METHOD_LABEL[p.method]}
                        {p.reference ? ` · ${p.reference}` : ''}
                      </div>
                    </div>
                    <span className="num font-[560]">{money(p.amount)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>

        <aside className="min-w-0 space-y-4">
          {inv.status !== 'void' && (
            <Section title={isOpen ? 'How to pay' : 'Remit to'}>
              <div className="space-y-3 text-[13.5px]">
                {isOpen && (
                  <p className="text-ink-2">
                    Pay by ACH, wire or check. Please include{' '}
                    <span className="num font-[600] text-ink">{inv.number}</span> in the payment memo so it’s
                    applied to the right invoice.
                  </p>
                )}
                <div className="rounded-sm bg-stone px-3 py-2.5">
                  <div className="flex items-start gap-2">
                    <Landmark className="mt-0.5 size-4 shrink-0 text-ink-3" />
                    <div>
                      <div className="font-[600]">{firm.data?.legalName ?? tenantName}</div>
                      {addrLines.map((l) => (
                        <div key={l} className="text-ink-2">
                          {l}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
                {isOpen && (
                  <p className="text-[12.5px] text-ink-3">
                    For ACH or wire details, ask your accounting contact — bank details are never sent by
                    email alone, so confirm them by phone before your first transfer.
                  </p>
                )}
                {(firm.data?.email || firm.data?.phone) && (
                  <div className="space-y-1 border-t border-line-2 pt-3">
                    <div className="text-[12px] text-ink-3">Questions about this invoice</div>
                    {firm.data?.email && (
                      <a
                        href={`mailto:${firm.data.email}?subject=${encodeURIComponent(`Invoice ${inv.number}`)}`}
                        className="flex items-center gap-2 text-lacquer hover:underline"
                      >
                        <Mail className="size-4" />
                        {firm.data.email}
                      </a>
                    )}
                    {firm.data?.phone && (
                      <a
                        href={`tel:${firm.data.phone}`}
                        className="flex items-center gap-2 text-lacquer hover:underline"
                      >
                        <Phone className="size-4" />
                        {firm.data.phone}
                      </a>
                    )}
                  </div>
                )}
              </div>
            </Section>
          )}
          <Section title="Project">
            <Link
              to={`/portal/projects/${inv.projectId}`}
              className="font-[560] text-lacquer hover:underline"
            >
              {inv.projectName}
            </Link>
            <p className="mt-1 text-[13px] text-ink-3">
              See schedule, approvals and deliveries for this project.
            </p>
          </Section>
        </aside>
      </div>
    </div>
  );
}

const Line = ({ label, value }: { label: string; value: number }) => (
  <div className="flex justify-between py-1 text-ink-2">
    <dt>{label}</dt>
    <dd className="num">{money(value)}</dd>
  </div>
);
