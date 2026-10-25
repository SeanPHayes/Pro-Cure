import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ChevronLeft, FileDown, MessageSquareWarning, PenLine } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { toast } from 'sonner';
import {
  Button,
  cx,
  Dialog,
  EmptyState,
  ErrorNote,
  Field,
  Input,
  Loading,
  StatusBadge,
  Textarea,
} from '@/components/ui';
import type { ClientQuoteDetail } from '@/features/quoting/types';
import { ApiError, api, documentUrl } from '@/lib/api';
import { hasPerm, useMe } from '@/lib/auth';
import { date, dateLong, dateTime, daysFromToday, money } from '@/lib/format';

export function Component() {
  const { id = '' } = useParams();
  const s = useMe();
  const qc = useQueryClient();
  const key = ['client', 'quote', id];
  const q = useQuery({
    queryKey: key,
    queryFn: () => api.get<ClientQuoteDetail>('quoting', `/client/quotes/${id}`),
  });
  const [mode, setMode] = useState<'approve' | 'reject' | null>(null);
  const [sig, setSig] = useState('');
  const [comment, setComment] = useState('');
  const [agree, setAgree] = useState(false);
  const decide = useMutation({
    mutationFn: () =>
      api.post<ClientQuoteDetail>('quoting', `/client/quotes/${id}/decision`, {
        decision: mode === 'approve' ? 'approved' : 'rejected',
        signatureName: sig.trim(),
        comment: comment.trim() || null,
      }),
    onSuccess: (d) => {
      qc.setQueryData(key, d);
      qc.invalidateQueries({ queryKey: ['client'] });
      toast.success(mode === 'approve' ? 'Quote approved' : 'Changes requested', {
        description:
          mode === 'approve'
            ? 'Your project team has been notified and will begin ordering.'
            : 'Your project team will revise the quote and send it back.',
      });
      setMode(null);
    },
  });
  const canApprove = hasPerm(s, 'client:approve');
  const firm = s.contexts.find((c) => c.tenantId === s.context.tenantId)?.tenantName ?? 'your project team';

  if (q.isLoading) return <Loading label="Loading quote" />;
  if (q.isError || !q.data)
    return q.error instanceof ApiError && q.error.status === 404 ? (
      <EmptyState
        title="This quote isn’t available"
        action={
          <Link to="/portal" className="font-[560] text-lacquer hover:underline">
            Back to your projects
          </Link>
        }
      >
        It may not have been sent to you yet, or it was withdrawn.
      </EmptyState>
    ) : (
      <ErrorNote error={q.error} />
    );
  const d = q.data;
  const pending = d.status === 'sent';
  const days = daysFromToday(d.validUntil);
  const sigOk = sig.trim().length >= 2;

  return (
    <div className="mx-auto max-w-[1040px] px-4 py-5 pb-28 sm:px-6">
      <Link
        to={d.projectId ? `/portal/projects/${d.projectId}` : '/portal/approvals'}
        className="inline-flex items-center gap-1 text-[13px] text-ink-2 hover:text-ink"
      >
        <ChevronLeft className="size-4" />
        {d.projectId ? 'Project' : 'Approvals'}
      </Link>
      <header className="mt-3 rounded-md border border-line bg-paper p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="num text-[13px] text-ink-3">Quote {d.number}</div>
            <h1 className="text-[24px] font-[640] leading-tight">{d.name}</h1>
            {d.phase && <p className="mt-0.5 text-ink-2">{d.phase}</p>}
          </div>
          <div className="text-right">
            <div className="text-[12px] text-ink-3">Total</div>
            <div className="num text-[26px] font-[660]">{money(d.totals.total)}</div>
            {d.documentId && (
              <a
                href={documentUrl(d.documentId, true)}
                className="mt-1 inline-flex items-center gap-1.5 text-[13px] font-[560] text-lacquer hover:underline"
              >
                <FileDown className="size-4" />
                Download PDF
              </a>
            )}
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-x-8 gap-y-2 border-t border-line-2 pt-3 text-[13px]">
          <div>
            <span className="text-ink-3">Sent </span>
            {date(d.sentAt)}
          </div>
          <div>
            <span className="text-ink-3">Prices valid until </span>
            <span className={cx(days !== null && days < 0 && 'text-crit')}>{dateLong(d.validUntil)}</span>
          </div>
          <div>
            <StatusBadge
              status={d.status}
              label={
                pending
                  ? 'Waiting for your decision'
                  : d.status === 'client_approved' || d.status === 'ordered'
                    ? 'Approved'
                    : d.status === 'client_rejected'
                      ? 'Changes requested'
                      : undefined
              }
            />
          </div>
        </div>
        {d.clientNotes && (
          <p className="mt-3 rounded-sm bg-stone px-3 py-2 text-[13px] text-ink-2">{d.clientNotes}</p>
        )}
      </header>

      {d.clientDecision && (
        <div
          className={cx(
            'mt-4 flex items-start gap-3 rounded-md border px-4 py-3',
            d.clientDecision === 'approved' ? 'border-ok/25 bg-ok-50' : 'border-warn/30 bg-warn-50',
          )}
        >
          {d.clientDecision === 'approved' ? (
            <CheckCircle2 className="mt-0.5 size-5 text-ok" />
          ) : (
            <MessageSquareWarning className="mt-0.5 size-5 text-warn" />
          )}
          <div className="text-[13px]">
            <div className={cx('font-[620]', d.clientDecision === 'approved' ? 'text-ok' : 'text-warn')}>
              {d.clientDecision === 'approved' ? 'You approved this quote' : 'You asked for changes'}
            </div>
            <div className="text-ink-2">
              Signed <span className="font-[600] italic text-ink">{d.clientSignatureName}</span>
              {d.clientDecidedByName && d.clientDecidedByName !== d.clientSignatureName
                ? ` by ${d.clientDecidedByName}`
                : ''}{' '}
              on {dateTime(d.clientDecidedAt)}.
            </div>
            {d.clientComment && <p className="mt-1 text-ink">“{d.clientComment}”</p>}
            <p className="mt-1 text-ink-2">
              {d.clientDecision === 'approved'
                ? `${firm} will place the orders and keep you updated on the project page.`
                : `${firm} will revise the quote and send you a new version.`}
            </p>
          </div>
        </div>
      )}

      <div className="mt-4 space-y-4">
        {d.sections.map((sec) => (
          <section
            key={sec.locationId ?? sec.location}
            className="overflow-hidden rounded-md border border-line bg-paper"
          >
            <header className="flex items-baseline justify-between gap-3 border-b border-line bg-stone px-4 py-2.5">
              <h2 className="font-[620]">{sec.location}</h2>
              <span className="num font-[600]">{money(sec.subtotal)}</span>
            </header>
            <div className="overflow-x-auto">
              <table className="grid-table">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th className="right max-sm:hidden">Qty</th>
                    <th className="right max-sm:hidden">Unit price</th>
                    <th className="right">Extended</th>
                  </tr>
                </thead>
                <tbody>
                  {sec.lines.map((l) => (
                    <tr key={l.id}>
                      <td className="sm:min-w-[260px]">
                        <div className="font-[560]">
                          <span className="num mr-2 text-[12px] text-ink-3">{l.code}</span>
                          {l.name}
                        </div>
                        <div className="text-[12px] text-ink-2">
                          {[l.finish, l.dimensions].filter(Boolean).join(' · ')}
                        </div>
                        {l.description && <div className="text-[12px] text-ink-3">{l.description}</div>}
                        {l.clientNotes && (
                          <div className="mt-0.5 text-[12px] text-brass">{l.clientNotes}</div>
                        )}
                        <div className="num mt-0.5 text-[12px] text-ink-2 sm:hidden">
                          {l.quantity.toLocaleString()} {l.unit} × {money(l.unitPrice)}
                        </div>
                      </td>
                      <td className="right num whitespace-nowrap max-sm:hidden">
                        {l.quantity.toLocaleString()} <span className="text-ink-3">{l.unit}</span>
                      </td>
                      <td className="right num max-sm:hidden">{money(l.unitPrice)}</td>
                      <td className="right num font-[560]">{money(l.extendedPrice)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))}
        <section className="ml-auto max-w-sm rounded-md border border-line bg-paper p-4 text-[14px]">
          <dl className="space-y-1.5">
            <div className="flex justify-between">
              <dt className="text-ink-2">Subtotal</dt>
              <dd className="num">{money(d.totals.subtotal)}</dd>
            </div>
            {d.totals.freight > 0 && (
              <div className="flex justify-between">
                <dt className="text-ink-2">Freight</dt>
                <dd className="num">{money(d.totals.freight)}</dd>
              </div>
            )}
            <div className="flex justify-between">
              <dt className="text-ink-2">Tax</dt>
              <dd className="num">{money(d.totals.tax)}</dd>
            </div>
            <div className="flex justify-between border-t border-ink pt-2 text-[16px] font-[660]">
              <dt>Total</dt>
              <dd className="num">{money(d.totals.total)}</dd>
            </div>
          </dl>
        </section>
      </div>

      {pending && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-paper/95 px-4 py-3 backdrop-blur lg:left-[232px]">
          <div className="mx-auto flex max-w-[1040px] flex-wrap items-center gap-3">
            <div className="mr-auto text-[13px]">
              <div className="font-[620]">Ready for your decision</div>
              <div className="text-ink-2">
                {canApprove
                  ? 'Approve to let your team start ordering, or ask for changes.'
                  : 'Someone with approval rights at your company needs to decide.'}
              </div>
            </div>
            {canApprove && (
              <>
                <Button onClick={() => setMode('reject')}>Request changes</Button>
                <Button
                  variant="primary"
                  icon={<PenLine className="size-4" />}
                  onClick={() => {
                    setSig('');
                    setAgree(false);
                    setMode('approve');
                  }}
                >
                  Approve quote
                </Button>
              </>
            )}
          </div>
        </div>
      )}

      <Dialog
        open={!!mode}
        onClose={() => setMode(null)}
        width={520}
        title={mode === 'approve' ? `Approve quote ${d.number}` : 'Request changes'}
        footer={
          <>
            <Button onClick={() => setMode(null)}>Cancel</Button>
            <Button
              variant={mode === 'approve' ? 'primary' : 'secondary'}
              loading={decide.isPending}
              disabled={!sigOk || (mode === 'approve' && !agree) || (mode === 'reject' && !comment.trim())}
              onClick={() => decide.mutate()}
            >
              {mode === 'approve' ? `Approve ${money(d.totals.total)}` : 'Send change request'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {mode === 'approve' ? (
            <p className="text-ink-2">
              You’re approving {d.sections.reduce((a, s) => a + s.lines.length, 0)} items totaling{' '}
              <b className="num font-[620] text-ink">{money(d.totals.total)}</b>. {firm} will place purchase
              orders based on this quote.
            </p>
          ) : (
            <p className="text-ink-2">
              Tell {firm} what to change. They’ll revise the quote and send it back for your approval.
            </p>
          )}
          <Field label={mode === 'approve' ? 'Comment (optional)' : 'What should change?'}>
            {(id) => (
              <Textarea
                id={id}
                rows={3}
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder={
                  mode === 'approve' ? '' : 'Please revise the lobby lounge chairs to the alternate fabric.'
                }
              />
            )}
          </Field>
          <Field
            label="Type your full name to sign"
            hint={`Signing as ${s.user.name}, ${s.context.orgName}.`}
          >
            {(id) => (
              <Input
                id={id}
                autoFocus
                value={sig}
                onChange={(e) => setSig(e.target.value)}
                className="font-[600] italic"
                placeholder={s.user.name}
                autoComplete="name"
              />
            )}
          </Field>
          {mode === 'approve' && (
            <label className="flex items-start gap-2 rounded-sm bg-stone p-3 text-[13px]">
              <input
                type="checkbox"
                className="mt-0.5 accent-lacquer"
                checked={agree}
                onChange={(e) => setAgree(e.target.checked)}
              />
              <span>
                I’m authorized to approve purchases for {s.context.orgName}. By typing my name I approve this
                quote as an electronic signature, and authorize {firm} to order the items listed at the prices
                shown.
              </span>
            </label>
          )}
        </div>
      </Dialog>
    </div>
  );
}
