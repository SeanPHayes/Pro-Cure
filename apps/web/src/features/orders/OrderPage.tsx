import { useMutation, useQuery } from '@tanstack/react-query';
import { Ban, ChevronLeft, FileDown, Pencil, Send } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { ActivityFeed } from '@/components/shared/ActivityFeed';
import { ThreadPanel } from '@/components/shared/ThreadPanel';
import {
  Button,
  Dialog,
  EmptyState,
  ErrorNote,
  Field,
  Loading,
  Menu,
  Section,
  StatusBadge,
  Tabs,
  Textarea,
  TitleBlock,
} from '@/components/ui';
import { ApiError, api, documentUrl } from '@/lib/api';
import { hasPerm, useSession } from '@/lib/auth';
import { date, daysFromToday, money } from '@/lib/format';
import { FilesTab } from './po/FilesTab';
import { LinesTab } from './po/LinesTab';
import { EditOrderSheet, OverviewTab } from './po/OverviewTab';
import { RecipientsTab } from './po/RecipientsTab';
import { ChangeList, RevisionsTab } from './po/RevisionsTab';
import { ShipmentsTab } from './po/ShipmentsTab';
import { OrderByDate, ok, RiskMark, relDays, useInvalidateOrders } from './shared';
import type { Change, PoDetail } from './types';

const TABS = [
  'overview',
  'lines',
  'shipments',
  'revisions',
  'recipients',
  'files',
  'messages',
  'activity',
] as const;
type Tab = (typeof TABS)[number];

export const usePo = (id: string) =>
  useQuery({
    queryKey: ok.po(id),
    queryFn: () => api.get<PoDetail>('orders', `/purchase-orders/${id}`),
  });

export function Component() {
  const { id = '' } = useParams();
  const s = useSession();
  const [params, setParams] = useSearchParams();
  const tab = (TABS as readonly string[]).includes(params.get('tab') ?? '')
    ? (params.get('tab') as Tab)
    : 'overview';
  const setTab = (t: string) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        if (t === 'overview') n.delete('tab');
        else n.set('tab', t);
        return n;
      },
      { replace: true },
    );
  const q = usePo(id);
  const [issuing, setIssuing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [editing, setEditing] = useState(false);
  const canIssue = hasPerm(s, 'orders:issue');
  const canWrite = hasPerm(s, 'orders:write');

  const pdf = useMutation({
    mutationFn: async (po: PoDetail) => {
      const latest = po.revisions.find((r) => r.revision === po.revision && r.documentId);
      if (latest?.documentId && !po.hasUnissuedChanges) return latest.documentId;
      const d = await api.post<{ id: string }>('orders', `/purchase-orders/${po.id}/report`);
      return d.id;
    },
    onSuccess: (docId) => window.open(documentUrl(docId), '_blank', 'noopener'),
  });

  if (q.isLoading) return <Loading label="Loading purchase order" />;
  if (q.isError) {
    const nf = q.error instanceof ApiError && (q.error.status === 404 || q.error.status === 400);
    return nf ? (
      <EmptyState
        title="This purchase order doesn’t exist"
        action={
          <Link to="/app/orders" className="font-[560] text-lacquer hover:underline">
            Back to purchase orders
          </Link>
        }
      >
        It may have been removed, or the link is wrong.
      </EmptyState>
    ) : (
      <ErrorNote error={q.error} />
    );
  }
  const po = q.data!;
  const closed = po.status === 'cancelled' || po.status === 'closed';
  const editable = canWrite && !closed && po.status !== 'delivered';
  const pendingReqs = po.requirements.filter((r) => ['pending', 'submitted', 'rejected'].includes(r.status));
  const cancellable =
    canIssue &&
    !closed &&
    !po.shipments.some((x) => ['shipped', 'in_transit', 'delivered'].includes(x.status));

  return (
    <div className="px-4 py-4 sm:px-6">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <Link
          to="/app/orders"
          className="inline-flex items-center gap-1 text-[13px] text-ink-2 hover:text-ink"
        >
          <ChevronLeft className="size-4" />
          Purchase orders
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            icon={<FileDown className="size-4" />}
            loading={pdf.isPending}
            onClick={() => pdf.mutate(po)}
          >
            Download PDF
          </Button>
          {editable && (
            <Button icon={<Pencil className="size-4" />} onClick={() => setEditing(true)}>
              Edit order details
            </Button>
          )}
          {canIssue && po.status === 'draft' && (
            <Button variant="primary" icon={<Send className="size-4" />} onClick={() => setIssuing(true)}>
              Issue to vendor
            </Button>
          )}
          {canIssue && po.status !== 'draft' && po.hasUnissuedChanges && !closed && (
            <Button variant="brass" icon={<Send className="size-4" />} onClick={() => setIssuing(true)}>
              Issue revision {po.revision + 1}
            </Button>
          )}
          {cancellable && (
            <Menu
              trigger={(toggle) => (
                <Button variant="ghost" onClick={toggle}>
                  More
                </Button>
              )}
              items={[
                {
                  label: 'Cancel purchase order',
                  danger: true,
                  icon: <Ban className="size-4" />,
                  onSelect: () => setCancelling(true),
                },
              ]}
            />
          )}
        </div>
      </div>

      <TitleBlock
        title={
          <span className="flex flex-wrap items-center gap-2">
            <span className="num">{po.number}</span>
            {po.revision > 0 && (
              <span className="num text-[15px] font-[520] text-ink-3">Rev {po.revision}</span>
            )}
            <RiskMark level={po.escalation} reasons={po.escalationReasons} score={po.riskScore} />
          </span>
        }
        subtitle={
          <span className="block truncate" title={`${po.vendorName} · ${po.projectName ?? ''}`}>
            <span className="font-[560] text-ink">{po.vendorName}</span>
            <span className="text-ink-3"> · {po.projectName}</span>
          </span>
        }
        fields={[
          {
            label: 'Project',
            value: (
              <Link
                to={`/app/projects/${po.projectId}`}
                className="hover:text-lacquer hover:underline"
                title={po.projectName ?? ''}
              >
                <span className="num">{po.projectNumber}</span>
              </Link>
            ),
          },
          {
            label: 'Status',
            value: (
              <span className="flex items-center gap-1.5">
                <StatusBadge status={po.status} />
                {po.hasUnissuedChanges && <span className="text-[12px] font-[560] text-brass">Unissued</span>}
              </span>
            ),
          },
          {
            label: 'Order-by date',
            value: <OrderByDate value={po.releaseByDate} pending={pendingReqs.length} compact />,
          },
          {
            label: 'Requested delivery',
            value: (
              <span className="num">
                {date(po.requestedDeliveryDate)}
                {Math.abs(daysFromToday(po.requestedDeliveryDate) ?? 999) <= 60 && (
                  <span className="ml-1.5 font-[480] text-ink-3">{relDays(po.requestedDeliveryDate)}</span>
                )}
              </span>
            ),
          },
          { label: 'Total', value: <span className="num">{money(po.total)}</span> },
        ]}
      />

      <Tabs
        className="mt-5 border-b border-line"
        value={tab}
        onChange={setTab}
        items={[
          { value: 'overview', label: 'Overview', count: pendingReqs.length || undefined },
          { value: 'lines', label: 'Lines', count: po.lines.length },
          { value: 'shipments', label: 'Shipments', count: po.shipments.length },
          { value: 'revisions', label: 'Revisions', count: po.revisions.length || undefined },
          { value: 'recipients', label: 'Delivery recipients', count: po.recipients.length || undefined },
          { value: 'files', label: 'Files' },
          { value: 'messages', label: 'Messages' },
          { value: 'activity', label: 'Activity' },
        ]}
      />

      <div className="pt-4">
        {tab === 'overview' && <OverviewTab po={po} onGoTo={setTab} />}
        {tab === 'lines' && <LinesTab po={po} />}
        {tab === 'shipments' && <ShipmentsTab po={po} />}
        {tab === 'revisions' && <RevisionsTab po={po} onIssue={() => setIssuing(true)} />}
        {tab === 'recipients' && <RecipientsTab po={po} />}
        {tab === 'files' && <FilesTab po={po} />}
        {tab === 'messages' && (
          <div className={po.vendorOrgId ? 'grid gap-4 lg:grid-cols-2' : ''}>
            <Section title="Team" className="min-w-0">
              <ThreadPanel
                entityType="purchase_order"
                entityId={po.id}
                visibility="internal"
                emptyHint="Internal notes about this order. The vendor never sees them."
              />
            </Section>
            {po.vendorOrgId ? (
              <Section title={`Vendor · ${po.vendorName}`} className="min-w-0">
                <ThreadPanel
                  entityType="purchase_order"
                  entityId={po.id}
                  visibility="vendor"
                  vendorOrgId={po.vendorOrgId}
                  allowEmail
                  emptyHint="The vendor sees these messages in their portal. Add an email address to also send by email; replies come back here."
                />
              </Section>
            ) : (
              <p className="mt-3 text-ink-3">
                {po.vendorName} isn’t on the vendor portal yet, so vendor messages go by email from the team
                thread.
              </p>
            )}
          </div>
        )}
        {tab === 'activity' && (
          <Section title="Activity">
            <ActivityFeed service="orders" path={`/purchase-orders/${po.id}/activity`} />
          </Section>
        )}
      </div>

      <IssueDialog po={po} open={issuing} onClose={() => setIssuing(false)} />
      <CancelDialog po={po} open={cancelling} onClose={() => setCancelling(false)} />
      <EditOrderSheet po={po} open={editing} onClose={() => setEditing(false)} />
    </div>
  );
}

// ------------------------------------------------------------------ issue / issue revision
function IssueDialog({ po, open, onClose }: { po: PoDetail; open: boolean; onClose: () => void }) {
  const invalidate = useInvalidateOrders();
  const revise = po.status !== 'draft';
  const next = po.revision + 1;
  const [message, setMessage] = useState('');
  const diff = useQuery({
    queryKey: ['orders', 'diff', po.id, next, po.version],
    queryFn: () =>
      api.get<{ changes: Change[] }>('orders', `/purchase-orders/${po.id}/revisions/${next}/diff`),
    enabled: open && revise,
  });
  const m = useMutation({
    mutationFn: () =>
      api.post<{ emailed: boolean; documentId: string }>(
        'orders',
        `/purchase-orders/${po.id}/${revise ? 'issue-revision' : 'issue'}`,
        { message: message.trim() || undefined },
      ),
    onSuccess: (r) => {
      toast.success(revise ? `Revision ${next} issued` : 'Purchase order issued', {
        description: r.emailed
          ? `Emailed to ${po.vendorContact?.email ?? po.vendorName} with the PDF and a portal link.`
          : 'The PDF is on the order. No vendor email address is on file, so send it yourself.',
        action: { label: 'Open PDF', onClick: () => window.open(documentUrl(r.documentId), '_blank') },
      });
      setMessage('');
      invalidate();
      onClose();
    },
  });
  const changes = diff.data?.changes ?? [];
  return (
    <Dialog
      open={open}
      onClose={onClose}
      width={600}
      title={revise ? `Issue revision ${next} of ${po.number}` : `Issue ${po.number} to ${po.vendorName}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon={<Send className="size-4" />}
            loading={m.isPending}
            disabled={revise && !changes.length}
            onClick={() => m.mutate()}
          >
            {revise ? `Issue revision ${next}` : 'Issue to vendor'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {revise ? (
          <>
            <p className="text-ink-2">
              The vendor gets a revision PDF with these changes highlighted, and is asked to confirm in their
              portal.
            </p>
            {diff.isLoading ? (
              <p className="text-ink-3">Comparing with revision {po.revision}…</p>
            ) : (
              <div className="max-h-72 overflow-y-auto rounded-sm border border-line">
                <ChangeList changes={changes} />
              </div>
            )}
          </>
        ) : (
          <p className="text-ink-2">
            Pro-Cure renders the PO PDF and emails it to{' '}
            <span className="font-[560] text-ink">{po.vendorContact?.email ?? 'the vendor'}</span> with a link
            to acknowledge it and confirm a ship date in the vendor portal.{' '}
            <span className="num">
              {po.lines.length} lines, {money(po.total)}.
            </span>
          </p>
        )}
        <Field label="Message to the vendor (optional)">
          {(id) => (
            <Textarea
              id={id}
              rows={3}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder={
                revise
                  ? 'e.g. Quantities updated after the final room count.'
                  : 'e.g. Please confirm your production slot.'
              }
            />
          )}
        </Field>
      </div>
    </Dialog>
  );
}

function CancelDialog({ po, open, onClose }: { po: PoDetail; open: boolean; onClose: () => void }) {
  const invalidate = useInvalidateOrders();
  const [reason, setReason] = useState('');
  const [notify, setNotify] = useState(true);
  const m = useMutation({
    mutationFn: () =>
      api.post('orders', `/purchase-orders/${po.id}/cancel`, {
        reason: reason.trim() || undefined,
        notifyVendor: notify,
      }),
    onSuccess: () => {
      toast.success(`${po.number} cancelled`);
      invalidate();
      onClose();
    },
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Cancel ${po.number}?`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Keep order
          </Button>
          <Button variant="danger" loading={m.isPending} onClick={() => m.mutate()}>
            Cancel purchase order
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-ink-2">
          The quote lines on this order become available to order again. This can’t be undone.
        </p>
        <Field label="Reason">
          {(id) => (
            <Textarea
              id={id}
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Owner value-engineered the lighting package"
            />
          )}
        </Field>
        {po.status !== 'draft' && (
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              className="size-4 accent-lacquer"
              checked={notify}
              onChange={(e) => setNotify(e.target.checked)}
            />
            Email {po.vendorName} that the order is cancelled
          </label>
        )}
      </div>
    </Dialog>
  );
}
