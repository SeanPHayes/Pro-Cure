import { useQuery } from '@tanstack/react-query';
import { format, parseISO } from 'date-fns';
import { CheckCircle2, Diamond } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { cx, EmptyState, ErrorNote, EscalationMark, Section, Spinner, StatusBadge } from '@/components/ui';
import {
  type DashboardData,
  PARTY_LABEL,
  qk,
  StageIndicator,
  StageStrip,
  TaskCheck,
  type TaskWithProject,
  useTaskActions,
} from '@/features/projects/shared';
import { api, type Page } from '@/lib/api';
import { useMe } from '@/lib/auth';
import { ago, date, daysFromToday, money, relativeDue } from '@/lib/format';

const greeting = () => {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
};

export function Component() {
  const s = useMe();
  const nav = useNavigate();
  const first = s.user.name.split(/\s+/)[0];
  const dash = useQuery({
    queryKey: qk.dashboard,
    queryFn: () => api.get<DashboardData>('projects', '/dashboard'),
  });
  const overdue = useQuery({
    queryKey: ['tasks', { due: 'overdue', home: true }],
    queryFn: () =>
      api.get<Page<TaskWithProject>>('projects', '/tasks', { due: 'overdue', limit: 8, sort: 'dueDate' }),
  });
  const d = dash.data;
  const counts = Object.fromEntries((d?.byStage ?? []).map((b) => [b.stage, b.count]));
  const overdueIds = new Set(overdue.data?.items.map((t) => t.id));
  const mine = d?.myTasks.filter((t) => !overdueIds.has(t.id));

  return (
    <div className="mx-auto max-w-[1360px] px-4 py-6 sm:px-6">
      <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div>
          <h1 className="text-[24px] leading-tight font-[640]">
            {greeting()}, {first}
          </h1>
          <p className="mt-1 text-ink-2">{format(new Date(), 'EEEE, MMMM d, yyyy')}</p>
        </div>
      </header>

      {dash.isError ? (
        <ErrorNote error={dash.error} />
      ) : (
        <>
          <dl className="mt-5 grid grid-cols-2 overflow-hidden rounded-md border border-line bg-paper md:grid-cols-4">
            <Figure label="Active projects" value={d?.activeProjects} to="/app/projects" />
            <Figure
              label="Overdue tasks"
              value={d?.overdueTasks}
              tone={d?.overdueTasks ? 'crit' : undefined}
              to="/app/tasks?due=overdue&assignee=all"
            />
            <Figure
              label="Due this week"
              value={d?.tasksDueThisWeek}
              to="/app/tasks?due=this_week&assignee=all"
            />
            <Figure label="Milestones in 14 days" value={d?.upcomingMilestones.length} />
          </dl>

          <Section
            className="mt-4"
            title="Portfolio by stage"
            actions={
              <Link to="/app/projects" className="text-[13px] font-[560] text-lacquer hover:underline">
                All projects
              </Link>
            }
          >
            {dash.isLoading ? (
              <div className="h-[46px]" />
            ) : (
              <StageStrip counts={counts} onSelect={(st) => nav(`/app/projects?stage=${st}`)} />
            )}
          </Section>

          <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
            <div className="min-w-0 space-y-4">
              <Section
                title="Needs attention"
                actions={
                  <Link to="/app/tasks" className="text-[13px] font-[560] text-lacquer hover:underline">
                    Open my work
                  </Link>
                }
                bodyClassName=""
              >
                {(overdue.isLoading || !!overdue.data?.items.length) && (
                  <TaskGroup
                    label="Overdue across the portfolio"
                    tone="crit"
                    count={overdue.data?.total}
                    loading={overdue.isLoading}
                    tasks={overdue.data?.items}
                    more={(overdue.data?.total ?? 0) > 8 ? '/app/tasks?due=overdue&assignee=all' : undefined}
                  />
                )}
                <TaskGroup
                  label="Assigned to me"
                  loading={dash.isLoading}
                  tasks={mine}
                  more="/app/tasks"
                  empty={
                    <EmptyState icon={<CheckCircle2 />} title="Nothing else assigned to you">
                      Tasks assigned to you on any project show up here as they become due.
                    </EmptyState>
                  }
                />
              </Section>
              <OrdersAtRisk />
            </div>
            <div className="min-w-0 space-y-4">
              <Section title="Upcoming milestones" bodyClassName="">
                {dash.isLoading ? (
                  <Pad />
                ) : !d?.upcomingMilestones.length ? (
                  <EmptyState icon={<Diamond />} title="No milestones in the next 14 days">
                    Milestones from every active project schedule appear here as they come up.
                  </EmptyState>
                ) : (
                  <ul className="divide-y divide-line-2">
                    {d.upcomingMilestones.map((m) => (
                      <li key={m.id}>
                        <Link
                          to={`/app/projects/${m.projectId}?tab=schedule`}
                          className="flex items-center gap-3 px-4 py-2.5 hover:bg-stone"
                        >
                          <DateTile d={m.dueDate} />
                          <div className="min-w-0 flex-1">
                            <div className="truncate font-[560]">{m.name}</div>
                            <div className="truncate text-[12px] text-ink-3">
                              {m.projectNumber} · {m.projectName}
                            </div>
                          </div>
                          {m.party !== 'internal' && (
                            <span className="shrink-0 text-[12px] font-[560] text-brass">
                              {PARTY_LABEL[m.party]}
                            </span>
                          )}
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>
              <PendingApprovals />
              <Section title="Recently updated projects" bodyClassName="">
                {dash.isLoading ? (
                  <Pad />
                ) : !d?.recentlyUpdatedProjects.length ? (
                  <EmptyState title="No projects yet">Create a project to start tracking it here.</EmptyState>
                ) : (
                  <ul className="divide-y divide-line-2">
                    {d.recentlyUpdatedProjects.slice(0, 6).map((p) => (
                      <li key={p.id}>
                        <Link
                          to={`/app/projects/${p.id}`}
                          className="flex items-center gap-3 px-4 py-2.5 hover:bg-stone"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="truncate font-[560]">{p.name}</div>
                            <div className="text-[12px] text-ink-3">
                              {p.number} · updated {ago(p.updatedAt)}
                            </div>
                          </div>
                          <span className="hidden shrink-0 sm:block">
                            {p.status === 'active' ? (
                              <StageIndicator stage={p.stage} />
                            ) : (
                              <StatusBadge status={p.status} />
                            )}
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

const Pad = () => (
  <div className="flex justify-center py-10">
    <Spinner />
  </div>
);

function Figure({
  label,
  value,
  tone,
  to,
}: {
  label: string;
  value: number | undefined;
  tone?: 'crit';
  to?: string;
}) {
  const body = (
    <>
      <dt className="text-[12px] text-ink-3">{label}</dt>
      <dd
        className={cx(
          'num mt-1 text-[26px] leading-none font-[620]',
          tone === 'crit' ? 'text-crit' : 'text-ink',
        )}
      >
        {value ?? <span className="text-ink-4">–</span>}
      </dd>
    </>
  );
  const cls =
    'block border-line-2 px-4 py-3.5 [&:nth-child(n+3)]:border-t md:[&:nth-child(n+3)]:border-t-0 [&:not(:first-child)]:border-l [&:nth-child(3)]:border-l-0 md:[&:nth-child(3)]:border-l';
  return to ? (
    <Link to={to} className={cx(cls, 'hover:bg-stone')}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

/** Calendar-page style date: month over day number. */
function DateTile({ d }: { d: string | null }) {
  if (!d) return <span className="w-10 shrink-0 text-center text-ink-4">—</span>;
  const x = parseISO(d);
  const n = daysFromToday(d) ?? 99;
  return (
    <span
      className={cx(
        'flex w-10 shrink-0 flex-col items-center rounded-xs border py-0.5 leading-tight',
        n <= 2 ? 'border-brass/50 bg-brass-50' : 'border-line',
      )}
    >
      <span className="text-[10.5px] text-ink-3">{format(x, 'MMM')}</span>
      <span className="num text-[15px] font-[620]">{format(x, 'd')}</span>
    </span>
  );
}

function TaskGroup({
  label,
  tone,
  count,
  tasks,
  loading,
  more,
  empty,
}: {
  label: string;
  tone?: 'crit';
  count?: number;
  tasks: TaskWithProject[] | undefined;
  loading: boolean;
  more?: string;
  empty?: ReactNode;
}) {
  const { toggle } = useTaskActions();
  return (
    <div className="border-b border-line-2 last:border-b-0">
      <div className="flex items-center justify-between bg-stone/60 px-4 py-1.5 text-[12px]">
        <span className={cx('font-[560]', tone === 'crit' ? 'text-crit' : 'text-ink-2')}>
          {label}
          {count !== undefined && <span className="num ml-1.5">{count}</span>}
        </span>
        {more && (
          <Link to={more} className="text-lacquer hover:underline">
            See all
          </Link>
        )}
      </div>
      {loading ? (
        <Pad />
      ) : !tasks?.length ? (
        empty
      ) : (
        <ul className="divide-y divide-line-2">
          {tasks.map((t) => {
            const done = t.status === 'done';
            return (
              <li key={t.id} className="flex items-center gap-3 px-4 py-2">
                <TaskCheck done={done} onToggle={() => toggle(t)} label={`Complete ${t.name}`} />
                <Link to={`/app/projects/${t.projectId}?tab=schedule`} className="group min-w-0 flex-1">
                  <div
                    className={cx(
                      'truncate font-[560] group-hover:text-lacquer',
                      done && 'text-ink-3 line-through',
                    )}
                  >
                    {t.name}
                  </div>
                  <div className="truncate text-[12px] text-ink-3">
                    {t.projectNumber} · {t.projectName}
                    {t.assigneeName && tone === 'crit' ? ` · ${t.assigneeName}` : ''}
                  </div>
                </Link>
                <DueLabel task={t} />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function DueLabel({
  task,
}: {
  task: { dueDate: string | null; status: string; overdue: boolean; completedAt?: string | null };
}) {
  const done = task.status === 'done' || task.status === 'skipped';
  if (done)
    return (
      <span className="num shrink-0 text-[12.5px] whitespace-nowrap text-ink-4">
        {task.status === 'skipped' ? 'Skipped' : task.completedAt ? `Done ${date(task.completedAt)}` : 'Done'}
      </span>
    );
  if (!task.dueDate) return <span className="shrink-0 text-[12px] text-ink-4">No date</span>;
  const n = daysFromToday(task.dueDate) ?? 0;
  return (
    <span
      className={cx(
        'num shrink-0 text-[12.5px] whitespace-nowrap',
        done ? 'text-ink-4' : n < 0 ? 'font-[560] text-crit' : n <= 1 ? 'font-[560] text-warn' : 'text-ink-2',
      )}
    >
      {relativeDue(task.dueDate)}
    </span>
  );
}

// ------------------------------------------------------------------ Slots for services that may not be up yet
interface PoRow {
  id: string;
  number: string;
  vendorName?: string;
  projectName?: string;
  status: string;
  escalation?: string;
  escalationLevel?: string;
  total?: number;
  requiredDeliveryDate?: string | null;
}

/** Purchase orders flagged at risk / critical. Hidden entirely until the orders service answers. */
function OrdersAtRisk() {
  const q = useQuery({
    queryKey: ['orders', 'purchase-orders', 'home-at-risk'],
    queryFn: () =>
      api.get<Page<PoRow>>('orders', '/purchase-orders', { escalation: 'at_risk,critical', limit: 5 }),
    retry: false,
    meta: { silent: true },
  });
  if (!q.data) return null;
  return (
    <Section
      title="Orders at risk"
      actions={
        <Link to="/app/orders" className="text-[13px] font-[560] text-lacquer hover:underline">
          All purchase orders
        </Link>
      }
      bodyClassName=""
    >
      {!q.data.items.length ? (
        <p className="px-4 py-4 text-ink-2">No purchase orders are at risk right now.</p>
      ) : (
        <ul className="divide-y divide-line-2">
          {q.data.items.map((po) => (
            <li key={po.id}>
              <Link
                to={`/app/orders/${po.id}`}
                className="flex items-center gap-3 px-4 py-2.5 hover:bg-stone"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate font-[560]">
                    {po.number}
                    {po.vendorName ? ` · ${po.vendorName}` : ''}
                  </div>
                  <div className="truncate text-[12px] text-ink-3">{po.projectName}</div>
                </div>
                {po.total !== undefined && <span className="num text-ink-2">{money(po.total, true)}</span>}
                <EscalationMark level={po.escalation ?? po.escalationLevel} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

interface ApprovalRow {
  id: string;
  entityId: string;
  quoteNumber: string | null;
  quoteName: string | null;
  policyName: string;
  reason: string;
  requestedByName: string | null;
  createdAt: string;
}

/** Quote approvals waiting on one of my roles. Hidden until the quoting service answers. */
function PendingApprovals() {
  const q = useQuery({
    queryKey: ['quoting', 'approvals', 'home-pending'],
    queryFn: () =>
      api.get<Page<ApprovalRow>>('quoting', '/approvals', { status: 'pending', mine: true, limit: 5 }),
    retry: false,
    meta: { silent: true },
  });
  if (!q.data?.items.length) return null;
  return (
    <Section
      title={
        <span>
          Waiting for your approval <span className="num ml-1 text-brass">{q.data.total}</span>
        </span>
      }
      actions={
        <Link to="/app/approvals" className="text-[13px] font-[560] text-lacquer hover:underline">
          Review approvals
        </Link>
      }
      bodyClassName=""
    >
      <ul className="divide-y divide-line-2">
        {q.data.items.map((a) => (
          <li key={a.id}>
            <Link to={`/app/quotes/${a.entityId}`} className="block px-4 py-2.5 hover:bg-stone">
              <div className="truncate font-[560]">
                {a.quoteNumber} {a.quoteName}
              </div>
              <div className="truncate text-[12px] text-ink-3">
                {a.reason} · {a.requestedByName ?? 'Someone'} {ago(a.createdAt)}
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </Section>
  );
}
