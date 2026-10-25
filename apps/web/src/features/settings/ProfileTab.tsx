import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Avatar, Badge, Button, ErrorNote, Facts, Field, Input, Loading, Section } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { roleLabel, settingsKeys, TabIntro } from './shared';

interface Me {
  id: string;
  email: string;
  name: string;
  title: string | null;
  phone: string | null;
  context: { orgName: string; roles: string[] };
  contexts: { orgId: string; orgName: string; tenantName: string; roles: string[] }[];
}

export function ProfileTab() {
  const qc = useQueryClient();
  const me = useQuery({ queryKey: settingsKeys.me, queryFn: () => api.get<Me>('identity', '/me') });
  const [f, setF] = useState({ name: '', title: '', phone: '' });
  useEffect(() => {
    if (me.data) setF({ name: me.data.name, title: me.data.title ?? '', phone: me.data.phone ?? '' });
  }, [me.data]);
  const save = useMutation({
    mutationFn: () =>
      api.patch('identity', '/me', {
        name: f.name.trim(),
        title: f.title.trim() || null,
        phone: f.phone.trim() || null,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: settingsKeys.me });
      qc.invalidateQueries({ queryKey: ['settings', 'users'] });
      toast.success('Profile saved');
    },
    onError: () => {},
  });
  if (me.isLoading) return <Loading />;
  if (me.isError || !me.data) return <ErrorNote error={me.error} />;
  const m = me.data;
  const dirty =
    f.name.trim() !== m.name || f.title.trim() !== (m.title ?? '') || f.phone.trim() !== (m.phone ?? '');

  return (
    <>
      <TabIntro title="Profile">
        How you appear to your team, and to vendors and owners when you message them or sign a PO.
      </TabIntro>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <Section title="Your details">
          <form
            className="max-w-[520px] space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (dirty && f.name.trim()) save.mutate();
            }}
          >
            <div className="flex items-center gap-3">
              <Avatar name={f.name || m.name} size={48} />
              <div className="min-w-0">
                <div className="font-[620]">{f.name || m.name}</div>
                <div className="text-[13px] text-ink-3">{m.email}</div>
              </div>
            </div>
            <Field label="Full name" error={!f.name.trim() ? 'Your name is required.' : undefined}>
              {(id) => (
                <Input id={id} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
              )}
            </Field>
            <Field label="Title" hint="Shown under your name in messages and on documents.">
              {(id) => (
                <Input id={id} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
              )}
            </Field>
            <Field label="Phone" hint="Printed as the contact number on POs you issue.">
              {(id) => (
                <Input
                  id={id}
                  type="tel"
                  value={f.phone}
                  onChange={(e) => setF({ ...f, phone: e.target.value })}
                />
              )}
            </Field>
            {save.isError && <p className="text-[13px] text-crit">{errorMessage(save.error)}</p>}
            <div className="flex gap-2">
              <Button
                type="submit"
                variant="primary"
                disabled={!dirty || !f.name.trim()}
                loading={save.isPending}
              >
                Save profile
              </Button>
              {dirty && (
                <Button onClick={() => setF({ name: m.name, title: m.title ?? '', phone: m.phone ?? '' })}>
                  Discard changes
                </Button>
              )}
            </div>
          </form>
        </Section>
        <Section title="Access">
          <Facts
            items={[
              { label: 'Email (sign-in)', value: m.email },
              {
                label: `Roles at ${m.context.orgName}`,
                value: (
                  <span className="mt-0.5 flex flex-wrap gap-1">
                    {m.context.roles.map((r) => (
                      <Badge key={r}>{roleLabel(r)}</Badge>
                    ))}
                  </span>
                ),
              },
              ...(m.contexts.length > 1
                ? [
                    {
                      label: 'Other workspaces',
                      value: m.contexts
                        .filter((c) => c.orgName !== m.context.orgName)
                        .map((c) => c.orgName)
                        .join(', '),
                    },
                  ]
                : []),
            ]}
          />
          <p className="mt-4 text-[12.5px] text-ink-3">
            An administrator changes roles under Settings → People. Your email is your sign-in and can’t be
            changed here.
          </p>
        </Section>
      </div>
    </>
  );
}
