import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { addDays, endOfWeek, format, parseISO } from 'date-fns';
import { CheckCircle2, ClipboardList, Diamond, Hourglass } from 'lucide-react';
import { type KeyboardEvent, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Chips, cx, EmptyState, ErrorNote, Loading, PageHeader, SearchInput, Select } from '@/components/ui';
import { DueLabel } from '@/features/home/Dashboard';
import { api, type Page } from '@/lib/api';
import { hasPerm, useSession } from '@/lib/auth';
import { daysFromToday } from '@/lib/format';
import { useListParams, useSearchParamInput } from '@/lib/hooks';
import { PARTY_LABEL, qk, TaskCheck, type TaskWithProject, useStaff, useTaskActions } from './shared';
import { TaskSheet } from './TaskSheet';

const DEFAULTS = { due: '', assignee: 'me', party: '', status: 'open', group: 'date', q: '' };
const STATUS_QUERY: Record<string, string | undefined> = {
  open: undefined, // server default: todo, in_progress, blocked
  in_progress: 'in_progress',
  blocked: 'blocked',
  done: 'done',
};

type Bucket = { key: string; label: string; tone?: 'crit' | 'warn' };
function dateBucket(t: TaskWithProject): Bucket {
  if (!t.dueDate) return { key: '9', label: 'No due date' };
  const n = daysFromToday(t.dueDate)!;
  const now = new Date();
  const weekEnd = endOfWeek(now, { weekStartsOn: 1 });
  const nextWeekEnd = addDays(weekEnd, 7);
  const d = parseISO(t.dueDate);
  if (n < 0 && t.status !== 'done') return { key: '0', label: 'Overdue', tone: 'crit' };
  if (n < 0) return { key: '0', label: 'Earlier' };
  if (n === 0) return { key: '1', label: 'Today', tone: 'warn' };
  if (n === 1) return { key: '2', label: 'Tomorrow' };
  if (d <= weekEnd) return { key: '3', label: 'Later this week' };
  if (d <= nextWeekEnd) return { key: '4', label: 'Next week' };
  return { key: `5${format(d, 'yyyyMM')}`, label: format(d, 'MMMM yyyy') };
}

export function Component() {
  const s = useSession();
  const canWrite = hasPerm(s, 'tasks:write');
  const [p, set] = useListParams(DEFAULTS);
  const [text, setText] = useSearchParamInput(p.q, (q) => set({ q }));
  const [open, setOpen] = useState<TaskWithProject | null>(null);
  const staff = useStaff();
  const { toggle, patch } = useTaskActions();

  const query = {
    due: p.due || undefined,
    assignee: p.assignee === 'all' ? undefined : p.assignee,
    party: p.party || undefined,
    status: STATUS_QUERY[p.status],
    q: p.q || undefined,
    sort: p.group === 'project' ? 'project' : p.status === 'done' ? '-updatedAt' : 'dueDate',
    limit: 300,
  };
  const list = useQuery({
    queryKey: qk.tasks(query),
    queryFn: () => api.get<Page<TaskWithProject>>('projects', '/tasks', query),
    placeholderData: keepPreviousData,
  });

  const groups = useMemo(() => {
    const items = list.data?.items ?? [];
    const m = new Map<
      string,
      { label: string; sub?: string; tone?: string; to?: string; items: TaskWithProject[] }
    >();
    for (const t of items) {
      let key: string;
      let head: { label: string; sub?: string; tone?: string; to?: string };
      if (p.group === 'project') {
        key = t.projectNumber;
        head = {
          label: t.projectName,
          sub: t.projectNumber,
          to: `/app/projects/${t.projectId}?tab=schedule`,
        };
      } else {
        const b = dateBucket(t);
        key = b.key;
        head = { label: b.label, tone: b.tone };
      }
      const g = m.get(key) ?? { ...head, items: [] };
      g.items.push(t);
      m.set(key, g);
    }
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, g]) => g);
  }, [list.data, p.group]);

  const total = list.data?.total ?? 0;
  const filtered = p.due || p.party || p.q || p.status !== 'open' || p.assignee !== 'me';

  const onRowKey = (e: KeyboardEvent, t: TaskWithProject) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter') setOpen(t);
    if ((e.key === 'x' || e.key === ' ') && canWrite) {
      e.preventDefault();
      toggle(t);
    }
    if (e.key === 'ArrowDown' || e.key === 'j') {
      e.preventDefault();
      (e.currentTarget.nextElementSibling as HTMLElement | null)?.focus();
    }
    if (e.key === 'ArrowUp' || e.key === 'k') {
      e.preventDefault();
      (e.currentTarget.previousElementSibling as HTMLElement | null)?.focus();
    }
  };

  return (
    <>
      <PageHeader
        title="My work"
        description="Everything that needs doing across your hotel projects, in one list."
        actions={
          <Chips
            value={p.group as 'date' | 'project'}
            onChange={(group) => set({ group })}
            options={[
              { value: 'date', label: 'By date' },
              { value: 'project', label: 'By project' },
            ]}
          />
        }
      >
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Chips
            value={p.assignee as 'me' | 'unassigned' | 'all'}
            onChange={(assignee) => set({ assignee })}
            options={[
              { value: 'me', label: 'Mine' },
              { value: 'unassigned', label: 'Unassigned' },
              { value: 'all', label: 'Everyone' },
            ]}
          />
          <div className="max-w-full overflow-x-auto">
            <Chips
              value={(p.due || 'all') as string}
              onChange={(due) => set({ due: due === 'all' ? '' : due })}
              options={[
                { value: 'all', label: 'Any time' },
                { value: 'overdue', label: 'Overdue' },
                { value: 'today', label: 'Today' },
                { value: 'this_week', label: 'This week' },
                { value: 'next_week', label: 'Next week' },
              ]}
            />
          </div>
          <div className="w-[140px]">
            <Select
              aria-label="Whose task"
              value={p.party}
              onChange={(e) => set({ party: e.target.value })}
              placeholder="Any party"
              options={[
                { value: 'internal', label: 'Our team' },
                { value: 'client', label: 'Owner' },
                { value: 'vendor', label: 'Vendor' },
              ]}
            />
          </div>
          <div className="w-[140px]">
            <Select
              aria-label="Status"
              value={p.status}
              onChange={(e) => set({ status: e.target.value })}
              options={[
                { value: 'open', label: 'Open' },
                { value: 'in_progress', label: 'In progress' },
                { value: 'blocked', label: 'Blocked' },
                { value: 'done', label: 'Done' },
              ]}
            />
          </div>
          <SearchInput
            value={text}
            onChange={setText}
            placeholder="Search tasks"
            className="w-full sm:w-56"
          />
        </div>
      </PageHeader>

      <div className="mx-auto max-w-[1180px] px-4 py-5 sm:px-6">
        <div className="mb-2 flex items-center justify-between text-[13px] text-ink-3">
          <span className="num">
            {list.data ? `${total} ${total === 1 ? 'task' : 'tasks'}` : ' '}
            {list.isFetching && !list.isLoading ? ' · updating' : ''}
          </span>
          <span className="hidden md:block">
            <Kbd>↑</Kbd> <Kbd>↓</Kbd> to move, <Kbd>x</Kbd> to complete, <Kbd>Enter</Kbd> to open
          </span>
        </div>
        {list.isError ? (
          <ErrorNote error={list.error} />
        ) : list.isLoading ? (
          <Loading label="Loading tasks" />
        ) : !groups.length ? (
          <div className="rounded-md border border-line bg-paper">
            {filtered ? (
              <EmptyState icon={<ClipboardList />} title="No tasks match these filters">
                Try a wider date range, or switch to everyone’s tasks.
              </EmptyState>
            ) : (
              <EmptyState icon={<CheckCircle2 />} title="You’re all caught up">
                Nothing is assigned to you right now. Unassigned tasks on your projects are under
                “Unassigned”.
              </EmptyState>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            {groups.map((g) => (
              <section
                key={g.label + (g.sub ?? '')}
                className="overflow-hidden rounded-md border border-line bg-paper"
              >
                <header className="flex items-baseline gap-2 border-b border-line-2 bg-stone/60 px-4 py-2">
                  {g.to ? (
                    <Link to={g.to} className="font-[620] hover:text-lacquer hover:underline">
                      {g.label}
                    </Link>
                  ) : (
                    <h2
                      className={cx(
                        'font-[620]',
                        g.tone === 'crit' && 'text-crit',
                        g.tone === 'warn' && 'text-warn',
                      )}
                    >
                      {g.label}
                    </h2>
                  )}
                  {g.sub && <span className="num text-[12px] text-ink-3">{g.sub}</span>}
                  <span className="num ml-auto text-[12px] text-ink-3">{g.items.length}</span>
                </header>
                <div>
                  {g.items.map((t) => {
                    const done = t.status === 'done' || t.status === 'skipped';
                    return (
                      // biome-ignore lint/a11y/useSemanticElements: row opens a sheet and contains its own controls (nested buttons are invalid)
                      <div
                        key={t.id}
                        tabIndex={0}
                        role="button"
                        aria-label={`Open ${t.name}`}
                        onClick={() => setOpen(t)}
                        onKeyDown={(e) => onRowKey(e, t)}
                        className={cx(
                          'grid cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 border-b border-line-2 px-4 py-2 last:border-b-0 hover:bg-[#fafbf9] focus-visible:bg-brass-50 focus-visible:outline-none md:grid-cols-[auto_minmax(0,1fr)_170px_110px]',
                          open?.id === t.id && 'bg-brass-50',
                        )}
                      >
                        <TaskCheck
                          done={done}
                          disabled={!canWrite}
                          onToggle={() => toggle(t)}
                          label={done ? `Reopen ${t.name}` : `Complete ${t.name}`}
                        />
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            {t.isMilestone && <Diamond className="size-3 shrink-0 fill-brass text-brass" />}
                            <span
                              className={cx(
                                'truncate font-[560] transition-colors',
                                done && 'text-ink-3 line-through decoration-ink-4',
                              )}
                            >
                              {t.name}
                            </span>
                            {t.party !== 'internal' && (
                              <span className="shrink-0 rounded-xs bg-info-50 px-1 text-[11.5px] font-[560] text-info">
                                {PARTY_LABEL[t.party]}
                              </span>
                            )}
                            {!t.ready && !done && (
                              <span title="Waiting on prerequisites" className="shrink-0">
                                <Hourglass
                                  className="size-3 text-ink-4"
                                  aria-label="Waiting on prerequisites"
                                />
                              </span>
                            )}
                            {t.status === 'blocked' && (
                              <span className="shrink-0 rounded-xs bg-risk-50 px-1 text-[11.5px] font-[560] text-risk">
                                Blocked
                              </span>
                            )}
                          </div>
                          <div className="truncate text-[12px] text-ink-3">
                            {p.group === 'project' ? t.phase : `${t.projectNumber} · ${t.projectName}`}
                          </div>
                        </div>
                        <div className="hidden md:block">
                          {canWrite ? (
                            <select
                              aria-label={`Assignee for ${t.name}`}
                              value={t.assigneeUserId ?? ''}
                              onClick={(e) => e.stopPropagation()}
                              onKeyDown={(e) => e.stopPropagation()}
                              onChange={(e) => {
                                const m = staff.data?.find((x) => x.userId === e.target.value);
                                patch.mutate({
                                  id: t.id,
                                  body: { assigneeUserId: m?.userId ?? null, assigneeName: m?.name ?? null },
                                  toast: m ? `Assigned to ${m.name}` : 'Task unassigned',
                                });
                              }}
                              className={cx(
                                'h-7 w-full cursor-pointer appearance-none truncate rounded-xs border border-transparent bg-transparent px-1.5 text-[13px] hover:border-line hover:bg-paper focus:border-lacquer focus:outline-none',
                                t.assigneeUserId ? 'text-ink-2' : 'text-ink-4',
                              )}
                            >
                              <option value="">Unassigned</option>
                              {t.assigneeUserId &&
                                !staff.data?.some((m) => m.userId === t.assigneeUserId) && (
                                  <option value={t.assigneeUserId}>{t.assigneeName}</option>
                                )}
                              {staff.data?.map((m) => (
                                <option key={m.userId} value={m.userId}>
                                  {m.name}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <span className="text-[13px] text-ink-2">{t.assigneeName ?? 'Unassigned'}</span>
                          )}
                        </div>
                        <div className="text-right">
                          <DueLabel task={t} />
                          {t.dueDate && (
                            <div className="num hidden text-[11.5px] text-ink-4 md:block">
                              {format(parseISO(t.dueDate), 'EEE, MMM d')}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            ))}
            {total > (list.data?.items.length ?? 0) && (
              <p className="text-center text-[13px] text-ink-3">
                Showing the first {list.data?.items.length} of {total}. Narrow the filters to see the rest.
              </p>
            )}
          </div>
        )}
      </div>
      <TaskSheet task={open} onClose={() => setOpen(null)} />
    </>
  );
}

const Kbd = ({ children }: { children: string }) => (
  <kbd className="rounded-xs border border-line bg-paper px-1 text-[11px] text-ink-2">{children}</kbd>
);
