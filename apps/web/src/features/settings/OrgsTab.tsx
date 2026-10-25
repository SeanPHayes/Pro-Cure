import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, ExternalLink, Plus, UserPlus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  Avatar,
  Badge,
  Button,
  Chips,
  EmptyState,
  ErrorNote,
  Facts,
  Field,
  Input,
  SearchInput,
  Sheet,
  Spinner,
  StatusBadge,
} from '@/components/ui';
import { type Column, DataTable } from '@/components/ui/DataTable';
import { api, errorMessage } from '@/lib/api';
import { ago } from '@/lib/format';
import { InviteSheet } from './PeopleTab';
import {
  CLIENT_ROLES,
  type Member,
  type Org,
  roleLabel,
  settingsKeys,
  TabIntro,
  VENDOR_ROLES,
} from './shared';

type Kind = 'vendor' | 'client';
const KIND: Record<Kind, { one: string; many: string; blurb: string }> = {
  vendor: {
    one: 'vendor',
    many: 'Vendors',
    blurb: 'Manufacturers and suppliers who answer pricing requests and confirm POs on the vendor portal.',
  },
  client: {
    one: 'owner',
    many: 'Owners',
    blurb:
      'Hotel owners and management companies who review quotes, approve and report claims on the owner portal.',
  },
};

export function OrgsTab() {
  const [kind, setKind] = useState<Kind>('vendor');
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<Org | null>(null);
  const orgs = useQuery({
    queryKey: settingsKeys.orgs(kind),
    queryFn: () => api.get<Org[]>('identity', '/orgs', { type: kind }),
  });
  const term = q.trim().toLowerCase();
  const rows = (orgs.data ?? []).filter(
    (o) => !term || `${o.name} ${o.website ?? ''} ${o.email ?? ''}`.toLowerCase().includes(term),
  );

  const columns: Column<Org>[] = [
    {
      key: 'name',
      header: 'Organization',
      cell: (o) => (
        <div className="min-w-[220px]">
          <div className="font-[560]">{o.name}</div>
          {o.legalName && o.legalName !== o.name && (
            <div className="text-[12.5px] text-ink-3">{o.legalName}</div>
          )}
        </div>
      ),
    },
    {
      key: 'contact',
      header: 'Contact',
      cell: (o) => (
        <div className="min-w-[180px] text-[13px] text-ink-2">
          {o.email ??
            (o.website ? o.website.replace(/^https?:\/\//, '') : <span className="text-ink-4">—</span>)}
        </div>
      ),
    },
    {
      key: 'members',
      header: 'Portal users',
      align: 'right',
      cell: (o) => (o.memberCount ? o.memberCount : <span className="text-[13px] text-ink-3">None yet</span>),
    },
    { key: 'status', header: 'Status', cell: (o) => <StatusBadge status={o.status} /> },
  ];

  return (
    <>
      <TabIntro
        title="Vendors & owners"
        actions={
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>
            Add {KIND[kind].one}
          </Button>
        }
      >
        Organizations connected to your firm. Their people sign in to their own portal and only ever see what
        is shared with them.
      </TabIntro>
      <div className="rounded-md border border-line bg-paper">
        <div className="flex flex-wrap items-center gap-3 border-b border-line-2 px-3 py-2.5">
          <Chips<Kind>
            value={kind}
            onChange={setKind}
            options={[
              { value: 'vendor', label: 'Vendors' },
              { value: 'client', label: 'Owners' },
            ]}
          />
          <SearchInput
            value={q}
            onChange={setQ}
            placeholder={`Search ${KIND[kind].many.toLowerCase()}`}
            className="w-full sm:w-[260px]"
          />
        </div>
        <p className="border-b border-line-2 bg-stone/50 px-3 py-2 text-[13px] text-ink-3">
          {KIND[kind].blurb}
        </p>
        {orgs.isError ? (
          <ErrorNote error={orgs.error} />
        ) : (
          <DataTable
            columns={columns}
            rows={orgs.data ? rows : undefined}
            loading={orgs.isLoading}
            onRowClick={setOpen}
            empty={
              <EmptyState
                icon={<Building2 />}
                title={term ? 'No matches' : `No ${KIND[kind].many.toLowerCase()} connected yet`}
                action={
                  !term && (
                    <Button icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>
                      Add {KIND[kind].one}
                    </Button>
                  )
                }
              >
                {term
                  ? 'Try another name.'
                  : `Add a ${KIND[kind].one} organization, then invite their people.`}
              </EmptyState>
            }
          />
        )}
      </div>
      <AddOrgSheet
        open={adding}
        kind={kind}
        onClose={() => setAdding(false)}
        onCreated={(o) => {
          setAdding(false);
          setOpen(o);
        }}
      />
      <OrgSheet org={open} onClose={() => setOpen(null)} />
    </>
  );
}

function AddOrgSheet({
  open,
  kind,
  onClose,
  onCreated,
}: {
  open: boolean;
  kind: Kind;
  onClose: () => void;
  onCreated: (o: Org) => void;
}) {
  const qc = useQueryClient();
  const [type, setType] = useState<Kind>(kind);
  const [f, setF] = useState({ name: '', legalName: '', email: '', phone: '', website: '' });
  useEffect(() => {
    if (open) {
      setType(kind);
      setF({ name: '', legalName: '', email: '', phone: '', website: '' });
    }
  }, [open, kind]);
  const create = useMutation({
    mutationFn: () =>
      api.post<Org>('identity', '/orgs', {
        type,
        name: f.name.trim(),
        ...Object.fromEntries(
          Object.entries({ legalName: f.legalName, email: f.email, phone: f.phone, website: f.website })
            .map(([k, v]) => [k, v.trim()])
            .filter(([, v]) => v),
        ),
      }),
    onSuccess: (o) => {
      qc.invalidateQueries({ queryKey: ['settings', 'orgs'] });
      toast.success(`${o.name} added`);
      onCreated(o);
    },
    onError: () => {},
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF({ ...f, [k]: e.target.value });
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={`Add ${KIND[type].one}`}
      description="Connect an organization to your firm. You can invite their people next."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={f.name.trim().length < 2}
            loading={create.isPending}
            onClick={() => create.mutate()}
          >
            Add {KIND[type].one}
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (f.name.trim().length >= 2) create.mutate();
        }}
      >
        <Field label="Type">
          {() => (
            <Chips<Kind>
              value={type}
              onChange={setType}
              options={[
                { value: 'vendor', label: 'Vendor' },
                { value: 'client', label: 'Owner' },
              ]}
            />
          )}
        </Field>
        <Field label="Name">
          {(id) => <Input id={id} autoFocus value={f.name} onChange={set('name')} />}
        </Field>
        <Field label="Legal name" hint="Optional; used on POs and invoices when different.">
          {(id) => <Input id={id} value={f.legalName} onChange={set('legalName')} />}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Email">
            {(id) => <Input id={id} type="email" value={f.email} onChange={set('email')} />}
          </Field>
          <Field label="Phone">{(id) => <Input id={id} value={f.phone} onChange={set('phone')} />}</Field>
        </div>
        <Field label="Website">
          {(id) => <Input id={id} value={f.website} onChange={set('website')} placeholder="https://" />}
        </Field>
        {type === 'vendor' && (
          <p className="text-[12.5px] text-ink-3">
            This connects the vendor’s portal login. Pricing, categories and lead times live on the vendor’s
            profile under Library → Vendors.
          </p>
        )}
        {create.isError && (
          <p className="rounded-sm bg-crit-50 px-3 py-2 text-[13px] text-crit">
            {errorMessage(create.error)}
          </p>
        )}
      </form>
    </Sheet>
  );
}

function OrgSheet({ org, onClose }: { org: Org | null; onClose: () => void }) {
  const [inviting, setInviting] = useState(false);
  const users = useQuery({
    queryKey: settingsKeys.users(org?.id ?? ''),
    queryFn: () => api.get<Member[]>('identity', '/users', { orgId: org!.id }),
    enabled: !!org,
  });
  if (!org) return null;
  const kind = (org.type === 'client' ? 'client' : 'vendor') as Kind;
  const roles = kind === 'vendor' ? VENDOR_ROLES : CLIENT_ROLES;
  return (
    <>
      <Sheet
        open
        onClose={onClose}
        title={org.name}
        description={kind === 'vendor' ? 'Vendor organization' : 'Owner organization'}
        width={560}
        footer={
          <Button variant="primary" icon={<UserPlus className="size-4" />} onClick={() => setInviting(true)}>
            Invite user
          </Button>
        }
      >
        <div className="space-y-6">
          <Facts
            cols={2}
            items={[
              { label: 'Email', value: org.email },
              { label: 'Phone', value: org.phone },
              {
                label: 'Website',
                value: org.website ? (
                  <a
                    href={org.website}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-lacquer hover:underline"
                  >
                    {org.website.replace(/^https?:\/\//, '')} <ExternalLink className="size-3" />
                  </a>
                ) : null,
              },
              { label: 'Connected', value: ago(org.createdAt) },
            ]}
          />
          <div>
            <h3 className="mb-2 font-[620]">Portal users</h3>
            {users.isLoading ? (
              <div className="flex justify-center py-6">
                <Spinner />
              </div>
            ) : users.isError ? (
              <ErrorNote error={users.error} />
            ) : !users.data?.length ? (
              <div className="rounded-sm border border-dashed border-line px-4 py-6 text-center text-ink-2">
                No one from {org.name} can sign in yet. Invite their{' '}
                {kind === 'vendor' ? 'sales or customer-service contact' : 'project lead'} so they can work
                with you on the portal.
              </div>
            ) : (
              <ul className="divide-y divide-line-2 rounded-sm border border-line">
                {users.data.map((u) => (
                  <li key={u.membershipId} className="flex items-center gap-3 px-3 py-2.5">
                    <Avatar name={u.name} tone="brass" size={30} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-[560]">{u.name}</div>
                      <div className="truncate text-[12.5px] text-ink-3">
                        {u.email}
                        {u.title && ` · ${u.title}`}
                      </div>
                    </div>
                    <div className="flex flex-wrap justify-end gap-1">
                      {u.roles.map((r) => (
                        <Badge key={r}>{roleLabel(r)}</Badge>
                      ))}
                      {u.status === 'disabled' && <StatusBadge status="cancelled" label="Disabled" />}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </Sheet>
      <InviteSheet
        open={inviting}
        onClose={() => setInviting(false)}
        orgId={org.id}
        orgName={org.name}
        roles={roles}
        defaultRoles={[roles[0]!.value]}
      />
    </>
  );
}
