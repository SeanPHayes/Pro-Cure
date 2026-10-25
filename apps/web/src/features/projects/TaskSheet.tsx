import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, CalendarClock, Link2 } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import {
  Badge,
  Button,
  cx,
  Dialog,
  enumOptions,
  Facts,
  Field,
  Input,
  Loading,
  Select,
  Sheet,
  StatusBadge,
  Textarea,
} from '@/components/ui';
import { api } from '@/lib/api';
import { hasPerm, useSession } from '@/lib/auth';
import { date, dateTime, humanize } from '@/lib/format';
import { PARTY_LABEL, type Task, TaskCheck, useProjectTasks, useStaff, useTaskActions } from './shared';

interface RescheduleResult {
  dryRun: boolean;
  deltaDays: number;
  changes: {
    taskId: string;
    name: string;
    fromStart: string | null;
    toStart: string | null;
    fromDue: string | null;
    toDue: string | null;
  }[];
}

/**
 * Preview, then apply, a downstream schedule shift from one task. The delta defaults to the task's
 * last due-date change; the user can override it in business days.
 */
export function RescheduleDialog(props: {
  projectId: string;
  task: Pick<Task, 'id' | 'name'> | null;
  onClose: () => void;
}) {
  return <RescheduleDialogInner key={props.task?.id ?? 'none'} {...props} />;
}

function RescheduleDialogInner({
  projectId,
  task,
  onClose,
}: {
  projectId: string;
  task: Pick<Task, 'id' | 'name'> | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [delta, setDelta] = useState('');
  const deltaDays = delta.trim() === '' ? undefined : Math.round(Number(delta));
  const preview = useQuery({
    queryKey: ['projects', 'reschedule-preview', projectId, task?.id, deltaDays],
    queryFn: () =>
      api.post<RescheduleResult>(
        'projects',
        `/projects/${projectId}/reschedule`,
        { fromTaskId: task!.id, deltaDays },
        { dryRun: true },
      ),
    enabled: !!task && (deltaDays === undefined || !Number.isNaN(deltaDays)),
    gcTime: 0,
  });
  const apply = useMutation({
    mutationFn: () =>
      api.post<RescheduleResult>('projects', `/projects/${projectId}/reschedule`, {
        fromTaskId: task!.id,
        deltaDays: deltaDays ?? preview.data?.deltaDays,
      }),
    onSuccess: (r) => {
      toast.success('Schedule shifted', {
        description: `${r.changes.length} tasks moved ${Math.abs(r.deltaDays)} business days ${r.deltaDays >= 0 ? 'later' : 'earlier'}`,
      });
      qc.invalidateQueries({ queryKey: ['projects'] });
      qc.invalidateQueries({ queryKey: ['tasks'] });
      onClose();
    },
  });
  const r = preview.data;
  return (
    <Dialog
      open={!!task}
      onClose={onClose}
      width={620}
      title="Shift schedule"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={apply.isPending}
            disabled={!r?.changes.length || !r.deltaDays}
            onClick={() => apply.mutate()}
          >
            {r?.changes.length ? `Shift ${r.changes.length} tasks` : 'Shift tasks'}
          </Button>
        </>
      }
    >
      <p className="text-ink-2">
        Moves every open task that depends on <span className="font-[560] text-ink">{task?.name}</span> by the
        same number of business days.
      </p>
      <div className="mt-3 flex items-end gap-3">
        <Field label="Business days" hint="Leave empty to use this task’s last due-date change.">
          {(id) => (
            <Input
              id={id}
              className="num w-32"
              inputMode="numeric"
              placeholder={r ? String(r.deltaDays) : ''}
              value={delta}
              onChange={(e) => setDelta(e.target.value)}
            />
          )}
        </Field>
      </div>
      <div className="mt-4 max-h-[320px] overflow-y-auto rounded-sm border border-line">
        {preview.isLoading ? (
          <Loading label="Previewing" />
        ) : preview.isError ? (
          <p className="p-3 text-crit">Couldn’t preview the shift. Check the number of days and try again.</p>
        ) : !r?.changes.length || !r.deltaDays ? (
          <p className="p-4 text-ink-2">
            Nothing to move. Change this task’s due date first, or enter the number of business days to shift.
          </p>
        ) : (
          <table className="grid-table text-[13px]">
            <thead>
              <tr>
                <th>Task</th>
                <th>Due now</th>
                <th aria-label="becomes" />
                <th>New due</th>
              </tr>
            </thead>
            <tbody>
              {r.changes.map((c) => (
                <tr key={c.taskId}>
                  <td>{c.name}</td>
                  <td className="num whitespace-nowrap text-ink-3">{date(c.fromDue)}</td>
                  <td>
                    <ArrowRight className="size-3.5 text-ink-4" />
                  </td>
                  <td className="num font-[560] whitespace-nowrap">{date(c.toDue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Dialog>
  );
}

/** Task detail & edit side sheet. */
export function TaskSheet({
  task,
  onClose,
  showProject = true,
}: {
  task: (Task & { projectName?: string; projectNumber?: string }) | null;
  onClose: () => void;
  showProject?: boolean;
}) {
  if (!task) return null;
  return <TaskSheetInner key={task.id} task={task} onClose={onClose} showProject={showProject} />;
}

function TaskSheetInner({
  task: initial,
  onClose,
  showProject,
}: {
  task: Task & { projectName?: string; projectNumber?: string };
  onClose: () => void;
  showProject: boolean;
}) {
  const s = useSession();
  const canWrite = hasPerm(s, 'tasks:write');
  const fresh = useQuery({
    queryKey: ['projects', 'task', initial.id],
    queryFn: () => api.get<Task>('projects', `/tasks/${initial.id}`),
    initialData: initial,
    staleTime: 0,
  });
  const task = { ...initial, ...fresh.data };
  const siblings = useProjectTasks(task.projectId);
  const staff = useStaff();
  const { patch, toggle } = useTaskActions();
  const [f, setF] = useState({
    name: task.name,
    description: task.description ?? '',
    startDate: task.startDate ?? '',
    dueDate: task.dueDate ?? '',
    status: task.status,
    assigneeUserId: task.assigneeUserId ?? '',
  });
  const [shift, setShift] = useState(false);
  const done = task.status === 'done' || task.status === 'skipped';
  const deps = (siblings.data ?? []).filter((t) => task.dependsOn.includes(t.id));
  const dependents = (siblings.data ?? []).filter((t) => t.dependsOn.includes(task.id));
  const dirty =
    f.name !== task.name ||
    f.description !== (task.description ?? '') ||
    f.startDate !== (task.startDate ?? '') ||
    f.dueDate !== (task.dueDate ?? '') ||
    f.status !== task.status ||
    f.assigneeUserId !== (task.assigneeUserId ?? '');
  const dateError =
    f.startDate && f.dueDate && f.dueDate < f.startDate ? 'Due date is before the start.' : '';

  const save = () => {
    const body: Record<string, unknown> = {};
    if (f.name.trim() && f.name !== task.name) body.name = f.name.trim();
    if (f.description !== (task.description ?? '')) body.description = f.description || null;
    if (f.startDate !== (task.startDate ?? '')) body.startDate = f.startDate || null;
    if (f.dueDate !== (task.dueDate ?? '')) body.dueDate = f.dueDate || null;
    if (f.status !== task.status) body.status = f.status;
    if (f.assigneeUserId !== (task.assigneeUserId ?? '')) {
      const m = staff.data?.find((x) => x.userId === f.assigneeUserId);
      body.assigneeUserId = m?.userId ?? null;
      body.assigneeName = m?.name ?? null;
    }
    const dueMoved = 'dueDate' in body && dependents.some((d) => d.status !== 'done');
    patch.mutate(
      { id: task.id, body, toast: 'Task saved' },
      {
        onSuccess: () => {
          fresh.refetch();
          if (dueMoved) setShift(true);
        },
      },
    );
  };

  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF((x) => ({ ...x, [k]: e.target.value }));

  return (
    <>
      <Sheet
        open
        onClose={onClose}
        width={560}
        title={
          <span className="flex items-start gap-2.5">
            <span className="pt-1">
              <TaskCheck
                done={done}
                disabled={!canWrite}
                onToggle={() => {
                  toggle(task);
                  setTimeout(() => fresh.refetch(), 400);
                }}
                label={done ? `Reopen ${task.name}` : `Complete ${task.name}`}
              />
            </span>
            <span className={cx(done && 'text-ink-3 line-through decoration-ink-4')}>{task.name}</span>
          </span>
        }
        description={
          <span className="mt-1 flex flex-wrap items-center gap-1.5">
            <StatusBadge status={task.overdue ? 'overdue' : task.status} />
            {task.isMilestone && <Badge tone="brass">Milestone</Badge>}
            {task.party !== 'internal' && <Badge tone="info">{PARTY_LABEL[task.party]} task</Badge>}
            {task.kind !== 'task' && <Badge>{humanize(task.kind)}</Badge>}
            {!task.ready && !done && <Badge tone="warn">Waiting on prerequisites</Badge>}
          </span>
        }
        footer={
          canWrite && (
            <>
              <Button variant="ghost" onClick={onClose}>
                Close
              </Button>
              <Button
                variant="primary"
                disabled={!dirty || !!dateError}
                loading={patch.isPending}
                onClick={save}
              >
                Save task
              </Button>
            </>
          )
        }
      >
        <div className="space-y-5">
          {showProject && task.projectName && (
            <Link
              to={`/app/projects/${task.projectId}?tab=schedule`}
              className="flex items-center justify-between rounded-sm border border-line px-3 py-2 hover:border-ink-4 hover:bg-stone"
            >
              <span className="min-w-0">
                <span className="block text-[12px] text-ink-3">Project</span>
                <span className="block truncate font-[560]">
                  {task.projectNumber} {task.projectName}
                </span>
              </span>
              <ArrowRight className="size-4 text-ink-3" />
            </Link>
          )}

          {canWrite ? (
            <>
              <Field label="Task">{(id) => <Input id={id} value={f.name} onChange={set('name')} />}</Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Assignee">
                  {(id) => (
                    <Select
                      id={id}
                      value={f.assigneeUserId}
                      onChange={set('assigneeUserId')}
                      placeholder="Unassigned"
                      options={(staff.data ?? []).map((m) => ({ value: m.userId, label: m.name }))}
                    />
                  )}
                </Field>
                <Field label="Status">
                  {(id) => (
                    <Select
                      id={id}
                      value={f.status}
                      onChange={set('status')}
                      options={enumOptions(['todo', 'in_progress', 'blocked', 'done', 'skipped'])}
                    />
                  )}
                </Field>
                <Field label="Start">
                  {(id) => <Input id={id} type="date" value={f.startDate} onChange={set('startDate')} />}
                </Field>
                <Field label="Due" error={dateError || undefined}>
                  {(id) => <Input id={id} type="date" value={f.dueDate} onChange={set('dueDate')} />}
                </Field>
              </div>
              <Field label="Description">
                {(id) => (
                  <Textarea
                    id={id}
                    rows={4}
                    value={f.description}
                    onChange={set('description')}
                    placeholder="What needs to happen, links, who to ask…"
                  />
                )}
              </Field>
            </>
          ) : (
            <Facts
              cols={2}
              items={[
                { label: 'Assignee', value: task.assigneeName ?? 'Unassigned' },
                { label: 'Due', value: date(task.dueDate) },
                { label: 'Start', value: date(task.startDate) },
                { label: 'Description', value: task.description },
              ]}
            />
          )}

          <Facts
            cols={2}
            items={[
              { label: 'Role', value: task.assigneeRole ? humanize(task.assigneeRole) : '—' },
              { label: 'Phase', value: task.phase ?? '—' },
              { label: 'Duration', value: `${task.durationDays} business days` },
              { label: 'Effort', value: task.workHours ? `${task.workHours} hours` : '—' },
              ...(task.completedAt
                ? [
                    {
                      label: 'Completed',
                      value: `${dateTime(task.completedAt)} by ${task.completedByName ?? '—'}`,
                    },
                  ]
                : []),
            ]}
          />

          <DepList
            title="Waits for"
            icon={<Link2 className="size-3.5" />}
            tasks={deps}
            empty="No prerequisites."
          />
          <DepList
            title="Unblocks"
            icon={<ArrowRight className="size-3.5" />}
            tasks={dependents}
            empty="Nothing depends on this task."
            action={
              canWrite &&
              dependents.length > 0 && (
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<CalendarClock className="size-4" />}
                  onClick={() => setShift(true)}
                >
                  Shift schedule
                </Button>
              )
            }
          />
        </div>
      </Sheet>
      <RescheduleDialog
        projectId={task.projectId}
        task={shift ? task : null}
        onClose={() => setShift(false)}
      />
    </>
  );
}

function DepList({
  title,
  icon,
  tasks,
  empty,
  action,
}: {
  title: string;
  icon: React.ReactNode;
  tasks: Task[];
  empty: string;
  action?: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <h3 className="flex items-center gap-1.5 text-[13px] font-[620] text-ink-2">
          {icon}
          {title}
        </h3>
        {action}
      </div>
      {!tasks.length ? (
        <p className="text-[13px] text-ink-3">{empty}</p>
      ) : (
        <ul className="divide-y divide-line-2 rounded-sm border border-line">
          {tasks.map((t) => (
            <li key={t.id} className="flex items-center gap-2 px-3 py-1.5 text-[13px]">
              <span
                className={cx(
                  'size-2 shrink-0 rounded-full',
                  t.status === 'done' ? 'bg-ok' : t.overdue ? 'bg-crit' : 'bg-ink-4',
                )}
              />
              <span className={cx('min-w-0 flex-1 truncate', t.status === 'done' && 'text-ink-3')}>
                {t.name}
              </span>
              <span className="num shrink-0 text-ink-3">
                {t.status === 'done' ? 'Done' : date(t.dueDate)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
