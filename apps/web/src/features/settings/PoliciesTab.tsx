import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BadgeCheck, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  ErrorNote,
  Field,
  Input,
  Select,
  Sheet,
  Textarea,
} from '@/components/ui';
import { type Column, DataTable } from '@/components/ui/DataTable';
import { Switch } from '@/components/ui/Switch';
import { api, errorMessage, type Page } from '@/lib/api';
import { hasPerm, useSession } from '@/lib/auth';
import { humanize, money } from '@/lib/format';
import { INTERNAL_ROLES, roleLabel, settingsKeys, TabIntro } from './shared';

type Condition =
  | { type: 'line_margin_below'; pct: number; category?: string }
  | { type: 'quote_margin_below'; pct: number }
  | { type: 'quote_total_above'; amount: number }
  | { type: 'line_below_cost' }
  | { type: 'cost_expired_lines' }
  | { type: 'vendor_not_preferred' };
type CType = Condition['type'];

interface Policy {
  id: string;
  name: string;
  active: boolean;
  appliesTo: 'quote';
  condition: Condition;
  approverRole: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

const CONDITIONS: { type: CType; label: string; hint: string }[] = [
  {
    type: 'line_margin_below',
    label: 'A line’s margin is below…',
    hint: 'Catches individually under-priced items.',
  },
  {
    type: 'quote_margin_below',
    label: 'The quote’s overall margin is below…',
    hint: 'Protects the job as a whole.',
  },
  { type: 'quote_total_above', label: 'The quote total is above…', hint: 'Large quotes get a second look.' },
  {
    type: 'line_below_cost',
    label: 'Any line is priced below cost',
    hint: 'Sell price lower than vendor cost.',
  },
  {
    type: 'cost_expired_lines',
    label: 'Any line uses an expired vendor cost',
    hint: 'The vendor’s price validity date has passed.',
  },
  {
    type: 'vendor_not_preferred',
    label: 'Any line uses a non-preferred vendor',
    hint: 'Based on the preferred flag on the vendor’s profile.',
  },
];

const CATEGORIES = [
  'casegoods',
  'seating',
  'soft_seating',
  'tables',
  'bedding',
  'lighting',
  'mirrors',
  'artwork',
  'window_treatments',
  'carpet',
  'flooring',
  'wallcovering',
  'millwork',
  'plumbing',
  'electronics',
  'signage',
  'outdoor',
  'ose',
  'other',
];
const categoryLabel = (c: string) => (c === 'ose' ? 'OS&E' : humanize(c).toLowerCase());

/** Who can decide: roles holding approvals:decide (admin, executive). */
const APPROVER_ROLES = INTERNAL_ROLES.filter((r) => r.value === 'executive' || r.value === 'admin');

const article = (s: string) => (/^[aeiou]/i.test(s) ? 'an' : 'a');

export function conditionPhrase(c: Condition): string {
  switch (c.type) {
    case 'line_margin_below':
      return `any ${c.category ? `${categoryLabel(c.category)} ` : ''}line’s margin is below ${c.pct}%`;
    case 'quote_margin_below':
      return `the quote’s overall margin is below ${c.pct}%`;
    case 'quote_total_above':
      return `the quote total is above ${money(c.amount, true)}`;
    case 'line_below_cost':
      return 'any line is priced below cost';
    case 'cost_expired_lines':
      return 'any line uses an expired vendor cost';
    case 'vendor_not_preferred':
      return 'any line uses a vendor that isn’t preferred';
  }
}
export const policySentence = (c: Condition, role: string) => {
  const r = roleLabel(role);
  return `Require ${article(r)} ${r} to approve when ${conditionPhrase(c)}.`;
};

const blankCondition = (t: CType): Condition =>
  t === 'line_margin_below' || t === 'quote_margin_below'
    ? { type: t, pct: 15 }
    : t === 'quote_total_above'
      ? { type: t, amount: 250000 }
      : { type: t };

export function PoliciesTab() {
  const s = useSession();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Policy | 'new' | null>(null);
  const policies = useQuery({
    queryKey: settingsKeys.policies,
    queryFn: () => api.get<Page<Policy>>('quoting', '/approval-policies', { limit: 200 }),
  });
  const toggle = useMutation({
    mutationFn: (p: Policy) =>
      api.patch<Policy>('quoting', `/approval-policies/${p.id}`, { active: !p.active }),
    onSuccess: (p) => {
      qc.invalidateQueries({ queryKey: settingsKeys.policies });
      toast.success(p.active ? `${p.name} turned on` : `${p.name} turned off`);
    },
  });
  const canWrite = hasPerm(s, 'approval_policies:write');

  const columns: Column<Policy>[] = [
    {
      key: 'active',
      header: <span className="sr-only">On</span>,
      width: 56,
      cell: (p) => (
        <Switch
          checked={p.active}
          label={p.active ? `Turn off ${p.name}` : `Turn on ${p.name}`}
          disabled={!canWrite || (toggle.isPending && toggle.variables?.id === p.id)}
          onChange={() => toggle.mutate(p)}
        />
      ),
    },
    {
      key: 'name',
      header: 'Policy',
      cell: (p) => (
        <div className="min-w-[280px] py-0.5">
          <div className="font-[560]">{p.name}</div>
          <div className="text-[13px] text-ink-2">{policySentence(p.condition, p.approverRole)}</div>
          {p.description && <div className="mt-0.5 text-[12.5px] text-ink-3">{p.description}</div>}
        </div>
      ),
    },
    { key: 'role', header: 'Approver', cell: (p) => <Badge tone="brass">{roleLabel(p.approverRole)}</Badge> },
  ];

  const items = policies.data?.items;
  return (
    <>
      <TabIntro
        title="Approval policies"
        actions={
          canWrite && (
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
              New policy
            </Button>
          )
        }
      >
        Rules checked whenever a quote is submitted for approval or sent to an owner. If any active rule is
        triggered, the quote waits on the Approvals page until someone in the approver role signs off.
      </TabIntro>
      <div className="rounded-md border border-line bg-paper">
        {policies.isError ? (
          <ErrorNote error={policies.error} />
        ) : (
          <DataTable
            columns={columns}
            rows={items}
            loading={policies.isLoading}
            onRowClick={canWrite ? (p) => setEditing(p) : undefined}
            rowClassName={(p) => (p.active ? undefined : '[&_td]:text-ink-3')}
            empty={
              <EmptyState
                icon={<BadgeCheck />}
                title="No approval policies"
                action={
                  canWrite && (
                    <Button icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
                      New policy
                    </Button>
                  )
                }
              >
                Without policies, quotes are approved internally as soon as they are submitted. Start with a
                margin floor so under-priced lines get a second look.
              </EmptyState>
            }
          />
        )}
      </div>
      <PolicySheet policy={editing} onClose={() => setEditing(null)} />
    </>
  );
}

function PolicySheet({ policy, onClose }: { policy: Policy | 'new' | null; onClose: () => void }) {
  const qc = useQueryClient();
  const isNew = policy === 'new';
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [cond, setCond] = useState<Condition>(blankCondition('line_margin_below'));
  const [role, setRole] = useState('executive');
  const [description, setDescription] = useState('');
  const [active, setActive] = useState(true);
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => {
    if (!policy) return;
    if (policy === 'new') {
      setName('');
      setNameTouched(false);
      setCond(blankCondition('line_margin_below'));
      setRole('executive');
      setDescription('');
      setActive(true);
    } else {
      setName(policy.name);
      setNameTouched(true);
      setCond(policy.condition);
      setRole(policy.approverRole);
      setDescription(policy.description ?? '');
      setActive(policy.active);
    }
  }, [policy]);

  const suggestedName = (c: Condition) =>
    ({
      line_margin_below: `Line margin floor (${'pct' in c ? c.pct : ''}%)`,
      quote_margin_below: `Quote margin floor (${'pct' in c ? c.pct : ''}%)`,
      quote_total_above: 'Large quote review',
      line_below_cost: 'Never sell below cost',
      cost_expired_lines: 'Expired vendor costs',
      vendor_not_preferred: 'Non-preferred vendors',
    })[c.type];
  const shownName = nameTouched ? name : suggestedName(cond);

  const invalid =
    (('pct' in cond && (Number.isNaN(cond.pct) || cond.pct < -100 || cond.pct > 100)) ||
      ('amount' in cond && (Number.isNaN(cond.amount) || cond.amount < 0))) ??
    false;

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: shownName.trim(),
        active,
        condition: cond,
        approverRole: role,
        description: description.trim() || (isNew ? undefined : null),
      };
      return isNew
        ? api.post<Policy>('quoting', '/approval-policies', body)
        : api.patch<Policy>('quoting', `/approval-policies/${(policy as Policy).id}`, body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: settingsKeys.policies });
      toast.success(isNew ? 'Policy created' : 'Policy saved');
      onClose();
    },
    onError: () => {},
  });
  const remove = useMutation({
    mutationFn: () => api.del('quoting', `/approval-policies/${(policy as Policy).id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: settingsKeys.policies });
      setConfirmDelete(false);
      toast.success('Policy deleted');
      onClose();
    },
  });

  if (!policy) return null;
  const meta = CONDITIONS.find((c) => c.type === cond.type)!;
  return (
    <>
      <Sheet
        open
        onClose={onClose}
        title={isNew ? 'New approval policy' : 'Edit approval policy'}
        width={560}
        footer={
          <>
            {!isNew && (
              <Button
                variant="danger"
                className="mr-auto"
                icon={<Trash2 className="size-4" />}
                onClick={() => setConfirmDelete(true)}
              >
                Delete
              </Button>
            )}
            <Button onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              disabled={invalid || !shownName.trim()}
              loading={save.isPending}
              onClick={() => save.mutate()}
            >
              {isNew ? 'Create policy' : 'Save policy'}
            </Button>
          </>
        }
      >
        <div className="space-y-5">
          <div className="rounded-md border border-brass/30 bg-brass-50 px-4 py-3">
            <div className="text-[12px] text-brass">Preview</div>
            <p className="mt-0.5 font-[560] text-ink">{policySentence(cond, role)}</p>
          </div>

          <Field label="When" hint={meta.hint}>
            {(id) => (
              <Select
                id={id}
                value={cond.type}
                options={CONDITIONS.map((c) => ({ value: c.type, label: c.label }))}
                onChange={(e) => setCond(blankCondition(e.target.value as CType))}
              />
            )}
          </Field>

          {(cond.type === 'line_margin_below' || cond.type === 'quote_margin_below') && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Margin threshold"
                error={invalid ? 'Enter a percentage between -100 and 100.' : undefined}
              >
                {(id) => (
                  <div className="relative">
                    <Input
                      id={id}
                      type="number"
                      step="0.5"
                      inputMode="decimal"
                      className="num pr-8"
                      value={Number.isNaN(cond.pct) ? '' : cond.pct}
                      onChange={(e) => setCond({ ...cond, pct: e.target.valueAsNumber })}
                    />
                    <span className="pointer-events-none absolute top-2 right-3 text-ink-3">%</span>
                  </div>
                )}
              </Field>
              {cond.type === 'line_margin_below' && (
                <Field label="Only for category" hint="Leave as all categories to check every line.">
                  {(id) => (
                    <Select
                      id={id}
                      value={cond.category ?? ''}
                      placeholder="All categories"
                      options={CATEGORIES.map((c) => ({ value: c, label: humanize(categoryLabel(c)) }))}
                      onChange={(e) =>
                        setCond({
                          type: 'line_margin_below',
                          pct: cond.pct,
                          ...(e.target.value ? { category: e.target.value } : {}),
                        })
                      }
                    />
                  )}
                </Field>
              )}
            </div>
          )}
          {cond.type === 'quote_total_above' && (
            <Field label="Quote total" error={invalid ? 'Enter an amount of $0 or more.' : undefined}>
              {(id) => (
                <div className="relative">
                  <span className="pointer-events-none absolute top-2 left-3 text-ink-3">$</span>
                  <Input
                    id={id}
                    type="number"
                    min={0}
                    step={1000}
                    className="num pl-6"
                    value={Number.isNaN(cond.amount) ? '' : cond.amount}
                    onChange={(e) => setCond({ ...cond, amount: e.target.valueAsNumber })}
                  />
                </div>
              )}
            </Field>
          )}

          <Field label="Approver" hint="Anyone with this role can approve or reject the quote.">
            {(id) => (
              <Select
                id={id}
                value={role}
                options={APPROVER_ROLES.map((r) => ({ value: r.value, label: r.label }))}
                onChange={(e) => setRole(e.target.value)}
              />
            )}
          </Field>
          <Field label="Name">
            {(id) => (
              <Input
                id={id}
                value={shownName}
                onChange={(e) => {
                  setNameTouched(true);
                  setName(e.target.value);
                }}
              />
            )}
          </Field>
          <Field
            label="Description"
            hint="Shown to the person submitting the quote, so explain why the rule exists."
          >
            {(id) => (
              <Textarea
                id={id}
                rows={3}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            )}
          </Field>
          <div className="flex items-center gap-2.5">
            <Switch checked={active} onChange={setActive} label="Policy is on" />
            <span>{active ? 'On — checked on every quote' : 'Off — not checked'}</span>
          </div>
          {save.isError && (
            <p className="rounded-sm bg-crit-50 px-3 py-2 text-[13px] text-crit">
              {errorMessage(save.error)}
            </p>
          )}
        </div>
      </Sheet>
      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Delete this policy?"
        footer={
          <>
            <Button onClick={() => setConfirmDelete(false)}>Cancel</Button>
            <Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate()}>
              Delete policy
            </Button>
          </>
        }
      >
        <p className="text-ink-2">
          Quotes will no longer be checked against it. Approvals already requested stay as they are. To pause
          a policy instead, turn it off.
        </p>
      </Dialog>
    </>
  );
}
