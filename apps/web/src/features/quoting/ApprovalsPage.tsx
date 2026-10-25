import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BadgeCheck, CheckCircle2, Settings2, XCircle } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import {
  Button,
  Dialog,
  EmptyState,
  ErrorNote,
  Field,
  Loading,
  PageHeader,
  Tabs,
  Textarea,
} from '@/components/ui';
import { api, type Page } from '@/lib/api';
import { hasPerm, useSession } from '@/lib/auth';
import { ago, money } from '@/lib/format';
import { ApprovalCard } from './builder/Tabs';
import { qk } from './shared';
import type { ApprovalRequest } from './types';

export function Component() {
  const s = useSession();
  const qc = useQueryClient();
  const canDecide = hasPerm(s, 'approvals:decide');
  const [tab, setTab] = useState<'mine' | 'all' | 'history'>(canDecide ? 'mine' : 'all');
  const query =
    tab === 'mine'
      ? { mine: 'true', status: 'pending', limit: 200 }
      : tab === 'all'
        ? { status: 'pending', limit: 200 }
        : { limit: 200 };
  const list = useQuery({
    queryKey: qk.approvals(query),
    queryFn: () => api.get<Page<ApprovalRequest>>('quoting', '/approvals', query),
  });
  const mineCount = useQuery({
    queryKey: qk.approvals({ mine: 'true', status: 'pending', limit: 200 }),
    queryFn: () =>
      api.get<Page<ApprovalRequest>>('quoting', '/approvals', {
        mine: 'true',
        status: 'pending',
        limit: 200,
      }),
    enabled: canDecide,
  });
  const [decide, setDecide] = useState<{ a: ApprovalRequest; decision: 'approved' | 'rejected' } | null>(
    null,
  );
  const [comment, setComment] = useState('');
  const m = useMutation({
    mutationFn: () =>
      api.post<{ quoteApproved: boolean }>('quoting', `/approvals/${decide!.a.id}/decide`, {
        decision: decide!.decision,
        comment: comment.trim() || null,
      }),
    onSuccess: (r) => {
      const d = decide!;
      toast.success(
        d.decision === 'approved' ? `Approved: ${d.a.policyName}` : `Rejected: ${d.a.policyName}`,
        {
          description:
            d.decision === 'approved'
              ? r.quoteApproved
                ? `${d.a.quoteNumber} has every approval and can be sent to the owner.`
                : `${d.a.quoteNumber} still has other approvals pending.`
              : `${d.a.quoteNumber} went back to merchandising for changes.`,
        },
      );
      setDecide(null);
      setComment('');
      qc.invalidateQueries({ queryKey: ['quoting'] });
    },
  });
  const rows = (list.data?.items ?? []).filter((a) => tab !== 'history' || a.status !== 'pending');
  const sorted = tab === 'history' ? rows : [...rows].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const mine = new Set(s?.context.roles ?? []);
  const canDecideOn = (a: ApprovalRequest) =>
    canDecide &&
    a.status === 'pending' &&
    (mine.has('admin') || mine.has(a.approverRole)) &&
    a.requestedBy !== s?.user.id;

  return (
    <>
      <PageHeader
        title="Approvals"
        description="Quotes that broke one of your firm’s approval rules wait here until an approver signs off. Nothing goes to the owner until every rule passes or is approved."
        actions={
          hasPerm(s, 'approval_policies:write') && (
            <Link to="/app/settings/policies">
              <Button size="sm" icon={<Settings2 className="size-4" />}>
                Approval rules
              </Button>
            </Link>
          )
        }
      >
        <Tabs
          className="mt-4 -mb-4"
          value={tab}
          onChange={(v) => setTab(v as typeof tab)}
          items={[
            ...(canDecide ? [{ value: 'mine', label: 'Waiting for me', count: mineCount.data?.total }] : []),
            { value: 'all', label: 'All pending' },
            { value: 'history', label: 'History' },
          ]}
        />
      </PageHeader>
      <div className="mx-auto max-w-[980px] space-y-3 px-4 py-5 sm:px-6">
        {list.isLoading ? (
          <Loading />
        ) : list.isError ? (
          <ErrorNote error={list.error} />
        ) : !sorted.length ? (
          <EmptyState
            icon={<BadgeCheck />}
            title={tab === 'history' ? 'No decisions yet' : 'Nothing waiting for approval'}
          >
            {tab === 'mine'
              ? 'When a quote breaks a rule routed to your role, it shows up here with the lines that caused it.'
              : 'Approval requests appear when a quote is submitted and breaks a rule such as the margin floor.'}
          </EmptyState>
        ) : (
          sorted.map((a) => (
            <div key={a.id}>
              <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2 px-1 text-[13px]">
                <Link
                  to={`/app/quotes/${a.entityId}?tab=approvals`}
                  className="font-[600] hover:text-lacquer hover:underline"
                >
                  <span className="num mr-1.5 text-ink-2">{a.quoteNumber}</span>
                  {a.quoteName}
                </Link>
                <span className="text-ink-3">
                  {a.status === 'pending' ? `Waiting ${ago(a.createdAt).replace(' ago', '')}` : ''}
                  {a.details?.value !== undefined &&
                  a.details.threshold !== undefined &&
                  a.policyName.toLowerCase().includes('large')
                    ? ` · ${money(a.details.value, true)}`
                    : ''}
                </span>
              </div>
              <ApprovalCard a={a}>
                {a.status === 'pending' && (
                  <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line-2 pt-3">
                    {!canDecideOn(a) && (
                      <span className="mr-auto text-[12px] text-ink-3">
                        {a.requestedBy === s?.user.id
                          ? 'You requested this, so someone else must decide it.'
                          : `Only the ${a.approverRole.replace(/_/g, ' ')} role can decide this.`}
                      </span>
                    )}
                    <Button
                      size="sm"
                      variant="danger"
                      icon={<XCircle className="size-4" />}
                      disabled={!canDecideOn(a)}
                      onClick={() => setDecide({ a, decision: 'rejected' })}
                    >
                      Reject
                    </Button>
                    <Button
                      size="sm"
                      variant="primary"
                      icon={<CheckCircle2 className="size-4" />}
                      disabled={!canDecideOn(a)}
                      onClick={() => setDecide({ a, decision: 'approved' })}
                    >
                      Approve
                    </Button>
                  </div>
                )}
              </ApprovalCard>
            </div>
          ))
        )}
      </div>
      <Dialog
        open={!!decide}
        onClose={() => setDecide(null)}
        title={
          decide?.decision === 'approved'
            ? `Approve “${decide.a.policyName}”?`
            : `Reject “${decide?.a.policyName}”?`
        }
        footer={
          <>
            <Button onClick={() => setDecide(null)}>Cancel</Button>
            <Button
              variant={decide?.decision === 'approved' ? 'primary' : 'danger'}
              loading={m.isPending}
              disabled={decide?.decision === 'rejected' && !comment.trim()}
              onClick={() => m.mutate()}
            >
              {decide?.decision === 'approved' ? 'Approve' : 'Reject'}
            </Button>
          </>
        }
      >
        {decide && (
          <div className="space-y-3">
            <p className="text-ink-2">
              {decide.a.quoteNumber} {decide.a.quoteName}: {decide.a.reason}.
              {decide.decision === 'rejected' &&
                ' The quote goes back to merchandising and the requester is notified.'}
            </p>
            <Field
              label={decide.decision === 'approved' ? 'Comment (optional)' : 'What needs to change?'}
              hint="The requester sees this with your decision."
            >
              {(id) => (
                <Textarea
                  id={id}
                  autoFocus
                  rows={3}
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder={
                    decide.decision === 'approved'
                      ? 'OK — strategic pricing for a repeat owner.'
                      : 'Raise the communal table to at least 16%.'
                  }
                />
              )}
            </Field>
          </div>
        )}
      </Dialog>
    </>
  );
}
