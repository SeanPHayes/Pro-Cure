import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Diamond,
  Mail,
  Pencil,
  Phone,
  Pin,
  PinOff,
  Plus,
  StickyNote,
  Trash2,
  Truck,
  Users,
} from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import {
  Avatar,
  Badge,
  Button,
  Checkbox,
  cx,
  Dialog,
  EmptyState,
  enumOptions,
  Facts,
  Field,
  IconButton,
  Input,
  ProgressBar,
  Section,
  Select,
  Sheet,
  Spinner,
  StatusBadge,
  Textarea,
} from '@/components/ui';
import { api, type Page } from '@/lib/api';
import { hasPerm, useSession } from '@/lib/auth';
import { ago, date, daysFromToday, humanize, money } from '@/lib/format';
import {
  CONTACT_ROLE_LABEL,
  CONTACT_ROLES,
  type Contact,
  fmtAddress,
  type Note,
  PARTY_LABEL,
  PROJECT_ROLES,
  PROJECT_STATUSES,
  type ProjectDetail,
  qk,
  STAGES,
  type Stage,
  StageStrip,
  type TeamMember,
  useClientOrgs,
  useStaff,
} from './shared';

export function useUpdateProject(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ body }: { body: Record<string, unknown>; toast?: string }) =>
      api.patch<ProjectDetail>('projects', `/projects/${id}`, body),
    onSuccess: (p, v) => {
      qc.setQueryData(qk.project(id), p);
      qc.invalidateQueries({ queryKey: ['projects'] });
      toast.success(v.toast ?? 'Project saved');
    },
  });
}

export function OverviewTab({ project: p }: { project: ProjectDetail }) {
  const s = useSession();
  const canWrite = hasPerm(s, 'projects:write');
  const clients = useClientOrgs();
  const update = useUpdateProject(p.id);
  const [stagePick, setStagePick] = useState<Stage | null>(null);
  const tc = p.taskCounts;
  const progress = tc.total ? ((tc.done + tc.skipped) / tc.total) * 100 : 0;
  const client = clients.data?.find((o) => o.id === p.clientOrgId);
  const upcoming = p.milestones.filter((m) => m.status !== 'done' && m.status !== 'skipped');
  const recentDone = p.milestones.filter((m) => m.status === 'done').slice(-2);

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
      <div className="min-w-0 space-y-4">
        <Section
          title="Stage"
          actions={
            canWrite && (
              <div className="flex items-center gap-2">
                <span className="text-[12px] text-ink-3">Status</span>
                <div className="w-[130px]">
                  <Select
                    aria-label="Project status"
                    value={p.status}
                    className="h-7 text-[13px]"
                    onChange={(e) =>
                      update.mutate({
                        body: { status: e.target.value },
                        toast: `Status set to ${humanize(e.target.value).toLowerCase()}`,
                      })
                    }
                    options={enumOptions(PROJECT_STATUSES)}
                  />
                </div>
              </div>
            )
          }
        >
          <StageStrip
            current={p.stage}
            onSelect={canWrite ? (st) => st !== p.stage && setStagePick(st) : undefined}
          />
          <div className="mt-4 grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
            <div>
              <div className="mb-1.5 flex justify-between text-[12px] text-ink-3">
                <span>Schedule progress</span>
                <span className="num">
                  {tc.done + tc.skipped} of {tc.total} tasks done
                </span>
              </div>
              <ProgressBar value={progress} />
            </div>
            <div className="flex gap-5 text-[13px]">
              <Count label="Open" n={tc.todo + tc.in_progress} />
              <Count label="Blocked" n={tc.blocked} tone={tc.blocked ? 'risk' : undefined} />
              <Count label="Overdue" n={tc.overdue} tone={tc.overdue ? 'crit' : undefined} />
            </div>
          </div>
        </Section>

        <Section title="Milestones" bodyClassName="">
          {!p.milestones.length ? (
            <EmptyState icon={<Diamond />} title="No milestones yet">
              Apply a schedule template on the Schedule tab to add milestones.
            </EmptyState>
          ) : (
            <ol className="divide-y divide-line-2">
              {[...recentDone, ...upcoming.slice(0, 6)].map((m) => {
                const done = m.status === 'done';
                const n = daysFromToday(m.dueDate);
                return (
                  <li key={m.id} className="flex items-center gap-3 px-4 py-2.5">
                    <span
                      className={cx(
                        'size-2.5 shrink-0 rotate-45',
                        done ? 'bg-ok' : n !== null && n < 0 ? 'bg-crit' : 'bg-brass',
                      )}
                    />
                    <div className="min-w-0 flex-1">
                      <div className={cx('truncate font-[560]', done && 'text-ink-3')}>{m.name}</div>
                      <div className="text-[12px] text-ink-3">
                        {m.phase}
                        {m.party !== 'internal' && ` · ${PARTY_LABEL[m.party]}`}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="num text-[13px]">{date(m.dueDate)}</div>
                      <div
                        className={cx(
                          'text-[12px]',
                          done ? 'text-ok' : n !== null && n < 0 ? 'text-crit' : 'text-ink-3',
                        )}
                      >
                        {done
                          ? 'Done'
                          : n === null
                            ? ''
                            : n < 0
                              ? `${-n} days late`
                              : n === 0
                                ? 'Today'
                                : `in ${n} days`}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </Section>

        <NotesPanel projectId={p.id} canWrite={canWrite} hasClient={!!p.clientOrgId} />
      </div>

      <div className="min-w-0 space-y-4">
        <Section title="Key facts">
          <Facts
            cols={2}
            items={[
              { label: 'Owner', value: client?.name ?? (p.clientOrgId ? '—' : 'No owner set') },
              { label: 'Type', value: humanize(p.type) },
              { label: 'Keys', value: p.keys ?? '—' },
              { label: 'Floors', value: p.floors ?? '—' },
              { label: 'Start', value: date(p.startDate) },
              { label: 'Target open', value: date(p.targetOpenDate) },
              ...(p.budget != null
                ? [{ label: 'FF&E budget', value: <span className="num">{money(p.budget, true)}</span> }]
                : []),
              { label: 'Credit terms', value: p.creditTerms ?? '—' },
            ]}
          />
          <div className="mt-3 border-t border-line-2 pt-3">
            <Facts
              items={[
                { label: 'Site address', value: fmtAddress(p.address) || '—' },
                ...(fmtAddress(p.shipToAddress) && fmtAddress(p.shipToAddress) !== fmtAddress(p.address)
                  ? [{ label: 'Ship to', value: fmtAddress(p.shipToAddress) }]
                  : []),
              ]}
            />
          </div>
          {p.description && (
            <p className="mt-3 border-t border-line-2 pt-3 whitespace-pre-wrap text-ink-2">{p.description}</p>
          )}
        </Section>
        <TeamPanel project={p} canWrite={canWrite} />
        <ContactsPanel project={p} canWrite={canWrite} />
      </div>

      <Dialog
        open={!!stagePick}
        onClose={() => setStagePick(null)}
        title={`Move to ${humanize(stagePick)}?`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setStagePick(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={update.isPending}
              onClick={() =>
                update.mutate(
                  { body: { stage: stagePick }, toast: `Stage set to ${humanize(stagePick).toLowerCase()}` },
                  { onSuccess: () => setStagePick(null) },
                )
              }
            >
              Set stage
            </Button>
          </>
        }
      >
        <p className="text-ink-2">
          {p.name} moves from <span className="font-[560] text-ink">{humanize(p.stage)}</span> to{' '}
          <span className="font-[560] text-ink">{humanize(stagePick)}</span>
          {stagePick && STAGES.indexOf(stagePick) < STAGES.indexOf(p.stage) ? ' (a step back)' : ''}. The
          owner sees the new stage in their portal.
        </p>
      </Dialog>
    </div>
  );
}

const Count = ({ label, n, tone }: { label: string; n: number; tone?: 'crit' | 'risk' }) => (
  <div>
    <div className="text-[12px] text-ink-3">{label}</div>
    <div
      className={cx(
        'num text-[17px] font-[620]',
        tone === 'crit' && 'text-crit',
        tone === 'risk' && 'text-risk',
      )}
    >
      {n}
    </div>
  </div>
);

// ------------------------------------------------------------------ Team
function TeamPanel({ project: p, canWrite }: { project: ProjectDetail; canWrite: boolean }) {
  const [editing, setEditing] = useState(false);
  return (
    <Section
      title="Team"
      actions={
        canWrite && (
          <Button
            size="sm"
            variant="ghost"
            icon={<Pencil className="size-3.5" />}
            onClick={() => setEditing(true)}
          >
            Edit team
          </Button>
        )
      }
      bodyClassName=""
    >
      {!p.team.length ? (
        <EmptyState icon={<Users />} title="No team yet">
          Add the PM, designer and procurement lead so tasks get assigned.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-line-2">
          {p.team.map((m) => (
            <li key={`${m.userId}-${m.role}`} className="flex items-center gap-3 px-4 py-2">
              <Avatar name={m.name} size={28} />
              <div className="min-w-0 flex-1">
                <div className="truncate font-[560]">
                  {m.name}
                  {m.isLead && m.role === 'project_manager' && (
                    <Badge tone="brass" className="ml-2">
                      Lead
                    </Badge>
                  )}
                </div>
                <div className="text-[12px] text-ink-3">{humanize(m.role)}</div>
              </div>
              {m.email && (
                <a
                  href={`mailto:${m.email}`}
                  className="text-ink-3 hover:text-lacquer"
                  aria-label={`Email ${m.name}`}
                >
                  <Mail className="size-4" />
                </a>
              )}
            </li>
          ))}
        </ul>
      )}
      {editing && <TeamSheet project={p} onClose={() => setEditing(false)} />}
    </Section>
  );
}

function TeamSheet({ project: p, onClose }: { project: ProjectDetail; onClose: () => void }) {
  const qc = useQueryClient();
  const staff = useStaff();
  const [rows, setRows] = useState<(Pick<TeamMember, 'userId' | 'role' | 'isLead'> & { key: string })[]>(
    p.team.map((m) => ({ key: crypto.randomUUID(), userId: m.userId, role: m.role, isLead: m.isLead })),
  );
  const save = useMutation({
    mutationFn: () => {
      const byId = new Map(staff.data?.map((m) => [m.userId, m]));
      const known = new Map(p.team.map((m) => [m.userId, m]));
      const team = rows
        .filter((r) => r.userId)
        .map((r) => {
          const m = byId.get(r.userId);
          const k = known.get(r.userId);
          return {
            userId: r.userId,
            name: m?.name ?? k?.name ?? '',
            email: m?.email ?? k?.email ?? null,
            role: r.role,
            isLead: r.isLead,
          };
        });
      return api.put('projects', `/projects/${p.id}/team`, { team });
    },
    onSuccess: () => {
      toast.success('Team saved');
      qc.invalidateQueries({ queryKey: ['projects'] });
      qc.invalidateQueries({ queryKey: ['tasks'] });
      onClose();
    },
  });
  return (
    <Sheet
      open
      onClose={onClose}
      title="Edit team"
      description="Open unassigned tasks pick up new members by role."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
            Save team
          </Button>
        </>
      }
    >
      <ul className="space-y-2">
        {rows.map((r, i) => (
          <li
            key={r.key}
            className="grid grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_auto_auto] items-center gap-2"
          >
            <Select
              aria-label="Team member"
              value={r.userId}
              placeholder="Choose a person"
              onChange={(e) =>
                setRows((x) => x.map((y, k) => (k === i ? { ...y, userId: e.target.value } : y)))
              }
              options={(staff.data ?? []).map((m) => ({ value: m.userId, label: m.name }))}
            />
            <Select
              aria-label="Role"
              value={r.role}
              onChange={(e) =>
                setRows((x) => x.map((y, k) => (k === i ? { ...y, role: e.target.value } : y)))
              }
              options={enumOptions(PROJECT_ROLES)}
            />
            {/* biome-ignore lint/a11y/noLabelWithoutControl: wraps the Checkbox input */}
            <label className="flex items-center gap-1 text-[12px] text-ink-2" title="Lead for this role">
              <Checkbox
                checked={r.isLead}
                onChange={(v) => setRows((x) => x.map((y, k) => (k === i ? { ...y, isLead: v } : y)))}
                label="Lead"
              />
              Lead
            </label>
            <IconButton label="Remove" onClick={() => setRows((x) => x.filter((_, k) => k !== i))}>
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
          setRows((x) => [...x, { key: crypto.randomUUID(), userId: '', role: 'designer', isLead: false }])
        }
      >
        Add team member
      </Button>
    </Sheet>
  );
}

// ------------------------------------------------------------------ Contacts
function ContactsPanel({ project: p, canWrite }: { project: ProjectDetail; canWrite: boolean }) {
  const [edit, setEdit] = useState<Contact | 'new' | null>(null);
  return (
    <Section
      title="Contacts"
      actions={
        canWrite && (
          <Button
            size="sm"
            variant="ghost"
            icon={<Plus className="size-3.5" />}
            onClick={() => setEdit('new')}
          >
            Add contact
          </Button>
        )
      }
      bodyClassName=""
    >
      {!p.contacts.length ? (
        <EmptyState title="No contacts yet">
          Add the owner rep, GM, site manager, GC and warehouse so deliveries and questions reach the right
          person.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-line-2">
          {p.contacts.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                disabled={!canWrite}
                onClick={() => setEdit(c)}
                className="block w-full px-4 py-2.5 text-left enabled:hover:bg-stone"
              >
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-[560]">{c.name}</span>
                  {c.isDeliveryRecipient && (
                    <span title="Receives delivery notices">
                      <Truck className="size-3.5 text-lacquer" aria-label="Delivery recipient" />
                    </span>
                  )}
                  {c.visibleToClient && (
                    <span
                      className="text-[11.5px] font-[560] text-brass"
                      title="Shown to the owner in their portal"
                    >
                      Owner can see
                    </span>
                  )}
                </div>
                <div className="truncate text-[12px] text-ink-3">
                  {CONTACT_ROLE_LABEL[c.role] ?? humanize(c.role)}
                  {c.company ? ` · ${c.company}` : ''}
                </div>
                <div className="mt-0.5 flex flex-wrap gap-x-3 text-[12.5px] text-ink-2">
                  {c.phone && (
                    <span className="inline-flex items-center gap-1">
                      <Phone className="size-3" />
                      {c.phone}
                    </span>
                  )}
                  {c.email && (
                    <span className="inline-flex min-w-0 items-center gap-1">
                      <Mail className="size-3" />
                      <span className="truncate">{c.email}</span>
                    </span>
                  )}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
      {edit && (
        <ContactSheet projectId={p.id} contact={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />
      )}
    </Section>
  );
}

function ContactSheet({
  projectId,
  contact,
  onClose,
}: {
  projectId: string;
  contact: Contact | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [f, setF] = useState({
    name: contact?.name ?? '',
    company: contact?.company ?? '',
    role: contact?.role ?? 'owner_rep',
    email: contact?.email ?? '',
    phone: contact?.phone ?? '',
    notes: contact?.notes ?? '',
    isDeliveryRecipient: contact?.isDeliveryRecipient ?? false,
    visibleToClient: contact?.visibleToClient ?? false,
  });
  const [err, setErr] = useState<Record<string, string>>({});
  const [confirmDelete, setConfirmDelete] = useState(false);
  const done = (msg: string) => {
    toast.success(msg, { description: f.name });
    qc.invalidateQueries({ queryKey: qk.project(projectId) });
    onClose();
  };
  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: f.name.trim(),
        company: f.company.trim() || null,
        role: f.role,
        email: f.email.trim() || null,
        phone: f.phone.trim() || null,
        notes: f.notes.trim() || null,
        isDeliveryRecipient: f.isDeliveryRecipient,
        visibleToClient: f.visibleToClient,
      };
      return contact
        ? api.patch('projects', `/projects/${projectId}/contacts/${contact.id}`, body)
        : api.post('projects', `/projects/${projectId}/contacts`, body);
    },
    onSuccess: () => done(contact ? 'Contact saved' : 'Contact added'),
  });
  const remove = useMutation({
    mutationFn: () => api.del('projects', `/projects/${projectId}/contacts/${contact!.id}`),
    onSuccess: () => done('Contact removed'),
  });
  const submit = () => {
    const e: Record<string, string> = {};
    if (!f.name.trim()) e.name = 'Enter the contact’s name.';
    if (f.email && !/^\S+@\S+\.\S+$/.test(f.email.trim()))
      e.email = 'Enter a valid email, like name@hotel.com.';
    setErr(e);
    if (!Object.keys(e).length) save.mutate();
  };
  const set =
    (k: 'name' | 'company' | 'role' | 'email' | 'phone' | 'notes') => (e: { target: { value: string } }) =>
      setF((x) => ({ ...x, [k]: e.target.value }));
  return (
    <Sheet
      open
      onClose={onClose}
      title={contact ? 'Edit contact' : 'Add contact'}
      footer={
        <>
          {contact && (
            <Button variant="danger" className="mr-auto" onClick={() => setConfirmDelete(true)}>
              Remove contact
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={save.isPending} onClick={submit}>
            {contact ? 'Save contact' : 'Add contact'}
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" error={err.name}>
            {(id) => <Input id={id} autoFocus value={f.name} onChange={set('name')} />}
          </Field>
          <Field label="Role">
            {(id) => (
              <Select
                id={id}
                value={f.role}
                onChange={set('role')}
                options={CONTACT_ROLES.map((r) => ({ value: r, label: CONTACT_ROLE_LABEL[r]! }))}
              />
            )}
          </Field>
          <Field label="Company" className="sm:col-span-2">
            {(id) => <Input id={id} value={f.company} onChange={set('company')} />}
          </Field>
          <Field label="Email" error={err.email}>
            {(id) => <Input id={id} type="email" value={f.email} onChange={set('email')} />}
          </Field>
          <Field label="Phone">
            {(id) => <Input id={id} type="tel" value={f.phone} onChange={set('phone')} />}
          </Field>
        </div>
        <div className="space-y-3 rounded-sm border border-line p-3">
          <Toggle
            checked={f.isDeliveryRecipient}
            onChange={(v) => setF((x) => ({ ...x, isDeliveryRecipient: v }))}
            title="Delivery recipient"
            hint="Gets delivery appointments and receiving notices for this site."
          />
          <Toggle
            checked={f.visibleToClient}
            onChange={(v) => setF((x) => ({ ...x, visibleToClient: v }))}
            title="Show to the owner"
            hint="Listed under “Who to call” in the owner portal."
          />
        </div>
        <Field label="Notes">
          {(id) => (
            <Textarea
              id={id}
              rows={3}
              value={f.notes}
              onChange={set('notes')}
              placeholder="Gate code, best time to call…"
            />
          )}
        </Field>
        <button type="submit" hidden />
      </form>
      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={`Remove ${f.name}?`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate()}>
              Remove contact
            </Button>
          </>
        }
      >
        <p className="text-ink-2">They’ll stop receiving delivery notices for this project.</p>
      </Dialog>
    </Sheet>
  );
}

function Toggle({
  checked,
  onChange,
  title,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  title: string;
  hint: string;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: wraps the Checkbox input
    <label className="flex cursor-pointer items-start gap-2.5">
      <span className="pt-0.5">
        <Checkbox checked={checked} onChange={onChange} label={title} />
      </span>
      <span>
        <span className="font-[560]">{title}</span>
        <span className="block text-[13px] text-ink-2">{hint}</span>
      </span>
    </label>
  );
}

// ------------------------------------------------------------------ Notes
function NotesPanel({
  projectId,
  canWrite,
  hasClient,
}: {
  projectId: string;
  canWrite: boolean;
  hasClient: boolean;
}) {
  const qc = useQueryClient();
  const notes = useQuery({
    queryKey: qk.notes(projectId),
    queryFn: () => api.get<Page<Note>>('projects', `/projects/${projectId}/notes`, { limit: 20 }),
  });
  const [body, setBody] = useState('');
  const [shared, setShared] = useState(false);
  const [pinned, setPinned] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: qk.notes(projectId) });
  const add = useMutation({
    mutationFn: () =>
      api.post('projects', `/projects/${projectId}/notes`, {
        body: body.trim(),
        visibility: shared ? 'client' : 'internal',
        pinned,
      }),
    onSuccess: () => {
      toast.success(shared ? 'Note shared with owner' : 'Note added');
      setBody('');
      setPinned(false);
      setShared(false);
      refresh();
    },
  });
  const patch = useMutation({
    mutationFn: ({ id, ...b }: { id: string; pinned?: boolean }) =>
      api.patch('projects', `/projects/${projectId}/notes/${id}`, b),
    onSuccess: (_d, v) => {
      toast.success(v.pinned ? 'Note pinned' : 'Note unpinned');
      refresh();
    },
  });
  const del = useMutation({
    mutationFn: (id: string) => api.del('projects', `/projects/${projectId}/notes/${id}`),
    onSuccess: () => {
      toast.success('Note deleted');
      refresh();
    },
  });
  const items = notes.data?.items ?? [];
  return (
    <Section title="Notes" bodyClassName="">
      {canWrite && (
        <form
          className="border-b border-line-2 p-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (body.trim()) add.mutate();
          }}
        >
          <Textarea
            rows={2}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Add a note — decisions, site conditions, owner preferences…"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && body.trim()) add.mutate();
            }}
          />
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
            {/* biome-ignore lint/a11y/noLabelWithoutControl: wraps the Checkbox input */}
            <label className="flex items-center gap-1.5 text-[13px] text-ink-2">
              <Checkbox checked={pinned} onChange={setPinned} label="Pin note" />
              Pin
            </label>
            {hasClient && (
              // biome-ignore lint/a11y/noLabelWithoutControl: wraps the Checkbox input
              <label className="flex items-center gap-1.5 text-[13px] text-ink-2">
                <Checkbox checked={shared} onChange={setShared} label="Share with owner" />
                Share with owner
              </label>
            )}
            <Button
              type="submit"
              size="sm"
              variant="primary"
              className="ml-auto"
              disabled={!body.trim()}
              loading={add.isPending}
            >
              {shared ? 'Share note' : 'Add note'}
            </Button>
          </div>
        </form>
      )}
      {notes.isLoading ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : !items.length ? (
        <EmptyState icon={<StickyNote />} title="No notes yet">
          Notes keep the whole team on the same page. Pin the ones everyone should see first.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-line-2">
          {items.map((n) => (
            <li key={n.id} className={cx('group px-4 py-3', n.pinned && 'bg-brass-50/60')}>
              <div className="flex items-center gap-2 text-[12px] text-ink-3">
                {n.pinned && <Pin className="size-3 text-brass" aria-label="Pinned" />}
                <span className="font-[560] text-ink-2">{n.authorName}</span>
                <span>{ago(n.createdAt)}</span>
                {n.visibility === 'client' && <StatusBadge status="sent" label="Shared with owner" />}
                {canWrite && (
                  <span className="ml-auto flex opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                    <IconButton
                      label={n.pinned ? 'Unpin note' : 'Pin note'}
                      className="size-7"
                      onClick={() => patch.mutate({ id: n.id, pinned: !n.pinned })}
                    >
                      {n.pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
                    </IconButton>
                    <IconButton label="Delete note" className="size-7" onClick={() => del.mutate(n.id)}>
                      <Trash2 className="size-3.5" />
                    </IconButton>
                  </span>
                )}
              </div>
              <p className="mt-1 whitespace-pre-wrap">{n.body}</p>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
