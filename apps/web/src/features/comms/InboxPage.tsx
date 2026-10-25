import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Check,
  CircleAlert,
  Download,
  EyeOff,
  FileText,
  FolderInput,
  Inbox,
  Mail,
  MailCheck,
  Paperclip,
  RefreshCw,
  Sparkles,
} from 'lucide-react';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { SandboxedHtml } from '@/components/shared/SandboxedHtml';
import {
  Avatar,
  Badge,
  Button,
  Chips,
  cx,
  Dialog,
  EmptyState,
  ErrorNote,
  Facts,
  Loading,
  PageHeader,
  SearchInput,
  Spinner,
  StatusBadge,
  Tabs,
} from '@/components/ui';
import { api, documentUrl, errorMessage, type Page } from '@/lib/api';
import { hasPerm, useSession } from '@/lib/auth';
import { ago, dateTime, money } from '@/lib/format';
import { useDebounced } from '@/lib/hooks';
import { RouteSheet } from './RouteSheet';
import { SimulateSheet } from './SimulateSheet';
import {
  aiState,
  ConfidenceBar,
  ENTITY_LABEL,
  entityPath,
  fileSize,
  type InboundCounts,
  type InboundEmail,
  type InboundListItem,
  inboxKeys,
  intentLabel,
  isRouteSuggestion,
  METHOD_LABEL,
  type RouteJob,
  type RouteJobSummary,
  STATUS_LABEL,
  type Suggestion,
  senderName,
  shortTime,
  useInboundConfig,
} from './shared';

type View = 'review' | 'routed' | 'ignored' | 'all';
const VIEW_STATUS: Record<View, string | undefined> = {
  review: 'pending,needs_review',
  routed: 'routed',
  ignored: 'ignored',
  all: undefined,
};

export function Component() {
  const s = useSession();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const view = (params.get('view') as View) || 'review';
  const selectedId = params.get('id');
  const [text, setText] = useState(params.get('q') ?? '');
  const q = useDebounced(text.trim());
  const [simulating, setSimulating] = useState(false);
  const cfg = useInboundConfig();
  const canAi = hasPerm(s, 'ai:use');

  const setParam = (patch: Record<string, string | null>) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(patch)) {
          if (v) next.set(k, v);
          else next.delete(k);
        }
        return next;
      },
      { replace: true },
    );
  // biome-ignore lint/correctness/useExhaustiveDependencies: sync the URL only when the debounced search changes
  useEffect(() => {
    if ((params.get('q') ?? '') !== q) setParam({ q: q || null });
  }, [q]);

  const query = { status: VIEW_STATUS[view], q: q || undefined, limit: 100 };
  const list = useQuery({
    queryKey: inboxKeys.list(query),
    queryFn: () => api.get<Page<InboundListItem>>('comms', '/inbound', query),
    placeholderData: keepPreviousData,
    refetchInterval: (qq) => (qq.state.data?.items.some((i) => i.status === 'pending') ? 3_000 : 20_000),
  });
  const counts = useQuery({
    queryKey: inboxKeys.counts,
    queryFn: () => api.get<InboundCounts>('comms', '/inbound/counts'),
    refetchInterval: 20_000,
    meta: { silent: true },
  });
  // AI routing summaries (intent, PO, confidence) for the list, keyed by inbound email id.
  const jobs = useQuery({
    queryKey: inboxKeys.jobs,
    queryFn: () =>
      api.get<Page<RouteJobSummary>>('ai', '/jobs', {
        kind: 'inbox_route',
        entityType: 'inbound_email',
        limit: 200,
      }),
    enabled: canAi,
    refetchInterval: 20_000,
    meta: { silent: true },
    retry: false,
  });
  const jobFor = new Map<string, RouteJobSummary>();
  for (const j of jobs.data?.items ?? [])
    if (j.entityId && !jobFor.has(j.entityId)) jobFor.set(j.entityId, j);

  const items = list.data?.items ?? [];
  const c = counts.data;

  const select = (id: string | null) => setParam({ id });
  const listRef = useRef<HTMLDivElement>(null);
  const onListKey = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const idx = items.findIndex((i) => i.id === selectedId);
    const next = items[Math.max(0, Math.min(items.length - 1, idx + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (next) {
      select(next.id);
      listRef.current?.querySelector<HTMLElement>(`[data-id="${next.id}"]`)?.focus();
    }
  };

  return (
    <div className="flex flex-col lg:h-[calc(100dvh-3.5rem)]">
      <PageHeader
        title="Inbox"
        description={
          <span className={cx(selectedId && 'hidden lg:inline')}>
            Vendor email sent to your purchasing mailbox. Pro-Cure files what it can match to a purchase order
            or thread; anything it isn’t sure about waits here for you.
          </span>
        }
        actions={
          cfg.data?.simulatorEnabled && (
            <Button
              size="sm"
              variant="ghost"
              icon={<Mail className="size-4" />}
              onClick={() => setSimulating(true)}
            >
              Simulate an email
            </Button>
          )
        }
      >
        <div className={cx('mt-4 flex-wrap items-center gap-3', selectedId ? 'hidden lg:flex' : 'flex')}>
          <div className="max-w-full overflow-x-auto">
            <Chips<View>
              value={view}
              onChange={(v) => setParam({ view: v === 'review' ? null : v, id: null })}
              options={[
                { value: 'review', label: 'Needs review', count: c ? c.pending + c.needs_review : undefined },
                { value: 'routed', label: 'Filed', count: c?.routed },
                { value: 'ignored', label: 'Ignored', count: c?.ignored },
                { value: 'all', label: 'All', count: c?.total },
              ]}
            />
          </div>
          <SearchInput
            value={text}
            onChange={setText}
            placeholder="Search sender, subject or text"
            className="w-full sm:w-[300px]"
          />
        </div>
      </PageHeader>

      <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(340px,420px)_1fr]">
        {/* ------------------------------------------------ list */}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: arrow-key navigation between the row buttons inside */}
        <div
          ref={listRef}
          onKeyDown={onListKey}
          className={cx(
            'min-h-0 overflow-y-auto border-line bg-paper lg:border-r',
            selectedId && 'hidden lg:block',
          )}
        >
          {list.isError ? (
            <ErrorNote error={list.error} />
          ) : list.isLoading ? (
            <Loading label="Loading inbox" />
          ) : !items.length ? (
            <InboxEmpty
              view={view}
              filtered={!!q}
              onSimulate={cfg.data?.simulatorEnabled ? () => setSimulating(true) : undefined}
            />
          ) : (
            <ul aria-label="Inbound emails">
              {items.map((e) => (
                <li key={e.id}>
                  <Row
                    email={e}
                    job={jobFor.get(e.id)}
                    jobsLoaded={!canAi || jobs.isSuccess}
                    active={e.id === selectedId}
                    onSelect={() => select(e.id)}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* ------------------------------------------------ detail */}
        <div className={cx('min-h-0 overflow-y-auto', !selectedId && 'hidden lg:block')}>
          {selectedId ? (
            <Detail
              key={selectedId}
              id={selectedId}
              onBack={() => select(null)}
              onChanged={() => {
                qc.invalidateQueries({ queryKey: inboxKeys.all });
              }}
            />
          ) : (
            <EmptyState icon={<Mail />} title="Select an email">
              {items.length
                ? 'Pick an email on the left to see what the AI read, where it suggests filing it, and the original message.'
                : 'When vendors write in, their emails show up on the left.'}
            </EmptyState>
          )}
        </div>
      </div>

      <SimulateSheet
        open={simulating}
        onClose={() => setSimulating(false)}
        onSent={(id) => {
          setSimulating(false);
          qc.invalidateQueries({ queryKey: inboxKeys.all });
          setParam({ id, view: null });
        }}
      />
    </div>
  );
}

function InboxEmpty({
  view,
  filtered,
  onSimulate,
}: {
  view: View;
  filtered: boolean;
  onSimulate?: () => void;
}) {
  if (filtered)
    return (
      <EmptyState icon={<Inbox />} title="No emails match your search">
        Try the sender’s address, a PO number, or a word from the subject.
      </EmptyState>
    );
  if (view === 'review')
    return (
      <EmptyState
        icon={<MailCheck />}
        title="Nothing waiting for review"
        action={
          onSimulate && (
            <Button size="sm" onClick={onSimulate} icon={<Mail className="size-4" />}>
              Simulate an email
            </Button>
          )
        }
      >
        Every vendor email has been filed or dismissed. New ones the AI can’t place will land here.
      </EmptyState>
    );
  return (
    <EmptyState icon={<Inbox />} title={view === 'ignored' ? 'No ignored emails' : 'No emails yet'}>
      {view === 'ignored'
        ? 'Emails you dismiss (newsletters, spam, no action needed) are kept here.'
        : 'Forward your purchasing mailbox to Pro-Cure (Settings → Email) and vendor email will appear here.'}
    </EmptyState>
  );
}

// ------------------------------------------------------------------ list row
function RoutingLine({
  email,
  job,
  jobsLoaded,
}: {
  email: InboundListItem;
  job?: RouteJobSummary;
  jobsLoaded: boolean;
}) {
  const state = aiState(email, jobsLoaded ? (job ?? null) : undefined);
  if (email.status !== 'routed' && email.status !== 'ignored' && state === 'reading')
    return (
      <span className="inline-flex items-center gap-1.5 text-ink-3">
        <Spinner className="size-3.5" /> AI is reading…
      </span>
    );
  if (email.status !== 'routed' && email.status !== 'ignored' && state === 'failed')
    return (
      <span className="inline-flex items-center gap-1.5 text-risk">
        <CircleAlert className="size-3.5" /> AI couldn’t read it — route by hand
      </span>
    );
  const intent = intentLabel(job?.summary.intent);
  const po = job?.summary.poNumber;
  const conf = email.routing?.confidence ?? job?.summary.confidence;
  if (email.status === 'routed') {
    const where = po ?? ENTITY_LABEL[email.routedEntityType ?? ''] ?? 'a thread';
    return (
      <span className="inline-flex min-w-0 items-center gap-1.5 text-ok">
        <Check className="size-3.5 shrink-0" />
        <span className="truncate">
          Filed on {where}
          {email.routing && (
            <span className="text-ink-3"> by {METHOD_LABEL[email.routing.method].toLowerCase()}</span>
          )}
        </span>
      </span>
    );
  }
  if (email.status === 'ignored') return <span className="text-ink-3">Ignored</span>;
  return (
    <span className="flex min-w-0 items-center gap-2">
      <Sparkles className="size-3.5 shrink-0 text-brass" />
      <span className="truncate text-ink-2">
        {intent ?? 'Unclear'}
        {po
          ? ` · ${po}`
          : email.suggestionCount
            ? ` · ${email.suggestionCount} suggestion${email.suggestionCount === 1 ? '' : 's'}`
            : ' · no PO match'}
      </span>
      {conf !== undefined && <ConfidenceBar value={conf} />}
    </span>
  );
}

function Row({
  email,
  job,
  jobsLoaded,
  active,
  onSelect,
}: {
  email: InboundListItem;
  job?: RouteJobSummary;
  jobsLoaded: boolean;
  active: boolean;
  onSelect: () => void;
}) {
  const unread = email.status === 'needs_review' || email.status === 'pending';
  return (
    <button
      type="button"
      data-id={email.id}
      onClick={onSelect}
      aria-current={active || undefined}
      className={cx(
        'relative block w-full border-b border-line-2 px-4 py-3 text-left transition-colors focus-visible:z-10',
        active ? 'bg-brass-50' : 'hover:bg-stone',
      )}
    >
      {active && <span className="absolute inset-y-0 left-0 w-[3px] bg-brass" aria-hidden />}
      <div className="flex items-baseline gap-2">
        <span className={cx('min-w-0 flex-1 truncate', unread ? 'font-[640]' : 'font-[540] text-ink-2')}>
          {senderName(email)}
        </span>
        {email.attachmentCount > 0 && (
          <Paperclip
            className="size-3.5 shrink-0 self-center text-ink-3"
            aria-label={`${email.attachmentCount} attachments`}
          />
        )}
        <time className="num shrink-0 text-[12px] text-ink-3" dateTime={email.receivedAt}>
          {shortTime(email.receivedAt)}
        </time>
      </div>
      <div className={cx('mt-0.5 truncate', unread ? 'text-ink' : 'text-ink-2')}>
        {email.subject || '(no subject)'}
      </div>
      <div className="mt-0.5 line-clamp-1 text-[13px] text-ink-3">{email.preview}</div>
      <div className="mt-1.5 text-[12.5px]">
        <RoutingLine email={email} job={job} jobsLoaded={jobsLoaded} />
      </div>
    </button>
  );
}

// ------------------------------------------------------------------ detail
interface ThreadInfo {
  id: string;
  subject: string;
  entityType: string;
  entityId: string;
  visibility: 'internal' | 'vendor' | 'client';
}

const AUDIENCE: Record<string, string> = {
  internal: 'team-only thread',
  vendor: 'vendor thread',
  client: 'owner thread',
};

function Detail({ id, onBack, onChanged }: { id: string; onBack: () => void; onChanged: () => void }) {
  const s = useSession();
  const qc = useQueryClient();
  const canAi = hasPerm(s, 'ai:use');
  const [routing, setRouting] = useState(false);
  const [confirmIgnore, setConfirmIgnore] = useState(false);
  const [body, setBody] = useState<'message' | 'full' | 'html'>('message');

  const email = useQuery({
    queryKey: inboxKeys.email(id),
    queryFn: () => api.get<InboundEmail>('comms', `/inbound/${id}`),
    refetchInterval: (q) => (q.state.data?.status === 'pending' ? 2_000 : false),
  });
  const e = email.data;

  const job = useQuery({
    queryKey: inboxKeys.job(id),
    queryFn: async () => {
      const page = await api.get<Page<RouteJobSummary>>('ai', '/jobs', {
        kind: 'inbox_route',
        entityType: 'inbound_email',
        entityId: id,
        limit: 1,
      });
      const latest = page.items[0];
      return latest ? api.get<RouteJob>('ai', `/jobs/${latest.id}`) : null;
    },
    enabled: canAi && !!e,
    refetchInterval: (q) => {
      const st = q.state.data?.status;
      return st === 'queued' || st === 'running' || e?.status === 'pending' ? 2_000 : false;
    },
    meta: { silent: true },
    retry: false,
  });

  const thread = useQuery({
    queryKey: ['thread-info', e?.routedThreadId],
    queryFn: () => api.get<ThreadInfo>('comms', `/threads/${e!.routedThreadId}`, { limit: 1 }),
    enabled: !!e?.routedThreadId,
    meta: { silent: true },
  });

  const refresh = (next?: InboundEmail) => {
    if (next) qc.setQueryData(inboxKeys.email(id), next);
    onChanged();
  };

  const apply = useMutation({
    mutationFn: (index: number) =>
      api.post<InboundEmail>('comms', `/inbound/${id}/suggestions/${index}/apply`),
    onSuccess: (next, index) => {
      refresh(next);
      const sg = next.suggestions[index];
      if (sg?.error) toast.error(`Couldn’t apply: ${sg.error}`);
      else if (sg && isRouteSuggestion(sg)) toast.success('Email routed');
      else toast.success('Suggestion applied');
    },
  });
  const ignore = useMutation({
    mutationFn: () => api.post<InboundEmail>('comms', `/inbound/${id}/ignore`),
    onSuccess: (next) => {
      setConfirmIgnore(false);
      refresh(next);
      toast.success('Email ignored');
    },
  });
  const rerun = useMutation({
    mutationFn: () => api.post<RouteJobSummary>('ai', '/jobs/inbox-route', { inboundEmailId: id }),
    onSuccess: () => {
      toast.success('AI is re-reading the email');
      qc.invalidateQueries({ queryKey: inboxKeys.job(id) });
      setTimeout(() => {
        qc.invalidateQueries({ queryKey: inboxKeys.email(id) });
        onChanged();
      }, 1500);
    },
  });

  if (email.isLoading) return <Loading label="Loading email" />;
  if (email.isError || !e) return <ErrorNote error={email.error} />;

  const out = job.data?.output ?? null;
  const state = aiState(e, !canAi ? null : job.isSuccess ? job.data : undefined);
  const reading = state === 'reading' && e.status !== 'routed' && e.status !== 'ignored';
  const failed = state === 'failed';
  const routeSuggestions = e.suggestions.map((sg, i) => ({ sg, i })).filter((x) => isRouteSuggestion(x.sg));
  const actionSuggestions = e.suggestions.map((sg, i) => ({ sg, i })).filter((x) => !isRouteSuggestion(x.sg));
  const target = thread.data
    ? { type: thread.data.entityType, id: thread.data.entityId }
    : { type: e.routedEntityType, id: e.routedEntityId };
  const href = entityPath(target.type, target.id);
  // Set when a person applied a routing suggestion (comms appends "Suggestion applied by <name>").
  const confirmedBy = e.routing?.reasons
    .find((r) => r.startsWith('Suggestion applied by '))
    ?.slice('Suggestion applied by '.length);
  const canRerun =
    canAi && e.status !== 'ignored' && e.routing?.method !== 'manual' && e.routing?.method !== 'alias';

  return (
    <article className="mx-auto max-w-[880px] px-4 py-5 sm:px-6">
      <button
        type="button"
        onClick={onBack}
        className="mb-3 inline-flex items-center gap-1.5 text-[13px] font-[560] text-ink-2 hover:text-ink lg:hidden"
      >
        <ArrowLeft className="size-4" /> Back to inbox
      </button>

      {/* ---------------------------------------------- header */}
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[19px] font-[640] leading-snug break-words">{e.subject || '(no subject)'}</h2>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[13px] text-ink-3">
            <StatusBadge
              status={e.status === 'pending' ? 'running' : e.status}
              label={STATUS_LABEL[e.status]}
            />
            <span>Received {ago(e.receivedAt)}</span>
            {e.source === 'simulate' && <Badge>Simulated</Badge>}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canRerun && (
            <Button
              size="sm"
              variant="ghost"
              icon={<RefreshCw className="size-3.5" />}
              loading={rerun.isPending}
              disabled={reading}
              onClick={() => rerun.mutate()}
            >
              Re-run AI
            </Button>
          )}
          {e.status !== 'routed' && e.status !== 'ignored' && (
            <Button
              size="sm"
              variant="secondary"
              icon={<EyeOff className="size-3.5" />}
              onClick={() => setConfirmIgnore(true)}
            >
              Ignore
            </Button>
          )}
          <Button
            size="sm"
            variant={e.status === 'routed' ? 'secondary' : 'primary'}
            icon={<FolderInput className="size-3.5" />}
            onClick={() => setRouting(true)}
          >
            {e.status === 'routed' ? 'Route elsewhere…' : 'Route to…'}
          </Button>
        </div>
      </header>

      {/* ---------------------------------------------- where it went (happy path) */}
      {e.status === 'routed' && (
        <section className="mt-4 flex flex-wrap items-center gap-3 rounded-md border border-ok/25 bg-ok-50 px-4 py-3">
          <span className="grid size-8 shrink-0 place-items-center rounded-full bg-ok text-white">
            <Check className="size-4" />
          </span>
          <div className="min-w-[200px] flex-1 basis-[260px]">
            <div className="font-[620]">
              {out?.target?.poNumber && target.id === out.target.entityId
                ? `Filed on ${out.target.poNumber}`
                : `Filed on ${(ENTITY_LABEL[target.type ?? ''] ?? 'record').toLowerCase()}`}
              {thread.data && (
                <span className="font-normal text-ink-2"> · thread “{thread.data.subject}”</span>
              )}
            </div>
            <div className="text-[13px] text-ink-2">
              {e.routing?.method === 'alias'
                ? 'The sender replied to the thread’s reply address, so it was filed automatically.'
                : e.routing?.method === 'ai'
                  ? `The AI agent matched it${confirmedBy ? ` and ${confirmedBy} confirmed` : ''} (${Math.round((e.routing.confidence ?? 0) * 100)}% confident).`
                  : `Filed by ${e.triagedByName ?? 'a teammate'}${e.triagedAt ? ` ${ago(e.triagedAt)}` : ''}.`}
              {thread.data && ` Added to the ${AUDIENCE[thread.data.visibility]}.`}
            </div>
          </div>
          {href && (
            <Link
              to={href}
              className="inline-flex h-8 items-center rounded-sm bg-paper px-3 text-[13px] font-[560] text-lacquer ring-1 ring-ok/30 hover:bg-white"
            >
              Open {(ENTITY_LABEL[target.type ?? ''] ?? 'record').toLowerCase()}
            </Link>
          )}
        </section>
      )}
      {e.status === 'ignored' && (
        <p className="mt-4 rounded-sm border border-line bg-stone px-3 py-2 text-[13px] text-ink-2">
          Ignored by {e.triagedByName ?? 'a teammate'}
          {e.triagedAt && ` ${ago(e.triagedAt)}`}. It won’t appear in review again. Route it if it turns out
          to matter.
        </p>
      )}

      {/* ---------------------------------------------- AI */}
      {(reading || failed || e.routing || out) &&
        e.routing?.method !== 'alias' &&
        e.routing?.method !== 'manual' && (
          <section className="mt-4 rounded-md border border-line bg-paper">
            <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line-2 px-4 py-2.5">
              <h3 className="flex items-center gap-2 text-[14px] font-[620]">
                <Sparkles className="size-4 text-brass" />
                {reading
                  ? 'The AI agent is reading this email…'
                  : failed
                    ? 'The AI agent couldn’t read this email'
                    : 'What the AI agent read'}
              </h3>
              {!reading && e.routing && <ConfidenceBar value={e.routing.confidence} wide />}
            </header>
            <div className="space-y-4 p-4">
              {reading ? (
                <div className="flex items-center gap-2 text-ink-3">
                  <Spinner className="size-4" /> Looking for a PO number, tracking, dates and amounts. This
                  takes a few seconds.
                </div>
              ) : (
                <>
                  {out && (
                    <Facts
                      cols={3}
                      items={[
                        { label: 'Reads as', value: intentLabel(out.intent) },
                        {
                          label: 'Best match',
                          value: out.target?.poNumber ?? (
                            <span className="text-ink-3">No purchase order</span>
                          ),
                        },
                        {
                          label: 'Vendor',
                          value: out.vendor?.name ?? <span className="text-ink-3">Not recognized</span>,
                        },
                        ...(out.extracted.poNumbers.length
                          ? [{ label: 'PO numbers mentioned', value: out.extracted.poNumbers.join(', ') }]
                          : []),
                        ...(out.extracted.trackingNumber
                          ? [
                              {
                                label: 'Tracking',
                                value: (
                                  <span className="num">
                                    {out.extracted.carrier} {out.extracted.trackingNumber}
                                  </span>
                                ),
                              },
                            ]
                          : []),
                        ...(out.extracted.newShipDate
                          ? [{ label: 'New ship date', value: out.extracted.newShipDate }]
                          : out.extracted.shipDate
                            ? [{ label: 'Ship date', value: out.extracted.shipDate }]
                            : []),
                        ...(out.extracted.amount !== null
                          ? [
                              {
                                label: 'Amount',
                                value: <span className="num">{money(out.extracted.amount)}</span>,
                              },
                            ]
                          : []),
                      ]}
                    />
                  )}
                  {failed && (
                    <p className="flex items-start gap-2 rounded-sm bg-risk-50 px-3 py-2 text-[13px] text-risk">
                      <CircleAlert className="mt-0.5 size-4 shrink-0" />
                      <span>
                        It stopped before finding a match
                        {job.data?.error ? ` (${job.data.error})` : ''}. This usually means the purchase-order
                        service was unavailable. Use <span className="font-[620]">Route to…</span> to file it
                        yourself, or <span className="font-[620]">Re-run AI</span> to try again.
                      </span>
                    </p>
                  )}
                  {!!e.routing?.reasons.length && (
                    <div>
                      <div className="text-[12px] text-ink-3">Why</div>
                      <ul className="mt-1 space-y-1">
                        {e.routing.reasons.map((r) => (
                          <li key={r} className="flex gap-2 text-[13px] text-ink-2">
                            <span className="mt-[7px] size-1 shrink-0 rounded-full bg-ink-4" />
                            {r}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </>
              )}

              {/* suggestions */}
              {!reading && !!e.suggestions.length && (
                <div className="space-y-3 border-t border-line-2 pt-4">
                  {!!routeSuggestions.length && (
                    <SuggestionGroup
                      title={e.status === 'routed' ? 'Other places it could go' : 'Where to file it'}
                      rows={routeSuggestions}
                      primaryFirst={e.status !== 'routed'}
                      disabled={e.status === 'routed'}
                      pendingIndex={apply.isPending ? apply.variables : undefined}
                      onApply={(i) => apply.mutate(i)}
                    />
                  )}
                  {!!actionSuggestions.length && (
                    <SuggestionGroup
                      title="Suggested updates"
                      rows={actionSuggestions}
                      pendingIndex={apply.isPending ? apply.variables : undefined}
                      onApply={(i) => apply.mutate(i)}
                    />
                  )}
                </div>
              )}
              {!reading && !e.suggestions.length && e.status === 'needs_review' && (
                <p className="border-t border-line-2 pt-4 text-[13px] text-ink-2">
                  No suggestions. Use <span className="font-[560]">Route to…</span> to file it on a project,
                  quote, cost request or purchase order, or <span className="font-[560]">Ignore</span> it if
                  no action is needed.
                </p>
              )}
            </div>
          </section>
        )}

      {/* ---------------------------------------------- headers */}
      <section className="mt-4 rounded-md border border-line bg-paper">
        <div className="flex items-start gap-3 border-b border-line-2 px-4 py-3">
          <Avatar name={senderName(e)} tone="brass" size={34} />
          <div className="min-w-0 flex-1 text-[13px]">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3">
              <span className="text-[14px] font-[620]">
                {senderName(e)}{' '}
                {e.fromName && <span className="font-normal text-ink-3">&lt;{e.fromAddress}&gt;</span>}
              </span>
              <time className="text-ink-3" dateTime={e.receivedAt}>
                {dateTime(e.receivedAt)}
              </time>
            </div>
            <div className="mt-0.5 break-words text-ink-2">
              <span className="text-ink-3">To</span> {e.toAddresses.join(', ') || '—'}
              {!!e.cc.length && (
                <>
                  {' '}
                  <span className="text-ink-3">· Cc</span> {e.cc.join(', ')}
                </>
              )}
            </div>
          </div>
        </div>

        <div className="px-4 pt-2">
          <Tabs
            value={body}
            onChange={(v) => setBody(v as typeof body)}
            items={[
              { value: 'message', label: 'Message' },
              ...(e.textBody && e.textBody.trim() !== e.strippedText.trim()
                ? [{ value: 'full', label: 'With quoted replies' }]
                : []),
              ...(e.htmlBody ? [{ value: 'html', label: 'Formatted' }] : []),
            ]}
          />
        </div>
        <div className="border-t border-line-2 px-4 py-4">
          {body === 'html' && e.htmlBody ? (
            <>
              <SandboxedHtml html={e.htmlBody} title={`Email: ${e.subject}`} />
              <p className="mt-2 text-[12px] text-ink-3">
                Shown in a locked-down frame: scripts, forms and remote images are blocked.
              </p>
            </>
          ) : (
            <div className="whitespace-pre-wrap break-words text-[14px] leading-relaxed">
              {(body === 'full' ? e.textBody : e.strippedText) || (
                <span className="text-ink-3">This email has no plain-text body.</span>
              )}
            </div>
          )}
        </div>

        {(!!e.attachments.length || e.rawDocumentId) && (
          <div className="border-t border-line-2 px-4 py-3">
            {!!e.attachments.length && (
              <>
                <div className="mb-2 text-[12px] text-ink-3">
                  {e.attachments.length} attachment{e.attachments.length === 1 ? '' : 's'}
                </div>
                <ul className="grid gap-2 sm:grid-cols-2">
                  {e.attachments.map((a) => (
                    <li
                      key={a.documentId}
                      className="flex items-center gap-2.5 rounded-sm border border-line px-3 py-2"
                    >
                      <FileText className="size-5 shrink-0 text-ink-3" />
                      <a
                        href={documentUrl(a.documentId)}
                        target="_blank"
                        rel="noreferrer"
                        className="min-w-0 flex-1 truncate font-[560] text-lacquer hover:underline"
                        title={a.filename}
                      >
                        {a.filename}
                      </a>
                      <span className="num shrink-0 text-[12px] text-ink-3">{fileSize(a.size)}</span>
                      <a
                        href={documentUrl(a.documentId, true)}
                        className="grid size-7 shrink-0 place-items-center rounded-xs text-ink-3 hover:bg-stone-2 hover:text-ink"
                        aria-label={`Download ${a.filename}`}
                        title="Download"
                      >
                        <Download className="size-3.5" />
                      </a>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {e.rawDocumentId && (
              <a
                href={documentUrl(e.rawDocumentId, true)}
                className="mt-2 inline-flex items-center gap-1.5 text-[12px] text-ink-3 hover:text-ink"
              >
                <Download className="size-3" /> Download original (.eml)
              </a>
            )}
          </div>
        )}
      </section>

      <RouteSheet
        open={routing}
        onClose={() => setRouting(false)}
        email={e}
        onRouted={(next, label) => {
          setRouting(false);
          refresh(next);
          toast.success(`Email routed to ${label}`);
        }}
      />
      <Dialog
        open={confirmIgnore}
        onClose={() => setConfirmIgnore(false)}
        title="Ignore this email?"
        footer={
          <>
            <Button onClick={() => setConfirmIgnore(false)}>Cancel</Button>
            <Button variant="primary" loading={ignore.isPending} onClick={() => ignore.mutate()}>
              Ignore email
            </Button>
          </>
        }
      >
        <p className="text-ink-2">
          It moves to <span className="font-[560]">Ignored</span> and won’t be filed on any record. Use this
          for newsletters, spam, or messages that need no action. You can still route it later.
        </p>
        {ignore.isError && <p className="mt-2 text-[13px] text-crit">{errorMessage(ignore.error)}</p>}
      </Dialog>
    </article>
  );
}

function SuggestionGroup({
  title,
  rows,
  onApply,
  pendingIndex,
  primaryFirst,
  disabled,
}: {
  title: string;
  rows: { sg: Suggestion; i: number }[];
  onApply: (i: number) => void;
  pendingIndex?: number;
  primaryFirst?: boolean;
  disabled?: boolean;
}) {
  return (
    <div>
      <div className="mb-1.5 text-[12px] text-ink-3">{title}</div>
      <ul className="divide-y divide-line-2 rounded-sm border border-line">
        {rows.map(({ sg, i }, n) => {
          const reasons = Array.isArray(sg.payload.reasons) ? (sg.payload.reasons as string[]) : [];
          const score = typeof sg.payload.score === 'number' ? sg.payload.score : null;
          return (
            <li key={i} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="font-[560]">{sg.label}</div>
                {(reasons.length > 0 || score !== null) && (
                  <div className="mt-0.5 text-[12px] text-ink-3">
                    {score !== null && `Match ${Math.round(score * 100)}%`}
                    {score !== null && reasons.length > 0 && ' — '}
                    {reasons.slice(0, 2).join('; ')}
                  </div>
                )}
                {sg.error && (
                  <div className="mt-1 flex items-start gap-1.5 text-[12.5px] text-crit">
                    <CircleAlert className="mt-px size-3.5 shrink-0" />
                    {sg.error}
                  </div>
                )}
              </div>
              {sg.appliedAt ? (
                <span className="inline-flex items-center gap-1 text-[13px] font-[560] text-ok">
                  <Check className="size-3.5" /> Applied {ago(sg.appliedAt)}
                </span>
              ) : (
                <Button
                  size="sm"
                  variant={primaryFirst && n === 0 ? 'primary' : 'secondary'}
                  loading={pendingIndex === i}
                  disabled={disabled || (pendingIndex !== undefined && pendingIndex !== i)}
                  onClick={() => onApply(i)}
                >
                  {sg.error ? 'Try again' : isRouteSuggestion(sg) ? 'Route here' : 'Apply'}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
