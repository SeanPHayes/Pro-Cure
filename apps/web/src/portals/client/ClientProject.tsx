import type { ServiceName } from '@procure/domain';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BadgeCheck,
  Check,
  ChevronLeft,
  CircleCheck,
  Clock,
  Hourglass,
  Mail,
  MessagesSquare,
  Package,
  Phone,
  ReceiptText,
  ShieldAlert,
  Warehouse,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Link, useParams } from 'react-router';
import { toast } from 'sonner';
import { ThreadPanel } from '@/components/shared/ThreadPanel';
import {
  Avatar,
  Button,
  cx,
  Dialog,
  EmptyState,
  ErrorNote,
  Loading,
  Section,
  Spinner,
  StatusBadge,
  Textarea,
  TitleBlock,
} from '@/components/ui';
import { type Address, CONTACT_ROLE_LABEL, fmtAddress, STAGES, stageIndex } from '@/features/projects/shared';
import { ApiError, api, type Page } from '@/lib/api';
import { hasPerm, useMe } from '@/lib/auth';
import { ago, date, dateLong, daysFromToday, humanize, money } from '@/lib/format';
import { OWNER_STAGE, OwnerStageBar } from './ClientHome';

interface ClientTask {
  id: string;
  name: string;
  description: string | null;
  phase: string | null;
  kind: string;
  party: string;
  status: string;
  isMilestone: boolean;
  startDate: string | null;
  dueDate: string | null;
  completedAt: string | null;
  completedByName: string | null;
  canComplete: boolean;
}
interface ClientProjectDetail {
  id: string;
  number: string;
  name: string;
  propertyName: string | null;
  type: string;
  stage: string;
  status: string;
  keys: number | null;
  address: Address;
  shipToAddress: Address;
  targetOpenDate: string | null;
  team: { name: string; email: string | null; role: string; isLead: boolean }[];
  contacts: {
    id: string;
    name: string;
    company: string | null;
    role: string;
    email: string | null;
    phone: string | null;
  }[];
  milestones: ClientTask[];
  tasks: ClientTask[];
  notes: { id: string; authorName: string; body: string; pinned: boolean; createdAt: string }[];
}

const TEAM_ROLE: Record<string, string> = {
  project_manager: 'Project manager — your main contact',
  designer: 'Interior designer',
  procurement: 'Purchasing',
  order_manager: 'Order tracking',
  logistics: 'Shipping & deliveries',
  sales: 'Account manager',
  accounting: 'Billing & invoices',
};
const isDone = (t: { status: string }) => t.status === 'done' || t.status === 'skipped';

export function Component() {
  const { id = '' } = useParams();
  const s = useMe();
  const q = useQuery({
    queryKey: ['client', 'project', id],
    queryFn: () => api.get<ClientProjectDetail>('projects', `/client/projects/${id}`),
  });
  if (q.isLoading) return <Loading label="Loading your project" />;
  if (q.isError)
    return q.error instanceof ApiError && [400, 403, 404].includes(q.error.status) ? (
      <EmptyState
        title="We couldn’t find this project"
        action={
          <Link to="/portal" className="font-[560] text-lacquer hover:underline">
            Back to your projects
          </Link>
        }
      >
        It may not be shared with your organization. Your project manager can add you.
      </EmptyState>
    ) : (
      <ErrorNote error={q.error} />
    );
  const p = q.data!;
  const pm =
    p.team.find((m) => m.role === 'project_manager' && m.isLead) ??
    p.team.find((m) => m.role === 'project_manager');
  const st = OWNER_STAGE[p.stage] ?? { label: humanize(p.stage), blurb: '' };
  const days = daysFromToday(p.targetOpenDate);
  const canApprove = hasPerm(s, 'client:approve');

  return (
    <div className="mx-auto max-w-[1180px] px-4 py-5 sm:px-6">
      <Link
        to="/portal"
        className="mb-3 inline-flex items-center gap-1 text-[13px] text-ink-2 hover:text-ink"
      >
        <ChevronLeft className="size-4" />
        Your projects
      </Link>
      <TitleBlock
        title={p.propertyName ?? p.name}
        subtitle={fmtAddress(p.address) || p.name}
        fields={[
          { label: 'Project', value: <span className="num">{p.number}</span> },
          { label: 'Where we are', value: st.label },
          {
            label: 'Target opening',
            value: <span className="num">{date(p.targetOpenDate)}</span>,
          },
          { label: 'Rooms', value: <span className="num">{p.keys ?? '—'}</span> },
          { label: 'Your project manager', value: pm?.name ?? '—' },
        ]}
      />

      <div className="mt-4 rounded-md border border-line bg-paper px-4 py-3.5">
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <p>
            <span className="font-[620]">{st.label}.</span> <span className="text-ink-2">{st.blurb}</span>
          </p>
          <span className="num text-[12px] text-ink-3">
            Step {stageIndex(p.stage) + 1} of {STAGES.length}
            {days !== null && days > 0 && ` · ${days} days to opening`}
          </span>
        </div>
        <OwnerStageBar stage={p.stage} />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 space-y-4">
          <ActionsNeeded tasks={p.tasks} canApprove={canApprove} />
          <Timeline milestones={p.milestones} target={p.targetOpenDate} />
          <PortalPanel
            service="orders"
            path={`/client/projects/${p.id}/orders`}
            title="Orders & deliveries"
            icon={<Package />}
            emptyTitle="No orders placed yet"
            emptyText="Once your quote is approved and orders go out, you’ll see each order and its delivery status here."
            render={(rows: OrderRow[]) => <OrderList rows={rows} />}
          />
          <PortalPanel
            service="quoting"
            path="/client/quotes"
            query={{ projectId: p.id }}
            title="Approvals"
            icon={<BadgeCheck />}
            emptyTitle="Nothing to approve yet"
            emptyText="Quotes we send you for this project appear here for review and sign-off."
            render={(rows: QuoteRow[]) => <QuoteList rows={rows} />}
          />
        </div>
        <div className="min-w-0 space-y-4">
          <WhoToCall team={p.team} contacts={p.contacts} />
          {p.notes.length > 0 && (
            <Section title="Updates from your team" bodyClassName="">
              <ul className="divide-y divide-line-2">
                {p.notes.map((n) => (
                  <li key={n.id} className={cx('px-4 py-3', n.pinned && 'bg-brass-50/60')}>
                    <p className="whitespace-pre-wrap">{n.body}</p>
                    <p className="mt-1 text-[12px] text-ink-3">
                      {n.authorName} · {ago(n.createdAt)}
                    </p>
                  </li>
                ))}
              </ul>
            </Section>
          )}
          <PortalPanel
            service="finance"
            path="/client/invoices"
            query={{ projectId: p.id }}
            title="Invoices"
            icon={<ReceiptText />}
            emptyTitle="No invoices yet"
            emptyText="Deposit and progress invoices for this project will be listed here."
            render={(rows: InvoiceRow[]) => <InvoiceList rows={rows} />}
          />
          <PortalPanel
            service="orders"
            path={`/client/projects/${p.id}/storage`}
            title="In storage"
            icon={<Warehouse />}
            emptyTitle="Nothing in storage"
            emptyText="Items received at the warehouse before installation are tracked here."
            render={(rows: StorageRow[]) => <StorageList rows={rows} />}
          />
          <Section
            title="Damage or missing items"
            actions={
              <Link to="/portal/claims" className="text-[13px] font-[560] text-lacquer hover:underline">
                View claims
              </Link>
            }
          >
            <p className="flex gap-2.5 text-ink-2">
              <ShieldAlert className="mt-0.5 size-4 shrink-0 text-ink-3" />
              Something arrived damaged or short? Report it on the claims page with a photo and we’ll take it
              from there with the vendor.
            </p>
          </Section>
        </div>
      </div>

      <Section className="mt-4" title="Messages with your project team">
        <OwnerThread projectId={p.id} clientOrgId={s.context.orgId} />
      </Section>
    </div>
  );
}

// ------------------------------------------------------------------ Your action needed
function ActionsNeeded({ tasks, canApprove }: { tasks: ClientTask[]; canApprove: boolean }) {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState<ClientTask | null>(null);
  const [note, setNote] = useState('');
  const complete = useMutation({
    mutationFn: (t: ClientTask) =>
      api.post<ClientTask>(
        'projects',
        `/client/tasks/${t.id}/complete`,
        note.trim() ? { note: note.trim() } : {},
      ),
    onSuccess: (_d, t) => {
      toast.success('Marked complete', { description: `${t.name}. Your project manager has been notified.` });
      setConfirm(null);
      setNote('');
      qc.invalidateQueries({ queryKey: ['client'] });
    },
  });
  const open = tasks.filter((t) => !isDone(t));
  const soon = (t: ClientTask) => {
    const n = daysFromToday(t.dueDate);
    return n === null || n <= 21;
  };
  const now = open.filter(soon);
  const later = open.filter((t) => !soon(t));
  const done = tasks.filter(isDone).slice(-3).reverse();
  const row = (t: ClientTask, primary: boolean) => {
    const n = daysFromToday(t.dueDate);
    const late = n !== null && n < 0;
    return (
      <li key={t.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
        <div className="min-w-0 flex-1 basis-[240px]">
          <div className={cx('font-[620]', !primary && 'font-[560] text-ink-2')}>{t.name}</div>
          {t.description && <p className="mt-0.5 text-[13px] text-ink-2">{t.description}</p>}
          <p className={cx('mt-0.5 text-[12.5px]', late ? 'font-[560] text-crit' : 'text-ink-3')}>
            {t.dueDate
              ? late
                ? `Was due ${dateLong(t.dueDate)}`
                : n === 0
                  ? 'Due today'
                  : `Needed by ${dateLong(t.dueDate)}`
              : 'No due date'}
          </p>
        </div>
        {t.canComplete && canApprove ? (
          <Button
            variant={primary ? 'primary' : 'secondary'}
            size="sm"
            icon={<Check className="size-4" />}
            onClick={() => setConfirm(t)}
          >
            Mark complete
          </Button>
        ) : (
          <span className="text-[12.5px] text-ink-3">Your project manager will confirm this</span>
        )}
      </li>
    );
  };
  return (
    <Section
      title={
        <span className="flex items-center gap-2">
          Your action needed
          {now.length > 0 && (
            <span className="num rounded-xs bg-brass-50 px-1.5 text-[12px] font-[620] text-brass">
              {now.length}
            </span>
          )}
        </span>
      }
      bodyClassName=""
    >
      {!open.length ? (
        <div className="flex items-center gap-3 px-4 py-4">
          <CircleCheck className="size-5 shrink-0 text-ok" />
          <p className="text-ink-2">
            <span className="font-[560] text-ink">You’re all caught up.</span> We’ll let you know when we need
            something from you.
          </p>
        </div>
      ) : (
        <>
          {now.length > 0 ? (
            <ul className="divide-y divide-line-2">{now.map((t) => row(t, true))}</ul>
          ) : (
            <p className="px-4 py-3 text-ink-2">Nothing is due in the next three weeks.</p>
          )}
          {later.length > 0 && (
            <>
              <div className="border-t border-line-2 bg-stone/60 px-4 py-1.5 text-[12px] font-[560] text-ink-2">
                Coming up later
              </div>
              <ul className="divide-y divide-line-2">{later.map((t) => row(t, false))}</ul>
            </>
          )}
        </>
      )}
      {done.length > 0 && (
        <div className="border-t border-line-2 bg-stone/50 px-4 py-2.5">
          <p className="mb-1 text-[12px] text-ink-3">Recently completed</p>
          <ul className="space-y-0.5 text-[13px]">
            {done.map((t) => (
              <li key={t.id} className="flex items-center gap-2 text-ink-2">
                <Check className="size-3.5 text-ok" />
                <span className="min-w-0 flex-1 truncate">{t.name}</span>
                <span className="num shrink-0 text-ink-3">{date(t.completedAt)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <Dialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        title="Mark this complete?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              Not yet
            </Button>
            <Button
              variant="primary"
              loading={complete.isPending}
              onClick={() => confirm && complete.mutate(confirm)}
            >
              Mark complete
            </Button>
          </>
        }
      >
        <p className="text-ink-2">
          <span className="font-[560] text-ink">{confirm?.name}</span>. We’ll let your project manager know
          right away so the next steps can start.
        </p>
        <label className="mt-3 block text-[13px] font-[560] text-ink-2" htmlFor="client-complete-note">
          Add a note (optional)
        </label>
        <Textarea
          id="client-complete-note"
          className="mt-1.5"
          rows={3}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="e.g. Approved with the change to the headboard finish we discussed."
        />
      </Dialog>
    </Section>
  );
}

// ------------------------------------------------------------------ Timeline
function Timeline({ milestones: raw, target }: { milestones: ClientTask[]; target: string | null }) {
  const milestones = [
    ...raw.filter(isDone).sort((a, b) => (a.completedAt ?? '').localeCompare(b.completedAt ?? '')),
    ...raw.filter((m) => !isDone(m)).sort((a, b) => (a.dueDate ?? '9').localeCompare(b.dueDate ?? '9')),
  ];
  const nextIdx = milestones.findIndex((m) => !isDone(m));
  return (
    <Section title="Project timeline">
      {!milestones.length ? (
        <p className="text-ink-2">Your project timeline will appear here once the schedule is set.</p>
      ) : (
        <ol className="relative">
          {milestones.map((m, i) => {
            const done = isDone(m);
            const next = i === nextIdx;
            const n = daysFromToday(m.dueDate);
            const late = !done && n !== null && n < 0;
            return (
              <li key={m.id} className="relative flex gap-4 pb-5 last:pb-0">
                {i < milestones.length - 1 && (
                  <span
                    className={cx(
                      'absolute top-6 bottom-0 left-[11px] w-[2px]',
                      done ? 'bg-lacquer-600' : 'bg-line',
                    )}
                    aria-hidden="true"
                  />
                )}
                <span
                  className={cx(
                    'relative z-[1] grid size-6 shrink-0 place-items-center rounded-full border-2',
                    done
                      ? 'border-lacquer-600 bg-lacquer-600 text-white'
                      : next
                        ? 'border-brass bg-brass-50 text-brass'
                        : 'border-line bg-paper text-ink-4',
                  )}
                >
                  {done ? <Check className="size-3.5" /> : next ? <Clock className="size-3" /> : null}
                </span>
                <div className="min-w-0 flex-1 pt-0.5">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <span className={cx('font-[620]', done && 'text-ink-2', !done && !next && 'text-ink-2')}>
                      {m.name}
                    </span>
                    <span className={cx('num text-[13px]', late ? 'font-[560] text-crit' : 'text-ink-2')}>
                      {done ? `Done ${date(m.completedAt)}` : date(m.dueDate)}
                    </span>
                  </div>
                  <div className="text-[12.5px] text-ink-3">
                    {m.party === 'client'
                      ? done
                        ? 'Completed by you'
                        : 'Needs your action'
                      : next
                        ? late
                          ? 'Running behind — your project manager will update you'
                          : n === 0
                            ? 'Up next · today'
                            : `Up next${n !== null && n > 0 ? ` · in ${n} days` : ''}`
                        : m.phase}
                  </div>
                </div>
              </li>
            );
          })}
          {target && (
            <li className="relative flex gap-4 pt-5">
              <span className="relative z-[1] grid size-6 shrink-0 place-items-center rounded-xs bg-lacquer text-white">
                <BadgeCheck className="size-3.5" />
              </span>
              <div className="flex flex-1 flex-wrap items-baseline justify-between gap-x-3 pt-0.5">
                <span className="font-[620]">Hotel opening</span>
                <span className="num text-[13px] font-[560]">{dateLong(target)}</span>
              </div>
            </li>
          )}
        </ol>
      )}
    </Section>
  );
}

// ------------------------------------------------------------------ Who to call
function WhoToCall({
  team,
  contacts,
}: {
  team: ClientProjectDetail['team'];
  contacts: ClientProjectDetail['contacts'];
}) {
  const order = [
    'project_manager',
    'designer',
    'logistics',
    'accounting',
    'procurement',
    'order_manager',
    'sales',
  ];
  const sorted = [...team]
    .filter((m) => m.role !== 'sales' || team.length < 4)
    .sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role) || Number(b.isLead) - Number(a.isLead));
  return (
    <Section title="Who to call" bodyClassName="">
      <ul className="divide-y divide-line-2">
        {sorted.map((m) => (
          <li key={`${m.name}-${m.role}`} className="flex items-center gap-3 px-4 py-2.5">
            <Avatar name={m.name} size={32} />
            <div className="min-w-0 flex-1">
              <div className="truncate font-[620]">{m.name}</div>
              <div className="truncate text-[12.5px] text-ink-3">{TEAM_ROLE[m.role] ?? humanize(m.role)}</div>
            </div>
            {m.email && (
              <a
                href={`mailto:${m.email}`}
                className="grid size-8 place-items-center rounded-sm text-ink-2 hover:bg-stone-2 hover:text-lacquer"
                aria-label={`Email ${m.name}`}
                title={m.email}
              >
                <Mail className="size-4" />
              </a>
            )}
          </li>
        ))}
      </ul>
      {contacts.length > 0 && (
        <>
          <div className="border-t border-line-2 bg-stone/60 px-4 py-1.5 text-[12px] font-[560] text-ink-2">
            On site and on your team
          </div>
          <ul className="divide-y divide-line-2">
            {contacts.map((c) => (
              <li key={c.id} className="px-4 py-2.5">
                <div className="font-[560]">{c.name}</div>
                <div className="text-[12.5px] text-ink-3">
                  {CONTACT_ROLE_LABEL[c.role] ?? humanize(c.role)}
                  {c.company ? ` · ${c.company}` : ''}
                </div>
                <div className="mt-0.5 flex flex-wrap gap-x-3 text-[13px]">
                  {c.phone && (
                    <a
                      href={`tel:${c.phone}`}
                      className="inline-flex items-center gap-1 text-lacquer hover:underline"
                    >
                      <Phone className="size-3" />
                      {c.phone}
                    </a>
                  )}
                  {c.email && (
                    <a
                      href={`mailto:${c.email}`}
                      className="inline-flex min-w-0 items-center gap-1 text-lacquer hover:underline"
                    >
                      <Mail className="size-3" />
                      <span className="truncate">{c.email}</span>
                    </a>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </Section>
  );
}

// ------------------------------------------------------------------ Panels from other services
function NotYet({ what }: { what: string }) {
  return (
    <div className="flex items-start gap-3 px-4 py-4 text-ink-2">
      <Hourglass className="mt-0.5 size-4 shrink-0 text-ink-4" />
      <p>
        {what} will show here soon. In the meantime, your project manager can answer any question — just send
        a message below.
      </p>
    </div>
  );
}

function PortalPanel<T>({
  service,
  path,
  query,
  title,
  icon,
  emptyTitle,
  emptyText,
  render,
}: {
  service: ServiceName;
  path: string;
  query?: Record<string, string>;
  title: string;
  icon: ReactNode;
  emptyTitle: string;
  emptyText: string;
  render: (rows: T[]) => ReactNode;
}) {
  const q = useQuery({
    queryKey: ['client', service, path, query],
    queryFn: () => api.get<Page<T> | T[]>(service, path, query),
    select: (d) => (Array.isArray(d) ? d : (d?.items ?? [])),
    retry: false,
    meta: { silent: true },
  });
  return (
    <Section title={title} bodyClassName="">
      {q.isLoading ? (
        <div className="flex justify-center py-6">
          <Spinner />
        </div>
      ) : q.isError ? (
        <NotYet what={title} />
      ) : !q.data?.length ? (
        <EmptyState icon={icon} title={emptyTitle}>
          {emptyText}
        </EmptyState>
      ) : (
        render(q.data)
      )}
    </Section>
  );
}

interface OrderRow {
  id: string;
  number: string;
  vendorName?: string;
  description?: string;
  status: string;
  expectedDeliveryDate?: string | null;
  requiredDeliveryDate?: string | null;
  deliveredAt?: string | null;
}
const OrderList = ({ rows }: { rows: OrderRow[] }) => (
  <ul className="divide-y divide-line-2">
    {rows.map((o) => (
      <li key={o.id} className="flex items-center gap-3 px-4 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="truncate font-[560]">{o.description ?? o.vendorName ?? o.number}</div>
          <div className="text-[12px] text-ink-3">
            {o.number}
            {o.vendorName && o.description ? ` · ${o.vendorName}` : ''}
          </div>
        </div>
        <div className="text-right">
          <StatusBadge status={o.status} />
          <div className="num mt-0.5 text-[12px] text-ink-3">
            {o.deliveredAt
              ? `Delivered ${date(o.deliveredAt)}`
              : (o.expectedDeliveryDate ?? o.requiredDeliveryDate)
                ? `Expected ${date(o.expectedDeliveryDate ?? o.requiredDeliveryDate)}`
                : ''}
          </div>
        </div>
      </li>
    ))}
  </ul>
);

interface QuoteRow {
  id: string;
  number: string;
  name: string;
  status: string;
  sentAt: string | null;
  clientDecision: 'approved' | 'rejected' | null;
  total?: number;
  grandTotal?: number;
}
const QuoteList = ({ rows }: { rows: QuoteRow[] }) => (
  <ul className="divide-y divide-line-2">
    {rows.map((x) => (
      <li key={x.id}>
        <Link to={`/portal/quotes/${x.id}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-stone">
          <div className="min-w-0 flex-1">
            <div className="truncate font-[560]">{x.name}</div>
            <div className="text-[12px] text-ink-3">
              {x.number} · sent {date(x.sentAt)}
            </div>
          </div>
          {(x.total ?? x.grandTotal) !== undefined && (
            <span className="num text-ink-2">{money(x.total ?? x.grandTotal, true)}</span>
          )}
          {x.clientDecision ? (
            <StatusBadge
              status={x.clientDecision === 'approved' ? 'client_approved' : 'client_rejected'}
              label={humanize(x.clientDecision)}
            />
          ) : (
            <span className="rounded-xs bg-brass-50 px-1.5 py-0.5 text-[12px] font-[620] text-brass">
              Review
            </span>
          )}
        </Link>
      </li>
    ))}
  </ul>
);

interface InvoiceRow {
  id: string;
  number: string;
  kind: string;
  status: string;
  dueDate: string;
  total: number;
  balance: number;
}
const InvoiceList = ({ rows }: { rows: InvoiceRow[] }) => (
  <ul className="divide-y divide-line-2">
    {rows.map((i) => (
      <li key={i.id}>
        <Link to={`/portal/invoices/${i.id}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-stone">
          <div className="min-w-0 flex-1">
            <div className="font-[560]">
              {i.number} <span className="font-[480] text-ink-3">{humanize(i.kind)}</span>
            </div>
            <div className="num text-[12px] text-ink-3">Due {date(i.dueDate)}</div>
          </div>
          <div className="text-right">
            <div className="num font-[560]">{money(i.balance > 0 ? i.balance : i.total)}</div>
            <StatusBadge status={i.status} />
          </div>
        </Link>
      </li>
    ))}
  </ul>
);

interface StorageRow {
  id: string;
  name?: string;
  description?: string;
  quantity?: number;
  status: string;
  locationName?: string;
}
const StorageList = ({ rows }: { rows: StorageRow[] }) => (
  <ul className="divide-y divide-line-2">
    {rows.map((r) => (
      <li key={r.id} className="flex items-center gap-3 px-4 py-2">
        <div className="min-w-0 flex-1">
          <div className="truncate">{r.name ?? r.description ?? 'Item'}</div>
          {r.locationName && <div className="text-[12px] text-ink-3">{r.locationName}</div>}
        </div>
        {r.quantity !== undefined && <span className="num text-ink-2">×{r.quantity}</span>}
        <StatusBadge status={r.status} />
      </li>
    ))}
  </ul>
);

function OwnerThread({ projectId, clientOrgId }: { projectId: string; clientOrgId: string }) {
  const probe = useQuery({
    queryKey: ['probe', 'comms', 'client-thread', projectId],
    queryFn: () =>
      api
        .get('comms', '/threads/for', {
          entityType: 'project',
          entityId: projectId,
          visibility: 'client',
          clientOrgId,
        })
        .then(() => true),
    retry: false,
    meta: { silent: true },
  });
  if (probe.isLoading)
    return (
      <div className="flex justify-center py-6">
        <Spinner />
      </div>
    );
  if (probe.isError)
    return (
      <EmptyState icon={<MessagesSquare />} title="Messaging isn’t available yet">
        For now, email your project manager directly using the envelope icon under “Who to call”.
      </EmptyState>
    );
  return (
    <ThreadPanel
      entityType="project"
      entityId={projectId}
      visibility="client"
      clientOrgId={clientOrgId}
      emptyHint="Ask a question or share an update. Your project team sees everything you post here."
    />
  );
}
