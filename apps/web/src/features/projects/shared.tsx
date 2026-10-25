import { type QueryKey, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { cx } from '@/components/ui';
import { api, type Page } from '@/lib/api';
import { humanize } from '@/lib/format';

// ------------------------------------------------------------------ Enums (mirrors @procure/domain)
export const STAGES = [
  'lead',
  'proposal',
  'design',
  'quoting',
  'client_approval',
  'procurement',
  'production',
  'logistics',
  'installation',
  'closeout',
  'complete',
] as const;
export type Stage = (typeof STAGES)[number];
export const stageIndex = (s: string) => STAGES.indexOf(s as Stage);
export const stageLabel = (s: string) => humanize(s);

export const PROJECT_STATUSES = ['active', 'on_hold', 'won', 'lost', 'closed', 'cancelled'] as const;
export const PROJECT_TYPES = ['renovation', 'new_construction', 'conversion', 'refresh', 'opening'] as const;
export const PROJECT_ROLES = [
  'project_manager',
  'designer',
  'procurement',
  'order_manager',
  'logistics',
  'sales',
  'accounting',
] as const;
export const CONTACT_ROLES = [
  'owner_rep',
  'gm',
  'site_manager',
  'gc',
  'installer',
  'warehouse',
  'architect',
  'designer',
  'other',
] as const;
export const TASK_STATUSES = ['todo', 'in_progress', 'blocked', 'done', 'skipped'] as const;
export const TASK_PARTIES = ['internal', 'client', 'vendor'] as const;

export const CONTACT_ROLE_LABEL: Record<string, string> = {
  owner_rep: 'Owner rep',
  gm: 'General manager',
  site_manager: 'Site manager',
  gc: 'General contractor',
  installer: 'Installer',
  warehouse: 'Warehouse',
  architect: 'Architect',
  designer: 'Designer',
  other: 'Other',
};
export const PARTY_LABEL: Record<string, string> = {
  internal: 'Our team',
  client: 'Owner',
  vendor: 'Vendor',
};

// ------------------------------------------------------------------ Types (mirrors services/projects/src/schemas.ts)
export interface Address {
  line1?: string;
  line2?: string;
  city?: string;
  region?: string;
  postalCode?: string;
  country?: string;
}
export interface Project {
  id: string;
  number: string;
  name: string;
  propertyName: string | null;
  brandId: string | null;
  clientOrgId: string | null;
  type: string;
  stage: Stage;
  status: string;
  keys: number | null;
  floors: number | null;
  address: Address;
  shipToAddress: Address;
  targetOpenDate: string | null;
  startDate: string | null;
  budget: number | null;
  creditTerms: string | null;
  tags: string[];
  description: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface NextMilestone {
  id: string;
  name: string;
  due: string | null;
}
export interface ProjectListItem extends Project {
  openTasks: number;
  overdueTasks: number;
  nextMilestone: NextMilestone | null;
}
export interface TeamMember {
  userId: string;
  name: string;
  email: string | null;
  role: string;
  isLead: boolean;
}
export interface Contact {
  id: string;
  projectId: string;
  name: string;
  company: string | null;
  role: string;
  email: string | null;
  phone: string | null;
  isDeliveryRecipient: boolean;
  visibleToClient: boolean;
  notes: string | null;
}
export interface Milestone {
  id: string;
  name: string;
  phase: string | null;
  party: string;
  status: string;
  startDate: string | null;
  dueDate: string | null;
  completedAt: string | null;
}
export interface ProjectDetail extends Project {
  team: TeamMember[];
  contacts: Contact[];
  milestones: Milestone[];
  taskCounts: Record<'todo' | 'in_progress' | 'blocked' | 'done' | 'skipped' | 'overdue' | 'total', number>;
}
export interface Task {
  id: string;
  projectId: string;
  key: string | null;
  name: string;
  description: string | null;
  phase: string | null;
  kind: string;
  party: string;
  status: string;
  assigneeUserId: string | null;
  assigneeName: string | null;
  assigneeRole: string | null;
  workHours: number | null;
  durationDays: number;
  startDate: string | null;
  dueDate: string | null;
  completedAt: string | null;
  completedByName: string | null;
  dependsOn: string[];
  isMilestone: boolean;
  ready: boolean;
  overdue: boolean;
  sort: number;
  updatedAt: string;
}
export interface TaskWithProject extends Task {
  projectNumber: string;
  projectName: string;
  propertyName: string | null;
}
export interface GanttTask {
  id: string;
  key: string | null;
  name: string;
  phase: string | null;
  party: string;
  kind: string;
  status: string;
  assigneeName: string | null;
  start: string | null;
  due: string | null;
  durationDays: number;
  dependsOn: string[];
  progress: number;
  isMilestone: boolean;
  critical: boolean;
  overdue: boolean;
}
export interface GanttData {
  projectId: string;
  start: string | null;
  end: string | null;
  targetOpenDate: string | null;
  tasks: GanttTask[];
}
export interface Note {
  id: string;
  projectId: string;
  authorName: string;
  body: string;
  visibility: 'internal' | 'client';
  pinned: boolean;
  createdAt: string;
}
export interface Template {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  taskCount: number;
}
export interface DashboardData {
  activeProjects: number;
  byStage: { stage: Stage; count: number }[];
  tasksDueThisWeek: number;
  overdueTasks: number;
  myTasks: TaskWithProject[];
  upcomingMilestones: TaskWithProject[];
  recentlyUpdatedProjects: {
    id: string;
    number: string;
    name: string;
    stage: Stage;
    status: string;
    updatedAt: string;
  }[];
}
export interface Member {
  userId: string;
  email: string;
  name: string;
  title: string | null;
  orgId: string;
  orgName: string;
  orgType: string;
  roles: string[];
  status: string;
}
export interface Org {
  id: string;
  type: string;
  name: string;
}

// ------------------------------------------------------------------ Queries
export const qk = {
  projects: (q?: unknown) => ['projects', 'list', q] as QueryKey,
  project: (id: string) => ['projects', 'detail', id] as QueryKey,
  gantt: (id: string) => ['projects', 'gantt', id] as QueryKey,
  projectTasks: (id: string) => ['projects', 'tasks', id] as QueryKey,
  notes: (id: string) => ['projects', 'notes', id] as QueryKey,
  tasks: (q?: unknown) => ['tasks', q] as QueryKey,
  dashboard: ['projects', 'dashboard'] as QueryKey,
};

export const useProject = (id: string) =>
  useQuery({
    queryKey: qk.project(id),
    queryFn: () => api.get<ProjectDetail>('projects', `/projects/${id}`),
  });

export const useProjectTasks = (id: string | undefined) =>
  useQuery({
    queryKey: qk.projectTasks(id ?? ''),
    queryFn: () => api.get<Task[]>('projects', `/projects/${id}/tasks`),
    enabled: !!id,
  });

/** Staff of the procurement firm (identity also returns members of connected vendor/client orgs). */
export const useStaff = () =>
  useQuery({
    queryKey: ['identity', 'users', 'staff'],
    queryFn: () => api.get<Member[]>('identity', '/users'),
    select: (rows) =>
      rows
        .filter((m) => m.orgType === 'procurement_firm' && m.status === 'active')
        .sort((a, b) => a.name.localeCompare(b.name)),
    staleTime: 5 * 60_000,
  });

export const useClientOrgs = () =>
  useQuery({
    queryKey: ['identity', 'orgs', 'client'],
    queryFn: () => api.get<Org[]>('identity', '/orgs', { type: 'client' }),
    staleTime: 5 * 60_000,
  });

export const useTemplates = () =>
  useQuery({
    queryKey: ['projects', 'templates'],
    queryFn: () => api.get<Template[]>('projects', '/task-templates'),
    staleTime: 60_000,
  });

/** Returns the id of a template to apply: the default one, creating the standard template if none exist. */
export async function ensureTemplateId(templates: Template[] | undefined, chosen?: string) {
  if (chosen) return chosen;
  const t = templates?.find((x) => x.isDefault) ?? templates?.[0];
  if (t) return t.id;
  const created = await api.post<Template>('projects', '/task-templates/default');
  return created.id;
}

// ------------------------------------------------------------------ Task actions (shared by My work, Home, Schedule)
type TaskPatchBody = Partial<
  Pick<
    Task,
    | 'status'
    | 'assigneeUserId'
    | 'assigneeName'
    | 'assigneeRole'
    | 'startDate'
    | 'dueDate'
    | 'description'
    | 'name'
    | 'dependsOn'
  >
>;

function patchCachedTasks(qc: ReturnType<typeof useQueryClient>, id: string, patch: Partial<Task>) {
  const apply = (t: Task) => (t.id === id ? { ...t, ...patch } : t);
  qc.setQueriesData<Page<TaskWithProject>>({ queryKey: ['tasks'] }, (d) =>
    d?.items ? { ...d, items: d.items.map(apply) as TaskWithProject[] } : d,
  );
  qc.setQueriesData<Task[]>({ queryKey: ['projects', 'tasks'] }, (d) =>
    Array.isArray(d) ? d.map(apply) : d,
  );
  qc.setQueriesData<GanttData>({ queryKey: ['projects', 'gantt'] }, (d) =>
    d?.tasks
      ? {
          ...d,
          tasks: d.tasks.map((t) =>
            t.id === id && patch.status
              ? { ...t, status: patch.status, progress: patch.status === 'done' ? 1 : 0 }
              : t,
          ),
        }
      : d,
  );
  qc.setQueriesData<DashboardData>({ queryKey: qk.dashboard }, (d) =>
    d?.myTasks ? { ...d, myTasks: d.myTasks.map(apply) as TaskWithProject[] } : d,
  );
}

/**
 * Complete / reopen / patch tasks with optimistic cache updates. Completed rows stay visible (struck
 * through) for the undo window before the open-task lists refetch and drop them.
 */
export function useTaskActions() {
  const qc = useQueryClient();
  const refreshAll = (delayLists = 0) => {
    qc.invalidateQueries({ queryKey: ['projects'] });
    if (delayLists) setTimeout(() => qc.invalidateQueries({ queryKey: ['tasks'] }), delayLists);
    else qc.invalidateQueries({ queryKey: ['tasks'] });
  };

  const reopen = useMutation({
    mutationFn: (t: Pick<Task, 'id' | 'name'>) => api.post<Task>('projects', `/tasks/${t.id}/reopen`),
    onMutate: (t) => patchCachedTasks(qc, t.id, { status: 'todo', completedAt: null }),
    onSuccess: (_d, t) => toast.success('Task reopened', { description: t.name }),
    onSettled: () => refreshAll(),
  });

  const complete = useMutation({
    mutationFn: (t: Pick<Task, 'id' | 'name'>) => api.post<Task>('projects', `/tasks/${t.id}/complete`),
    onMutate: (t) => patchCachedTasks(qc, t.id, { status: 'done', completedAt: new Date().toISOString() }),
    onSuccess: (_d, t) =>
      toast.success('Task completed', {
        description: t.name,
        duration: 6000,
        action: { label: 'Undo', onClick: () => reopen.mutate(t) },
      }),
    onError: (_e, t) => patchCachedTasks(qc, t.id, { status: 'todo', completedAt: null }),
    onSettled: () => refreshAll(6500),
  });

  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: TaskPatchBody; toast?: string }) =>
      api.patch<Task>('projects', `/tasks/${id}`, body),
    onMutate: ({ id, body }) => patchCachedTasks(qc, id, body),
    onSuccess: (_d, v) => toast.success(v.toast ?? 'Task updated'),
    onSettled: () => refreshAll(),
  });

  const toggle = (t: Pick<Task, 'id' | 'name' | 'status'>) =>
    t.status === 'done' || t.status === 'skipped' ? reopen.mutate(t) : complete.mutate(t);

  return { complete, reopen, patch, toggle };
}

// ------------------------------------------------------------------ Small visuals
/** Round check button for completing a task. */
export function TaskCheck({
  done,
  onToggle,
  label,
  disabled,
}: {
  done: boolean;
  onToggle: () => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: styled round check with checkbox semantics
    <button
      type="button"
      role="checkbox"
      aria-checked={done}
      aria-label={label}
      title={done ? 'Reopen task' : 'Complete task'}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      className={cx(
        'group/check grid size-[18px] shrink-0 place-items-center rounded-full border transition-colors disabled:opacity-40',
        done
          ? 'border-ok bg-ok text-white'
          : 'border-ink-4 bg-paper text-transparent hover:border-ok hover:text-ok',
      )}
    >
      <svg viewBox="0 0 12 12" className="size-2.5" aria-hidden="true">
        <path
          d="M2.5 6.2 5 8.5l4.5-5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}

/** Compact stage position for table cells: 11 ticks, filled to the current stage. */
export function StageIndicator({ stage, status }: { stage: string; status?: string }) {
  const i = stageIndex(stage);
  const muted = status && !['active', 'won'].includes(status);
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap">
      <span className="inline-flex gap-[2px]" aria-hidden="true">
        {STAGES.map((s, k) => (
          <span
            key={s}
            className={cx(
              'h-2.5 w-[3px] rounded-[1px]',
              k < i ? (muted ? 'bg-ink-4' : 'bg-lacquer-600') : k === i ? 'bg-brass' : 'bg-line',
            )}
          />
        ))}
      </span>
      <span className="text-[13px]">{stageLabel(stage)}</span>
    </span>
  );
}

/**
 * The stage sequence lead → complete as a stepped strip. With `counts` it is a portfolio view (how many
 * projects sit at each stage); with `current` it shows one project's position.
 */
export function StageStrip({
  counts,
  current,
  onSelect,
  selected,
}: {
  counts?: Partial<Record<Stage, number>>;
  current?: string;
  onSelect?: (s: Stage) => void;
  selected?: string;
}) {
  const ci = current ? stageIndex(current) : -1;
  return (
    <>
      {counts && (
        <ol className="grid grid-flow-col grid-cols-2 grid-rows-6 gap-x-4 gap-y-1.5 sm:hidden">
          {STAGES.map((s, k) => {
            const n = counts[s] ?? 0;
            return (
              <li key={s}>
                <button
                  type="button"
                  disabled={!onSelect}
                  onClick={() => onSelect?.(s)}
                  className="flex w-full items-center gap-2 rounded-xs py-0.5 text-left text-[13px]"
                >
                  <span className="num w-4 text-[11px] text-ink-4">{k + 1}</span>
                  <span className={cx('h-3 w-[3px] rounded-[1px]', n ? 'bg-lacquer-600' : 'bg-stone-2')} />
                  <span className={cx('flex-1 truncate', n ? 'text-ink' : 'text-ink-4')}>
                    {stageLabel(s)}
                  </span>
                  <span className={cx('num font-[620]', n ? 'text-ink' : 'text-ink-4')}>{n}</span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
      <div className={cx('overflow-x-auto', counts && 'max-sm:hidden')}>
        <ol className={cx('flex', counts ? 'min-w-[760px]' : 'min-w-[280px]')}>
          {STAGES.map((s, k) => {
            const n = counts?.[s] ?? 0;
            const filled = counts ? n > 0 : k < ci;
            const isCurrent = counts ? selected === s : k === ci;
            const body = (
              <>
                <span
                  className={cx(
                    'block h-[5px]',
                    k === 0 && 'rounded-l-full',
                    k === STAGES.length - 1 && 'rounded-r-full',
                    isCurrent ? 'bg-brass' : filled ? 'bg-lacquer-600' : 'bg-stone-2',
                  )}
                />
                {counts ? (
                  <span className="mt-2 flex min-w-0 items-baseline gap-1.5 px-0.5">
                    {counts && (
                      <span
                        className={cx(
                          'num text-[18px] leading-none font-[620]',
                          n ? 'text-ink' : 'text-ink-4',
                        )}
                      >
                        {n}
                      </span>
                    )}
                    <span
                      title={stageLabel(s)}
                      className={cx(
                        'min-w-0 truncate text-[12px] leading-tight',
                        isCurrent ? 'font-[620] text-ink' : filled || n ? 'text-ink-2' : 'text-ink-4',
                      )}
                    >
                      {stageLabel(s)}
                    </span>
                  </span>
                ) : (
                  <span
                    className={cx(
                      'num mt-1.5 block px-0.5 text-[11px]',
                      isCurrent ? 'font-[620] text-brass' : 'text-ink-4',
                    )}
                  >
                    {k + 1}
                  </span>
                )}
              </>
            );
            return (
              <li key={s} className="min-w-0 flex-1 pr-[3px]" aria-current={k === ci ? 'step' : undefined}>
                {onSelect ? (
                  <button
                    type="button"
                    onClick={() => onSelect(s)}
                    title={stageLabel(s)}
                    className="block w-full rounded-xs pb-1 text-left hover:bg-stone"
                    aria-label={counts ? `${stageLabel(s)}: ${n} projects` : `Set stage to ${stageLabel(s)}`}
                  >
                    {body}
                  </button>
                ) : (
                  <div className="pb-1" title={stageLabel(s)}>
                    {body}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      </div>
      {!counts && ci >= 0 && (
        <p className="mt-2 text-[13px] text-ink-2">
          <span className="font-[620] text-ink">{stageLabel(STAGES[ci]!)}</span>
          <span className="text-ink-3">
            {' '}
            · step {ci + 1} of {STAGES.length}
          </span>
          {ci < STAGES.length - 1 && (
            <span className="text-ink-3"> · next: {stageLabel(STAGES[ci + 1]!).toLowerCase()}</span>
          )}
        </p>
      )}
    </>
  );
}

export const fmtAddress = (a: Address | null | undefined) =>
  a
    ? [
        a.line1,
        a.line2,
        [a.city, [a.region, a.postalCode].filter(Boolean).join(' ')].filter(Boolean).join(', '),
      ]
        .filter(Boolean)
        .join(', ')
    : '';

export const projectLead = (team: TeamMember[] | undefined) =>
  team?.find((m) => m.role === 'project_manager' && m.isLead) ??
  team?.find((m) => m.role === 'project_manager');
