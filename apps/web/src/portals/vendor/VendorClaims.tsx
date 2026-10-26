import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { ThreadPanel } from '@/components/shared/ThreadPanel';
import { Badge, Button, Chips, EmptyState, ErrorNote, Field, Loading, Textarea } from '@/components/ui';
import {
  CLAIM_STATUS_LABEL,
  CLAIM_TONE,
  CLAIM_TYPE_LABEL,
  isClosedClaim,
  PhotoGrid,
} from '@/features/orders/shared';
import type { VendorClaim } from '@/features/orders/types';
import { api } from '@/lib/api';
import { useMe } from '@/lib/auth';
import { ago, date } from '@/lib/format';

export function Component() {
  const s = useMe();
  const firm = s.contexts.find((c) => c.tenantId === s.context.tenantId)?.tenantName ?? 'your client';
  const [show, setShow] = useState<'open' | 'closed'>('open');
  const [openId, setOpenId] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ['vendor', 'claims'],
    queryFn: () => api.get<VendorClaim[]>('orders', '/vendor/claims'),
  });
  const rows = (q.data ?? []).filter((c) =>
    show === 'open' ? !isClosedClaim(c.status) : isClosedClaim(c.status),
  );

  return (
    <div className="mx-auto max-w-[980px] px-4 py-6 sm:px-6">
      <h1 className="text-[24px] leading-tight font-[640]">Claims</h1>
      <p className="mt-1 max-w-[66ch] text-ink-2">
        Damaged, missing or wrong items {firm} reported on your orders. Let them know you’ve seen each one,
        and when a replacement is on order.
      </p>
      <div className="mt-5">
        <Chips
          value={show}
          onChange={setShow}
          options={[
            {
              value: 'open',
              label: 'Open',
              count: (q.data ?? []).filter((c) => !isClosedClaim(c.status)).length,
            },
            { value: 'closed', label: 'Closed' },
          ]}
        />
      </div>
      <div className="mt-3">
        {q.isError ? (
          <ErrorNote error={q.error} />
        ) : q.isLoading ? (
          <Loading label="Loading claims" />
        ) : !rows.length ? (
          <div className="rounded-md border border-line bg-paper">
            <EmptyState
              icon={<ShieldAlert />}
              title={show === 'open' ? 'No open claims' : 'No closed claims'}
            >
              {show === 'open'
                ? 'Nothing needs your attention. Claims appear here when the buyer sends you one.'
                : 'Resolved claims are kept here.'}
            </EmptyState>
          </div>
        ) : (
          <ul className="space-y-3">
            {rows.map((c) => (
              <ClaimCard
                key={c.id}
                c={c}
                firm={firm}
                vendorOrgId={s.context.orgId}
                expanded={openId === c.id}
                onToggle={() => setOpenId(openId === c.id ? null : c.id)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function ClaimCard({
  c,
  firm,
  vendorOrgId,
  expanded,
  onToggle,
}: {
  c: VendorClaim;
  firm: string;
  vendorOrgId: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const qc = useQueryClient();
  const [notes, setNotes] = useState('');
  const m = useMutation({
    mutationFn: (status: 'vendor_acknowledged' | 'replacement_ordered') =>
      api.patch('orders', `/vendor/claims/${c.id}`, { status, resolution: notes.trim() || undefined }),
    onSuccess: (_d, status) => {
      toast.success(status === 'replacement_ordered' ? 'Replacement marked ordered' : 'Claim acknowledged', {
        description: `${firm} has been notified.`,
      });
      setNotes('');
      qc.invalidateQueries({ queryKey: ['vendor'] });
    },
  });
  const closed = isClosedClaim(c.status);
  const canAck = c.status === 'open' || c.status === 'submitted_to_vendor';
  const canReplace = canAck || c.status === 'vendor_acknowledged';
  return (
    <li className="overflow-hidden rounded-md border border-line bg-paper">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full flex-wrap items-start gap-x-4 gap-y-1 px-4 py-3 text-left hover:bg-stone"
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="num font-[620]">{c.number}</span>
            <span className="text-ink-2">{CLAIM_TYPE_LABEL[c.type]}</span>
            <Badge tone={CLAIM_TONE[c.status]}>
              {c.status === 'submitted_to_vendor' ? 'Needs your response' : CLAIM_STATUS_LABEL[c.status]}
            </Badge>
          </div>
          <p className={expanded ? 'mt-1 text-ink-2' : 'mt-1 line-clamp-1 text-ink-2'}>{c.description}</p>
        </div>
        <div className="text-right text-[13px] text-ink-3">
          {c.poNumber && (
            <Link
              to={`/vendor/orders/${c.poId}`}
              onClick={(e) => e.stopPropagation()}
              className="num block font-[560] text-lacquer hover:underline"
            >
              {c.poNumber}
            </Link>
          )}
          Reported {ago(c.reportedAt)}
        </div>
      </button>
      {expanded && (
        <div className="grid gap-5 border-t border-line-2 p-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="min-w-0 space-y-4">
            {c.items.length > 0 && (
              <div>
                <h3 className="mb-1 text-[13px] font-[620] text-ink-2">Items</h3>
                <ul className="divide-y divide-line-2 rounded-sm border border-line-2 text-[13px]">
                  {c.items.map((i, n) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: items carry no id in the vendor view
                    <li key={n} className="flex gap-3 px-3 py-1.5">
                      <span className="num text-ink-3">{i.code}</span>
                      <span className="min-w-0 flex-1">{i.name}</span>
                      <span className="num font-[560]">×{i.quantity}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div>
              <h3 className="mb-1 text-[13px] font-[620] text-ink-2">Photos</h3>
              <PhotoGrid
                ids={c.photoDocumentIds}
                empty={<p className="text-[13px] text-ink-3">No photos were attached.</p>}
              />
            </div>
            {c.resolution && (
              <div>
                <h3 className="mb-1 text-[13px] font-[620] text-ink-2">Resolution notes</h3>
                <p className="text-[13px] whitespace-pre-wrap">{c.resolution}</p>
              </div>
            )}
            {!closed && (canAck || canReplace) && (
              <div className="space-y-2 rounded-sm border border-line-2 bg-stone/50 p-3">
                <Field
                  label="Your response"
                  hint="e.g. Replacements cut and shipping with shipment B, PRO to follow."
                >
                  {(id) => (
                    <Textarea id={id} rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
                  )}
                </Field>
                <div className="flex flex-wrap gap-2">
                  {canAck && (
                    <Button
                      loading={m.isPending && m.variables === 'vendor_acknowledged'}
                      onClick={() => m.mutate('vendor_acknowledged')}
                    >
                      Acknowledge claim
                    </Button>
                  )}
                  {canReplace && (
                    <Button
                      variant="primary"
                      loading={m.isPending && m.variables === 'replacement_ordered'}
                      onClick={() => m.mutate('replacement_ordered')}
                    >
                      Mark replacement ordered
                    </Button>
                  )}
                </div>
              </div>
            )}
            {c.resolvedAt && <p className="text-[13px] text-ink-3">Closed {date(c.resolvedAt)}</p>}
          </div>
          <div className="min-w-0">
            <h3 className="mb-2 text-[13px] font-[620] text-ink-2">Messages with {firm}</h3>
            <ThreadPanel
              entityType="claim"
              entityId={c.id}
              visibility="vendor"
              vendorOrgId={vendorOrgId}
              emptyHint="Ask a question about this claim or share details."
            />
          </div>
        </div>
      )}
    </li>
  );
}
