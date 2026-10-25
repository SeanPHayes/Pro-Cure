import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';
import {
  Button,
  Checkbox,
  enumOptions,
  Field,
  IconButton,
  Input,
  Select,
  Sheet,
  Textarea,
} from '@/components/ui';
import { api } from '@/lib/api';
import { useMe } from '@/lib/auth';
import { isoToday } from '@/lib/format';
import {
  type Address,
  ensureTemplateId,
  PROJECT_ROLES,
  PROJECT_STATUSES,
  PROJECT_TYPES,
  type ProjectDetail,
  qk,
  STAGES,
  useClientOrgs,
  useStaff,
  useTemplates,
} from './shared';

interface TeamRow {
  key: string;
  userId: string;
  role: string;
}

const intOrNull = (v: string) => (v.trim() === '' ? null : Math.round(Number(v)));
const numOrNull = (v: string) => (v.trim() === '' ? null : Number(v.replace(/[$,\s]/g, '')));

/**
 * Create or edit a project in a side sheet. Create also sets the team and can generate the task
 * schedule from a template. Editing changes the project's fields only (team is edited on the record).
 */
export function ProjectFormSheet({
  open,
  onClose,
  project,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  project?: ProjectDetail;
  onCreated?: (p: ProjectDetail) => void;
}) {
  if (!open) return null;
  return <ProjectFormInner onClose={onClose} project={project} onCreated={onCreated} />;
}

function ProjectFormInner({
  onClose,
  project,
  onCreated,
}: {
  onClose: () => void;
  project?: ProjectDetail;
  onCreated?: (p: ProjectDetail) => void;
}) {
  const me = useMe();
  const qc = useQueryClient();
  const editing = !!project;
  const staff = useStaff();
  const clients = useClientOrgs();
  const templates = useTemplates();

  const [f, setF] = useState({
    name: project?.name ?? '',
    propertyName: project?.propertyName ?? '',
    type: project?.type ?? 'renovation',
    stage: project?.stage ?? 'lead',
    status: project?.status ?? 'active',
    clientOrgId: project?.clientOrgId ?? '',
    keys: project?.keys?.toString() ?? '',
    floors: project?.floors?.toString() ?? '',
    targetOpenDate: project?.targetOpenDate ?? '',
    budget: project?.budget?.toString() ?? '',
    description: project?.description ?? '',
  });
  const [addr, setAddr] = useState<Address>(project?.address ?? {});
  const [team, setTeam] = useState<TeamRow[]>(
    project ? [] : [{ key: 'pm', userId: me.user.id, role: 'project_manager' }],
  );
  const [applyTemplate, setApplyTemplate] = useState(true);
  const [templateId, setTemplateId] = useState('');
  const [anchorDate, setAnchorDate] = useState(isoToday());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF((x) => ({ ...x, [k]: e.target.value }));
  const setA = (k: keyof Address) => (e: { target: { value: string } }) =>
    setAddr((x) => ({ ...x, [k]: e.target.value }));

  const save = useMutation({
    mutationFn: async () => {
      const cleanAddr = Object.fromEntries(Object.entries(addr).filter(([, v]) => v && String(v).trim()));
      const body = {
        name: f.name.trim(),
        propertyName: f.propertyName.trim() || null,
        type: f.type,
        stage: f.stage,
        status: f.status,
        clientOrgId: f.clientOrgId || null,
        keys: intOrNull(f.keys),
        floors: intOrNull(f.floors),
        address: cleanAddr,
        targetOpenDate: f.targetOpenDate || null,
        budget: numOrNull(f.budget),
        description: f.description.trim() || null,
      };
      if (editing) return api.patch<ProjectDetail>('projects', `/projects/${project.id}`, body);
      const byId = new Map(staff.data?.map((m) => [m.userId, m]));
      const seenLead = new Set<string>();
      const teamBody = team
        .filter((t) => t.userId && byId.has(t.userId))
        .map((t) => {
          const m = byId.get(t.userId)!;
          const isLead = !seenLead.has(t.role);
          seenLead.add(t.role);
          return { userId: m.userId, name: m.name, email: m.email, role: t.role, isLead };
        });
      const extra = applyTemplate
        ? { templateId: await ensureTemplateId(templates.data, templateId || undefined), anchorDate }
        : {};
      return api.post<ProjectDetail>('projects', '/projects', { ...body, team: teamBody, ...extra });
    },
    onSuccess: (p) => {
      toast.success(editing ? 'Project saved' : 'Project created', { description: `${p.number} ${p.name}` });
      qc.invalidateQueries({ queryKey: ['projects'] });
      qc.invalidateQueries({ queryKey: ['tasks'] });
      qc.setQueryData(qk.project(p.id), p);
      onClose();
      onCreated?.(p);
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!f.name.trim()) errs.name = 'Give the project a name, e.g. “Hampton Inn Cary Renovation”.';
    if (f.keys && !(Number(f.keys) >= 0)) errs.keys = 'Enter the number of guest rooms.';
    if (f.budget && Number.isNaN(Number(f.budget.replace(/[$,\s]/g, ''))))
      errs.budget = 'Enter an amount like 1250000.';
    if (!editing && applyTemplate && !anchorDate) errs.anchor = 'Pick the date the schedule starts from.';
    setErrors(errs);
    if (!Object.keys(errs).length) save.mutate();
  };

  return (
    <Sheet
      open
      onClose={onClose}
      width={600}
      title={editing ? `Edit ${project.number}` : 'New project'}
      description={editing ? project.name : 'Set up the property, owner, team and schedule.'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="project-form" loading={save.isPending}>
            {editing ? 'Save project' : 'Create project'}
          </Button>
        </>
      }
    >
      <form id="project-form" onSubmit={submit} className="space-y-6">
        <fieldset className="space-y-4">
          <Field label="Project name" error={errors.name}>
            {(id) => <Input id={id} autoFocus value={f.name} onChange={set('name')} />}
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Property">
              {(id) => (
                <Input
                  id={id}
                  value={f.propertyName}
                  onChange={set('propertyName')}
                  placeholder="Home2 Suites by Hilton…"
                />
              )}
            </Field>
            <Field label="Project type">
              {(id) => (
                <Select id={id} value={f.type} onChange={set('type')} options={enumOptions(PROJECT_TYPES)} />
              )}
            </Field>
            <Field label="Owner (client)" hint="Owner users see this project in their portal.">
              {(id) => (
                <Select
                  id={id}
                  value={f.clientOrgId}
                  onChange={set('clientOrgId')}
                  placeholder={clients.isLoading ? 'Loading…' : 'No owner yet'}
                  options={(clients.data ?? []).map((o) => ({ value: o.id, label: o.name }))}
                />
              )}
            </Field>
            <Field label="Target open date">
              {(id) => (
                <Input id={id} type="date" value={f.targetOpenDate} onChange={set('targetOpenDate')} />
              )}
            </Field>
            <Field label="Stage">
              {(id) => (
                <Select id={id} value={f.stage} onChange={set('stage')} options={enumOptions(STAGES)} />
              )}
            </Field>
            <Field label="Status">
              {(id) => (
                <Select
                  id={id}
                  value={f.status}
                  onChange={set('status')}
                  options={enumOptions(PROJECT_STATUSES)}
                />
              )}
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Keys" error={errors.keys}>
                {(id) => (
                  <Input id={id} inputMode="numeric" className="num" value={f.keys} onChange={set('keys')} />
                )}
              </Field>
              <Field label="Floors">
                {(id) => (
                  <Input
                    id={id}
                    inputMode="numeric"
                    className="num"
                    value={f.floors}
                    onChange={set('floors')}
                  />
                )}
              </Field>
            </div>
            <Field label="FF&E budget" error={errors.budget}>
              {(id) => (
                <Input
                  id={id}
                  inputMode="decimal"
                  className="num"
                  value={f.budget}
                  onChange={set('budget')}
                  placeholder="0"
                />
              )}
            </Field>
          </div>
        </fieldset>

        <fieldset className="space-y-3">
          <legend className="mb-2 font-[620]">Site address</legend>
          <Input
            aria-label="Street address"
            placeholder="Street"
            value={addr.line1 ?? ''}
            onChange={setA('line1')}
          />
          <div className="grid grid-cols-[minmax(0,1.6fr)_minmax(0,0.7fr)_minmax(0,0.9fr)] gap-3">
            <Input aria-label="City" placeholder="City" value={addr.city ?? ''} onChange={setA('city')} />
            <Input
              aria-label="State"
              placeholder="State"
              value={addr.region ?? ''}
              onChange={setA('region')}
            />
            <Input
              aria-label="ZIP code"
              placeholder="ZIP"
              value={addr.postalCode ?? ''}
              onChange={setA('postalCode')}
            />
          </div>
        </fieldset>

        {!editing && (
          <fieldset>
            <legend className="mb-2 font-[620]">Team</legend>
            <p className="mb-3 text-[13px] text-ink-2">
              Template tasks are assigned to the first team member with the matching role.
            </p>
            <ul className="space-y-2">
              {team.map((t, i) => (
                <li key={t.key} className="grid grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_auto] gap-2">
                  <Select
                    aria-label="Team member"
                    value={t.userId}
                    placeholder="Choose a person"
                    onChange={(e) =>
                      setTeam((x) => x.map((r, k) => (k === i ? { ...r, userId: e.target.value } : r)))
                    }
                    options={(staff.data ?? []).map((m) => ({
                      value: m.userId,
                      label: m.title ? `${m.name} — ${m.title}` : m.name,
                    }))}
                  />
                  <Select
                    aria-label="Role on this project"
                    value={t.role}
                    onChange={(e) =>
                      setTeam((x) => x.map((r, k) => (k === i ? { ...r, role: e.target.value } : r)))
                    }
                    options={enumOptions(PROJECT_ROLES)}
                  />
                  <IconButton
                    label="Remove team member"
                    onClick={() => setTeam((x) => x.filter((_, k) => k !== i))}
                  >
                    <Trash2 className="size-4" />
                  </IconButton>
                </li>
              ))}
            </ul>
            <Button
              size="sm"
              variant="ghost"
              className="mt-2"
              icon={<Plus className="size-4" />}
              onClick={() =>
                setTeam((x) => [...x, { key: crypto.randomUUID(), userId: '', role: 'designer' }])
              }
            >
              Add team member
            </Button>
          </fieldset>
        )}

        {!editing && (
          <fieldset className="rounded-sm border border-line bg-stone/50 p-3">
            {/* biome-ignore lint/a11y/noLabelWithoutControl: wraps the Checkbox input */}
            <label className="flex items-start gap-2.5">
              <span className="pt-0.5">
                <Checkbox checked={applyTemplate} onChange={setApplyTemplate} label="Apply a task template" />
              </span>
              <span>
                <span className="font-[560]">Build the schedule from a template</span>
                <span className="block text-[13px] text-ink-2">
                  Generates kickoff-to-closeout tasks and milestones, scheduled in business days.
                </span>
              </span>
            </label>
            {applyTemplate && (
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <Field label="Template">
                  {(id) => (
                    <Select
                      id={id}
                      value={templateId}
                      onChange={(e) => setTemplateId(e.target.value)}
                      placeholder={
                        templates.data?.length ? 'Default template' : 'Standard hospitality FF&E template'
                      }
                      options={(templates.data ?? []).map((t) => ({
                        value: t.id,
                        label: `${t.name} (${t.taskCount} tasks)`,
                      }))}
                    />
                  )}
                </Field>
                <Field label="Schedule starts" error={errors.anchor}>
                  {(id) => (
                    <Input
                      id={id}
                      type="date"
                      value={anchorDate}
                      onChange={(e) => setAnchorDate(e.target.value)}
                    />
                  )}
                </Field>
              </div>
            )}
          </fieldset>
        )}

        <Field label="Description">
          {(id) => <Textarea id={id} value={f.description} onChange={set('description')} rows={3} />}
        </Field>
      </form>
    </Sheet>
  );
}
