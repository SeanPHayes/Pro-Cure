import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpRight, FileSearch, Inbox, Play, Scissors, ShieldAlert, Sparkles } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';
import {
  Button,
  cx,
  EmptyState,
  ErrorNote,
  PageHeader,
  Section,
  Select,
  Spinner,
  StatusBadge,
} from '@/components/ui';
import { type Column, DataTable, Pagination } from '@/components/ui/DataTable';
import { api, type Page } from '@/lib/api';
import { hasPerm, useSession } from '@/lib/auth';
import { ago, count, dateTime, humanize } from '@/lib/format';
import { useListParams } from '@/lib/hooks';
import { friendlyError } from '../catalog/shared';
import { BrandSpecImportSheet } from './BrandSpecImportSheet';
import {
  aiKeys,
  duration,
  isActive,
  JOB_KINDS,
  JOB_STATE_LABEL,
  type Job,
  type JobSummary,
  jobErrorText,
  jobState,
  KIND_LABEL,
  ModeBanner,
  type RiskSummary,
  useCapabilities,
} from './shared';
import { DrawingSplitSheet, VendorQuoteSheet } from './ToolSheets';

const DEFAULTS = { kind: '', status: '', limit: '25' };

const STATUS_FILTERS = [
  { value: '', label: 'Any status' },
  { value: 'needs_review', label: 'Ready for review' },
  { value: 'queued,running', label: 'In progress' },
  { value: 'failed', label: 'Failed' },
  { value: 'applied', label: 'Applied' },
  { value: 'completed', label: 'Completed or discarded' },
];

export function Component() {
  const s = useSession();
  const nav = useNavigate();
  const caps = useCapabilities();
  const [p, set] = useListParams(DEFAULTS);
  const [tool, setTool] = useState<'brand' | 'quote' | 'split' | null>(null);
  const query = {
    kind: p.kind || undefined,
    status: p.status || undefined,
    limit: Number(p.limit),
    offset: Number(p.offset),
  };
  const jobs = useQuery({
    queryKey: aiKeys.jobs(query),
    queryFn: () => api.get<Page<JobSummary>>('ai', '/jobs', query),
    placeholderData: keepPreviousData,
    refetchInterval: (q) => (q.state.data?.items.some((j) => isActive(j.status)) ? 2500 : false),
  });
  const reviewCount = useQuery({
    queryKey: aiKeys.jobs({ status: 'needs_review', limit: 1 }),
    queryFn: () => api.get<Page<JobSummary>>('ai', '/jobs', { status: 'needs_review', limit: 1 }),
    select: (d) => d.total,
  });
  const inboxJobs = useQuery({
    queryKey: aiKeys.jobs({ kind: 'inbox_route', limit: 4 }),
    queryFn: () => api.get<Page<JobSummary>>('ai', '/jobs', { kind: 'inbox_route', limit: 4 }),
    select: (d) => d.items,
  });

  const canSpecs = hasPerm(s, 'catalog:contribute') || hasPerm(s, 'specs:write');
  const canQuote = hasPerm(s, 'quotes:costs:read');
  const canSplit = hasPerm(s, 'specs:write');
  const canInbox = hasPerm(s, 'inbox:triage');
  const canRisk = hasPerm(s, 'orders:read');
  const filtered = !!(p.kind || p.status);

  const columns: Column<JobSummary>[] = [
    {
      key: 'title',
      header: 'Job',
      cell: (r) => (
        <div className="min-w-[240px]">
          <Link
            to={`/app/ai/jobs/${r.id}`}
            onClick={(e) => e.stopPropagation()}
            className="font-[560] hover:text-lacquer"
          >
            {summaryTitle(r)}
          </Link>
          <div className="text-[12px] text-ink-3">{KIND_LABEL[r.kind]}</div>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (r) => {
        const st = jobState(r);
        return (
          <span className="inline-flex items-center gap-1.5">
            {isActive(r.status) && <Spinner className="size-3.5" />}
            <StatusBadge status={st === 'discarded' ? 'cancelled' : st} label={JOB_STATE_LABEL[st]} />
          </span>
        );
      },
    },
    {
      key: 'result',
      header: 'Result',
      cell: (r) => <span className="whitespace-nowrap text-ink-2">{summaryResult(r)}</span>,
    },
    {
      key: 'by',
      header: 'Started by',
      cell: (r) => <span className="whitespace-nowrap">{r.createdByName ?? 'Pro-Cure'}</span>,
    },
    {
      key: 'when',
      header: 'Started',
      cell: (r) => (
        <time className="whitespace-nowrap text-ink-2" title={dateTime(r.createdAt)}>
          {ago(r.createdAt)}
        </time>
      ),
    },
    {
      key: 'dur',
      header: 'Duration',
      align: 'right',
      cell: (r) => <span className="text-ink-2">{duration(r.durationMs) ?? '—'}</span>,
    },
  ];

  return (
    <>
      <PageHeader
        title="AI assistant"
        description="Pro-Cure reads the documents that slow procurement down. Every result is a job you review; nothing changes until you apply it."
      >
        <div className="mt-4 max-w-[980px]">
          <ModeBanner caps={caps.data} />
        </div>
      </PageHeader>

      <div className="space-y-6 px-6 py-5 max-sm:px-4">
        <div className="grid gap-px overflow-hidden rounded-md border border-line bg-line sm:grid-cols-2 xl:grid-cols-4">
          <Tool
            icon={<FileSearch />}
            title="Read a brand-spec PDF"
            body="Turn a brand’s FF&E standard into structured items with codes, dimensions, finishes and approved vendors."
            action={canSpecs ? 'Choose PDF' : undefined}
            onAction={() => setTool('brand')}
            missing="Needs catalog or spec library access"
          />
          <Tool
            icon={<Sparkles />}
            title="Read a vendor quote PDF"
            body="Match a vendor’s PDF quote to your pricing request and pick up unit costs, lead times and expiry dates."
            action={canQuote ? 'Choose quote' : undefined}
            onAction={() => setTool('quote')}
            missing="Needs access to vendor costs"
          />
          <Tool
            icon={<Scissors />}
            title="Split a drawing packet"
            body="Break one PDF of vendor line drawings into a drawing per spec, ready for the spec book."
            action={canSplit ? 'Choose packet' : undefined}
            onAction={() => setTool('split')}
            missing="Needs spec library access"
          />
          <Tool
            icon={<Inbox />}
            title="Inbox routing"
            body="Vendor emails are read as they arrive and filed to the right purchase order with suggested updates."
            action={canInbox ? 'Open inbox' : undefined}
            onAction={() => nav('/app/inbox')}
            missing="Needs inbox access"
            footer={<InboxRecent jobs={inboxJobs.data} />}
          />
        </div>

        {canRisk && <RiskPanel />}

        <Section
          title={
            <span className="inline-flex items-center gap-2">
              Jobs
              {!!reviewCount.data && (
                <button
                  type="button"
                  onClick={() => set({ status: 'needs_review', kind: '' })}
                  className="rounded-xs bg-brass-50 px-1.5 text-[12px] font-[560] text-brass hover:bg-brass-100"
                >
                  {reviewCount.data} ready for review
                </button>
              )}
            </span>
          }
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <div className="w-[190px]">
                <Select
                  aria-label="Kind"
                  value={p.kind}
                  onChange={(e) => set({ kind: e.target.value })}
                  placeholder="Every tool"
                  options={JOB_KINDS.map((k) => ({ value: k, label: KIND_LABEL[k] }))}
                />
              </div>
              <div className="w-[190px]">
                <Select
                  aria-label="Status"
                  value={p.status}
                  onChange={(e) => set({ status: e.target.value })}
                  options={STATUS_FILTERS}
                />
              </div>
            </div>
          }
          bodyClassName="p-0"
        >
          {jobs.isError ? (
            <ErrorNote error={jobs.error} />
          ) : (
            <DataTable
              columns={columns}
              rows={jobs.data?.items}
              loading={jobs.isLoading}
              onRowClick={(r) => nav(`/app/ai/jobs/${r.id}`)}
              empty={
                filtered ? (
                  <EmptyState title="No jobs match these filters">
                    Clear the filters to see every job.
                  </EmptyState>
                ) : (
                  <EmptyState icon={<Sparkles />} title="No AI jobs yet">
                    Start with a brand-spec PDF or a vendor quote above. Each run appears here for review.
                  </EmptyState>
                )
              }
              footer={
                jobs.data && (
                  <Pagination
                    total={jobs.data.total}
                    limit={jobs.data.limit}
                    offset={jobs.data.offset}
                    onChange={(o) => set({ offset: String(o) })}
                  />
                )
              }
            />
          )}
        </Section>
      </div>

      <BrandSpecImportSheet open={tool === 'brand'} onClose={() => setTool(null)} />
      <VendorQuoteSheet open={tool === 'quote'} onClose={() => setTool(null)} />
      <DrawingSplitSheet open={tool === 'split'} onClose={() => setTool(null)} />
    </>
  );
}

function Tool({
  icon,
  title,
  body,
  action,
  onAction,
  missing,
  footer,
}: {
  icon: ReactNode;
  title: string;
  body: string;
  action?: string;
  onAction: () => void;
  missing: string;
  footer?: ReactNode;
}) {
  return (
    <div className="flex flex-col bg-paper p-4">
      <div className="mb-2 flex items-center gap-2">
        <span className="grid size-7 place-items-center rounded-sm bg-lacquer-50 text-lacquer [&>svg]:size-4">
          {icon}
        </span>
        <h3 className="font-[620]">{title}</h3>
      </div>
      <p className="flex-1 text-[13px] text-ink-2">{body}</p>
      {footer}
      <div className="mt-3">
        {action ? (
          <Button size="sm" onClick={onAction}>
            {action}
          </Button>
        ) : (
          <span className="text-[12px] text-ink-3">{missing}</span>
        )}
      </div>
    </div>
  );
}

function InboxRecent({ jobs }: { jobs: JobSummary[] | undefined }) {
  if (!jobs?.length) return null;
  return (
    <ul className="mt-3 space-y-1 border-t border-line-2 pt-2 text-[12px]">
      {jobs.slice(0, 3).map((j) => (
        <li key={j.id}>
          <Link to={`/app/ai/jobs/${j.id}`} className="flex justify-between gap-2 hover:text-lacquer">
            <span className="truncate">{summaryResult(j)}</span>
            <span className="shrink-0 text-ink-3">{ago(j.createdAt)}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

const LEVELS: { key: keyof RiskSummary['counts']; label: string; tone: string }[] = [
  { key: 'critical', label: 'Critical', tone: 'text-crit' },
  { key: 'at_risk', label: 'At risk', tone: 'text-risk' },
  { key: 'watch', label: 'Watch', tone: 'text-warn' },
  { key: 'none', label: 'On track', tone: 'text-ok' },
];

function RiskPanel() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const [runningId, setRunningId] = useState<string | null>(null);
  const risk = useQuery({
    queryKey: aiKeys.risk,
    queryFn: () => api.get<RiskSummary>('ai', '/risk/summary'),
  });
  // Poll the on-demand job until it finishes, then refresh the summary.
  const job = useQuery({
    queryKey: aiKeys.job(runningId ?? ''),
    queryFn: () => api.get<Job>('ai', `/jobs/${runningId}`),
    enabled: !!runningId,
    refetchInterval: (q) => (q.state.data && !isActive(q.state.data.status) ? false : 1500),
  });
  const finished = job.data && !isActive(job.data.status) ? job.data : null;
  useEffect(() => {
    if (!runningId || !finished) return;
    setRunningId(null);
    qc.invalidateQueries({ queryKey: aiKeys.risk });
    qc.invalidateQueries({ queryKey: ['ai', 'jobs'] });
    if (finished.status === 'failed')
      toast.error('Delivery risk run failed', {
        description: /ECONNREFUSED|fetch failed|unavailable/i.test(finished.error ?? '')
          ? 'Purchase orders are unavailable right now, so shipments couldn’t be scored. Try again in a few minutes.'
          : (finished.error ?? undefined),
      });
    else toast.success('Delivery risk updated');
  }, [runningId, finished, qc]);
  const lastJob = useQuery({
    queryKey: aiKeys.jobs({ kind: 'risk_score', limit: 1 }),
    queryFn: () => api.get<Page<JobSummary>>('ai', '/jobs', { kind: 'risk_score', limit: 1 }),
    select: (d) => d.items[0],
  });
  const lastFailed = lastJob.data?.status === 'failed' ? lastJob.data : null;
  const run = useMutation({
    mutationFn: () => api.post<Job>('ai', '/jobs/risk-score', {}),
    onSuccess: (j) => setRunningId(j.id),
  });
  const r = risk.data;
  const busy = run.isPending || !!runningId;
  return (
    <Section
      title={
        <span className="inline-flex items-center gap-2">
          <ShieldAlert className="size-4 text-ink-3" /> Delivery risk
        </span>
      }
      actions={
        <>
          {r?.run && (
            <span className="hidden text-[12px] text-ink-3 sm:inline">Scored {ago(r.run.runAt)}</span>
          )}
          <Button size="sm" icon={<Play className="size-3.5" />} loading={busy} onClick={() => run.mutate()}>
            {busy ? 'Scoring shipments' : 'Run now'}
          </Button>
        </>
      }
    >
      {risk.isLoading ? (
        <div className="flex justify-center py-6">
          <Spinner />
        </div>
      ) : risk.isError ? (
        <p className="text-crit">{friendlyError(risk.error, 'Delivery risk')}</p>
      ) : !r?.run ? (
        <>
          {lastFailed && !busy && (
            <p
              role="alert"
              className="mb-1 rounded-sm border border-crit/25 bg-crit-50 px-3 py-2 text-[13px] text-crit"
            >
              The last run {ago(lastFailed.createdAt)} failed: {jobErrorText(lastFailed)}
            </p>
          )}
          <EmptyState title="Delivery risk hasn’t been scored yet">
            Pro-Cure predicts which open shipments will arrive late from each vendor’s track record, lead
            times and ship-date changes. It runs every night; run it now to see today’s picture.
          </EmptyState>
        </>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
          <div>
            <div className="grid grid-cols-4 gap-px overflow-hidden rounded-sm border border-line bg-line">
              {LEVELS.map((l) => (
                <div key={l.key} className="bg-paper px-3 py-2.5">
                  <div className="text-[12px] text-ink-3">{l.label}</div>
                  <div className={cx('num text-[22px] font-[620]', r.counts[l.key] ? l.tone : 'text-ink-4')}>
                    {count(r.counts[l.key])}
                  </div>
                </div>
              ))}
            </div>
            {r.narrative && <p className="mt-3 text-[13px] whitespace-pre-line text-ink-2">{r.narrative}</p>}
            <p className="mt-2 text-[12px] text-ink-3">
              {r.run.shipmentsScored} open shipments across {r.run.vendorsProfiled} vendors.{' '}
              <Link to="/app/shipments" className="font-[560] text-lacquer hover:underline">
                Open shipments
              </Link>
            </p>
          </div>
          <div>
            <h3 className="mb-1.5 text-[13px] font-[620] text-ink-2">Riskiest shipments</h3>
            {!r.top.filter((t) => t.level !== 'none').length ? (
              <p className="text-ink-3">No shipment is at risk right now.</p>
            ) : (
              <ul className="divide-y divide-line-2 rounded-sm border border-line">
                {r.top
                  .filter((t) => t.level !== 'none')
                  .slice(0, 6)
                  .map((t) => (
                    <li key={t.shipmentId}>
                      <button
                        type="button"
                        disabled={!t.poId}
                        onClick={() => t.poId && nav(`/app/orders/${t.poId}`)}
                        className="flex w-full items-start gap-3 px-3 py-2 text-left hover:bg-stone disabled:cursor-default"
                      >
                        <StatusBadge status={t.level} />
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-[560]">
                            {[t.poNumber, t.vendorName].filter(Boolean).join(' · ') || t.label}
                          </div>
                          <div className="truncate text-[12px] text-ink-3">
                            {[t.projectName, ...t.reasons.slice(0, 2)].filter(Boolean).join(' · ')}
                          </div>
                        </div>
                        <span className="num text-[12px] text-ink-3">{Math.round(t.score)}</span>
                        {t.poId && <ArrowUpRight className="size-4 shrink-0 text-ink-4" />}
                      </button>
                    </li>
                  ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </Section>
  );
}

// ------------------------------------------------------------------ list row text
function summaryTitle(j: JobSummary) {
  // biome-ignore lint/suspicious/noExplicitAny: per-kind summary shape is computed in SQL
  const s = j.summary as Record<string, any>;
  if (j.kind === 'brand_spec_extract' && s.standard) return String(s.standard);
  if (j.kind === 'vendor_quote_extract' && s.costRequest) return `Vendor quote for ${s.costRequest}`;
  return j.title;
}

function summaryResult(j: JobSummary): string {
  // biome-ignore lint/suspicious/noExplicitAny: per-kind summary shape is computed in SQL
  const s = j.summary as Record<string, any>;
  if (j.status === 'failed') return jobErrorText(j, true).slice(0, 70);
  if (isActive(j.status)) return j.status === 'queued' ? 'Waiting to start' : 'Reading…';
  switch (j.kind) {
    case 'brand_spec_extract':
      return `${s.items ?? 0} items${s.warnings ? ` · ${s.warnings} warnings` : ''}`;
    case 'vendor_quote_extract':
      return `${s.matches ?? 0} matched${s.unmatched ? ` · ${s.unmatched} unmatched` : ''}`;
    case 'drawing_split':
      return `${s.groups ?? 0} drawings${s.unassignedPages ? ` · ${s.unassignedPages} pages unassigned` : ''}`;
    case 'inbox_route':
      return `${humanize(s.intent)}${s.poNumber ? ` → ${s.poNumber}` : ''}${s.routed ? '' : ' · needs a person'}`;
    case 'risk_score': {
      const c = s.counts ?? {};
      return `${s.scored ?? 0} shipments · ${(c.critical ?? 0) + (c.at_risk ?? c.atRisk ?? 0)} at risk`;
    }
    default:
      return '—';
  }
}
