import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CircleAlert, Flag, ListChecks, Plus, Star, Trash2, Zap } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  Badge,
  Button,
  Checkbox,
  cx,
  Dialog,
  EmptyState,
  ErrorNote,
  Field,
  IconButton,
  Input,
  Loading,
  Select,
  Sheet,
  Textarea,
} from '@/components/ui';
import { type Column, DataTable } from '@/components/ui/DataTable';
import { ApiError, api, errorMessage } from '@/lib/api';
import { humanize } from '@/lib/format';
import { settingsKeys, TabIntro } from './shared';

// ------------------------------------------------------------------ shapes (services/projects)
interface Template {
  id: string;
  name: string;
  description: string | null;
  projectType: string | null;
  isDefault: boolean;
  taskCount: number;
  createdAt: string;
  updatedAt: string;
}
interface TemplateTask {
  key: string;
  name: string;
  phase: string | null;
  kind: string;
  party: string;
  assigneeRole: string | null;
  workHours: number | null;
  durationDays: number;
  dependsOn: string[];
  offsetDays: number;
  isMilestone: boolean;
  autoCompleteOn: string | null;
  description: string | null;
  sort?: number;
}
interface TemplateDetail extends Template {
  tasks: (TemplateTask & { id: string; sort: number })[];
}

const KINDS = ['task', 'approval', 'payment', 'milestone', 'document'];
const PARTIES: Record<string, string> = { internal: 'Our team', client: 'Owner', vendor: 'Vendor' };
const ROLES = [
  'project_manager',
  'designer',
  'procurement',
  'order_manager',
  'logistics',
  'sales',
  'accounting',
];
const PROJECT_TYPES = ['renovation', 'new_construction', 'conversion', 'refresh', 'opening'];
/** Events the projects service listens to for auto-completion (services/projects/src/subscriptions.ts). */
const EVENTS: Record<string, string> = {
  'quoting.quote.sent_to_client': 'Quote sent to the owner',
  'quoting.quote.client_decided': 'Owner approves the quote',
  'finance.payment.received': 'Owner payment received',
  'orders.po.issued': 'Purchase order issued',
  'orders.shipment.delivered': 'Shipment delivered',
};

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || 'task';

export function TemplatesTab() {
  const [openId, setOpenId] = useState<string | null>(null);
  return openId ? (
    <TemplateEditor id={openId} onBack={() => setOpenId(null)} />
  ) : (
    <TemplateList onOpen={setOpenId} />
  );
}

function TemplateList({ onOpen }: { onOpen: (id: string) => void }) {
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const list = useQuery({
    queryKey: settingsKeys.templates,
    queryFn: () => api.get<Template[]>('projects', '/task-templates'),
  });
  const createDefault = useMutation({
    mutationFn: () => api.post<TemplateDetail>('projects', '/task-templates/default'),
    onSuccess: (t) => {
      qc.invalidateQueries({ queryKey: settingsKeys.templates });
      toast.success('Standard template added');
      onOpen(t.id);
    },
  });
  const hasStandard = list.data?.some((t) => t.name.startsWith('Hospitality FF&E'));
  const columns: Column<Template>[] = [
    {
      key: 'name',
      header: 'Template',
      cell: (t) => (
        <div className="min-w-[260px] py-0.5">
          <div className="flex items-center gap-2 font-[560]">
            {t.name}
            {t.isDefault && (
              <Badge tone="brass">
                <Star className="size-3" /> Default
              </Badge>
            )}
          </div>
          {t.description && <div className="line-clamp-2 text-[12.5px] text-ink-3">{t.description}</div>}
        </div>
      ),
    },
    {
      key: 'type',
      header: 'Project type',
      cell: (t) => (t.projectType ? humanize(t.projectType) : <span className="text-ink-3">Any</span>),
    },
    { key: 'tasks', header: 'Tasks', align: 'right', cell: (t) => t.taskCount },
  ];
  return (
    <>
      <TabIntro
        title="Task templates"
        actions={
          <>
            {list.data && !hasStandard && (
              <Button loading={createDefault.isPending} onClick={() => createDefault.mutate()}>
                Add standard FF&E template
              </Button>
            )}
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
              New template
            </Button>
          </>
        }
      >
        The schedule every new project starts from: tasks, who does them, how long they take and what they
        wait on. Some tasks complete themselves when the matching event happens, such as a PO being issued.
      </TabIntro>
      <div className="rounded-md border border-line bg-paper">
        {list.isError ? (
          <ErrorNote error={list.error} />
        ) : (
          <DataTable
            columns={columns}
            rows={list.data}
            loading={list.isLoading}
            onRowClick={(t) => onOpen(t.id)}
            empty={
              <EmptyState
                icon={<ListChecks />}
                title="No task templates yet"
                action={
                  <Button
                    variant="primary"
                    loading={createDefault.isPending}
                    onClick={() => createDefault.mutate()}
                  >
                    Add standard FF&E template
                  </Button>
                }
              >
                Start from Pro-Cure’s standard hospitality FF&E schedule (kickoff to closeout, 47 tasks) and
                adjust it to how your firm works.
              </EmptyState>
            }
          />
        )}
      </div>
      <NewTemplateSheet
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(id) => {
          setCreating(false);
          onOpen(id);
        }}
      />
    </>
  );
}

function NewTemplateSheet({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const qc = useQueryClient();
  const [f, setF] = useState({ name: '', description: '', projectType: '' });
  useEffect(() => {
    if (open) setF({ name: '', description: '', projectType: '' });
  }, [open]);
  const create = useMutation({
    mutationFn: () =>
      api.post<TemplateDetail>('projects', '/task-templates', {
        name: f.name.trim(),
        description: f.description.trim() || null,
        projectType: f.projectType || null,
      }),
    onSuccess: (t) => {
      qc.invalidateQueries({ queryKey: settingsKeys.templates });
      toast.success('Template created');
      onCreated(t.id);
    },
  });
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="New task template"
      description="Create an empty template, then add its tasks."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!f.name.trim()}
            loading={create.isPending}
            onClick={() => create.mutate()}
          >
            Create template
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name">
          {(id) => (
            <Input id={id} autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          )}
        </Field>
        <Field label="Use for" hint="Suggested when creating a project of this type.">
          {(id) => (
            <Select
              id={id}
              value={f.projectType}
              placeholder="Any project type"
              options={PROJECT_TYPES.map((t) => ({ value: t, label: humanize(t) }))}
              onChange={(e) => setF({ ...f, projectType: e.target.value })}
            />
          )}
        </Field>
        <Field label="Description">
          {(id) => (
            <Textarea
              id={id}
              rows={3}
              value={f.description}
              onChange={(e) => setF({ ...f, description: e.target.value })}
            />
          )}
        </Field>
      </div>
    </Sheet>
  );
}

// ------------------------------------------------------------------ editor
type Draft = TemplateTask;
const toDraft = (t: TemplateDetail['tasks'][number]): Draft => ({
  key: t.key,
  name: t.name,
  phase: t.phase,
  kind: t.kind,
  party: t.party,
  assigneeRole: t.assigneeRole,
  workHours: t.workHours,
  durationDays: t.durationDays,
  dependsOn: t.dependsOn,
  offsetDays: t.offsetDays,
  isMilestone: t.isMilestone,
  autoCompleteOn: t.autoCompleteOn,
  description: t.description,
});

function TemplateEditor({ id, onBack }: { id: string; onBack: () => void }) {
  const qc = useQueryClient();
  const tpl = useQuery({
    queryKey: settingsKeys.template(id),
    queryFn: () => api.get<TemplateDetail>('projects', `/task-templates/${id}`),
  });
  const [tasks, setTasks] = useState<Draft[] | null>(null);
  const [editing, setEditing] = useState<{ index: number | null; phase?: string | null } | null>(null);
  const [saveError, setSaveError] = useState<{ message: string; key?: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);

  useEffect(() => {
    if (tpl.data && tasks === null) setTasks(tpl.data.tasks.map(toDraft));
  }, [tpl.data, tasks]);

  const original = useMemo(() => JSON.stringify(tpl.data?.tasks.map(toDraft) ?? []), [tpl.data]);
  const dirty = tasks !== null && JSON.stringify(tasks) !== original;

  const save = useMutation({
    mutationFn: () =>
      api.put('projects', `/task-templates/${id}/tasks`, {
        tasks: tasks!.map((t, i) => ({ ...t, sort: (i + 1) * 10 })),
      }),
    onSuccess: async () => {
      setSaveError(null);
      await qc.invalidateQueries({ queryKey: settingsKeys.template(id) });
      qc.invalidateQueries({ queryKey: settingsKeys.templates });
      setTasks(null);
      toast.success('Template saved');
    },
    onError: (e) => {
      const detail =
        e instanceof ApiError ? (e.detail as { key?: string; cycle?: string[] } | undefined) : undefined;
      setSaveError({ message: errorMessage(e), key: detail?.key ?? detail?.cycle?.[0] });
    },
  });
  const patch = useMutation({
    mutationFn: (body: Partial<Template>) =>
      api.patch<TemplateDetail>('projects', `/task-templates/${id}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: settingsKeys.template(id) });
      qc.invalidateQueries({ queryKey: settingsKeys.templates });
      toast.success('Template is now the default');
    },
  });
  const remove = useMutation({
    mutationFn: () => api.del('projects', `/task-templates/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: settingsKeys.templates });
      toast.success('Template deleted');
      onBack();
    },
  });

  if (tpl.isLoading || (tpl.data && !tasks)) return <Loading label="Loading template" />;
  if (tpl.isError || !tpl.data || !tasks) return <ErrorNote error={tpl.error} />;
  const t = tpl.data;

  // group by phase in first-seen order
  const phases: { phase: string | null; rows: { task: Draft; index: number }[] }[] = [];
  tasks.forEach((task, index) => {
    const g = phases.find((p) => p.phase === task.phase);
    if (g) g.rows.push({ task, index });
    else phases.push({ phase: task.phase, rows: [{ task, index }] });
  });
  const nameOf = new Map(tasks.map((x) => [x.key, x.name]));

  const upsert = (draft: Draft, index: number | null) => {
    setTasks((prev) => {
      const list = [...(prev ?? [])];
      if (index === null) {
        // insert after the last task of the same phase
        const last = list.map((x) => x.phase).lastIndexOf(draft.phase);
        list.splice(last === -1 ? list.length : last + 1, 0, draft);
        return list;
      }
      const oldKey = list[index]!.key;
      list[index] = draft;
      return oldKey === draft.key
        ? list
        : list.map((x) => ({ ...x, dependsOn: x.dependsOn.map((d) => (d === oldKey ? draft.key : d)) }));
    });
    setSaveError(null);
  };
  const removeAt = (index: number) =>
    setTasks((prev) => {
      const gone = prev![index]!.key;
      return prev!
        .filter((_, i) => i !== index)
        .map((x) => ({ ...x, dependsOn: x.dependsOn.filter((d) => d !== gone) }));
    });

  const columns: Column<{ id: string; task: Draft; index: number }>[] = [
    {
      key: 'name',
      header: 'Task',
      cell: ({ task }) => (
        <div className="min-w-[240px]">
          <div className="flex items-center gap-1.5 font-[560]">
            {task.isMilestone && <Flag className="size-3.5 shrink-0 text-brass" aria-label="Milestone" />}
            {task.name}
          </div>
          <div className="num text-[12px] text-ink-4">{task.key}</div>
        </div>
      ),
    },
    { key: 'kind', header: 'Kind', className: 'whitespace-nowrap', cell: ({ task }) => humanize(task.kind) },
    {
      key: 'party',
      header: 'Done by',
      className: 'whitespace-nowrap',
      cell: ({ task }) => PARTIES[task.party] ?? task.party,
    },
    {
      key: 'role',
      header: 'Assignee role',
      className: 'whitespace-nowrap',
      cell: ({ task }) =>
        task.assigneeRole ? humanize(task.assigneeRole) : <span className="text-ink-4">—</span>,
    },
    {
      key: 'hours',
      header: 'Work hrs',
      align: 'right',
      cell: ({ task }) => task.workHours ?? <span className="text-ink-4">—</span>,
    },
    { key: 'days', header: 'Days', align: 'right', cell: ({ task }) => task.durationDays },
    {
      key: 'deps',
      header: 'Waits on',
      cell: ({ task }) =>
        task.dependsOn.length ? (
          <span
            className="line-clamp-2 min-w-[160px] text-[12.5px] text-ink-2"
            title={task.dependsOn.join(', ')}
          >
            {task.dependsOn.map((d) => nameOf.get(d) ?? d).join(', ')}
          </span>
        ) : (
          <span className="text-ink-4">—</span>
        ),
    },
    {
      key: 'auto',
      header: 'Completes on',
      cell: ({ task }) =>
        task.autoCompleteOn ? (
          <span className="inline-flex items-center gap-1 text-[12.5px] whitespace-nowrap text-lacquer">
            <Zap className="size-3" />
            {EVENTS[task.autoCompleteOn] ?? task.autoCompleteOn}
          </span>
        ) : (
          <span className="text-ink-4">—</span>
        ),
    },
    {
      key: 'x',
      header: <span className="sr-only">Remove</span>,
      width: 40,
      cell: ({ task, index }) => (
        <IconButton
          label={`Remove ${task.name}`}
          onClick={(e) => {
            e.stopPropagation();
            removeAt(index);
          }}
        >
          <Trash2 className="size-3.5" />
        </IconButton>
      ),
    },
  ];

  const totalDays = tasks.reduce((n, x) => n + x.durationDays, 0);
  const totalHours = tasks.reduce((n, x) => n + (x.workHours ?? 0), 0);

  return (
    <>
      <button
        type="button"
        onClick={() => (dirty ? setConfirmLeave(true) : onBack())}
        className="mb-3 inline-flex items-center gap-1.5 text-[13px] font-[560] text-ink-2 hover:text-ink"
      >
        <ArrowLeft className="size-4" /> All templates
      </button>
      <TabIntro
        title={t.name}
        actions={
          <>
            {!t.isDefault && (
              <Button
                size="sm"
                icon={<Star className="size-3.5" />}
                loading={patch.isPending}
                onClick={() => patch.mutate({ isDefault: true })}
              >
                Make default
              </Button>
            )}
            <Button
              size="sm"
              variant="danger"
              icon={<Trash2 className="size-3.5" />}
              onClick={() => setConfirmDelete(true)}
            >
              Delete
            </Button>
          </>
        }
      >
        {t.description ?? 'No description.'}{' '}
        <span className="text-ink-3">
          {tasks.length} tasks · {totalHours} work hours ·{' '}
          {t.isDefault
            ? 'Default for new projects'
            : t.projectType
              ? `For ${humanize(t.projectType).toLowerCase()} projects`
              : 'Any project type'}
        </span>
      </TabIntro>

      {dirty && (
        <div className="sticky top-[4rem] z-10 mb-4 flex flex-wrap items-center gap-3 rounded-md border border-brass/40 bg-brass-50 px-4 py-2.5 shadow-[var(--shadow-pop)]">
          <span className="flex-1 font-[560]">You have unsaved changes to this template’s tasks.</span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setTasks(null);
              setSaveError(null);
            }}
          >
            Discard
          </Button>
          <Button size="sm" variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
            Save template
          </Button>
        </div>
      )}
      {saveError && (
        <div
          role="alert"
          className="mb-4 flex items-start gap-2 rounded-md border border-crit/25 bg-crit-50 px-4 py-3 text-crit"
        >
          <CircleAlert className="mt-0.5 size-4 shrink-0" />
          <div>
            <div className="font-[620]">The template wasn’t saved</div>
            <div className="text-[13px]">
              {saveError.message}. Fix the “Waits on” list of the task named
              {saveError.key ? ` “${nameOf.get(saveError.key) ?? saveError.key}”` : ' in the message'} so
              tasks don’t wait on each other in a loop.
            </div>
          </div>
        </div>
      )}

      <div className="space-y-4">
        {phases.map((g) => (
          <section key={g.phase ?? '—'} className="rounded-md border border-line bg-paper">
            <header className="flex items-center justify-between gap-3 border-b border-line-2 px-4 py-2.5">
              <h3 className="text-[14px] font-[620]">
                {g.phase ?? 'No phase'}
                <span className="ml-2 text-[12px] font-normal text-ink-3">
                  {g.rows.length} task{g.rows.length === 1 ? '' : 's'}
                </span>
              </h3>
              <Button
                size="sm"
                variant="ghost"
                icon={<Plus className="size-3.5" />}
                onClick={() => setEditing({ index: null, phase: g.phase })}
              >
                Add task
              </Button>
            </header>
            <DataTable
              dense
              columns={columns}
              rows={g.rows.map((r) => ({ ...r, id: `${r.index}-${r.task.key}` }))}
              onRowClick={(r) => setEditing({ index: r.index })}
              rowClassName={(r) => (saveError?.key === r.task.key ? '[&_td]:!bg-crit-50' : undefined)}
            />
          </section>
        ))}
        {!tasks.length && (
          <div className="rounded-md border border-line bg-paper">
            <EmptyState
              icon={<ListChecks />}
              title="This template has no tasks"
              action={
                <Button
                  variant="primary"
                  icon={<Plus className="size-4" />}
                  onClick={() => setEditing({ index: null, phase: null })}
                >
                  Add task
                </Button>
              }
            >
              Add the first task. Group tasks into phases such as Design, Procurement and Installation.
            </EmptyState>
          </div>
        )}
        {!!tasks.length && (
          <Button icon={<Plus className="size-4" />} onClick={() => setEditing({ index: null, phase: null })}>
            Add task in a new phase
          </Button>
        )}
        <p className="text-[12.5px] text-ink-3">
          Total of task durations: {totalDays} business days (tasks without dependencies run in parallel, so
          the schedule is shorter).
        </p>
      </div>

      <TaskSheet
        open={!!editing}
        index={editing?.index ?? null}
        initialPhase={editing?.phase ?? null}
        tasks={tasks}
        onClose={() => setEditing(null)}
        onSave={(d) => {
          upsert(d, editing!.index);
          setEditing(null);
        }}
      />
      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={`Delete “${t.name}”?`}
        footer={
          <>
            <Button onClick={() => setConfirmDelete(false)}>Cancel</Button>
            <Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate()}>
              Delete template
            </Button>
          </>
        }
      >
        <p className="text-ink-2">
          Projects already created from it keep their tasks. New projects can’t use it.
        </p>
      </Dialog>
      <Dialog
        open={confirmLeave}
        onClose={() => setConfirmLeave(false)}
        title="Discard unsaved changes?"
        footer={
          <>
            <Button onClick={() => setConfirmLeave(false)}>Keep editing</Button>
            <Button variant="danger" onClick={onBack}>
              Discard changes
            </Button>
          </>
        }
      >
        <p className="text-ink-2">Your changes to this template’s tasks haven’t been saved.</p>
      </Dialog>
    </>
  );
}

function TaskSheet({
  open,
  index,
  initialPhase,
  tasks,
  onClose,
  onSave,
}: {
  open: boolean;
  index: number | null;
  initialPhase: string | null;
  tasks: Draft[];
  onClose: () => void;
  onSave: (d: Draft) => void;
}) {
  const blank: Draft = {
    key: '',
    name: '',
    phase: initialPhase,
    kind: 'task',
    party: 'internal',
    assigneeRole: null,
    workHours: null,
    durationDays: 1,
    dependsOn: [],
    offsetDays: 0,
    isMilestone: false,
    autoCompleteOn: null,
    description: null,
  };
  const [d, setD] = useState<Draft>(blank);
  const [keyTouched, setKeyTouched] = useState(false);
  const [depQuery, setDepQuery] = useState('');
  // biome-ignore lint/correctness/useExhaustiveDependencies: load the draft only when the sheet opens
  useEffect(() => {
    if (!open) return;
    const t = index === null ? blank : tasks[index]!;
    setD(t);
    setKeyTouched(index !== null);
    setDepQuery('');
  }, [open, index]);

  const key = keyTouched ? d.key : slug(d.name);
  const others = tasks.filter((_, i) => i !== index);
  const phases = [...new Set(tasks.map((t) => t.phase).filter((p): p is string => !!p))];
  const keyError = !/^[a-z0-9][a-z0-9_-]*$/.test(key)
    ? 'Lowercase letters, numbers, - and _ only.'
    : others.some((t) => t.key === key)
      ? 'Another task already uses this key.'
      : undefined;
  const valid = d.name.trim() && !keyError && d.durationDays >= 0;
  const term = depQuery.trim().toLowerCase();
  const depChoices = others.filter(
    (t) => !term || `${t.name} ${t.key} ${t.phase ?? ''}`.toLowerCase().includes(term),
  );

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={index === null ? 'Add task' : 'Edit task'}
      description="Changes are kept in the template draft until you save the template."
      width={600}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!valid}
            onClick={() => onSave({ ...d, key, name: d.name.trim(), phase: d.phase?.trim() || null })}
          >
            {index === null ? 'Add task' : 'Update task'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name">
          {(id) => (
            <Input id={id} autoFocus value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} />
          )}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Phase" hint="Type a new phase or pick an existing one.">
            {(id) => (
              <>
                <Input
                  id={id}
                  list="tpl-phases"
                  value={d.phase ?? ''}
                  onChange={(e) => setD({ ...d, phase: e.target.value })}
                />
                <datalist id="tpl-phases">
                  {phases.map((p) => (
                    <option key={p} value={p} />
                  ))}
                </datalist>
              </>
            )}
          </Field>
          <Field
            label="Key"
            hint="Used for dependencies."
            error={d.name || keyTouched ? keyError : undefined}
          >
            {(id) => (
              <Input
                id={id}
                className="num"
                value={key}
                onChange={(e) => {
                  setKeyTouched(true);
                  setD({ ...d, key: e.target.value });
                }}
              />
            )}
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Kind">
            {(id) => (
              <Select
                id={id}
                value={d.kind}
                options={KINDS.map((k) => ({ value: k, label: humanize(k) }))}
                onChange={(e) => setD({ ...d, kind: e.target.value })}
              />
            )}
          </Field>
          <Field label="Done by">
            {(id) => (
              <Select
                id={id}
                value={d.party}
                options={Object.entries(PARTIES).map(([value, label]) => ({ value, label }))}
                onChange={(e) => setD({ ...d, party: e.target.value })}
              />
            )}
          </Field>
          <Field label="Assignee role" hint="First team member with it.">
            {(id) => (
              <Select
                id={id}
                value={d.assigneeRole ?? ''}
                placeholder="Unassigned"
                options={ROLES.map((r) => ({ value: r, label: humanize(r) }))}
                onChange={(e) => setD({ ...d, assigneeRole: e.target.value || null })}
              />
            )}
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Work hours">
            {(id) => (
              <Input
                id={id}
                type="number"
                min={0}
                step={0.5}
                className="num"
                value={d.workHours ?? ''}
                onChange={(e) =>
                  setD({ ...d, workHours: e.target.value === '' ? null : e.target.valueAsNumber })
                }
              />
            )}
          </Field>
          <Field label="Duration (business days)">
            {(id) => (
              <Input
                id={id}
                type="number"
                min={0}
                className="num"
                value={d.durationDays}
                onChange={(e) =>
                  setD({ ...d, durationDays: Math.max(0, Math.round(e.target.valueAsNumber || 0)) })
                }
              />
            )}
          </Field>
          <Field label="Start offset (days)" hint="After its dependencies.">
            {(id) => (
              <Input
                id={id}
                type="number"
                className="num"
                value={d.offsetDays}
                onChange={(e) => setD({ ...d, offsetDays: Math.round(e.target.valueAsNumber || 0) })}
              />
            )}
          </Field>
        </div>

        <div>
          <div className="mb-1.5 flex items-baseline justify-between gap-2">
            <span className="text-[13px] font-[560] text-ink-2">Waits on</span>
            <span className="text-[12px] text-ink-3">{d.dependsOn.length} selected</span>
          </div>
          {!!d.dependsOn.length && (
            <div className="mb-2 flex flex-wrap gap-1">
              {d.dependsOn.map((k) => (
                <Badge key={k} tone="lacquer">
                  {tasks.find((t) => t.key === k)?.name ?? k}
                  <button
                    type="button"
                    aria-label={`Remove dependency ${k}`}
                    className="ml-0.5 hover:text-ink"
                    onClick={() => setD({ ...d, dependsOn: d.dependsOn.filter((x) => x !== k) })}
                  >
                    ×
                  </button>
                </Badge>
              ))}
            </div>
          )}
          <Input
            value={depQuery}
            onChange={(e) => setDepQuery(e.target.value)}
            placeholder="Filter tasks"
            className="mb-1.5"
          />
          <ul className="max-h-[200px] divide-y divide-line-2 overflow-y-auto rounded-sm border border-line">
            {depChoices.map((t) => {
              const on = d.dependsOn.includes(t.key);
              return (
                <li key={t.key}>
                  {/* biome-ignore lint/a11y/noLabelWithoutControl: Checkbox renders the input */}
                  <label
                    className={cx(
                      'flex cursor-pointer items-center gap-2.5 px-3 py-1.5',
                      on ? 'bg-lacquer-50' : 'hover:bg-stone',
                    )}
                  >
                    <Checkbox
                      checked={on}
                      label={t.name}
                      onChange={(v) =>
                        setD({
                          ...d,
                          dependsOn: v ? [...d.dependsOn, t.key] : d.dependsOn.filter((x) => x !== t.key),
                        })
                      }
                    />
                    <span className="min-w-0 flex-1 truncate">{t.name}</span>
                    <span className="shrink-0 text-[12px] text-ink-3">{t.phase}</span>
                  </label>
                </li>
              );
            })}
            {!depChoices.length && (
              <li className="px-3 py-3 text-center text-[13px] text-ink-3">No tasks match.</li>
            )}
          </ul>
        </div>

        <Field
          label="Completes automatically when"
          hint="Pro-Cure marks the task done when this happens on the project."
        >
          {(id) => (
            <Select
              id={id}
              value={d.autoCompleteOn ?? ''}
              placeholder="Never — someone completes it"
              options={[
                ...Object.entries(EVENTS).map(([value, label]) => ({ value, label })),
                ...(d.autoCompleteOn && !EVENTS[d.autoCompleteOn]
                  ? [{ value: d.autoCompleteOn, label: d.autoCompleteOn }]
                  : []),
              ]}
              onChange={(e) => setD({ ...d, autoCompleteOn: e.target.value || null })}
            />
          )}
        </Field>
        {/* biome-ignore lint/a11y/noLabelWithoutControl: Checkbox renders the input */}
        <label className="flex items-center gap-2.5">
          <Checkbox
            checked={d.isMilestone}
            label="Milestone"
            onChange={(v) => setD({ ...d, isMilestone: v })}
          />
          <span>
            Milestone <span className="text-ink-3">— shown on the project timeline and owner portal</span>
          </span>
        </label>
        <Field label="Description">
          {(id) => (
            <Textarea
              id={id}
              rows={3}
              value={d.description ?? ''}
              onChange={(e) => setD({ ...d, description: e.target.value || null })}
            />
          )}
        </Field>
      </div>
    </Sheet>
  );
}
