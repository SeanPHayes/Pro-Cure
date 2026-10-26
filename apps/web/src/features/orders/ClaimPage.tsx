import { useMutation, useQuery } from '@tanstack/react-query';
import { ChevronLeft, FileDown, ImagePlus } from 'lucide-react';
import { useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { ActivityFeed } from '@/components/shared/ActivityFeed';
import { uploadDocument } from '@/components/shared/DocumentsPanel';
import { ThreadPanel } from '@/components/shared/ThreadPanel';
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  ErrorNote,
  Field,
  Input,
  Loading,
  Section,
  Spinner,
  Tabs,
  Textarea,
  TitleBlock,
} from '@/components/ui';
import { ApiError, api, documentUrl, errorMessage } from '@/lib/api';
import { hasPerm, useSession } from '@/lib/auth';
import { date, dateTime, money } from '@/lib/format';
import {
  CLAIM_STATUS_LABEL,
  CLAIM_TONE,
  CLAIM_TYPE_LABEL,
  isClosedClaim,
  ok,
  PhotoGrid,
  useInvalidateOrders,
  useProjectsLite,
} from './shared';
import type { Claim, ClaimStatus } from './types';

type ClaimWithOrgs = Claim & { vendorOrgId?: string | null; clientOrgId?: string | null };

/** Workflow actions offered from each status (mirrors services/orders/src/domain/claims.ts). */
const NEXT: Record<ClaimStatus, { to: ClaimStatus; label: string; primary?: boolean; danger?: boolean }[]> = {
  open: [
    { to: 'submitted_to_vendor', label: 'Submit to vendor', primary: true },
    { to: 'resolved', label: 'Resolve' },
    { to: 'rejected', label: 'Reject', danger: true },
  ],
  submitted_to_vendor: [
    { to: 'replacement_ordered', label: 'Mark replacement ordered', primary: true },
    { to: 'credited', label: 'Credit' },
    { to: 'resolved', label: 'Resolve' },
    { to: 'rejected', label: 'Reject', danger: true },
  ],
  vendor_acknowledged: [
    { to: 'replacement_ordered', label: 'Mark replacement ordered', primary: true },
    { to: 'credited', label: 'Credit' },
    { to: 'resolved', label: 'Resolve' },
    { to: 'rejected', label: 'Reject', danger: true },
  ],
  replacement_ordered: [
    { to: 'resolved', label: 'Resolve', primary: true },
    { to: 'credited', label: 'Credit' },
  ],
  credited: [{ to: 'resolved', label: 'Resolve', primary: true }],
  resolved: [{ to: 'open', label: 'Reopen' }],
  rejected: [{ to: 'open', label: 'Reopen' }],
};
const TOAST: Record<ClaimStatus, string> = {
  open: 'Claim reopened',
  submitted_to_vendor: 'Claim submitted to vendor',
  vendor_acknowledged: 'Claim marked acknowledged',
  replacement_ordered: 'Replacement marked ordered',
  credited: 'Credit recorded',
  resolved: 'Claim resolved',
  rejected: 'Claim rejected',
};
const STEPS: ClaimStatus[] = [
  'open',
  'submitted_to_vendor',
  'vendor_acknowledged',
  'replacement_ordered',
  'resolved',
];
const REPORTER: Record<string, string> = { internal: 'our team', client: 'the owner', vendor: 'the vendor' };

export function Component() {
  const { id = '' } = useParams();
  const s = useSession();
  const canWrite = hasPerm(s, 'claims:write');
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'details';
  const setTab = (t: string) => setParams(t === 'details' ? {} : { tab: t }, { replace: true });
  const projects = useProjectsLite();
  const invalidate = useInvalidateOrders();
  const q = useQuery({
    queryKey: ok.claim(id),
    queryFn: () => api.get<ClaimWithOrgs>('orders', `/claims/${id}`),
  });
  const [action, setAction] = useState<ClaimStatus | null>(null);
  const photoInput = useRef<HTMLInputElement>(null);

  const pdf = useMutation({
    mutationFn: () => api.post<{ id: string }>('orders', `/claims/${id}/report`),
    onSuccess: (d) => window.open(documentUrl(d.id), '_blank', 'noopener'),
  });
  const addPhotos = useMutation({
    mutationFn: async (files: File[]) => {
      const c = q.data!;
      const ids: string[] = [];
      for (const f of files)
        ids.push(
          (
            await uploadDocument(f, {
              entityType: 'claim',
              entityId: c.id,
              kind: 'photo',
              visibility: c.vendorOrgId ? 'vendor' : 'internal',
              vendorOrgId: c.vendorOrgId ?? null,
            })
          ).id,
        );
      return ids;
    },
    onSuccess: (ids) => {
      toast.success(ids.length === 1 ? 'Photo added' : `${ids.length} photos added`);
      invalidate();
    },
    onError: (e) => toast.error(`Upload failed: ${errorMessage(e)}`),
  });
  // Photos uploaded to the claim record after it was opened (claim.photoDocumentIds holds the originals).
  const extra = useQuery({
    queryKey: ['documents', 'claim', id],
    queryFn: () =>
      api.get<{ items: { id: string; contentType: string }[] }>('documents', '/documents', {
        entityType: 'claim',
        entityId: id,
      }),
    select: (d) => d.items.filter((x) => x.contentType.startsWith('image/')).map((x) => x.id),
    meta: { silent: true },
  });

  if (q.isLoading) return <Loading label="Loading claim" />;
  if (q.isError)
    return q.error instanceof ApiError && (q.error.status === 404 || q.error.status === 400) ? (
      <EmptyState
        title="This claim doesn’t exist"
        action={
          <Link to="/app/claims" className="font-[560] text-lacquer hover:underline">
            Back to claims
          </Link>
        }
      />
    ) : (
      <ErrorNote error={q.error} />
    );
  const c = q.data!;
  const project = projects.data?.find((x) => x.id === c.projectId);
  const photos = [...new Set([...c.photoDocumentIds, ...(extra.data ?? [])])];
  const stepAt = c.status === 'credited' ? 3 : STEPS.indexOf(c.status);

  return (
    <div className="px-4 py-4 sm:px-6">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <Link
          to="/app/claims"
          className="inline-flex items-center gap-1 text-[13px] text-ink-2 hover:text-ink"
        >
          <ChevronLeft className="size-4" />
          Claims
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <Button icon={<FileDown className="size-4" />} loading={pdf.isPending} onClick={() => pdf.mutate()}>
            Download claim PDF
          </Button>
          {canWrite &&
            NEXT[c.status].map((a) => (
              <Button
                key={a.to}
                variant={a.primary ? 'primary' : a.danger ? 'danger' : 'secondary'}
                disabled={a.to === 'submitted_to_vendor' && !c.poId}
                title={
                  a.to === 'submitted_to_vendor' && !c.poId
                    ? 'Link the claim to a purchase order first'
                    : undefined
                }
                onClick={() => setAction(a.to)}
              >
                {a.label}
              </Button>
            ))}
        </div>
      </div>

      <TitleBlock
        title={<span className="num">{c.number}</span>}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            {CLAIM_TYPE_LABEL[c.type]}
            <Badge tone={CLAIM_TONE[c.status]}>{CLAIM_STATUS_LABEL[c.status]}</Badge>
          </span>
        }
        fields={[
          {
            label: 'Order',
            value: c.poId ? (
              <Link to={`/app/orders/${c.poId}`} className="num hover:text-lacquer hover:underline">
                {c.poNumber}
              </Link>
            ) : (
              <span className="text-ink-4">Not linked</span>
            ),
          },
          { label: 'Vendor', value: c.vendorName ?? '—' },
          {
            label: 'Project',
            value: (
              <Link
                to={`/app/projects/${c.projectId}`}
                className="hover:text-lacquer hover:underline"
                title={project?.name}
              >
                <span className="num">{project?.number ?? 'Project'}</span>
              </Link>
            ),
          },
          {
            label: 'Reported',
            value: <span title={dateTime(c.reportedAt)}>{date(c.reportedAt)}</span>,
          },
          {
            label: 'Credit',
            value: <span className="num">{c.creditAmount ? money(c.creditAmount) : '—'}</span>,
          },
        ]}
      />

      {c.status !== 'rejected' && (
        <ol
          className="mt-4 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12.5px]"
          aria-label="Claim progress"
        >
          {STEPS.map((st, i) => (
            <li key={st} className="flex items-center gap-1.5">
              {i > 0 && <span className={i <= stepAt ? 'h-px w-5 bg-lacquer' : 'h-px w-5 bg-line'} />}
              <span
                className={
                  i === stepAt ? 'font-[620] text-lacquer' : i < stepAt ? 'text-ink-2' : 'text-ink-4'
                }
              >
                {st === 'replacement_ordered' && c.status === 'credited'
                  ? 'Credited'
                  : CLAIM_STATUS_LABEL[st]}
              </span>
            </li>
          ))}
        </ol>
      )}

      <Tabs
        className="mt-4 border-b border-line"
        value={tab}
        onChange={setTab}
        items={[
          { value: 'details', label: 'Details' },
          { value: 'messages', label: 'Messages' },
          { value: 'activity', label: 'Activity' },
        ]}
      />
      <div className="pt-4">
        {tab === 'details' && (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
            <div className="min-w-0 space-y-4">
              <Section title="What happened">
                <p className="whitespace-pre-wrap">{c.description}</p>
                <p className="mt-2 text-[12.5px] text-ink-3">
                  Reported by {c.reportedByName ?? 'someone'} ({REPORTER[c.reportedByActor]}) on{' '}
                  {dateTime(c.reportedAt)}
                </p>
              </Section>
              <Section title="Items" bodyClassName="">
                {!c.items?.length ? (
                  <p className="px-4 py-3 text-ink-3">No specific items listed.</p>
                ) : (
                  <table className="grid-table">
                    <thead>
                      <tr>
                        <th>Code</th>
                        <th>Item</th>
                        <th className="right">Qty</th>
                        <th>Note</th>
                      </tr>
                    </thead>
                    <tbody>
                      {c.items.map((i, n) => (
                        <tr key={i.id ?? n}>
                          <td className="num whitespace-nowrap text-ink-2">{i.code ?? '—'}</td>
                          <td>{i.name ?? '—'}</td>
                          <td className="right num font-[560]">{i.quantity}</td>
                          <td className="text-[13px] text-ink-2">{i.note}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Section>
              <Section
                title={`Photos${photos.length ? ` · ${photos.length}` : ''}`}
                actions={
                  canWrite && (
                    <>
                      {addPhotos.isPending && <Spinner className="size-4" />}
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<ImagePlus className="size-3.5" />}
                        onClick={() => photoInput.current?.click()}
                      >
                        Add photos
                      </Button>
                      <input
                        ref={photoInput}
                        type="file"
                        accept="image/*"
                        multiple
                        hidden
                        onChange={(e) => {
                          if (e.target.files?.length) addPhotos.mutate([...e.target.files]);
                          e.target.value = '';
                        }}
                      />
                    </>
                  )
                }
              >
                <PhotoGrid
                  ids={photos}
                  empty={
                    <p className="text-ink-3">
                      No photos yet. Photos make vendor claims far quicker to settle.
                    </p>
                  }
                />
              </Section>
            </div>
            <div className="min-w-0 space-y-4">
              <Section title="Resolution">
                {c.resolution ? (
                  <p className="whitespace-pre-wrap">{c.resolution}</p>
                ) : (
                  <p className="text-ink-3">
                    {isClosedClaim(c.status)
                      ? 'Closed without notes.'
                      : 'Not resolved yet. Notes you add when moving the claim forward appear here.'}
                  </p>
                )}
                {c.resolvedAt && (
                  <p className="mt-2 text-[12.5px] text-ink-3">Closed {dateTime(c.resolvedAt)}</p>
                )}
              </Section>
              <Section title="Who sees this claim">
                <ul className="space-y-1.5 text-[13px] text-ink-2">
                  <li>
                    <span className="font-[560] text-ink">Owner:</span>{' '}
                    {c.clientOrgId
                      ? 'sees the claim, its status and their message thread.'
                      : 'no owner on this project.'}
                  </li>
                  <li>
                    <span className="font-[560] text-ink">Vendor:</span>{' '}
                    {!c.vendorOrgId
                      ? 'not on the vendor portal; submitting emails them.'
                      : c.status === 'open'
                        ? 'sees it once you submit it to them.'
                        : 'can see it and respond in their portal.'}
                  </li>
                </ul>
              </Section>
            </div>
          </div>
        )}
        {tab === 'messages' && (
          <div className="grid gap-4 xl:grid-cols-3 lg:grid-cols-2">
            <Section title="Team" className="min-w-0">
              <ThreadPanel
                entityType="claim"
                entityId={c.id}
                visibility="internal"
                emptyHint="Internal notes. Owners and vendors never see these."
              />
            </Section>
            {c.clientOrgId && (
              <Section title="Owner" className="min-w-0">
                <ThreadPanel
                  entityType="claim"
                  entityId={c.id}
                  visibility="client"
                  clientOrgId={c.clientOrgId}
                  allowEmail
                  emptyHint="The owner sees these messages on the claim in their portal."
                />
              </Section>
            )}
            {c.vendorOrgId && (
              <Section title={`Vendor · ${c.vendorName}`} className="min-w-0">
                <ThreadPanel
                  entityType="claim"
                  entityId={c.id}
                  visibility="vendor"
                  vendorOrgId={c.vendorOrgId}
                  allowEmail
                  emptyHint={
                    c.status === 'open'
                      ? 'The vendor sees this thread once the claim is submitted to them.'
                      : 'The vendor sees these messages on the claim in their portal.'
                  }
                />
              </Section>
            )}
          </div>
        )}
        {tab === 'activity' && (
          <Section title="Activity">
            <ActivityFeed service="orders" path={`/claims/${c.id}/activity`} />
          </Section>
        )}
      </div>
      <TransitionDialog claim={c} to={action} onClose={() => setAction(null)} />
    </div>
  );
}

function TransitionDialog({
  claim,
  to,
  onClose,
}: {
  claim: Claim;
  to: ClaimStatus | null;
  onClose: () => void;
}) {
  const invalidate = useInvalidateOrders();
  const [notes, setNotes] = useState('');
  const [credit, setCredit] = useState('');
  const m = useMutation({
    mutationFn: () =>
      api.patch('orders', `/claims/${claim.id}`, {
        status: to,
        ...(notes.trim() ? { resolution: notes.trim() } : {}),
        ...(to === 'credited' ? { creditAmount: Number(credit) } : {}),
      }),
    onSuccess: () => {
      toast.success(
        TOAST[to!],
        to === 'submitted_to_vendor'
          ? { description: `${claim.vendorName} was emailed the claim.` }
          : undefined,
      );
      setNotes('');
      setCredit('');
      invalidate();
      onClose();
    },
  });
  if (!to) return null;
  const label = NEXT[claim.status].find((a) => a.to === to)?.label ?? 'Update claim';
  const creditOk = to !== 'credited' || Number(credit) > 0;
  return (
    <Dialog
      open
      onClose={onClose}
      title={`${label}: ${claim.number}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={to === 'rejected' ? 'danger' : 'primary'}
            loading={m.isPending}
            disabled={!creditOk}
            onClick={() => m.mutate()}
          >
            {label}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {to === 'submitted_to_vendor' && (
          <p className="text-ink-2">
            {claim.vendorName} gets an email with the description, items and a link to respond in their
            portal.
          </p>
        )}
        {to === 'credited' && (
          <Field label="Credit amount">
            {(id) => (
              <Input
                id={id}
                type="number"
                min={0}
                step="0.01"
                value={credit}
                onChange={(e) => setCredit(e.target.value)}
                placeholder="0.00"
              />
            )}
          </Field>
        )}
        <Field
          label={to === 'submitted_to_vendor' ? 'Note (optional)' : 'Resolution notes'}
          hint="Saved on the claim. The owner sees resolution notes in their portal."
        >
          {(id) => (
            <Textarea
              id={id}
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={
                to === 'replacement_ordered'
                  ? 'e.g. Replacement headboards ship with shipment B on Oct 31.'
                  : undefined
              }
            />
          )}
        </Field>
      </div>
    </Dialog>
  );
}
