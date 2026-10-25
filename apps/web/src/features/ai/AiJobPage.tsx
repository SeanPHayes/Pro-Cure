import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertOctagon, Ban, EyeOff, FileText, Loader2, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { toast } from 'sonner';
import { Button, Dialog, ErrorNote, Loading, PageHeader, StatusBadge, TitleBlock } from '@/components/ui';
import { api, documentUrl } from '@/lib/api';
import { ago, count, dateTime } from '@/lib/format';
import { Crumb } from '../catalog/shared';
import { BrandSpecReview } from './review/BrandSpecReview';
import { Banner } from './review/common';
import { DrawingSplitReview, InboxReview, RiskReview } from './review/OtherReviews';
import { VendorQuoteReview } from './review/VendorQuoteReview';
import {
  aiKeys,
  duration,
  isActive,
  JOB_STATE_LABEL,
  type Job,
  jobErrorText,
  jobState,
  KIND_LABEL,
  ModeBanner,
  useCapabilities,
} from './shared';

const REVIEWABLE = new Set(['brand_spec_extract', 'vendor_quote_extract', 'drawing_split']);

export function Component() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const caps = useCapabilities();
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const job = useQuery({
    queryKey: aiKeys.job(id),
    queryFn: () => api.get<Job>('ai', `/jobs/${id}`),
    refetchInterval: (q) => (q.state.data && isActive(q.state.data.status) ? 1500 : false),
  });
  const refresh = (j: Job) => {
    qc.setQueryData(aiKeys.job(id), j);
    qc.invalidateQueries({ queryKey: ['ai', 'jobs'] });
  };
  const retry = useMutation({
    mutationFn: () => api.post<Job>('ai', `/jobs/${id}/retry`),
    onSuccess: (j) => {
      refresh(j);
      toast.success('Reading again');
    },
  });
  const discard = useMutation({
    mutationFn: () => api.post<Job>('ai', `/jobs/${id}/discard`),
    onSuccess: (j) => {
      refresh(j);
      setConfirmDiscard(false);
      toast.success('Result discarded');
    },
  });

  if (job.isLoading) return <Loading label="Loading AI job" />;
  if (job.isError || !job.data)
    return (
      <>
        <PageHeader title="AI job" />
        <ErrorNote error={job.error ?? new Error('This job could not be found.')} />
      </>
    );
  const j = job.data;
  const st = jobState(j);
  const documentId = j.input.documentId as string | undefined;
  const reviewing = j.status === 'needs_review' && !j.discardedAt;
  const readOnly = !reviewing;
  const canRetry = (j.status === 'failed' || (reviewing && !j.applyResult)) && !j.discardedAt;
  const canDiscard = reviewing;
  const tokens = j.inputTokens + j.outputTokens;

  return (
    <>
      <div className="border-b border-line bg-paper px-6 pt-4 pb-5 max-sm:px-4">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
          <Crumb to="/app/ai">AI assistant</Crumb>
          <div className="flex flex-wrap items-center gap-2">
            {documentId && (
              <a
                href={documentUrl(documentId)}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-9 items-center gap-2 rounded-sm px-3 font-[560] text-ink-2 hover:bg-stone-2 hover:text-ink"
              >
                <FileText className="size-4" />
                Source document
              </a>
            )}
            {canRetry && REVIEWABLE.has(j.kind) && (
              <Button
                icon={<RotateCcw className="size-4" />}
                loading={retry.isPending}
                onClick={() => retry.mutate()}
              >
                {j.status === 'failed' ? 'Retry' : 'Read again'}
              </Button>
            )}
            {canDiscard && REVIEWABLE.has(j.kind) && (
              <Button
                variant="danger"
                icon={<Ban className="size-4" />}
                onClick={() => setConfirmDiscard(true)}
              >
                Discard result
              </Button>
            )}
          </div>
        </div>
        <TitleBlock
          title={KIND_LABEL[j.kind]}
          subtitle={j.title}
          fields={[
            {
              label: 'Status',
              value: (
                <span className="inline-flex items-center gap-1.5">
                  {isActive(j.status) && <Loader2 className="size-3.5 animate-spin text-info" />}
                  <StatusBadge status={st === 'discarded' ? 'cancelled' : st} label={JOB_STATE_LABEL[st]} />
                </span>
              ),
            },
            {
              label: 'Read by',
              value:
                j.provider === 'heuristic' || !j.provider
                  ? j.kind === 'risk_score'
                    ? 'Statistical risk model'
                    : 'Rule-based parser'
                  : (j.model ?? j.provider),
            },
            {
              label: 'Pages · tokens',
              value: (
                <span className="num">
                  {j.pages ?? '—'} · {tokens ? count(tokens) : 'none'}
                </span>
              ),
            },
            { label: 'Duration', value: <span className="num">{duration(j.durationMs) ?? '—'}</span> },
            {
              label: 'Started by',
              value: (
                <span title={dateTime(j.createdAt)}>
                  {j.createdByName ?? 'Pro-Cure'} · {ago(j.createdAt)}
                </span>
              ),
            },
          ]}
        />
      </div>

      <div className="space-y-5 px-6 py-5 max-sm:px-4">
        {(j.provider === 'heuristic' || caps.data?.mode === 'heuristic') &&
          REVIEWABLE.has(j.kind) &&
          reviewing && <ModeBanner caps={caps.data} compact />}

        {isActive(j.status) ? (
          <Banner
            tone="info"
            icon={<Loader2 className="animate-spin" />}
            title={j.status === 'queued' ? 'Waiting to start' : 'Reading the document'}
          >
            This usually takes a few seconds. The page updates by itself — you can leave and come back.
          </Banner>
        ) : j.status === 'failed' ? (
          <Banner
            tone="crit"
            icon={<AlertOctagon />}
            title="This job failed"
            actions={
              REVIEWABLE.has(j.kind) && (
                <Button
                  size="sm"
                  icon={<RotateCcw className="size-4" />}
                  loading={retry.isPending}
                  onClick={() => retry.mutate()}
                >
                  Retry
                </Button>
              )
            }
          >
            {jobErrorText(j)}
            {j.attempts > 1 && ` (after ${j.attempts} attempts)`}
          </Banner>
        ) : j.discardedAt ? (
          <Banner
            tone="neutral"
            icon={<Ban />}
            title={`Discarded by ${j.discardedByName ?? 'someone'} ${ago(j.discardedAt)}`}
          >
            Nothing from this job was applied.
          </Banner>
        ) : null}

        {j.outputRedacted ? (
          <Banner tone="neutral" icon={<EyeOff />} title="This result contains vendor costs">
            Only people who can see costs can review it. Ask a procurement manager to review and apply it.
          </Banner>
        ) : j.output ? (
          <>
            {j.kind === 'brand_spec_extract' && (
              <BrandSpecReview key={j.id + j.status} job={j} readOnly={readOnly} />
            )}
            {j.kind === 'vendor_quote_extract' && (
              <VendorQuoteReview key={j.id + j.status} job={j} readOnly={readOnly} />
            )}
            {j.kind === 'drawing_split' && (
              <DrawingSplitReview key={j.id + j.status} job={j} readOnly={readOnly} />
            )}
            {j.kind === 'inbox_route' && <InboxReview job={j} />}
            {j.kind === 'risk_score' && <RiskReview job={j} />}
          </>
        ) : null}

        {j.kind === 'inbox_route' && !j.output && !isActive(j.status) && (
          <p className="text-ink-3">
            No routing result.{' '}
            <Link to="/app/inbox" className="font-[560] text-lacquer hover:underline">
              Open the inbox
            </Link>
          </p>
        )}
      </div>

      <Dialog
        open={confirmDiscard}
        onClose={() => setConfirmDiscard(false)}
        title="Discard this result?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDiscard(false)}>
              Cancel
            </Button>
            <Button variant="danger" loading={discard.isPending} onClick={() => discard.mutate()}>
              Discard result
            </Button>
          </>
        }
      >
        <p className="text-ink-2">
          Nothing is applied and the job can’t be reviewed again. The uploaded document is kept.
        </p>
      </Dialog>
    </>
  );
}
