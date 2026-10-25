import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, CalendarPlus, Diamond, FileDown, ListChecks } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  Button,
  Checkbox,
  Chips,
  cx,
  Dialog,
  EmptyState,
  ErrorNote,
  Field,
  Input,
  Loading,
  Select,
} from '@/components/ui';
import { Gantt, GanttLegend, type GanttZoom } from '@/components/ui/Gantt';
import { DueLabel } from '@/features/home/Dashboard';
import { ApiError, api, documentUrl } from '@/lib/api';
import { hasPerm, useSession } from '@/lib/auth';
import { date, isoToday } from '@/lib/format';
import {
  ensureTemplateId,
  type GanttData,
  PARTY_LABEL,
  type ProjectDetail,
  qk,
  type Task,
  TaskCheck,
  useProjectTasks,
  useTaskActions,
  useTemplates,
} from './shared';
import { RescheduleDialog, TaskSheet } from './TaskSheet';

export function ScheduleTab({ project }: { project: ProjectDetail }) {
  const s = useSession();
  const canWrite = hasPerm(s, 'tasks:write');
  const [view, setView] = useState<'chart' | 'list'>(() => (window.innerWidth < 700 ? 'list' : 'chart'));
  const [zoom, setZoom] = useState<GanttZoom>('month');
  const [deps, setDeps] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [shiftFrom, setShiftFrom] = useState<Task | null>(null);
  const [pickShift, setPickShift] = useState(false);
  const gantt = useQuery({
    queryKey: qk.gantt(project.id),
    queryFn: () => api.get<GanttData>('projects', `/projects/${project.id}/gantt`),
  });
  const tasks = useProjectTasks(project.id);
  const openTask = tasks.data?.find((t) => t.id === openId) ?? null;

  const report = useMutation({
    mutationFn: () =>
      api.post<{ id: string; filename: string }>('projects', `/projects/${project.id}/reports/schedule`, {}),
    onSuccess: (doc) => {
      toast.success('Schedule report created', { description: doc.filename });
      window.open(documentUrl(doc.id), '_blank', 'noopener');
    },
    onError: (e) =>
      toast.error('Couldn’t create the schedule report', {
        description:
          e instanceof ApiError && e.status >= 500
            ? 'The documents service isn’t available yet. Try again in a few minutes.'
            : e instanceof Error
              ? e.message
              : undefined,
      }),
  });

  const items = useMemo(
    () =>
      (gantt.data?.tasks ?? []).map((t) => ({
        id: t.id,
        name: t.name,
        group: t.phase ?? 'Other',
        start: t.start,
        end: t.due,
        milestone: t.isMilestone,
        critical: t.critical && t.status !== 'done',
        done: t.status === 'done' || t.status === 'skipped',
        inProgress: t.status === 'in_progress',
        overdue: t.overdue,
        external: t.party !== 'internal',
        dependsOn: t.dependsOn,
        sub: t.party !== 'internal' ? PARTY_LABEL[t.party] : t.assigneeName?.split(' ')[0],
      })),
    [gantt.data],
  );

  if (gantt.isLoading) return <Loading label="Loading schedule" />;
  if (gantt.isError) return <ErrorNote error={gantt.error} />;
  const g = gantt.data!;
  const crit = g.tasks.filter((t) => t.critical && t.status !== 'done').length;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {g.tasks.length > 0 && (
          <Chips
            value={view}
            onChange={setView}
            options={[
              { value: 'chart', label: 'Gantt' },
              { value: 'list', label: 'Task list' },
            ]}
          />
        )}
        {view === 'chart' && g.tasks.length > 0 && (
          <>
            <Chips
              value={zoom}
              onChange={setZoom}
              options={[
                { value: 'week', label: 'Weeks' },
                { value: 'month', label: 'Months' },
                { value: 'quarter', label: 'Year' },
              ]}
            />
            {/* biome-ignore lint/a11y/noLabelWithoutControl: wraps the Checkbox input */}
            <label className="flex items-center gap-1.5 text-[13px] text-ink-2">
              <Checkbox checked={deps} onChange={setDeps} label="Show dependencies" />
              Dependencies
            </label>
          </>
        )}
        <div className="ml-auto flex flex-wrap gap-2">
          {canWrite && (
            <>
              <Button size="sm" icon={<CalendarPlus className="size-4" />} onClick={() => setApplying(true)}>
                Apply template
              </Button>
              <Button
                size="sm"
                icon={<CalendarClock className="size-4" />}
                disabled={!g.tasks.length}
                onClick={() => setPickShift(true)}
              >
                Shift schedule
              </Button>
            </>
          )}
          <Button
            size="sm"
            icon={<FileDown className="size-4" />}
            loading={report.isPending}
            disabled={!g.tasks.length}
            onClick={() => report.mutate()}
          >
            Schedule report
          </Button>
        </div>
      </div>

      {!g.tasks.length ? (
        <div className="rounded-md border border-line bg-paper">
          <EmptyState
            icon={<ListChecks />}
            title="No schedule yet"
            action={
              canWrite && (
                <Button variant="primary" onClick={() => setApplying(true)}>
                  Apply template
                </Button>
              )
            }
          >
            Apply the standard FF&E template to generate kickoff-to-closeout tasks and milestones, scheduled
            in business days from a start date.
          </EmptyState>
        </div>
      ) : view === 'chart' ? (
        <>
          <Gantt
            items={items}
            today={isoToday()}
            target={g.targetOpenDate}
            zoom={zoom}
            showDependencies={deps}
            selectedId={openId}
            onSelect={setOpenId}
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <GanttLegend />
            <span className="text-[12px] text-ink-3">
              {date(g.start)} – {date(g.end)} · {crit} open tasks on the critical path
            </span>
          </div>
        </>
      ) : (
        <TaskList
          tasks={tasks.data}
          loading={tasks.isLoading}
          onOpen={(t) => setOpenId(t.id)}
          canWrite={canWrite}
        />
      )}

      <TaskSheet task={openTask} onClose={() => setOpenId(null)} showProject={false} />
      <ApplyTemplateDialog
        open={applying}
        onClose={() => setApplying(false)}
        project={project}
        hasTasks={!!g.tasks.length}
      />
      <PickShiftDialog
        open={pickShift}
        tasks={tasks.data ?? []}
        onClose={() => setPickShift(false)}
        onPick={(t) => {
          setPickShift(false);
          setShiftFrom(t);
        }}
      />
      <RescheduleDialog projectId={project.id} task={shiftFrom} onClose={() => setShiftFrom(null)} />
    </div>
  );
}

function TaskList({
  tasks,
  loading,
  onOpen,
  canWrite,
}: {
  tasks: Task[] | undefined;
  loading: boolean;
  onOpen: (t: Task) => void;
  canWrite: boolean;
}) {
  const { toggle } = useTaskActions();
  const [hideDone, setHideDone] = useState(false);
  if (loading) return <Loading />;
  const phases = new Map<string, Task[]>();
  for (const t of tasks ?? []) {
    if (hideDone && (t.status === 'done' || t.status === 'skipped')) continue;
    const k = t.phase ?? 'Other';
    phases.set(k, [...(phases.get(k) ?? []), t]);
  }
  return (
    <div className="overflow-hidden rounded-md border border-line bg-paper">
      <div className="flex items-center justify-end border-b border-line-2 px-4 py-1.5">
        {/* biome-ignore lint/a11y/noLabelWithoutControl: wraps the Checkbox input */}
        <label className="flex items-center gap-1.5 text-[13px] text-ink-2">
          <Checkbox checked={hideDone} onChange={setHideDone} label="Hide completed tasks" />
          Hide completed
        </label>
      </div>
      {[...phases.entries()].map(([phase, list]) => (
        <div key={phase}>
          <div className="flex items-center justify-between bg-stone/60 px-4 py-1.5 text-[12.5px] font-[620] text-ink-2">
            {phase}
            <span className="num font-[520] text-ink-3">
              {list.filter((t) => t.status === 'done').length}/{list.length}
            </span>
          </div>
          <ul>
            {list.map((t) => {
              const done = t.status === 'done' || t.status === 'skipped';
              return (
                <li key={t.id} className="border-t border-line-2">
                  <div className="flex items-center gap-3 px-4 py-2 hover:bg-[#fafbf9]">
                    <TaskCheck
                      done={done}
                      disabled={!canWrite}
                      onToggle={() => toggle(t)}
                      label={done ? `Reopen ${t.name}` : `Complete ${t.name}`}
                    />
                    <button type="button" onClick={() => onOpen(t)} className="min-w-0 flex-1 text-left">
                      <span className="flex items-center gap-1.5">
                        {t.isMilestone && <Diamond className="size-3 shrink-0 fill-brass text-brass" />}
                        <span
                          className={cx(
                            'truncate font-[560] hover:text-lacquer',
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
                      </span>
                      <span className="block truncate text-[12px] text-ink-3">
                        {t.assigneeName ?? 'Unassigned'} · {date(t.startDate)} – {date(t.dueDate)}
                      </span>
                    </button>
                    <DueLabel task={t} />
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

function ApplyTemplateDialog({
  open,
  onClose,
  project,
  hasTasks,
}: {
  open: boolean;
  onClose: () => void;
  project: ProjectDetail;
  hasTasks: boolean;
}) {
  const qc = useQueryClient();
  const templates = useTemplates();
  const [templateId, setTemplateId] = useState('');
  const [anchor, setAnchor] = useState(project.startDate ?? isoToday());
  const [mode, setMode] = useState<'append' | 'replace'>('append');
  const apply = useMutation({
    mutationFn: async () => {
      const id = await ensureTemplateId(templates.data, templateId || undefined);
      return api.post<{ created: number; removed: number; end: string | null }>(
        'projects',
        `/projects/${project.id}/apply-template`,
        { templateId: id, anchorDate: anchor, mode },
      );
    },
    onSuccess: (r) => {
      toast.success('Template applied', {
        description: `${r.created} tasks scheduled${r.removed ? `, ${r.removed} removed` : ''}, finishing ${date(r.end)}`,
      });
      qc.invalidateQueries({ queryKey: ['projects'] });
      qc.invalidateQueries({ queryKey: ['tasks'] });
      onClose();
    },
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Apply template"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={mode === 'replace' ? 'danger' : 'primary'}
            loading={apply.isPending}
            disabled={!anchor}
            onClick={() => apply.mutate()}
          >
            {mode === 'replace' ? 'Replace schedule' : 'Apply template'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-ink-2">
          Generates tasks scheduled forward in business days. Tasks are assigned to team members by role.
        </p>
        <Field label="Template">
          {(id) => (
            <Select
              id={id}
              value={templateId}
              onChange={(e) => setTemplateId(e.target.value)}
              placeholder={templates.data?.length ? 'Default template' : 'Standard hospitality FF&E template'}
              options={(templates.data ?? []).map((t) => ({
                value: t.id,
                label: `${t.name} (${t.taskCount} tasks)`,
              }))}
            />
          )}
        </Field>
        <Field label="Schedule starts">
          {(id) => <Input id={id} type="date" value={anchor} onChange={(e) => setAnchor(e.target.value)} />}
        </Field>
        {hasTasks && (
          <Field label="Existing tasks">
            {(id) => (
              <Select
                id={id}
                value={mode}
                onChange={(e) => setMode(e.target.value as 'append' | 'replace')}
                options={[
                  { value: 'append', label: 'Keep them and add the template tasks' },
                  { value: 'replace', label: 'Delete them and start over' },
                ]}
              />
            )}
          </Field>
        )}
      </div>
    </Dialog>
  );
}

function PickShiftDialog({
  open,
  tasks,
  onClose,
  onPick,
}: {
  open: boolean;
  tasks: Task[];
  onClose: () => void;
  onPick: (t: Task) => void;
}) {
  const [id, setId] = useState('');
  const candidates = tasks
    .filter(
      (t) => t.status !== 'skipped' && tasks.some((d) => d.dependsOn.includes(t.id) && d.status !== 'done'),
    )
    .sort(
      (a, b) =>
        Number(a.status === 'done') - Number(b.status === 'done') ||
        (a.dueDate ?? '').localeCompare(b.dueDate ?? ''),
    );
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Shift schedule"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!id}
            onClick={() => {
              const t = tasks.find((x) => x.id === id);
              if (t) onPick(t);
            }}
          >
            Preview shift
          </Button>
        </>
      }
    >
      <p className="mb-3 text-ink-2">
        Pick the task that slipped (or moved earlier). Everything downstream of it moves by the same number of
        business days.
      </p>
      <Field label="Shift everything after">
        {(fid) => (
          <Select
            id={fid}
            value={id}
            onChange={(e) => setId(e.target.value)}
            placeholder="Choose a task"
            options={candidates.map((t) => ({ value: t.id, label: `${t.name} — due ${date(t.dueDate)}` }))}
          />
        )}
      </Field>
    </Dialog>
  );
}
