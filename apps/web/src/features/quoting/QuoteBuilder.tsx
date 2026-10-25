import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BadgeCheck,
  BookOpen,
  Copy,
  FileDown,
  History,
  LayoutTemplate,
  ListPlus,
  MoreHorizontal,
  PackageCheck,
  PanelRight,
  RefreshCw,
  Send,
  Settings2,
  Sparkles,
  Tags,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { ActivityFeed } from '@/components/shared/ActivityFeed';
import { DocumentsPanel } from '@/components/shared/DocumentsPanel';
import { ThreadPanel } from '@/components/shared/ThreadPanel';
import {
  Button,
  cx,
  Dialog,
  EmptyState,
  Field,
  Input,
  Loading,
  Menu,
  SearchInput,
  Section,
  Select,
  Sheet,
  StatusBadge,
  Tabs,
  Textarea,
  TitleBlock,
} from '@/components/ui';
import { Popover } from '@/components/ui/Popover';
import { ApiError, api, documentUrl, errorMessage, type Page } from '@/lib/api';
import { hasPerm, useSession } from '@/lib/auth';
import { date, daysFromToday, money, pct } from '@/lib/format';
import { descendants } from './builder/calc';
import { type LinePatch, qtyPatch, useLines, usePatchLine, useQuoteAction, useSummary } from './builder/data';
import { Grid } from './builder/Grid';
import { AlternatesSheet, BulkDialog, LineSheet } from './builder/LineSheets';
import {
  AddSpecsSheet,
  CopyQuoteSheet,
  MerchandiseSheet,
  RequestPricingSheet,
  SendToOwnerSheet,
} from './builder/Sheets';
import { LocationTree, RoomTypesStrip } from './builder/Structure';
import { SummaryPanel } from './builder/SummaryPanel';
import { ApprovalsTab, CostRequestsTab, OwnerTab, PriceMatrixTab } from './builder/Tabs';
import {
  BackLink,
  EDITABLE,
  FLAG_META,
  isConflict,
  MarginCell,
  parseNum,
  plural,
  QUOTE_STATUS_LABEL,
  qk,
  RecordError,
  useCostsVisible,
  useProjects,
  useQuote,
} from './shared';
import type { ApprovalRequest, Line, LineFlag, QuoteDetail } from './types';

const TABS = ['lines', 'matrix', 'costs', 'approvals', 'owner', 'files', 'messages', 'activity'] as const;
type Tab = (typeof TABS)[number];
type SheetKind = 'add' | 'merch' | 'pricing' | 'send' | 'copy' | 'template' | 'settings' | 'summary' | null;

export function Component() {
  const { id = '' } = useParams();
  const s = useSession();
  const nav = useNavigate();
  const qc = useQueryClient();
  const costs = useCostsVisible();
  const [params, setParams] = useSearchParams();
  const tab: Tab = (TABS as readonly string[]).includes(params.get('tab') ?? '')
    ? (params.get('tab') as Tab)
    : 'lines';
  const setTab = (t: string) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        if (t === 'lines') n.delete('tab');
        else n.set('tab', t);
        return n;
      },
      { replace: true },
    );

  const quoteQ = useQuote(id);
  const quote = quoteQ.data;
  const linesQ = useLines(id);
  const lines = linesQ.data ?? [];
  const summary = useSummary(id, costs && !!quote);
  const approvalsQ = useQuery({
    queryKey: qk.approvals({ quoteId: id }),
    queryFn: () => api.get<Page<ApprovalRequest>>('quoting', '/approvals', { quoteId: id, limit: 100 }),
    enabled: !!quote && !quote.isTemplate,
  });
  const approvals = useMemo(
    () => (approvalsQ.data?.items ?? []).filter((a) => a.status !== 'cancelled'),
    [approvalsQ.data],
  );
  const projects = useProjects();
  const project = projects.data?.find((p) => p.id === quote?.projectId);

  const editableStage = !!quote && (quote.isTemplate || EDITABLE.includes(quote.status));
  const canWrite = hasPerm(s, 'quotes:write');
  const canEdit = editableStage && canWrite;
  const canReady =
    !!quote &&
    ['client_approved', 'ordered'].includes(quote.status) &&
    (canWrite || hasPerm(s, 'orders:write'));
  const canPricing = hasPerm(s, 'cost_requests:write') && costs;
  const canSend = hasPerm(s, 'quotes:send');

  // ---------------------------------------------------------------- filters
  const [locFilter, setLocFilter] = useState<string | null>(null);
  const [flag, setFlag] = useState<LineFlag | null>(null);
  const [breakdown, setBreakdown] = useState<{
    by: 'location' | 'category' | 'vendor';
    key: string | null;
  } | null>(null);
  const [text, setText] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sheet, setSheet] = useState<SheetKind>(null);
  const [lineSheet, setLineSheet] = useState<Line | null>(null);
  const [altFor, setAltFor] = useState<Line | null>(null);
  const [rowMenu, setRowMenu] = useState<{ line: Line; anchor: HTMLElement } | null>(null);
  const [bulk, setBulk] = useState<'markup' | 'move' | 'delete' | null>(null);
  const search = useRef<HTMLDivElement>(null);
  const [panel, setPanelState] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem('procure.quote.summary');
      return v === null ? window.innerWidth >= 1680 : v === '1';
    } catch {
      return window.innerWidth >= 1680;
    }
  });
  const setPanel = (v: boolean) => {
    setPanelState(v);
    try {
      localStorage.setItem('procure.quote.summary', v ? '1' : '0');
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) {
        e.preventDefault();
        search.current?.querySelector('input')?.focus();
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  const visible = useMemo(() => {
    if (!quote) return [];
    let ls = lines;
    if (locFilter === '__unassigned__')
      ls = ls.filter((l) => !l.locationId || !quote.locations.some((x) => x.id === l.locationId));
    else if (locFilter) {
      const set = descendants(locFilter, quote.locations);
      ls = ls.filter((l) => l.locationId && set.has(l.locationId));
    }
    if (flag) ls = ls.filter((l) => l.flags.includes(flag) && l.isSelected);
    if (breakdown) {
      if (breakdown.by === 'category') ls = ls.filter((l) => l.category === breakdown.key);
      else if (breakdown.by === 'vendor') ls = ls.filter((l) => (l.vendorId ?? null) === breakdown.key);
      else if (breakdown.key) {
        const set = descendants(breakdown.key, quote.locations);
        ls = ls.filter((l) => l.locationId && set.has(l.locationId));
      } else ls = ls.filter((l) => !l.locationId);
    }
    const t = text.trim().toLowerCase();
    if (t)
      ls = ls.filter((l) =>
        [l.code, l.name, l.vendorName, l.finish, l.dimensions].some((x) => x?.toLowerCase().includes(t)),
      );
    return ls;
  }, [lines, quote, locFilter, flag, breakdown, text]);
  const grouped =
    !!quote?.locations.length && (!locFilter || quote.locations.some((l) => l.parentId === locFilter));

  // ---------------------------------------------------------------- mutations
  const patch = usePatchLine(quote);
  const onPatch = useCallback(
    (l: Line, p: LinePatch) => {
      if (!quote) return;
      const full =
        p.qtyFixed !== undefined || p.qtyPerRoom !== undefined || p.atticStockPct !== undefined
          ? qtyPatch(l, quote, p)
          : p;
      patch.mutate({ lineId: l.id, patch: full });
    },
    [quote, patch],
  );

  const bulkPatch = useQuoteAction(
    id,
    (v: { lineIds: string[]; patch: Record<string, unknown>; msg: string }) =>
      api.post<{ updated: number }>('quoting', `/quotes/${id}/lines/bulk`, {
        lineIds: v.lineIds,
        patch: v.patch,
      }),
    {
      success: (r, v) => v.msg.replace('{n}', plural('line', r.updated)),
      onDone: () => {
        setBulk(null);
        setSelected(new Set());
      },
    },
  );
  const bulkDelete = useQuoteAction(
    id,
    (ids: string[]) =>
      api.post<{ deleted: number }>('quoting', `/quotes/${id}/lines/delete`, { lineIds: ids }),
    {
      success: (r) => `Deleted ${plural('line', r.deleted)}`,
      onDone: () => {
        setBulk(null);
        setSelected(new Set());
      },
    },
  );
  const deleteLine = useQuoteAction(id, (l: Line) => api.del('quoting', `/quotes/${id}/lines/${l.id}`), {
    success: (_r, l) => `Deleted ${l.code}`,
  });
  const syncLine = useQuoteAction(
    id,
    (l: Line) => api.post<Line>('quoting', `/quotes/${id}/lines/${l.id}/sync-from-spec`),
    { success: (_r, l) => `${l.code} refreshed from the library spec` },
  );
  const refreshCosts = useQuoteAction(
    id,
    () => api.post<{ changed: unknown[] }>('quoting', `/quotes/${id}/refresh-costs`, {}),
    {
      success: (r) =>
        r.changed.length
          ? `Costs refreshed from library: ${plural('line', r.changed.length)} changed`
          : 'Costs refreshed from library: everything was current',
    },
  );
  const submit = useMutation({
    mutationFn: () =>
      api.post<{ approved: boolean; requests: ApprovalRequest[]; warnings: string[] }>(
        'quoting',
        `/quotes/${id}/submit-for-approval`,
      ),
    onSuccess: (r) => {
      if (r.approved) toast.success('Submitted for approval: every rule passed — ready to send to the owner');
      else {
        toast.success(`Submitted for approval: ${plural('approval', r.requests.length)} needed`, {
          description: r.requests.map((a) => `${a.policyName}: ${a.reason}`).join(' · '),
        });
        setTab('approvals');
      }
      qc.invalidateQueries({ queryKey: ['quoting'] });
    },
  });
  const report = useMutation({
    mutationFn: async (variant: 'client' | 'internal') => {
      const w = window.open('', '_blank');
      try {
        const r = await api.post<{ documentId: string }>('quoting', `/quotes/${id}/report`, { variant });
        if (w) w.location.href = documentUrl(r.documentId);
        else window.open(documentUrl(r.documentId), '_blank');
        return r;
      } catch (e) {
        w?.close();
        throw e;
      }
    },
    onSuccess: () => toast.success('Quote PDF ready'),
  });
  const specBook = useMutation({
    mutationFn: async () => {
      const w = window.open('', '_blank');
      try {
        const r = await api.post<{ documentId: string; specCount: number; warnings: string[] }>(
          'quoting',
          `/quotes/${id}/spec-book`,
          { includeDocuments: true },
        );
        if (w) w.location.href = documentUrl(r.documentId);
        return r;
      } catch (e) {
        w?.close();
        throw e;
      }
    },
    onSuccess: (r) =>
      toast.success(`Spec book ready: ${plural('spec', r.specCount)}`, {
        description: r.warnings.join(' ') || undefined,
      }),
  });
  const createPOs = useMutation({
    mutationFn: (lineIds: string[]) =>
      api.post<{ items?: { id: string; number: string }[] }>('orders', '/purchase-orders/from-quote', {
        quoteId: id,
        lineIds,
      }),
    onSuccess: (r) => {
      const pos = r?.items ?? [];
      toast.success(
        pos.length
          ? `Purchase orders created: ${pos.map((p) => p.number).join(', ')}`
          : 'Purchase orders created',
        {
          action: { label: 'View orders', onClick: () => nav('/app/orders') },
          duration: 8000,
        },
      );
      setSelected(new Set());
      // Ordering links lines back to the quote asynchronously; refresh now and again shortly.
      for (const ms of [0, 1500, 4000]) setTimeout(() => qc.invalidateQueries({ queryKey: ['quoting'] }), ms);
    },
    onError: (e) => {
      const down = e instanceof ApiError && e.status >= 500;
      toast.error(
        down
          ? 'Purchase orders couldn’t be created'
          : `Purchase orders couldn’t be created: ${errorMessage(e)}`,
        {
          duration: 12_000,
          description: down
            ? 'The ordering service isn’t responding. Nothing was changed — the lines stay ready to order. Try again shortly.'
            : undefined,
        },
      );
    },
    meta: { silent: true },
  });

  if (quoteQ.isLoading) return <Loading label="Loading quote" />;
  if (quoteQ.isError || !quote)
    return (
      <RecordError error={quoteQ.error} what="quote" back={{ to: '/app/quotes', label: 'Back to quotes' }} />
    );

  // ---------------------------------------------------------------- primary action
  const t = quote.totals;
  const needCost = t.flagCounts.missing_cost + t.flagCounts.cost_expired;
  const pending = approvals.filter((a) => a.status === 'pending');
  const readyLines = lines.filter((l) => l.readyToOrder && !l.poId && l.isSelected);
  const notReady = lines.filter(
    (l) =>
      l.isSelected &&
      !l.readyToOrder &&
      !l.poId &&
      l.unitCost !== null &&
      l.unitPrice !== null &&
      l.quantity > 0,
  );

  type Act = {
    label: string;
    icon?: React.ReactNode;
    run: () => void;
    loading?: boolean;
    disabled?: boolean;
    hint?: string;
  };
  const acts: Record<string, Act> = {
    pricing: { label: 'Request pricing', icon: <Send className="size-4" />, run: () => setSheet('pricing') },
    merch: { label: 'Merchandise', icon: <Tags className="size-4" />, run: () => setSheet('merch') },
    submit: {
      label: 'Submit for approval',
      icon: <BadgeCheck className="size-4" />,
      run: () => submit.mutate(),
      loading: submit.isPending,
    },
    send: { label: 'Send to owner', icon: <Send className="size-4" />, run: () => setSheet('send') },
    ready: {
      label: selected.size
        ? `Mark ${plural('line', [...selected].filter((x) => notReady.some((l) => l.id === x)).length)} ready to order`
        : 'Mark ready to order',
      icon: <PackageCheck className="size-4" />,
      run: () => {
        const ids = selected.size
          ? notReady.filter((l) => selected.has(l.id)).map((l) => l.id)
          : notReady.map((l) => l.id);
        if (!ids.length) return toast.message('Select lines with a cost and price to release for ordering');
        bulkPatch.mutate({ lineIds: ids, patch: { readyToOrder: true }, msg: 'Marked {n} ready to order' });
      },
      loading: bulkPatch.isPending,
    },
    po: {
      label: readyLines.length ? `Create purchase orders (${readyLines.length})` : 'Create purchase orders',
      icon: <PackageCheck className="size-4" />,
      run: () => createPOs.mutate(readyLines.map((l) => l.id)),
      loading: createPOs.isPending,
      disabled: !readyLines.length,
      hint: readyLines.length ? undefined : 'Mark lines ready to order first',
    },
  };
  let primary: Act | null = null;
  const secondary: Act[] = [];
  if (!quote.isTemplate) {
    switch (quote.status) {
      case 'draft':
      case 'costing':
        if (canPricing && (needCost || quote.status === 'draft')) primary = acts.pricing!;
        else if (costs && canWrite) primary = acts.merch!;
        if (primary !== acts.merch && costs && canWrite) secondary.push(acts.merch!);
        if (primary !== acts.pricing && canPricing && needCost) secondary.push(acts.pricing!);
        if (canWrite || canSend) secondary.push(acts.submit!);
        break;
      case 'merchandising':
      case 'client_rejected':
        if (quote.internalApprovedAt && canSend) primary = acts.send!;
        else if (canWrite || canSend) primary = acts.submit!;
        if (costs && canWrite) secondary.push(acts.merch!);
        if (canPricing && needCost) secondary.push(acts.pricing!);
        break;
      case 'pending_internal_approval':
        primary = {
          label: `Awaiting ${plural('approval', pending.length)}`,
          run: () => setTab('approvals'),
          icon: <BadgeCheck className="size-4" />,
        };
        if (costs && canWrite) secondary.push(acts.merch!);
        break;
      case 'sent':
        primary = { label: 'Awaiting owner decision', run: () => setTab('owner') };
        break;
      case 'client_approved':
      case 'ordered':
        if (canReady && notReady.length) primary = acts.ready!;
        else if (hasPerm(s, 'orders:write')) primary = acts.po!;
        if (primary === acts.ready && hasPerm(s, 'orders:write')) secondary.push(acts.po!);
        break;
    }
  }

  const days = daysFromToday(quote.validUntil);
  const flagTotal = Object.values(t.flagCounts).reduce((a, b) => a + b, 0);

  const openLinePdf = (variant: 'client' | 'internal') => report.mutate(variant);
  const menuItems = [
    ...(canEdit && costs
      ? [
          {
            label: 'Refresh costs from library',
            icon: <RefreshCw className="size-4 text-ink-3" />,
            onSelect: () => refreshCosts.mutate(undefined),
          },
        ]
      : []),
    ...(canEdit
      ? [
          {
            label: 'Quote settings',
            icon: <Settings2 className="size-4 text-ink-3" />,
            onSelect: () => setSheet('settings'),
          },
        ]
      : []),
    'divider' as const,
    ...(canWrite
      ? [
          {
            label: 'Copy quote',
            icon: <Copy className="size-4 text-ink-3" />,
            onSelect: () => setSheet('copy'),
          },
        ]
      : []),
    ...(canWrite
      ? [
          {
            label: 'Save as template',
            icon: <LayoutTemplate className="size-4 text-ink-3" />,
            onSelect: () => setSheet('template'),
          },
        ]
      : []),
    'divider' as const,
    {
      label: 'Quote PDF (owner)',
      icon: <FileDown className="size-4 text-ink-3" />,
      onSelect: () => openLinePdf('client'),
    },
    ...(costs
      ? [
          {
            label: 'Quote PDF (internal, with cost)',
            icon: <FileDown className="size-4 text-ink-3" />,
            onSelect: () => openLinePdf('internal'),
          },
        ]
      : []),
    {
      label: 'Spec book',
      icon: <BookOpen className="size-4 text-ink-3" />,
      onSelect: () => specBook.mutate(),
    },
    'divider' as const,
    {
      label: 'Activity',
      icon: <History className="size-4 text-ink-3" />,
      onSelect: () => setTab('activity'),
    },
  ].filter((x, i, a) => !(x === 'divider' && (i === 0 || a[i - 1] === 'divider')));

  const selLines = lines.filter((l) => selected.has(l.id));
  const sums = (ls: Line[]) => {
    const sel = ls.filter((l) => l.isSelected);
    const sell = sel.reduce((a, l) => a + (l.extendedPrice ?? 0), 0);
    const cost = sel.reduce((a, l) => a + (l.extendedCost ?? 0), 0);
    return { sell, cost, margin: sell ? ((sell - cost) / sell) * 100 : null };
  };
  const foot = sums(selLines.length ? selLines : visible);
  const filtersOn = !!(locFilter || flag || breakdown || text.trim());

  return (
    <div className="flex flex-col lg:h-[calc(100dvh-3.5rem)]">
      {/* ------------------------------------------------ header */}
      <div className="border-b border-line bg-paper px-4 pt-3 pb-0 sm:px-6">
        <div className="mb-2.5 flex items-center justify-between gap-2">
          <BackLink to={quote.isTemplate ? '/app/quotes?templates=templates' : '/app/quotes'}>
            {quote.isTemplate ? 'Templates' : 'Quotes'}
          </BackLink>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {secondary.map((a) => (
              <Button
                key={a.label}
                size="sm"
                icon={a.icon}
                onClick={a.run}
                loading={a.loading}
                disabled={a.disabled}
                className="max-sm:!hidden"
              >
                {a.label}
              </Button>
            ))}
            {primary && (
              <Button
                size="sm"
                variant={primary.label.startsWith('Await') ? 'secondary' : 'primary'}
                icon={primary.icon}
                onClick={primary.run}
                loading={primary.loading}
                disabled={primary.disabled}
                title={primary.hint}
              >
                {primary.label}
              </Button>
            )}
            <Menu
              trigger={(open) => (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={open}
                  aria-label="More actions"
                  icon={<MoreHorizontal className="size-4" />}
                >
                  <span className="hidden sm:inline">More</span>
                </Button>
              )}
              items={[
                ...(typeof window !== 'undefined' && window.innerWidth < 640
                  ? [
                      ...secondary.map((a) => ({ label: a.label, onSelect: a.run, disabled: a.disabled })),
                      ...(secondary.length ? (['divider'] as const) : []),
                    ]
                  : []),
                ...menuItems,
              ]}
            />
          </div>
        </div>
        <TitleBlock
          title={quote.isTemplate ? (quote.templateName ?? quote.name) : quote.name}
          subtitle={
            <span className="flex flex-wrap items-center gap-x-2">
              {quote.phase && <span>{quote.phase}</span>}
              {quote.phase && (project || quote.isTemplate) && <span className="text-ink-4">·</span>}
              {quote.isTemplate ? (
                <span>Template</span>
              ) : project ? (
                <Link to={`/app/projects/${project.id}`} className="hover:text-lacquer hover:underline">
                  {project.name}
                </Link>
              ) : null}
            </span>
          }
          fields={[
            { label: 'Number', value: <span className="num">{quote.number}</span> },
            {
              label: 'Status',
              value: quote.isTemplate ? (
                <StatusBadge status="draft" label="Template" />
              ) : (
                <StatusBadge
                  status={
                    quote.internalApprovedAt && quote.status === 'merchandising' ? 'approved' : quote.status
                  }
                  label={
                    quote.internalApprovedAt && quote.status === 'merchandising'
                      ? 'Approved internally'
                      : QUOTE_STATUS_LABEL[quote.status]
                  }
                />
              ),
            },
            { label: 'Sell total', value: <span className="num">{money(t.grandTotal, true)}</span> },
            ...(costs
              ? [{ label: 'Margin', value: <MarginCell value={t.marginPct} floor={quote.minMarginPct} /> }]
              : []),
            {
              label: 'Valid until',
              value: (
                <span className={cx('num', days !== null && days < 0 && 'text-crit')}>
                  {date(quote.validUntil)}
                  {days !== null && days >= 0 && days <= 21 && (
                    <span className="ml-1.5 font-[480] text-ink-3">{days}d</span>
                  )}
                </span>
              ),
            },
          ]}
        />
        <Tabs
          className="mt-3"
          value={tab}
          onChange={setTab}
          items={[
            { value: 'lines', label: 'Lines', count: t.lineCount },
            ...(costs ? [{ value: 'matrix', label: 'Price matrix' }] : []),
            ...(costs && !quote.isTemplate ? [{ value: 'costs', label: 'Cost requests' }] : []),
            ...(!quote.isTemplate
              ? [{ value: 'approvals', label: 'Approvals', count: pending.length || undefined }]
              : []),
            ...(!quote.isTemplate ? [{ value: 'owner', label: 'Owner' }] : []),
            { value: 'files', label: 'Files' },
            { value: 'messages', label: 'Messages' },
            { value: 'activity', label: 'Activity' },
          ]}
        />
      </div>

      {/* ------------------------------------------------ body */}
      {tab === 'lines' ? (
        <div className="flex min-h-0 flex-1">
          <aside className="hidden w-[236px] shrink-0 overflow-y-auto border-r border-line bg-paper px-2 py-3 lg:block">
            <LocationTree
              quote={quote}
              lines={lines}
              value={locFilter}
              onChange={(v) => {
                setLocFilter(v);
                setBreakdown(null);
              }}
              canEdit={canEdit}
            />
          </aside>
          <div className="flex min-h-[70vh] min-w-0 flex-1 flex-col bg-paper lg:min-h-0">
            <div className="space-y-2 border-b border-line px-3 py-2 sm:px-4">
              <RoomTypesStrip quote={quote} canEdit={canEdit} />
              <div className="flex flex-wrap items-center gap-2">
                <div className="w-full sm:hidden">
                  <Select
                    aria-label="Location"
                    value={locFilter ?? ''}
                    onChange={(e) => setLocFilter(e.target.value || null)}
                    options={[
                      { value: '', label: 'All locations' },
                      ...quote.locations.map((l) => ({ value: l.id, label: l.path })),
                    ]}
                  />
                </div>
                <div ref={search} className="w-full sm:w-64">
                  <SearchInput value={text} onChange={setText} placeholder="Filter lines (press /)" />
                </div>
                {flag && <FilterChip onClear={() => setFlag(null)}>{FLAG_META[flag].label}</FilterChip>}
                {breakdown && (
                  <FilterChip onClear={() => setBreakdown(null)}>
                    {breakdown.by === 'vendor'
                      ? (lines.find((l) => l.vendorId === breakdown.key)?.vendorName ?? 'No vendor')
                      : breakdown.by === 'category'
                        ? (breakdown.key ?? 'Other')
                        : (quote.locations.find((l) => l.id === breakdown.key)?.name ?? 'Unassigned')}
                  </FilterChip>
                )}
                {locFilter && (
                  <FilterChip onClear={() => setLocFilter(null)}>
                    {locFilter === '__unassigned__'
                      ? 'Unassigned'
                      : quote.locations.find((l) => l.id === locFilter)?.path}
                  </FilterChip>
                )}
                <div className="ml-auto flex items-center gap-2">
                  {!costs && (
                    <span className="hidden text-[12px] text-ink-3 md:inline">
                      Costs and margins are hidden for your role
                    </span>
                  )}
                  <Button
                    size="sm"
                    className="xl:!hidden"
                    icon={<PanelRight className="size-4" />}
                    onClick={() => setSheet('summary')}
                  >
                    Summary
                  </Button>
                  <Button
                    size="sm"
                    className="max-xl:!hidden"
                    variant={panel ? 'secondary' : 'ghost'}
                    aria-pressed={panel}
                    icon={<PanelRight className="size-4" />}
                    onClick={() => setPanel(!panel)}
                  >
                    {panel ? 'Hide summary' : 'Summary'}
                  </Button>
                  {canEdit && (
                    <Button
                      size="sm"
                      variant="primary"
                      icon={<ListPlus className="size-4" />}
                      onClick={() => setSheet('add')}
                    >
                      Add specs
                    </Button>
                  )}
                </div>
              </div>
              {selected.size > 0 && (
                <div className="flex flex-wrap items-center gap-1.5 rounded-sm bg-brass-50 px-2 py-1.5 text-[13px]">
                  <span className="mr-1 font-[600]">{plural('line', selected.size)} selected</span>
                  {canEdit && costs && (
                    <Button size="sm" variant="ghost" onClick={() => setBulk('markup')}>
                      Set markup
                    </Button>
                  )}
                  {canEdit && (
                    <Button size="sm" variant="ghost" onClick={() => setBulk('move')}>
                      Move to location
                    </Button>
                  )}
                  {canPricing && !quote.isTemplate && (
                    <Button size="sm" variant="ghost" onClick={() => setSheet('pricing')}>
                      Request pricing
                    </Button>
                  )}
                  {canReady && (
                    <Button size="sm" variant="ghost" onClick={acts.ready!.run}>
                      Mark ready to order
                    </Button>
                  )}
                  {canEdit && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="!text-crit"
                      onClick={() => setBulk('delete')}
                    >
                      Delete
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="ml-auto"
                    onClick={() => setSelected(new Set())}
                  >
                    Clear selection
                  </Button>
                </div>
              )}
              {!editableStage && !quote.isTemplate && (
                <p className="text-[12px] text-ink-3">
                  This quote is {QUOTE_STATUS_LABEL[quote.status]?.toLowerCase()} — prices and quantities are
                  locked.
                  {canReady ? ' You can release lines for ordering.' : ''}
                </p>
              )}
            </div>
            {linesQ.isLoading ? (
              <Loading label="Loading lines" />
            ) : (
              <Grid
                quote={quote}
                lines={visible}
                locations={quote.locations}
                grouped={grouped}
                costs={costs}
                canEdit={canEdit}
                canReady={canReady}
                selected={selected}
                onSelect={setSelected}
                onPatch={onPatch}
                onRowMenu={(line, anchor) => setRowMenu({ line, anchor })}
                empty={
                  filtersOn ? (
                    <EmptyState title="No lines match these filters">
                      <button
                        type="button"
                        className="font-[560] text-lacquer hover:underline"
                        onClick={() => {
                          setLocFilter(null);
                          setFlag(null);
                          setBreakdown(null);
                          setText('');
                        }}
                      >
                        Clear filters
                      </button>
                    </EmptyState>
                  ) : (
                    <EmptyState
                      icon={<ListPlus />}
                      title="No lines yet"
                      action={
                        canEdit && (
                          <Button variant="primary" onClick={() => setSheet('add')}>
                            Add specs
                          </Button>
                        )
                      }
                    >
                      Add specs from your library to a location. Set quantities per room type and every line
                      follows the room counts.
                    </EmptyState>
                  )
                }
              />
            )}
            <div className="num flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-line bg-stone px-4 py-2 text-[13px]">
              <span className="text-ink-2">
                {selLines.length
                  ? `${plural('line', selLines.length)} selected`
                  : filtersOn
                    ? `${plural('line', visible.length)} shown`
                    : plural('line', lines.length)}
              </span>
              {costs && (
                <span>
                  Cost <b className="font-[600]">{money(foot.cost)}</b>
                </span>
              )}
              <span>
                Sell <b className="font-[600]">{money(foot.sell)}</b>
              </span>
              {costs && (
                <span>
                  Margin <b className="font-[600]">{pct(foot.margin)}</b>
                </span>
              )}
              <span className="ml-auto hidden text-[12px] text-ink-3 md:inline">
                Arrows to move · Enter to edit · Tab next · Esc cancel · Space select
              </span>
            </div>
          </div>
          <aside
            className={cx(
              'hidden w-72 shrink-0 overflow-y-auto border-l border-line bg-paper px-4 py-4',
              panel && 'xl:block',
            )}
          >
            <SummaryPanel
              quote={quote}
              summary={summary.data}
              costs={costs}
              flag={flag}
              onFlag={setFlag}
              breakdownFilter={breakdown}
              onBreakdown={setBreakdown}
            />
            {flagTotal === 0 && t.lineCount > 0 && (
              <p className="mt-4 flex items-center gap-1.5 text-[12px] text-ok">
                <Sparkles className="size-3.5" />
                No issues on this quote.
              </p>
            )}
          </aside>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {tab === 'matrix' && <PriceMatrixTab quote={quote} canEdit={canEdit} />}
          {tab === 'costs' && (
            <CostRequestsTab
              quote={quote}
              onRequest={canPricing && editableStage ? () => setSheet('pricing') : undefined}
            />
          )}
          {tab === 'approvals' && <ApprovalsTab quote={quote} approvals={approvals} />}
          {tab === 'owner' && <OwnerTab quote={quote} />}
          {tab === 'files' && (
            <div className="p-4 sm:p-6">
              <Section title="Files">
                <DocumentsPanel entityType="quote" entityId={quote.id} />
              </Section>
            </div>
          )}
          {tab === 'messages' && (
            <div className="p-4 sm:p-6">
              <Section title="Team discussion">
                <ThreadPanel
                  entityType="quote"
                  entityId={quote.id}
                  visibility="internal"
                  emptyHint="Discuss pricing and specs with your team. Owners and vendors never see this."
                />
              </Section>
            </div>
          )}
          {tab === 'activity' && (
            <div className="p-4 sm:p-6">
              <Section title="Activity">
                <ActivityFeed service="quoting" path={`/quotes/${quote.id}/activity`} />
              </Section>
            </div>
          )}
        </div>
      )}

      {/* ------------------------------------------------ overlays */}
      <AddSpecsSheet
        open={sheet === 'add'}
        onClose={() => setSheet(null)}
        quote={quote}
        defaultLocationId={locFilter && locFilter !== '__unassigned__' ? locFilter : null}
      />
      <MerchandiseSheet open={sheet === 'merch'} onClose={() => setSheet(null)} quote={quote} lines={lines} />
      <RequestPricingSheet
        open={sheet === 'pricing'}
        onClose={() => setSheet(null)}
        quote={quote}
        lines={lines}
        preselected={selected}
      />
      <SendToOwnerSheet
        open={sheet === 'send'}
        onClose={() => setSheet(null)}
        quote={quote}
        approvals={approvals}
      />
      <CopyQuoteSheet
        open={sheet === 'copy' || sheet === 'template'}
        asTemplate={sheet === 'template'}
        onClose={() => setSheet(null)}
        quote={quote}
      />
      <QuoteSettingsSheet open={sheet === 'settings'} onClose={() => setSheet(null)} quote={quote} />
      <Sheet open={sheet === 'summary'} onClose={() => setSheet(null)} title="Summary" width={400}>
        <SummaryPanel
          quote={quote}
          summary={summary.data}
          costs={costs}
          flag={flag}
          onFlag={(f) => {
            setFlag(f);
            setSheet(null);
          }}
          breakdownFilter={breakdown}
          onBreakdown={(b) => {
            setBreakdown(b);
            setSheet(null);
          }}
        />
      </Sheet>
      <LineSheet
        line={lineSheet}
        quote={quote}
        costs={costs}
        canEdit={canEdit}
        onClose={() => setLineSheet(null)}
        onSave={onPatch}
      />
      <AlternatesSheet line={altFor} quote={quote} onClose={() => setAltFor(null)} />
      <BulkDialog
        kind={bulk}
        count={selected.size}
        quote={quote}
        onClose={() => setBulk(null)}
        pending={bulkPatch.isPending || bulkDelete.isPending}
        onApply={(v) => {
          const ids = [...selected].filter((x) => lines.some((l) => l.id === x && !l.poId));
          if (bulk === 'markup')
            bulkPatch.mutate({
              lineIds: ids,
              patch: { markupPct: parseNum(v), clearPriceOverride: true },
              msg: `Markup set to ${v}% on {n}`,
            });
          else if (bulk === 'move')
            bulkPatch.mutate({
              lineIds: ids,
              patch: { locationId: v || null },
              msg: `Moved {n} to ${quote.locations.find((l) => l.id === v)?.name ?? 'Unassigned'}`,
            });
          else if (bulk === 'delete') bulkDelete.mutate(ids);
        }}
      />
      <Popover
        anchor={rowMenu?.anchor ?? null}
        open={!!rowMenu}
        onClose={() => setRowMenu(null)}
        width={240}
        label="Line actions"
      >
        {rowMenu && (
          <div className="py-1" role="menu">
            {[
              {
                label: canEdit && !rowMenu.line.poId ? 'Edit details' : 'View details',
                run: () => setLineSheet(rowMenu.line),
                show: true,
              },
              {
                label: 'Add competing vendors',
                run: () => setAltFor(rowMenu.line),
                show: canEdit && costs && !rowMenu.line.poId,
              },
              {
                label: 'Refresh from library spec',
                run: () => syncLine.mutate(rowMenu.line),
                show: canEdit && !!rowMenu.line.specId && !rowMenu.line.poId,
              },
              {
                label: 'Open library spec',
                run: () => nav(`/app/specs/${rowMenu.line.specId}`),
                show: !!rowMenu.line.specId,
              },
              {
                label: rowMenu.line.readyToOrder ? 'Unmark ready to order' : 'Mark ready to order',
                run: () => onPatch(rowMenu.line, { readyToOrder: !rowMenu.line.readyToOrder }),
                show: canReady && !rowMenu.line.poId && rowMenu.line.isSelected,
              },
              {
                label: 'Delete line',
                run: () => deleteLine.mutate(rowMenu.line),
                show: canEdit && !rowMenu.line.poId,
                danger: true,
              },
            ]
              .filter((x) => x.show)
              .map((x) => (
                <button
                  key={x.label}
                  type="button"
                  role="menuitem"
                  className={cx('flex w-full px-3 py-1.5 text-left hover:bg-stone', x.danger && 'text-crit')}
                  onClick={() => {
                    setRowMenu(null);
                    x.run();
                  }}
                >
                  {x.label}
                </button>
              ))}
          </div>
        )}
      </Popover>
    </div>
  );
}

function FilterChip({ children, onClear }: { children: React.ReactNode; onClear: () => void }) {
  return (
    <span className="inline-flex h-7 items-center gap-1 rounded-sm bg-brass-50 pr-1 pl-2.5 text-[13px] font-[560] text-ink">
      {children}
      <button
        type="button"
        aria-label="Clear filter"
        onClick={onClear}
        className="grid size-5 place-items-center rounded-xs hover:bg-brass-100"
      >
        <X className="size-3.5" />
      </button>
    </span>
  );
}

// ================================================================ settings (If-Match)
function QuoteSettingsSheet({
  open,
  onClose,
  quote,
}: {
  open: boolean;
  onClose: () => void;
  quote: QuoteDetail;
}) {
  const qc = useQueryClient();
  const costs = useCostsVisible();
  const [f, setF] = useState<Record<string, string>>({});
  const [conflict, setConflict] = useState(false);
  const [version, setVersion] = useState(quote.version);
  // biome-ignore lint/correctness/useExhaustiveDependencies: snapshot the quote when the sheet opens
  useEffect(() => {
    if (!open) return;
    setVersion(quote.version);
    setF({
      name: quote.name,
      phase: quote.phase ?? '',
      validUntil: quote.validUntil ?? '',
      defaultMarkupPct: String(quote.defaultMarkupPct),
      minMarginPct: quote.minMarginPct === null ? '' : String(quote.minMarginPct),
      taxRate: String(quote.taxRate),
      freightMode: quote.freightMode,
      freightPct: String(quote.freightPct),
      clientNotes: quote.clientNotes ?? '',
      notes: quote.notes ?? '',
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const set = (k: string) => (e: { target: { value: string } }) =>
    setF((x) => ({ ...x, [k]: e.target.value }));
  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {
        name: f.name?.trim(),
        phase: f.phase?.trim() || null,
        validUntil: f.validUntil || null,
        clientNotes: f.clientNotes?.trim() || null,
        notes: f.notes?.trim() || null,
      };
      if (costs) {
        const m = parseNum(f.defaultMarkupPct ?? '');
        if (m !== null && m !== quote.defaultMarkupPct) body.defaultMarkupPct = m;
        const mm = parseNum(f.minMarginPct ?? '');
        if (mm !== quote.minMarginPct) body.minMarginPct = mm;
        const tx = parseNum(f.taxRate ?? '') ?? 0;
        if (tx !== quote.taxRate) body.taxRate = tx;
        if (f.freightMode !== quote.freightMode) body.freightMode = f.freightMode;
        const fp = parseNum(f.freightPct ?? '') ?? 0;
        if (fp !== quote.freightPct) body.freightPct = fp;
      }
      return api.patch<QuoteDetail>('quoting', `/quotes/${quote.id}`, body, { 'if-match': `"${version}"` });
    },
    onSuccess: (q) => {
      toast.success('Quote settings saved');
      qc.setQueryData(qk.quote(quote.id), q);
      qc.invalidateQueries({ queryKey: qk.lines(quote.id) });
      qc.invalidateQueries({ queryKey: qk.summary(quote.id) });
      onClose();
    },
    onError: (e) => {
      if (isConflict(e) && (e as ApiError).message.toLowerCase().includes('changed')) setConflict(true);
      else toast.error(errorMessage(e));
    },
    meta: { silent: true },
  });
  return (
    <>
      <Sheet
        open={open}
        onClose={onClose}
        title="Quote settings"
        description="Changing markup, margin floor, tax or freight re-prices every line."
        footer={
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              loading={save.isPending}
              disabled={!f.name?.trim()}
              onClick={() => save.mutate()}
            >
              Save settings
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Quote name">
            {(id) => <Input id={id} value={f.name ?? ''} onChange={set('name')} />}
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Phase">
              {(id) => <Input id={id} value={f.phase ?? ''} onChange={set('phase')} />}
            </Field>
            <Field label="Valid until">
              {(id) => <Input id={id} type="date" value={f.validUntil ?? ''} onChange={set('validUntil')} />}
            </Field>
          </div>
          {costs && (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Default markup %">
                  {(id) => (
                    <Input
                      id={id}
                      className="num"
                      inputMode="decimal"
                      value={f.defaultMarkupPct ?? ''}
                      onChange={set('defaultMarkupPct')}
                    />
                  )}
                </Field>
                <Field label="Minimum margin %">
                  {(id) => (
                    <Input
                      id={id}
                      className="num"
                      inputMode="decimal"
                      value={f.minMarginPct ?? ''}
                      onChange={set('minMarginPct')}
                    />
                  )}
                </Field>
                <Field label="Tax %">
                  {(id) => (
                    <Input
                      id={id}
                      className="num"
                      inputMode="decimal"
                      value={f.taxRate ?? ''}
                      onChange={set('taxRate')}
                    />
                  )}
                </Field>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Freight">
                  {(id) => (
                    <Select
                      id={id}
                      value={f.freightMode ?? 'per_line'}
                      onChange={set('freightMode')}
                      options={[
                        { value: 'per_line', label: 'Per line (in landed cost)' },
                        { value: 'percent', label: 'Percent of sell' },
                      ]}
                    />
                  )}
                </Field>
                {f.freightMode === 'percent' && (
                  <Field label="Freight %">
                    {(id) => (
                      <Input
                        id={id}
                        className="num"
                        inputMode="decimal"
                        value={f.freightPct ?? ''}
                        onChange={set('freightPct')}
                      />
                    )}
                  </Field>
                )}
              </div>
            </>
          )}
          <Field label="Notes for the owner" hint="Printed on the owner’s quote.">
            {(id) => <Textarea id={id} rows={3} value={f.clientNotes ?? ''} onChange={set('clientNotes')} />}
          </Field>
          <Field label="Internal notes">
            {(id) => <Textarea id={id} rows={3} value={f.notes ?? ''} onChange={set('notes')} />}
          </Field>
        </div>
      </Sheet>
      <Dialog
        open={conflict}
        onClose={() => setConflict(false)}
        title="This quote changed — reload"
        footer={
          <>
            <Button onClick={() => setConflict(false)}>Keep editing</Button>
            <Button
              variant="primary"
              onClick={async () => {
                setConflict(false);
                const q = await qc.fetchQuery({
                  queryKey: qk.quote(quote.id),
                  queryFn: () => api.get<QuoteDetail>('quoting', `/quotes/${quote.id}`),
                });
                setVersion(q.version);
                qc.invalidateQueries({ queryKey: qk.lines(quote.id) });
                onClose();
                toast.message('Reloaded the latest version. Re-open settings to make your change.');
              }}
            >
              Reload quote
            </Button>
          </>
        }
      >
        <p className="text-ink-2">
          Someone else saved changes to this quote while you were editing, so your settings weren’t saved.
          Reload to see the latest version, then make your change again.
        </p>
      </Dialog>
    </>
  );
}
