import { ChevronLeft, Pencil } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { ActivityFeed } from '@/components/shared/ActivityFeed';
import {
  Button,
  EmptyState,
  ErrorNote,
  Loading,
  Section,
  StatusBadge,
  Tabs,
  TitleBlock,
} from '@/components/ui';
import { ApiError } from '@/lib/api';
import { hasPerm, useSession } from '@/lib/auth';
import { date, daysFromToday } from '@/lib/format';
import { ProjectFinancials } from '@/features/finance/ProjectFinancials';
import { OverviewTab } from './OverviewTab';
import { ProjectFormSheet } from './ProjectForm';
import { ScheduleTab } from './ScheduleTab';
import {
  GuardedThread,
  ProjectFiles,
  ProjectOrders,
  ProjectQuotes,
} from './ServicePanels';
import { projectLead, STAGES, stageIndex, stageLabel, useClientOrgs, useProject } from './shared';

const TABS = [
  'overview',
  'schedule',
  'quotes',
  'orders',
  'financials',
  'files',
  'messages',
  'activity',
] as const;
type Tab = (typeof TABS)[number];

export function Component() {
  const { id = '' } = useParams();
  const s = useSession();
  const [params, setParams] = useSearchParams();
  const tab = (TABS as readonly string[]).includes(params.get('tab') ?? '')
    ? (params.get('tab') as Tab)
    : 'overview';
  const setTab = (t: string) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        if (t === 'overview') n.delete('tab');
        else n.set('tab', t);
        return n;
      },
      { replace: true },
    );
  const q = useProject(id);
  const clients = useClientOrgs();
  const [editing, setEditing] = useState(false);

  if (q.isLoading) return <Loading label="Loading project" />;
  if (q.isError) {
    const notFound = q.error instanceof ApiError && (q.error.status === 404 || q.error.status === 400);
    return notFound ? (
      <EmptyState
        title="This project doesn’t exist"
        action={
          <Link to="/app/projects" className="font-[560] text-lacquer hover:underline">
            Back to projects
          </Link>
        }
      >
        It may have been removed, or the link is wrong.
      </EmptyState>
    ) : (
      <ErrorNote error={q.error} />
    );
  }
  const p = q.data!;
  const lead = projectLead(p.team);
  const days = daysFromToday(p.targetOpenDate);
  const finance = hasPerm(s, 'finance:read');
  const client = clients.data?.find((o) => o.id === p.clientOrgId);

  return (
    <div className="px-4 py-4 sm:px-6">
      <div className="mb-3 flex items-center justify-between gap-2">
        <Link
          to="/app/projects"
          className="inline-flex items-center gap-1 text-[13px] text-ink-2 hover:text-ink"
        >
          <ChevronLeft className="size-4" />
          Projects
        </Link>
        {hasPerm(s, 'projects:write') && (
          <Button size="sm" icon={<Pencil className="size-3.5" />} onClick={() => setEditing(true)}>
            Edit project
          </Button>
        )}
      </div>
      <TitleBlock
        title={p.name}
        subtitle={
          <span className="flex flex-wrap items-center gap-x-2">
            {p.propertyName && p.propertyName !== p.name ? p.propertyName : client?.name}
            {p.status !== 'active' && <StatusBadge status={p.status} />}
          </span>
        }
        fields={[
          { label: 'Number', value: <span className="num">{p.number}</span> },
          {
            label: 'Stage',
            value: (
              <span>
                {stageLabel(p.stage)}
                <span className="num ml-1.5 font-[480] text-ink-3">
                  {stageIndex(p.stage) + 1}/{STAGES.length}
                </span>
              </span>
            ),
          },
          {
            label: 'Target open',
            value: (
              <span className="num">
                {date(p.targetOpenDate)}
                {days !== null && days >= 0 && p.status === 'active' && (
                  <span className="ml-1.5 font-[480] text-ink-3">{days}d</span>
                )}
              </span>
            ),
          },
          { label: 'Keys', value: <span className="num">{p.keys ?? '—'}</span> },
          { label: 'Project manager', value: lead?.name ?? '—' },
        ]}
      />

      <Tabs
        className="mt-5 border-b border-line"
        value={tab}
        onChange={setTab}
        items={[
          { value: 'overview', label: 'Overview' },
          {
            value: 'schedule',
            label: 'Schedule',
            count: p.taskCounts.total - p.taskCounts.done - p.taskCounts.skipped || undefined,
          },
          { value: 'quotes', label: 'Quotes' },
          { value: 'orders', label: 'Orders' },
          ...(finance ? [{ value: 'financials', label: 'Financials' }] : []),
          { value: 'files', label: 'Files' },
          { value: 'messages', label: 'Messages' },
          { value: 'activity', label: 'Activity' },
        ]}
      />

      <div className="pt-4">
        {tab === 'overview' && <OverviewTab project={p} />}
        {tab === 'schedule' && <ScheduleTab project={p} />}
        {tab === 'quotes' && <ProjectQuotes projectId={p.id} />}
        {tab === 'orders' && <ProjectOrders projectId={p.id} />}
        {tab === 'financials' && finance && <ProjectFinancials projectId={p.id} />}
        {tab === 'files' && (
          <Section title="Files">
            <ProjectFiles projectId={p.id} />
          </Section>
        )}
        {tab === 'messages' && (
          <div className={p.clientOrgId ? 'grid gap-4 lg:grid-cols-2' : ''}>
            <Section title="Team" className="min-w-0">
              <GuardedThread
                projectId={p.id}
                visibility="internal"
                emptyHint="Internal discussion about this project. Owners and vendors never see it."
              />
            </Section>
            {p.clientOrgId && (
              <Section title={`Owner${client ? ` · ${client.name}` : ''}`} className="min-w-0">
                <GuardedThread
                  projectId={p.id}
                  visibility="client"
                  clientOrgId={p.clientOrgId}
                  emptyHint="Messages here are visible to the owner in their portal, and can also go out by email."
                />
              </Section>
            )}
          </div>
        )}
        {tab === 'activity' && (
          <Section title="Activity">
            <ActivityFeed service="projects" path={`/projects/${p.id}/activity`} />
          </Section>
        )}
      </div>
      <ProjectFormSheet open={editing} onClose={() => setEditing(false)} project={p} />
    </div>
  );
}
