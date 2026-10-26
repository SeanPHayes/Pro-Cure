import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Camera, ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { uploadDocument } from '@/components/shared/DocumentsPanel';
import {
  Badge,
  Button,
  cx,
  EmptyState,
  ErrorNote,
  Field,
  Loading,
  Select,
  Sheet,
  Textarea,
} from '@/components/ui';
import { FilePicker } from '@/features/orders/shared';
import type { ClaimType, ClientClaim, ClientOrder } from '@/features/orders/types';
import { api, errorMessage, type Page } from '@/lib/api';
import { hasPerm, useMe } from '@/lib/auth';
import { ago } from '@/lib/format';

/** Owner-facing wording for claim types and statuses. */
export const OWNER_CLAIM_TYPE: Record<ClaimType, string> = {
  damage: 'Damaged on arrival',
  concealed_damage: 'Damage found after unpacking',
  shortage: 'Missing items',
  wrong_item: 'Wrong item',
  defect: 'Defect',
  other: 'Something else',
};
export const OWNER_CLAIM_STATUS: Record<
  string,
  { label: string; tone: 'warn' | 'info' | 'lacquer' | 'ok' | 'neutral'; next: string }
> = {
  open: {
    label: 'Received',
    tone: 'warn',
    next: 'Your project team is reviewing it and will take it up with the vendor.',
  },
  submitted_to_vendor: {
    label: 'With the vendor',
    tone: 'info',
    next: 'The vendor has the claim and photos and is working out the fix.',
  },
  vendor_acknowledged: {
    label: 'Vendor working on it',
    tone: 'lacquer',
    next: 'The vendor accepted the claim. Next they’ll order a replacement or issue a credit.',
  },
  replacement_ordered: {
    label: 'Replacement on the way',
    tone: 'lacquer',
    next: 'A replacement is ordered. Your team will tell you when it’s scheduled to arrive.',
  },
  credited: {
    label: 'Credited',
    tone: 'ok',
    next: 'The vendor issued a credit. Your team will confirm how it’s applied.',
  },
  resolved: {
    label: 'Resolved',
    tone: 'ok',
    next: 'This claim is closed. Reply below if anything is still wrong.',
  },
  rejected: {
    label: 'Closed without action',
    tone: 'neutral',
    next: 'Your team closed this claim; the reason is below. Reply if you disagree.',
  },
};

interface ClientProjectLite {
  id: string;
  name: string;
  propertyName: string | null;
  number: string;
}

export function Component() {
  const s = useMe();
  const nav = useNavigate();
  const canReport = hasPerm(s, 'client:report_claims');
  const [open, setOpen] = useState(false);
  const q = useQuery({
    queryKey: ['client', 'claims'],
    queryFn: () => api.get<ClientClaim[]>('orders', '/client/claims'),
  });
  const projects = useClientProjects();
  const pname = (id: string) => {
    const p = projects.data?.find((x) => x.id === id);
    return p?.propertyName ?? p?.name;
  };
  const rows = q.data ?? [];
  const active = rows.filter((c) => !['resolved', 'rejected', 'credited'].includes(c.status));

  return (
    <div className="mx-auto max-w-[980px] px-4 py-6 sm:px-6 sm:py-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[24px] leading-tight font-[640]">Claims</h1>
          <p className="mt-1 max-w-[62ch] text-ink-2">
            Something arrived damaged, is missing, or isn’t what was ordered? Report it here with a few photos
            and your project team takes it up with the vendor.
          </p>
        </div>
        {canReport && (
          <Button variant="primary" icon={<Camera className="size-4" />} onClick={() => setOpen(true)}>
            Report a problem
          </Button>
        )}
      </div>

      <div className="mt-6">
        {q.isError ? (
          <ErrorNote error={q.error} />
        ) : q.isLoading ? (
          <Loading label="Loading your claims" />
        ) : !rows.length ? (
          <div className="rounded-md border border-line bg-paper">
            <EmptyState
              icon={<ShieldAlert />}
              title="No claims"
              action={canReport && <Button onClick={() => setOpen(true)}>Report a problem</Button>}
            >
              If anything arrives damaged or short, report it as soon as you can, ideally before the packaging
              is thrown away.
            </EmptyState>
          </div>
        ) : (
          <>
            {active.length > 0 && (
              <p className="mb-2 text-[13px] text-ink-3">{active.length} still being worked on</p>
            )}
            <ul className="overflow-hidden rounded-md border border-line bg-paper">
              {rows.map((c) => {
                const st = OWNER_CLAIM_STATUS[c.status];
                return (
                  <li key={c.id} className="border-b border-line-2 last:border-b-0">
                    <Link
                      to={`/portal/claims/${c.id}`}
                      className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 px-4 py-3 hover:bg-stone"
                    >
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-[620]">{OWNER_CLAIM_TYPE[c.type]}</span>
                          <Badge tone={st?.tone}>{st?.label ?? c.status}</Badge>
                        </div>
                        <p className="mt-0.5 line-clamp-1 text-ink-2">{c.description}</p>
                        <p className="mt-0.5 text-[12px] text-ink-3">
                          <span className="num">{c.number}</span> · {pname(c.projectId) ?? 'Project'}
                          {c.vendorName && ` · ${c.vendorName}`} · reported {ago(c.reportedAt)}
                        </p>
                      </div>
                      <ArrowRight className="size-4 text-ink-4" />
                    </Link>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
      <ReportSheet
        open={open}
        onClose={() => setOpen(false)}
        projects={projects.data ?? []}
        onCreated={(c) => nav(`/portal/claims/${c.id}`)}
      />
    </div>
  );
}

const useClientProjects = () =>
  useQuery({
    queryKey: ['client', 'projects'],
    queryFn: () => api.get<Page<ClientProjectLite>>('projects', '/client/projects'),
    select: (d) => d.items,
  });

const TYPES: ClaimType[] = ['damage', 'concealed_damage', 'shortage', 'wrong_item', 'defect', 'other'];
const TYPE_HINT: Record<ClaimType, string> = {
  damage: 'Visible damage when the delivery arrived (crushed cartons, broken items).',
  concealed_damage: 'The carton looked fine but the item was damaged inside.',
  shortage: 'Fewer pieces arrived than were ordered.',
  wrong_item: 'The wrong item, size or finish arrived.',
  defect: 'The item doesn’t work or has a manufacturing fault.',
  other: 'Anything else that isn’t right.',
};

export function ReportSheet({
  open,
  onClose,
  projects,
  onCreated,
  defaultProjectId,
}: {
  open: boolean;
  onClose: () => void;
  projects: ClientProjectLite[];
  onCreated: (c: ClientClaim) => void;
  defaultProjectId?: string;
}) {
  const s = useMe();
  const qc = useQueryClient();
  const [projectId, setProjectId] = useState(defaultProjectId ?? '');
  const pid = projectId || (projects.length === 1 ? projects[0]!.id : '');
  const [poId, setPoId] = useState('');
  const [type, setType] = useState<ClaimType | ''>('');
  const [desc, setDesc] = useState('');
  const [qty, setQty] = useState<Record<string, string>>({});
  const [photos, setPhotos] = useState<File[]>([]);
  const orders = useQuery({
    queryKey: ['client', 'orders', pid],
    queryFn: () => api.get<{ items: ClientOrder[] }>('orders', `/client/projects/${pid}/orders`),
    enabled: open && !!pid,
  });
  const order = orders.data?.items.find((o) => o.id === poId);
  const m = useMutation({
    mutationFn: async () => {
      const ids: string[] = [];
      for (const f of photos)
        ids.push(
          (
            await uploadDocument(f, {
              entityType: 'project',
              entityId: pid,
              kind: 'photo',
              visibility: 'client',
              clientOrgId: s.context.orgId,
            })
          ).id,
        );
      return api.post<ClientClaim>('orders', '/client/claims', {
        projectId: pid,
        poId: poId || undefined,
        type,
        description: desc.trim(),
        photoDocumentIds: ids,
        items: Object.entries(qty)
          .filter(([, v]) => Number(v) > 0)
          .map(([poLineId, v]) => ({ poLineId, quantity: Number(v) })),
      });
    },
    onSuccess: (c) => {
      toast.success('Problem reported', { description: `Claim ${c.number} is with your project team.` });
      qc.invalidateQueries({ queryKey: ['client', 'claims'] });
      setPoId('');
      setType('');
      setDesc('');
      setQty({});
      setPhotos([]);
      onClose();
      onCreated(c);
    },
    onError: (e) => toast.error(`Couldn’t send your report: ${errorMessage(e)}`),
  });
  return (
    <Sheet
      open={open}
      onClose={onClose}
      width={580}
      title="Report a problem"
      description="Tell us what’s wrong. Photos of the item, the label and the packaging help the vendor act quickly."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={m.isPending}
            disabled={!pid || !type || !desc.trim()}
            onClick={() => m.mutate()}
          >
            Send report
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {projects.length > 1 && (
          <Field label="Which hotel">
            {(id) => (
              <Select
                id={id}
                value={projectId}
                onChange={(e) => {
                  setProjectId(e.target.value);
                  setPoId('');
                }}
                placeholder="Choose a project"
                options={projects.map((p) => ({ value: p.id, label: p.propertyName ?? p.name }))}
              />
            )}
          </Field>
        )}
        <fieldset>
          <legend className="mb-2 text-[13px] font-[560] text-ink-2">What’s wrong?</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {TYPES.map((t) => (
              <label
                key={t}
                className={cx(
                  'flex cursor-pointer gap-2.5 rounded-sm border px-3 py-2.5',
                  type === t ? 'border-lacquer bg-lacquer-50' : 'border-line hover:bg-stone',
                )}
              >
                <input
                  type="radio"
                  name="claimtype"
                  className="mt-1 accent-lacquer"
                  checked={type === t}
                  onChange={() => setType(t)}
                />
                <span>
                  <span className="block font-[560]">{OWNER_CLAIM_TYPE[t]}</span>
                  <span className="block text-[12.5px] text-ink-3">{TYPE_HINT[t]}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <Field
          label="Which order (if you know)"
          hint="It’s on the packing slip or carton label. Leave it if you’re not sure."
        >
          {(id) => (
            <Select
              id={id}
              value={poId}
              disabled={!pid}
              onChange={(e) => {
                setPoId(e.target.value);
                setQty({});
              }}
              placeholder="I’m not sure"
              options={(orders.data?.items ?? []).map((o) => ({
                value: o.id,
                label: `${o.vendorName} · ${o.number}${o.deliveredCount ? '' : ' (not delivered yet)'}`,
              }))}
            />
          )}
        </Field>
        {order && (
          <fieldset>
            <legend className="mb-1.5 text-[13px] font-[560] text-ink-2">
              Which items, and how many (optional)
            </legend>
            <ul className="max-h-56 divide-y divide-line-2 overflow-y-auto rounded-sm border border-line">
              {order.items.map((l) => (
                <li key={l.id} className="flex items-center gap-3 px-3 py-1.5">
                  <span className="min-w-0 flex-1 text-[13px]">
                    {l.name}
                    <span className="block text-[12px] text-ink-3">
                      {[l.finish, l.locationName].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                  <input
                    aria-label={`How many ${l.name}`}
                    inputMode="numeric"
                    placeholder="0"
                    value={qty[l.id] ?? ''}
                    onChange={(e) => setQty((x) => ({ ...x, [l.id]: e.target.value }))}
                    className="num h-8 w-16 rounded-xs border border-line px-2 text-right focus:border-lacquer focus:outline-none"
                  />
                </li>
              ))}
            </ul>
          </fieldset>
        )}
        <Field
          label="What happened"
          hint="Where it is now (e.g. room 214), what’s damaged, and when it arrived."
        >
          {(id) => <Textarea id={id} rows={4} value={desc} onChange={(e) => setDesc(e.target.value)} />}
        </Field>
        <Field label="Photos">
          {() => <FilePicker files={photos} onChange={setPhotos} label="Add photos" />}
        </Field>
      </div>
    </Sheet>
  );
}
