import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button, cx, ErrorNote, Loading, Section } from '@/components/ui';
import { Switch } from '@/components/ui/Switch';
import { api } from '@/lib/api';
import { settingsKeys, TabIntro } from './shared';

type Digest = 'none' | 'daily' | 'immediate_critical';
interface Prefs {
  emailDigest: Digest;
  mutedTypes: string[];
}

const DIGESTS: { value: Digest; label: string; hint: string }[] = [
  { value: 'none', label: 'No email', hint: 'Notifications only appear in Pro-Cure (the bell).' },
  {
    value: 'immediate_critical',
    label: 'Urgent ones right away',
    hint: 'Critical alerts (at-risk shipments, claims) are emailed as they happen.',
  },
  {
    value: 'daily',
    label: 'Daily summary',
    hint: 'One email each morning with everything from the day before.',
  },
];

/** Notification types produced by comms (services/comms/src/subscriptions.ts, threads.ts). */
const TYPES: { type: string; label: string; hint: string }[] = [
  { type: 'mention', label: 'Mentions', hint: 'Someone @mentions you in a conversation.' },
  {
    type: 'message',
    label: 'New messages',
    hint: 'Replies on threads you take part in, including vendor email.',
  },
  { type: 'task_assigned', label: 'Task assigned to you', hint: 'A project task is assigned to you.' },
  { type: 'approval_requested', label: 'Approvals needed', hint: 'A quote is waiting for your approval.' },
  { type: 'quote_client_decided', label: 'Owner decisions', hint: 'An owner approves or rejects a quote.' },
  { type: 'tracking_added', label: 'Tracking added', hint: 'A shipment gets a tracking number.' },
  { type: 'ship_date_slipped', label: 'Ship dates slipping', hint: 'A vendor moves a ship date later.' },
  { type: 'risk_escalated', label: 'Delivery risk', hint: 'A shipment is flagged at risk of arriving late.' },
  { type: 'claim_opened', label: 'Claims', hint: 'A damage or shortage claim is opened.' },
  { type: 'ai_job_completed', label: 'AI results ready', hint: 'A document you uploaded has been read.' },
  { type: 'notify', label: 'Other updates', hint: 'Everything else Pro-Cure tells you about.' },
];

export function NotificationsTab() {
  const qc = useQueryClient();
  const prefs = useQuery({
    queryKey: settingsKeys.prefs,
    queryFn: () => api.get<Prefs>('comms', '/notification-preferences'),
  });
  const [draft, setDraft] = useState<Prefs | null>(null);
  useEffect(() => {
    if (prefs.data) setDraft(prefs.data);
  }, [prefs.data]);
  const save = useMutation({
    mutationFn: (p: Prefs) => api.put<Prefs>('comms', '/notification-preferences', p),
    onSuccess: (p) => {
      qc.setQueryData(settingsKeys.prefs, p);
      toast.success('Notification preferences saved');
    },
  });
  if (prefs.isLoading || (prefs.data && !draft)) return <Loading />;
  if (prefs.isError || !draft) return <ErrorNote error={prefs.error} />;
  const dirty = JSON.stringify(draft) !== JSON.stringify(prefs.data);

  return (
    <>
      <TabIntro
        title="Notifications"
        actions={
          <Button
            variant="primary"
            disabled={!dirty}
            loading={save.isPending}
            onClick={() => save.mutate(draft)}
          >
            Save preferences
          </Button>
        }
      >
        Choose what Pro-Cure tells you about and whether it emails you. These settings are yours alone.
      </TabIntro>
      <div className="space-y-6">
        <Section title="Email">
          <fieldset className="grid gap-2 md:grid-cols-3">
            <legend className="sr-only">Email delivery</legend>
            {DIGESTS.map((d) => (
              <label
                key={d.value}
                className={cx(
                  'flex cursor-pointer items-start gap-2.5 rounded-sm border px-3 py-2.5',
                  draft.emailDigest === d.value ? 'border-brass bg-brass-50' : 'border-line hover:bg-stone',
                )}
              >
                <input
                  type="radio"
                  name="digest"
                  className="mt-1 accent-lacquer"
                  checked={draft.emailDigest === d.value}
                  onChange={() => setDraft({ ...draft, emailDigest: d.value })}
                />
                <span>
                  <span className="block font-[560]">{d.label}</span>
                  <span className="block text-[12.5px] text-ink-3">{d.hint}</span>
                </span>
              </label>
            ))}
          </fieldset>
        </Section>
        <Section title="What to notify me about" bodyClassName="p-0">
          <ul className="divide-y divide-line-2">
            {TYPES.map((t) => {
              const on = !draft.mutedTypes.includes(t.type);
              return (
                <li key={t.type} className="flex items-center gap-3 px-4 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className={cx('font-[560]', !on && 'text-ink-3')}>{t.label}</div>
                    <div className="text-[12.5px] text-ink-3">{t.hint}</div>
                  </div>
                  <Switch
                    checked={on}
                    label={`${on ? 'Mute' : 'Unmute'} ${t.label}`}
                    onChange={(v) =>
                      setDraft({
                        ...draft,
                        mutedTypes: v
                          ? draft.mutedTypes.filter((x) => x !== t.type)
                          : [...draft.mutedTypes, t.type],
                      })
                    }
                  />
                </li>
              );
            })}
          </ul>
        </Section>
        <div className="flex justify-end">
          <Button
            variant="primary"
            disabled={!dirty}
            loading={save.isPending}
            onClick={() => save.mutate(draft)}
          >
            Save preferences
          </Button>
        </div>
      </div>
    </>
  );
}
