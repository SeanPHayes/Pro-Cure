import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { UserPlus, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { CopyField } from '@/components/shared/CopyField';
import {
  Avatar,
  Badge,
  Button,
  Dialog,
  EmptyState,
  ErrorNote,
  Field,
  Input,
  SearchInput,
  Sheet,
  StatusBadge,
} from '@/components/ui';
import { type Column, DataTable } from '@/components/ui/DataTable';
import { api, errorMessage } from '@/lib/api';
import { useMe } from '@/lib/auth';
import { ago } from '@/lib/format';
import {
  INTERNAL_ROLES,
  type InviteResult,
  type Member,
  type RoleInfo,
  RolePicker,
  roleLabel,
  rolesFor,
  settingsKeys,
  TabIntro,
} from './shared';

export function PeopleTab() {
  const s = useMe();
  const orgId = s.context.orgId;
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<Member | null>(null);
  const [inviting, setInviting] = useState(false);
  const users = useQuery({
    queryKey: settingsKeys.users(orgId),
    queryFn: () => api.get<Member[]>('identity', '/users', { orgId }),
  });
  const term = q.trim().toLowerCase();
  const rows = (users.data ?? [])
    .filter((u) => !term || `${u.name} ${u.email} ${u.title ?? ''}`.toLowerCase().includes(term))
    .map((u) => ({ ...u, id: u.membershipId }));
  const active = users.data?.filter((u) => u.status === 'active').length ?? 0;

  const columns: Column<Member & { id: string }>[] = [
    {
      key: 'name',
      header: 'Person',
      cell: (u) => (
        <div className="flex min-w-[220px] items-center gap-2.5">
          <Avatar name={u.name} size={30} />
          <div className="min-w-0">
            <div className="truncate font-[560]">
              {u.name}
              {u.userId === s.user.id && (
                <span className="ml-1.5 text-[12px] font-normal text-ink-3">(you)</span>
              )}
            </div>
            <div className="truncate text-[12.5px] text-ink-3">{u.email}</div>
          </div>
        </div>
      ),
    },
    { key: 'title', header: 'Title', cell: (u) => u.title ?? <span className="text-ink-4">—</span> },
    {
      key: 'roles',
      header: 'Roles',
      cell: (u) => (
        <div className="flex min-w-[160px] flex-wrap gap-1">
          {u.roles.map((r) => (
            <Badge key={r} tone={r === 'admin' ? 'brass' : 'neutral'}>
              {roleLabel(r)}
            </Badge>
          ))}
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (u) =>
        u.status === 'active' && !u.lastLoginAt ? (
          <StatusBadge status="pending" label="Invited" />
        ) : (
          <StatusBadge
            status={u.status === 'disabled' ? 'cancelled' : u.status}
            label={u.status === 'disabled' ? 'Disabled' : 'Active'}
          />
        ),
    },
    {
      key: 'last',
      header: 'Last signed in',
      cell: (u) => <span className="text-ink-2">{u.lastLoginAt ? ago(u.lastLoginAt) : 'Never'}</span>,
    },
  ];

  return (
    <>
      <TabIntro
        title="People"
        actions={
          <Button variant="primary" icon={<UserPlus className="size-4" />} onClick={() => setInviting(true)}>
            Invite person
          </Button>
        }
      >
        Everyone at {s.context.orgName} who can sign in. Roles decide what each person can see and do; a
        person can hold more than one.
      </TabIntro>
      <div className="rounded-md border border-line bg-paper">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line-2 px-3 py-2.5">
          <SearchInput
            value={q}
            onChange={setQ}
            placeholder="Search people"
            className="w-full sm:w-[280px]"
          />
          {users.data && (
            <span className="text-[13px] text-ink-3">
              {active} active of {users.data.length}
            </span>
          )}
        </div>
        {users.isError ? (
          <ErrorNote error={users.error} />
        ) : (
          <DataTable
            columns={columns}
            rows={users.data ? rows : undefined}
            loading={users.isLoading}
            onRowClick={(u) => setEditing(u)}
            rowClassName={(u) => (u.status === 'disabled' ? 'opacity-60' : undefined)}
            empty={
              <EmptyState icon={<Users />} title={term ? 'No one matches that search' : 'No people yet'}>
                {term ? 'Try a name or email address.' : 'Invite your team to start working in Pro-Cure.'}
              </EmptyState>
            }
          />
        )}
      </div>
      <MemberSheet member={editing} onClose={() => setEditing(null)} />
      <InviteSheet
        open={inviting}
        onClose={() => setInviting(false)}
        orgId={orgId}
        orgName={s.context.orgName}
        roles={INTERNAL_ROLES}
        defaultRoles={['viewer']}
      />
    </>
  );
}

function MemberSheet({ member, onClose }: { member: Member | null; onClose: () => void }) {
  const s = useMe();
  const qc = useQueryClient();
  const [roles, setRoles] = useState<string[]>([]);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => setRoles(member?.roles ?? []), [member]);
  const self = member?.userId === s.user.id;
  const save = useMutation({
    mutationFn: (body: { roles?: string[]; status?: 'active' | 'disabled' }) =>
      api.patch('identity', `/memberships/${member!.membershipId}`, body),
    onSuccess: (_r, body) => {
      qc.invalidateQueries({ queryKey: ['settings', 'users'] });
      setConfirm(false);
      toast.success(
        body.status === 'disabled'
          ? `${member!.name} disabled`
          : body.status === 'active'
            ? `${member!.name} re-enabled`
            : 'Roles saved',
      );
      onClose();
    },
  });
  if (!member) return null;
  const changed = roles.slice().sort().join() !== member.roles.slice().sort().join();
  const losingAdmin = self && member.roles.includes('admin') && !roles.includes('admin');
  return (
    <>
      <Sheet
        open
        onClose={onClose}
        title={member.name}
        description={`${member.email}${member.title ? ` · ${member.title}` : ''}`}
        footer={
          <>
            {member.status === 'active' ? (
              !self && (
                <Button variant="danger" className="mr-auto" onClick={() => setConfirm(true)}>
                  Disable access
                </Button>
              )
            ) : (
              <Button
                className="mr-auto"
                loading={save.isPending}
                onClick={() => save.mutate({ status: 'active' })}
              >
                Re-enable access
              </Button>
            )}
            <Button onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!changed || !roles.length}
              loading={save.isPending && !confirm}
              onClick={() => save.mutate({ roles })}
            >
              Save roles
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <div className="text-[13px] font-[560] text-ink-2">Roles</div>
          <RolePicker roles={rolesFor(member.orgType)} value={roles} onChange={setRoles} />
          {!roles.length && <p className="text-[12px] text-crit">Choose at least one role.</p>}
          {losingAdmin && (
            <p className="rounded-sm bg-warn-50 px-3 py-2 text-[13px] text-warn">
              You are removing your own administrator role. You will lose access to People and Settings after
              you next sign in.
            </p>
          )}
          <p className="text-[12.5px] text-ink-3">
            Role changes take effect the next time {self ? 'you sign' : `${member.name.split(' ')[0]} signs`}{' '}
            in or their session refreshes (within 15 minutes).
          </p>
          {save.isError && <p className="text-[13px] text-crit">{errorMessage(save.error)}</p>}
        </div>
      </Sheet>
      <Dialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title={`Disable ${member.name}?`}
        footer={
          <>
            <Button onClick={() => setConfirm(false)}>Cancel</Button>
            <Button
              variant="danger"
              loading={save.isPending}
              onClick={() => save.mutate({ status: 'disabled' })}
            >
              Disable access
            </Button>
          </>
        }
      >
        <p className="text-ink-2">
          They can no longer sign in to {s.context.orgName}. Their work, messages and history stay as they
          are. You can re-enable access at any time.
        </p>
      </Dialog>
    </>
  );
}

/** Invite a person into this firm or a connected vendor/owner organization; shows the link to share. */
export function InviteSheet({
  open,
  onClose,
  orgId,
  orgName,
  roles,
  defaultRoles,
}: {
  open: boolean;
  onClose: () => void;
  orgId: string;
  orgName: string;
  roles: RoleInfo[];
  defaultRoles: string[];
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ name: '', email: '', title: '' });
  const [picked, setPicked] = useState<string[]>(defaultRoles);
  const [result, setResult] = useState<InviteResult | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the sheet opens
  useEffect(() => {
    if (open) {
      setForm({ name: '', email: '', title: '' });
      setPicked(defaultRoles);
      setResult(null);
    }
  }, [open]);
  const invite = useMutation({
    mutationFn: () =>
      api.post<InviteResult>('identity', '/users/invite', {
        name: form.name.trim(),
        email: form.email.trim(),
        title: form.title.trim() || undefined,
        orgId,
        roles: picked,
      }),
    onSuccess: (r) => {
      setResult(r);
      qc.invalidateQueries({ queryKey: ['settings'] });
      toast.success(`Invitation sent to ${form.name.trim()}`);
    },
    onError: () => {},
  });
  const valid = form.name.trim() && /.+@.+\..+/.test(form.email) && picked.length > 0;
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={result ? 'Invitation ready' : `Invite to ${orgName}`}
      description={result ? undefined : 'They get an email with a link to set up their sign-in.'}
      footer={
        result ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!valid}
              loading={invite.isPending}
              onClick={() => invite.mutate()}
            >
              Send invitation
            </Button>
          </>
        )
      }
    >
      {result ? (
        <div className="space-y-4">
          <p className="text-ink-2">
            We emailed <span className="font-[560] text-ink">{form.email}</span> an invitation to {orgName}.
            You can also share this link directly; it works once and expires in 14 days.
          </p>
          <CopyField value={result.inviteUrl} label="Invite link" />
        </div>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) invite.mutate();
          }}
        >
          <Field label="Full name">
            {(id) => (
              <Input
                id={id}
                autoFocus
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            )}
          </Field>
          <Field label="Work email">
            {(id) => (
              <Input
                id={id}
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
              />
            )}
          </Field>
          <Field label="Title" hint="Optional, e.g. Purchasing Coordinator">
            {(id) => (
              <Input
                id={id}
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
              />
            )}
          </Field>
          <div className="space-y-1.5">
            <div className="text-[13px] font-[560] text-ink-2">Roles</div>
            <RolePicker roles={roles} value={picked} onChange={setPicked} />
          </div>
          {invite.isError && (
            <p className="rounded-sm bg-crit-50 px-3 py-2 text-[13px] text-crit">
              {errorMessage(invite.error)}
            </p>
          )}
        </form>
      )}
    </Sheet>
  );
}
