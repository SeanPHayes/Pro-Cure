import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileSpreadsheet, Plus } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import {
  Button,
  Chips,
  EmptyState,
  ErrorNote,
  Field,
  Input,
  PageHeader,
  SearchInput,
  Select,
  Sheet,
  StatusBadge,
} from '@/components/ui';
import { type Column, DataTable, Pagination } from '@/components/ui/DataTable';
import { api, type Page } from '@/lib/api';
import { hasPerm, useSession } from '@/lib/auth';
import { ago, date, daysFromToday, money } from '@/lib/format';
import { useListParams, useSearchParamInput } from '@/lib/hooks';
import { MarginCell, parseNum, QUOTE_STATUS_LABEL, qk, useCostsVisible, useProjects } from './shared';
import type { QuoteDetail, QuoteListItem } from './types';

const DEFAULTS = { status: 'open', projectId: '', templates: 'quotes', q: '', limit: '50' };

/** Chip groups map onto the API's single status filter (or client-side groups). */
const STATUS_CHIPS = [
  { value: 'open', label: 'Open' },
  { value: 'draft', label: 'Draft' },
  { value: 'costing', label: 'Costing' },
  { value: 'merchandising', label: 'Merchandising' },
  { value: 'pending_internal_approval', label: 'Awaiting approval' },
  { value: 'sent', label: 'With owner' },
  { value: 'client_approved', label: 'Approved' },
  { value: 'all', label: 'All' },
] as const;
/** Quotes someone still has to act on (owner-approved quotes still need ordering). */
const OPEN = new Set([
  'draft',
  'costing',
  'merchandising',
  'pending_internal_approval',
  'sent',
  'client_rejected',
  'client_approved',
]);

/** Flag counts aren't on the list endpoint; fetch each visible quote's header lazily (cached). */
function FlagCount({ id }: { id: string }) {
  const q = useQuery({
    queryKey: qk.quote(id),
    queryFn: () => api.get<QuoteDetail>('quoting', `/quotes/${id}`),
    staleTime: 60_000,
    meta: { silent: true },
  });
  if (!q.data) return <span className="text-ink-4">·</span>;
  const n = Object.values(q.data.totals.flagCounts).reduce((a, b) => a + b, 0);
  return n ? (
    <span className="num rounded-xs bg-warn-50 px-1.5 py-0.5 text-[12px] font-[560] text-warn">{n}</span>
  ) : (
    <span className="text-ink-4">0</span>
  );
}

export function Component() {
  const s = useSession();
  const nav = useNavigate();
  const costs = useCostsVisible();
  const [p, set] = useListParams(DEFAULTS);
  const [text, setText] = useSearchParamInput(p.q, (q) => set({ q }));
  const [creating, setCreating] = useState(false);
  const projects = useProjects();
  const projectById = useMemo(() => new Map(projects.data?.map((x) => [x.id, x])), [projects.data]);
  const templates = p.templates === 'templates';
  const serverStatus = p.status === 'open' || p.status === 'all' || templates ? undefined : p.status;
  const query = {
    status: serverStatus,
    projectId: p.projectId || undefined,
    isTemplate: templates ? 'true' : 'false',
    q: p.q || undefined,
    limit: p.status === 'open' ? 500 : Number(p.limit),
    offset: p.status === 'open' ? 0 : Number(p.offset),
  };
  const list = useQuery({
    queryKey: qk.quotes(query),
    queryFn: () => api.get<Page<QuoteListItem>>('quoting', '/quotes', query),
    placeholderData: keepPreviousData,
  });
  const rows = useMemo(
    () =>
      (list.data?.items ?? [])
        .filter((r) => templates || p.status !== 'open' || OPEN.has(r.status))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [list.data, p.status, templates],
  );
  const filtered = !!(p.projectId || p.q || p.status !== 'open');
  const canWrite = hasPerm(s, 'quotes:write');

  const columns: Column<QuoteListItem>[] = [
    {
      key: 'number',
      header: 'Number',
      width: 100,
      cell: (r) => <span className="num whitespace-nowrap text-ink-2">{r.number}</span>,
    },
    {
      key: 'name',
      header: templates ? 'Template' : 'Quote',
      cell: (r) => (
        <div className="min-w-[220px]">
          <div className="font-[560]">{r.isTemplate ? (r.templateName ?? r.name) : r.name}</div>
          {r.phase && <div className="text-[12px] text-ink-3">{r.phase}</div>}
        </div>
      ),
    },
    ...(!templates
      ? [
          {
            key: 'project',
            header: 'Project',
            cell: (r: QuoteListItem) => {
              const pr = r.projectId ? projectById.get(r.projectId) : null;
              return pr ? (
                <div className="min-w-[180px]">
                  <div className="truncate">{pr.name}</div>
                  <div className="num text-[12px] text-ink-3">{pr.number}</div>
                </div>
              ) : (
                <span className="text-ink-4">—</span>
              );
            },
          },
          {
            key: 'status',
            header: 'Status',
            cell: (r: QuoteListItem) => (
              <StatusBadge status={r.status} label={QUOTE_STATUS_LABEL[r.status]} />
            ),
          },
        ]
      : []),
    { key: 'lines', header: 'Lines', align: 'right', cell: (r) => r.totals.lineCount },
    {
      key: 'sell',
      header: 'Sell total',
      align: 'right',
      cell: (r) => <span className="font-[560]">{money(r.totals.grandTotal, true)}</span>,
    },
    ...(costs
      ? [
          {
            key: 'margin',
            header: 'Margin',
            align: 'right' as const,
            cell: (r: QuoteListItem) => <MarginCell value={r.totals.marginPct} floor={r.minMarginPct} />,
          },
        ]
      : []),
    { key: 'flags', header: 'Flags', align: 'right', cell: (r) => <FlagCount id={r.id} /> },
    ...(!templates
      ? [
          {
            key: 'valid',
            header: 'Valid until',
            cell: (r: QuoteListItem) => {
              const d = daysFromToday(r.validUntil);
              return (
                <span
                  className={`num whitespace-nowrap ${d !== null && d < 0 && OPEN.has(r.status) ? 'text-crit' : ''}`}
                >
                  {date(r.validUntil)}
                </span>
              );
            },
          },
        ]
      : []),
    {
      key: 'updated',
      header: 'Updated',
      cell: (r) => <span className="whitespace-nowrap text-ink-2">{ago(r.updatedAt)}</span>,
    },
  ];

  return (
    <>
      <PageHeader
        title="Quotes"
        description="Every quote and template: where it stands, what it sells for, and what still needs attention."
        actions={
          canWrite && (
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
              New quote
            </Button>
          )
        }
      >
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <SearchInput
            value={text}
            onChange={setText}
            placeholder="Search number, name or phase"
            className="w-full sm:w-64"
          />
          <Chips
            value={p.templates as 'quotes' | 'templates'}
            onChange={(v) => set({ templates: v })}
            options={[
              { value: 'quotes', label: 'Quotes' },
              { value: 'templates', label: 'Templates' },
            ]}
          />
          {!templates && (
            <div className="w-full sm:w-56">
              <Select
                aria-label="Project"
                value={p.projectId}
                onChange={(e) => set({ projectId: e.target.value })}
                placeholder="All projects"
                options={(projects.data ?? []).map((x) => ({ value: x.id, label: `${x.number} ${x.name}` }))}
              />
            </div>
          )}
          {filtered && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setText('');
                set({ status: 'open', projectId: '', q: '' });
              }}
            >
              Clear filters
            </Button>
          )}
          <span className="num ml-auto text-[13px] text-ink-3">
            {list.data ? `${rows.length} of ${list.data.total}` : ''}
          </span>
        </div>
        {!templates && (
          <div className="mt-3 overflow-x-auto">
            <Chips
              value={p.status as (typeof STATUS_CHIPS)[number]['value']}
              onChange={(v) => set({ status: v })}
              options={[...STATUS_CHIPS]}
            />
          </div>
        )}
      </PageHeader>

      {list.isError ? (
        <ErrorNote error={list.error} />
      ) : (
        <div className="bg-paper [&_td:first-child]:pl-6 [&_td:last-child]:pr-6 [&_th:first-child]:pl-6 [&_th:last-child]:pr-6">
          <DataTable
            columns={columns}
            rows={list.isLoading ? undefined : rows}
            loading={list.isLoading}
            onRowClick={(r) => nav(`/app/quotes/${r.id}`)}
            empty={
              filtered || (list.data?.total ?? 0) > 0 ? (
                <EmptyState icon={<FileSpreadsheet />} title="No quotes match these filters">
                  Try another status or project, or clear the filters.
                </EmptyState>
              ) : (
                <EmptyState
                  icon={<FileSpreadsheet />}
                  title={templates ? 'No templates yet' : 'No quotes yet'}
                  action={
                    canWrite && (
                      <Button variant="primary" onClick={() => setCreating(true)}>
                        New quote
                      </Button>
                    )
                  }
                >
                  {templates
                    ? 'Save any quote as a template from its menu to reuse its rooms, locations and specs.'
                    : 'Start a quote for a project — blank, or from a prototype template.'}
                </EmptyState>
              )
            }
            footer={
              list.data &&
              p.status !== 'open' && (
                <Pagination
                  total={list.data.total}
                  limit={list.data.limit}
                  offset={list.data.offset}
                  onChange={(o) => set({ offset: String(o) })}
                />
              )
            }
          />
        </div>
      )}
      <NewQuoteSheet
        open={creating}
        onClose={() => setCreating(false)}
        defaultProjectId={p.projectId}
        onCreated={(q) => nav(`/app/quotes/${q.id}`)}
      />
    </>
  );
}

function NewQuoteSheet({
  open,
  onClose,
  defaultProjectId,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  defaultProjectId?: string;
  onCreated: (q: QuoteDetail) => void;
}) {
  const qc = useQueryClient();
  const projects = useProjects();
  const tpls = useQuery({
    queryKey: qk.quotes({ isTemplate: 'true', limit: 200 }),
    queryFn: () => api.get<Page<QuoteListItem>>('quoting', '/quotes', { isTemplate: 'true', limit: 200 }),
    enabled: open,
  });
  const [projectId, setProjectId] = useState('');
  const [name, setName] = useState('');
  const [phase, setPhase] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [markup, setMarkup] = useState('25');
  const [minMargin, setMinMargin] = useState('15');
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (open) {
      setProjectId(defaultProjectId ?? '');
      setName('');
      setPhase('');
      setTemplateId('');
      setMarkup('25');
      setMinMargin('15');
      setTouched(false);
    }
  }, [open, defaultProjectId]);
  const tpl = tpls.data?.items.find((t) => t.id === templateId);
  useEffect(() => {
    if (tpl) {
      setMarkup(String(tpl.defaultMarkupPct));
      setMinMargin(tpl.minMarginPct === null ? '' : String(tpl.minMarginPct));
    }
  }, [tpl]);

  const create = useMutation({
    mutationFn: () =>
      api.post<QuoteDetail>('quoting', '/quotes', {
        projectId,
        name: name.trim(),
        phase: phase.trim() || null,
        templateId: templateId || undefined,
        defaultMarkupPct: parseNum(markup) ?? 0,
        minMarginPct: parseNum(minMargin),
      }),
    onSuccess: (q) => {
      toast.success(`Quote ${q.number} created`);
      qc.invalidateQueries({ queryKey: ['quoting', 'quotes'] });
      onClose();
      onCreated(q);
    },
  });
  const markupN = parseNum(markup);
  const minN = parseNum(minMargin);
  const errors = {
    projectId: !projectId ? 'Choose the project this quote is for' : undefined,
    name: !name.trim() ? 'Give the quote a name, e.g. “Guestroom FF&E”' : undefined,
    markup: markupN === null || Number.isNaN(markupN) ? 'Enter a markup %' : undefined,
    minMargin: minN !== null && Number.isNaN(minN) ? 'Enter a number, or leave blank' : undefined,
  };
  const valid = !Object.values(errors).some(Boolean);

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="New quote"
      description="Quotes are organized by locations and room types. Start blank or from a prototype template."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={create.isPending}
            onClick={() => {
              setTouched(true);
              if (valid) create.mutate();
            }}
          >
            Create quote
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          setTouched(true);
          if (valid) create.mutate();
        }}
      >
        <Field label="Project" error={touched ? errors.projectId : undefined}>
          {(id) => (
            <Select
              id={id}
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              placeholder="Choose a project"
              options={(projects.data ?? []).map((x) => ({ value: x.id, label: `${x.number} ${x.name}` }))}
            />
          )}
        </Field>
        <Field label="Quote name" error={touched ? errors.name : undefined}>
          {(id) => (
            <Input
              id={id}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Guestroom & public area FF&E"
              autoFocus
            />
          )}
        </Field>
        <Field label="Phase" hint="Optional, e.g. “Budget pricing” or “Phase 1 – floors 1–4”.">
          {(id) => <Input id={id} value={phase} onChange={(e) => setPhase(e.target.value)} />}
        </Field>
        <fieldset className="space-y-2">
          <legend className="text-[13px] font-[560] text-ink-2">Start from</legend>
          <label className="flex cursor-pointer items-start gap-2.5 rounded-sm border border-line p-3 has-[:checked]:border-lacquer has-[:checked]:bg-lacquer-50">
            <input
              type="radio"
              name="start"
              className="mt-0.5 accent-lacquer"
              checked={!templateId}
              onChange={() => setTemplateId('')}
            />
            <span>
              <span className="block font-[560]">Blank quote</span>
              <span className="text-[13px] text-ink-2">Add room types, locations and specs yourself.</span>
            </span>
          </label>
          {(tpls.data?.items ?? []).map((t) => (
            <label
              key={t.id}
              className="flex cursor-pointer items-start gap-2.5 rounded-sm border border-line p-3 has-[:checked]:border-lacquer has-[:checked]:bg-lacquer-50"
            >
              <input
                type="radio"
                name="start"
                className="mt-0.5 accent-lacquer"
                checked={templateId === t.id}
                onChange={() => setTemplateId(t.id)}
              />
              <span className="min-w-0">
                <span className="block font-[560]">{t.templateName ?? t.name}</span>
                <span className="num text-[13px] text-ink-2">
                  {t.totals.lineCount} lines · rooms, locations and specs copied
                </span>
              </span>
            </label>
          ))}
        </fieldset>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Default markup %" error={touched ? errors.markup : undefined}>
            {(id) => (
              <Input
                id={id}
                inputMode="decimal"
                className="num"
                value={markup}
                onChange={(e) => setMarkup(e.target.value)}
              />
            )}
          </Field>
          <Field
            label="Minimum margin %"
            error={touched ? errors.minMargin : undefined}
            hint="Lines below it are flagged."
          >
            {(id) => (
              <Input
                id={id}
                inputMode="decimal"
                className="num"
                value={minMargin}
                onChange={(e) => setMinMargin(e.target.value)}
              />
            )}
          </Field>
        </div>
        <button type="submit" hidden />
      </form>
    </Sheet>
  );
}
