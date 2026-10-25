import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BadgeCheck, CheckCircle2, FileText, Grid3x3, ReceiptText, XCircle } from 'lucide-react';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { Badge, Button, cx, EmptyState, Loading, ProgressBar, Section, StatusBadge } from '@/components/ui';
import { type Column, DataTable } from '@/components/ui/DataTable';
import { api, documentUrl, type Page } from '@/lib/api';
import { ago, date, dateTime, money, relativeDue } from '@/lib/format';
import { ExpiryBadge, FlagChips, qk } from '../shared';
import type { ApprovalRequest, CostRequest, PriceMatrixSlot, QuoteDetail } from '../types';
import { useRefreshDerived } from './data';

// ================================================================ price matrix
export function PriceMatrixTab({ quote, canEdit }: { quote: QuoteDetail; canEdit: boolean }) {
  const qc = useQueryClient();
  const refresh = useRefreshDerived(quote.id);
  const m = useQuery({
    queryKey: qk.matrix(quote.id),
    queryFn: () => api.get<{ slots: PriceMatrixSlot[] }>('quoting', `/quotes/${quote.id}/price-matrix`),
  });
  const select = useMutation({
    mutationFn: (v: { slot: PriceMatrixSlot; lineId: string }) =>
      api.post('quoting', `/quotes/${quote.id}/price-matrix/select`, {
        selections: { [v.slot.masterSpecId]: v.lineId },
      }),
    onSuccess: (_r, v) => {
      const o = v.slot.options.find((x) => x.lineId === v.lineId);
      toast.success(`${o?.vendorName ?? 'Option'} selected for ${v.slot.name}`);
      qc.invalidateQueries({ queryKey: qk.matrix(quote.id) });
      qc.invalidateQueries({ queryKey: qk.lines(quote.id) });
      refresh(true);
    },
  });
  if (m.isLoading) return <Loading label="Loading price matrix" />;
  const slots = m.data?.slots ?? [];
  if (!slots.length)
    return (
      <EmptyState icon={<Grid3x3 />} title="No competing vendors yet">
        To compare vendors for one item, open a line’s menu in the grid and choose “Add competing vendors”.
        Each option is priced side by side here; pick the winner and only it counts in the totals.
      </EmptyState>
    );
  return (
    <div className="space-y-4 p-4 sm:p-6">
      {slots.map((s) => (
        <Section
          key={`${s.masterSpecId}:${s.locationId}`}
          title={
            <span>
              {s.name}
              <span className="ml-2 text-[13px] font-[480] text-ink-3">{s.locationName ?? 'Unassigned'}</span>
            </span>
          }
          bodyClassName="overflow-x-auto"
        >
          <table className="grid-table">
            <thead>
              <tr>
                <th>Option</th>
                <th>Vendor</th>
                <th className="right">Unit cost</th>
                <th>Cost valid</th>
                <th className="right">Lead time</th>
                <th className="right">Qty</th>
                <th className="right">Extended</th>
                <th className="right">vs lowest</th>
                <th>Flags</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {s.options.map((o) => (
                <tr key={o.lineId} data-selected={o.isSelected || undefined}>
                  <td>
                    <div className="font-[560]">
                      <span className="num mr-1.5 text-ink-2">{o.code}</span>
                      {o.name}
                    </div>
                  </td>
                  <td>{o.vendorName ?? '—'}</td>
                  <td className="right num">
                    {money(o.unitCost)}
                    {o.isLowest && (
                      <Badge tone="ok" className="ml-1.5 !h-[18px] !px-1 !text-[11px]">
                        Lowest
                      </Badge>
                    )}
                  </td>
                  <td>
                    {o.costExpiresAt ? (
                      <ExpiryBadge expiresAt={o.costExpiresAt} />
                    ) : (
                      <span className="text-ink-4">—</span>
                    )}
                  </td>
                  <td className="right num">{o.leadTimeWeeks === null ? '—' : `${o.leadTimeWeeks} wk`}</td>
                  <td className="right num">{o.quantity.toLocaleString()}</td>
                  <td className="right num font-[560]">{money(o.extendedCost)}</td>
                  <td className={cx('right num', o.deltaVsLowest ? 'text-crit' : 'text-ink-3')}>
                    {o.deltaVsLowest === null
                      ? '—'
                      : o.deltaVsLowest === 0
                        ? '—'
                        : `+${money(o.deltaVsLowest)} (${o.deltaPct?.toFixed(1)}%)`}
                  </td>
                  <td>
                    <FlagChips flags={o.flags} />
                  </td>
                  <td className="right">
                    {o.isSelected ? (
                      <span className="inline-flex items-center gap-1 text-[13px] font-[600] text-ok">
                        <CheckCircle2 className="size-4" />
                        Selected
                      </span>
                    ) : (
                      canEdit && (
                        <Button
                          size="sm"
                          loading={select.isPending && select.variables?.lineId === o.lineId}
                          onClick={() => select.mutate({ slot: s, lineId: o.lineId })}
                        >
                          Select
                        </Button>
                      )
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      ))}
    </div>
  );
}

// ================================================================ cost requests
export function CostRequestsTab({ quote, onRequest }: { quote: QuoteDetail; onRequest?: () => void }) {
  const nav = useNavigate();
  const q = useQuery({
    queryKey: qk.costRequests({ quoteId: quote.id }),
    queryFn: () => api.get<Page<CostRequest>>('quoting', '/cost-requests', { quoteId: quote.id, limit: 200 }),
  });
  const cols: Column<CostRequest>[] = [
    { key: 'n', header: 'Request', cell: (r) => <span className="num font-[560]">{r.number}</span> },
    { key: 'v', header: 'Vendor', cell: (r) => r.vendorName ?? '—' },
    { key: 's', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
    {
      key: 'p',
      header: 'Responses',
      cell: (r) => (
        <div className="w-36">
          <div className="num mb-1 text-[12px] text-ink-2">
            {r.respondedLineCount} of {r.lineCount} answered · {r.appliedLineCount} applied
          </div>
          <ProgressBar value={(r.respondedLineCount / Math.max(1, r.lineCount)) * 100} tone="brass" />
        </div>
      ),
    },
    {
      key: 'd',
      header: 'Due',
      cell: (r) => (
        <span className="num whitespace-nowrap">
          {date(r.dueDate)}
          {['sent', 'viewed'].includes(r.status) && r.dueDate && (
            <span className="ml-1.5 text-[12px] text-ink-3">{relativeDue(r.dueDate)}</span>
          )}
        </span>
      ),
    },
    { key: 'sent', header: 'Sent', cell: (r) => <span className="text-ink-2">{ago(r.sentAt)}</span> },
  ];
  return (
    <div className="p-4 sm:p-6">
      <Section
        title="Cost requests"
        bodyClassName=""
        actions={
          onRequest && (
            <Button size="sm" onClick={onRequest}>
              Request pricing
            </Button>
          )
        }
      >
        <DataTable
          columns={cols}
          rows={q.data?.items}
          loading={q.isLoading}
          onRowClick={(r) => nav(`/app/cost-requests/${r.id}`)}
          rowClassName={(r) => (r.status === 'responded' ? 'font-[520]' : undefined)}
          empty={
            <EmptyState icon={<ReceiptText />} title="No pricing requested yet">
              Use “Request pricing” to package lines for each vendor. Their answers come back here to compare
              and apply.
            </EmptyState>
          }
        />
      </Section>
    </div>
  );
}

// ================================================================ approvals
export function ApprovalsTab({ quote, approvals }: { quote: QuoteDetail; approvals: ApprovalRequest[] }) {
  return (
    <div className="space-y-4 p-4 sm:p-6">
      {quote.internalApprovedAt && (
        <div className="flex items-center gap-2 rounded-sm border border-ok/25 bg-ok-50 px-3 py-2 text-[13px] text-ok">
          <BadgeCheck className="size-4" />
          Internally approved {dateTime(quote.internalApprovedAt)}. Any price or quantity change clears this.
        </div>
      )}
      {!approvals.length ? (
        <EmptyState icon={<BadgeCheck />} title="No approval requests">
          When the quote is submitted, your firm’s approval rules (margin floor, below cost, large quotes) are
          checked. Anything that needs sign-off is routed to an approver here.
        </EmptyState>
      ) : (
        approvals.map((a) => <ApprovalCard key={a.id} a={a} />)
      )}
      <p className="text-[13px] text-ink-3">
        Approvers decide in{' '}
        <Link to="/app/approvals" className="font-[560] text-lacquer hover:underline">
          Approvals
        </Link>
        .
      </p>
    </div>
  );
}

export function ApprovalCard({ a, children }: { a: ApprovalRequest; children?: React.ReactNode }) {
  const lines = a.details?.lines ?? [];
  return (
    <section className="rounded-md border border-line bg-paper">
      <header className="flex flex-wrap items-start justify-between gap-2 border-b border-line-2 px-4 py-2.5">
        <div>
          <div className="font-[620]">{a.policyName}</div>
          <div className="text-ink-2">{a.reason}</div>
        </div>
        <StatusBadge status={a.status} />
      </header>
      <div className="space-y-3 px-4 py-3 text-[13px]">
        {lines.length > 0 && (
          <table className="w-full">
            <thead>
              <tr className="text-[12px] text-ink-3">
                <th className="py-1 text-left font-[520]">Line</th>
                <th className="py-1 text-right font-[520]">
                  {a.details.threshold !== undefined ? 'Margin' : 'Value'}
                </th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.id} className="border-t border-line-2">
                  <td className="py-1">
                    <span className="num mr-2 text-ink-2">{l.code}</span>
                    {l.name}
                  </td>
                  <td className="num py-1 text-right font-[560] text-warn">
                    {typeof l.value === 'number' ? `${l.value.toFixed(2)}%` : (l.value ?? '—')}
                    {a.details.threshold !== undefined && (
                      <span className="ml-1 font-[480] text-ink-3">/ {a.details.threshold}%</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {a.details?.value !== undefined && !lines.length && (
          <p className="num">
            Value <b className="font-[600]">{a.details.value.toLocaleString()}</b>
            {a.details.threshold !== undefined && <> · threshold {a.details.threshold.toLocaleString()}</>}
          </p>
        )}
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-ink-3">
          <span>
            Requested by {a.requestedByName ?? 'someone'} {ago(a.createdAt)}
          </span>
          <span>Routed to {a.approverRole.replace(/_/g, ' ')}</span>
          {a.decidedAt && (
            <span className="inline-flex items-center gap-1">
              {a.status === 'approved' ? (
                <CheckCircle2 className="size-3.5 text-ok" />
              ) : (
                <XCircle className="size-3.5 text-crit" />
              )}
              {a.decidedByName} {a.status} {ago(a.decidedAt)}
            </span>
          )}
        </div>
        {a.comment && <p className="rounded-sm bg-stone px-3 py-2 text-ink">“{a.comment}”</p>}
        {children}
      </div>
    </section>
  );
}

// ================================================================ owner
export function OwnerTab({ quote }: { quote: QuoteDetail }) {
  if (!quote.sentAt && !quote.clientDecision)
    return (
      <EmptyState icon={<FileText />} title="Not sent to the owner yet">
        Once it’s approved internally, use “Send to owner”. The owner reviews sell prices by location and
        approves with a typed signature in their portal.
      </EmptyState>
    );
  return (
    <div className="grid gap-4 p-4 sm:p-6 lg:grid-cols-2">
      <Section title="Sent">
        <dl className="space-y-2 text-[13px]">
          <div className="flex justify-between gap-2">
            <dt className="text-ink-3">Sent</dt>
            <dd>{dateTime(quote.sentAt)}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-ink-3">By</dt>
            <dd>{quote.sentByName ?? '—'}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-ink-3">Owner PDF</dt>
            <dd>
              {quote.clientDocumentId ? (
                <a
                  href={documentUrl(quote.clientDocumentId)}
                  target="_blank"
                  rel="noreferrer"
                  className="font-[560] text-lacquer hover:underline"
                >
                  {quote.number}.pdf
                </a>
              ) : (
                '—'
              )}
            </dd>
          </div>
        </dl>
      </Section>
      <Section title="Owner decision">
        {!quote.clientDecision ? (
          <p className="text-ink-2">Waiting for the owner. They were sent a link to the owner portal.</p>
        ) : (
          <div className="space-y-3 text-[13px]">
            <StatusBadge
              status={quote.clientDecision === 'approved' ? 'client_approved' : 'client_rejected'}
              label={quote.clientDecision === 'approved' ? 'Approved by owner' : 'Changes requested'}
            />
            <dl className="space-y-2">
              <div className="flex justify-between gap-2">
                <dt className="text-ink-3">Signed</dt>
                <dd className="font-[600] italic">{quote.clientSignatureName}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-ink-3">User</dt>
                <dd>{quote.clientDecidedByName}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-ink-3">When</dt>
                <dd>{dateTime(quote.clientDecidedAt)}</dd>
              </div>
            </dl>
            {quote.clientComment && <p className="rounded-sm bg-stone px-3 py-2">“{quote.clientComment}”</p>}
          </div>
        )}
      </Section>
    </div>
  );
}
