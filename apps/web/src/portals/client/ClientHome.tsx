import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Building2, CalendarDays, CircleAlert, Diamond } from 'lucide-react';
import { Link } from 'react-router';
import { cx, EmptyState, ErrorNote, Loading, StatusBadge } from '@/components/ui';
import { type Address, fmtAddress, STAGES, stageIndex } from '@/features/projects/shared';
import { api, type Page } from '@/lib/api';
import { useMe } from '@/lib/auth';
import { date, dateLong, daysFromToday } from '@/lib/format';

export interface ClientProjectSummary {
  id: string;
  number: string;
  name: string;
  propertyName: string | null;
  type: string;
  stage: string;
  status: string;
  address: Address;
  targetOpenDate: string | null;
  openClientTasks: number;
  nextMilestone: { id: string; name: string; due: string | null } | null;
}

/** Plain-language names for the project stages, written for hotel owners. */
export const OWNER_STAGE: Record<string, { label: string; blurb: string }> = {
  lead: { label: 'Getting started', blurb: 'We’re learning about your project and scope.' },
  proposal: { label: 'Proposal', blurb: 'We’re preparing our proposal for your review.' },
  design: { label: 'Design', blurb: 'Your furniture, fixtures and finishes are being selected.' },
  quoting: { label: 'Pricing', blurb: 'We’re collecting vendor pricing and preparing your quote.' },
  client_approval: { label: 'Your approval', blurb: 'Your quote is ready for review and sign-off.' },
  procurement: { label: 'Ordering', blurb: 'Purchase orders are going out to the makers.' },
  production: { label: 'In production', blurb: 'Your items are being manufactured.' },
  logistics: { label: 'Shipping', blurb: 'Items are shipping to the warehouse or your site.' },
  installation: { label: 'Installation', blurb: 'Rooms are being furnished and installed.' },
  closeout: { label: 'Wrapping up', blurb: 'Punch list, warranties and final paperwork.' },
  complete: { label: 'Complete', blurb: 'Everything is delivered and installed.' },
};

export function OwnerStageBar({ stage, size = 'md' }: { stage: string; size?: 'sm' | 'md' }) {
  const i = stageIndex(stage);
  return (
    <div className="flex gap-[3px]" aria-hidden="true">
      {STAGES.map((s, k) => (
        <span
          key={s}
          className={cx(
            'flex-1 rounded-full',
            size === 'sm' ? 'h-1' : 'h-1.5',
            k < i ? 'bg-lacquer-600' : k === i ? 'bg-brass' : 'bg-stone-2',
          )}
        />
      ))}
    </div>
  );
}

export function Component() {
  const s = useMe();
  const q = useQuery({
    queryKey: ['client', 'projects'],
    queryFn: () => api.get<Page<ClientProjectSummary>>('projects', '/client/projects'),
  });
  const items = q.data?.items ?? [];
  const active = items.filter((p) => !['closed', 'complete', 'cancelled', 'lost'].includes(p.status));
  const past = items.filter((p) => !active.includes(p));
  const featured = active.length === 1 ? active[0] : null;
  const actions = active.reduce((a, p) => a + p.openClientTasks, 0);

  return (
    <div className="mx-auto max-w-[1080px] px-4 py-6 sm:px-6 sm:py-8">
      <h1 className="text-[24px] leading-tight font-[640]">Welcome, {s.user.name.split(/\s+/)[0]}</h1>
      <p className="mt-1 max-w-[62ch] text-ink-2">
        Here’s where your hotel projects with{' '}
        {s.contexts.find((c) => c.tenantId === s.context.tenantId)?.tenantName ?? 'our team'} stand. Open a
        project to see its timeline, what we need from you, and who to call.
      </p>

      {q.isLoading ? (
        <Loading label="Loading your projects" />
      ) : q.isError ? (
        <ErrorNote error={q.error} />
      ) : !items.length ? (
        <div className="mt-6 rounded-md border border-line bg-paper">
          <EmptyState icon={<Building2 />} title="No projects shared with you yet">
            When your project team adds you to a project, it will appear here. If you expected to see one,
            reply to your invitation email or contact your project manager.
          </EmptyState>
        </div>
      ) : (
        <>
          {actions > 0 && (
            <div className="mt-5 flex items-start gap-3 rounded-md border border-brass/40 bg-brass-50 px-4 py-3">
              <CircleAlert className="mt-0.5 size-5 shrink-0 text-brass" />
              <p>
                <span className="font-[620]">
                  You have {actions === 1 ? 'one open item' : `${actions} open items`} across your projects.
                </span>{' '}
                <span className="text-ink-2">Open a project to see what’s needed and by when.</span>
              </p>
            </div>
          )}

          {featured && <FeaturedProject p={featured} />}

          {(featured ? past.length > 0 : true) && (
            <section className="mt-6">
              <h2 className="mb-2 text-[15px] font-[620]">{featured ? 'Past projects' : 'Your projects'}</h2>
              <ul className="overflow-hidden rounded-md border border-line bg-paper">
                {(featured ? past : [...active, ...past]).map((p) => (
                  <ProjectRow key={p.id} p={p} />
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function FeaturedProject({ p }: { p: ClientProjectSummary }) {
  const st = OWNER_STAGE[p.stage] ?? { label: p.stage, blurb: '' };
  const days = daysFromToday(p.targetOpenDate);
  return (
    <Link
      to={`/portal/projects/${p.id}`}
      className="group mt-5 block overflow-hidden rounded-md border border-line bg-paper hover:border-ink-4"
    >
      <div className="grid gap-0 md:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="p-5 sm:p-6">
          <div className="text-[12px] text-ink-3">{p.number}</div>
          <h2 className="mt-0.5 text-[21px] leading-snug font-[640] group-hover:text-lacquer">
            {p.propertyName ?? p.name}
          </h2>
          {fmtAddress(p.address) && <p className="mt-0.5 text-ink-2">{fmtAddress(p.address)}</p>}
          <div className="mt-5">
            <div className="mb-2 flex items-baseline justify-between gap-3">
              <span className="font-[620]">{st.label}</span>
              <span className="num text-[12px] text-ink-3">
                Step {stageIndex(p.stage) + 1} of {STAGES.length}
              </span>
            </div>
            <OwnerStageBar stage={p.stage} />
            <p className="mt-2 text-ink-2">{st.blurb}</p>
          </div>
        </div>
        <dl className="grid grid-cols-2 border-t border-line-2 bg-stone/50 md:grid-cols-1 md:border-t-0 md:border-l">
          <div className="border-line-2 p-5 max-md:border-r md:border-b">
            <dt className="flex items-center gap-1.5 text-[12px] text-ink-3">
              <CalendarDays className="size-3.5" />
              Target opening
            </dt>
            <dd className="mt-1 text-[16px] font-[620]">{dateLong(p.targetOpenDate)}</dd>
            {days !== null && days > 0 && <dd className="num text-[13px] text-ink-2">{days} days to go</dd>}
          </div>
          <div className="p-5">
            <dt className="flex items-center gap-1.5 text-[12px] text-ink-3">
              <Diamond className="size-3.5" />
              Next milestone
            </dt>
            <dd className="mt-1 font-[620]">{p.nextMilestone?.name ?? 'Nothing scheduled'}</dd>
            {p.nextMilestone?.due && (
              <dd className="num text-[13px] text-ink-2">{date(p.nextMilestone.due)}</dd>
            )}
          </div>
        </dl>
      </div>
      <div className="flex items-center justify-between border-t border-line-2 px-5 py-3 sm:px-6">
        <span className={cx('font-[560]', p.openClientTasks ? 'text-brass' : 'text-ink-2')}>
          {p.openClientTasks
            ? `${p.openClientTasks} ${p.openClientTasks === 1 ? 'item needs' : 'items need'} your action`
            : 'Nothing needed from you right now'}
        </span>
        <span className="inline-flex items-center gap-1 font-[560] text-lacquer">
          Open project
          <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
        </span>
      </div>
    </Link>
  );
}

function ProjectRow({ p }: { p: ClientProjectSummary }) {
  const st = OWNER_STAGE[p.stage];
  const done = ['closed', 'complete'].includes(p.status) || p.stage === 'complete';
  return (
    <li className="border-b border-line-2 last:border-b-0">
      <Link
        to={`/portal/projects/${p.id}`}
        className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 px-4 py-3 hover:bg-stone sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto]"
      >
        <div className="min-w-0">
          <div className="truncate font-[620]">{p.propertyName ?? p.name}</div>
          <div className="truncate text-[12px] text-ink-3">
            {p.number}
            {p.address.city ? ` · ${p.address.city}, ${p.address.region ?? ''}` : ''}
          </div>
        </div>
        <div className="col-span-2 row-start-2 sm:col-span-1 sm:row-start-auto">
          <div className="mb-1 flex justify-between text-[12.5px]">
            <span className="font-[560]">{done ? 'Complete' : (st?.label ?? p.stage)}</span>
            <span className="num text-ink-3">
              {done ? `Opened ${date(p.targetOpenDate)}` : `Opens ${date(p.targetOpenDate)}`}
            </span>
          </div>
          <OwnerStageBar stage={done ? 'complete' : p.stage} size="sm" />
        </div>
        <div className="text-right">
          {p.openClientTasks > 0 ? (
            <span className="rounded-xs bg-brass-50 px-1.5 py-0.5 text-[12px] font-[620] text-brass">
              {p.openClientTasks} for you
            </span>
          ) : done ? (
            <StatusBadge status="completed" label="Done" />
          ) : (
            <ArrowRight className="size-4 text-ink-4" />
          )}
        </div>
      </Link>
    </li>
  );
}
