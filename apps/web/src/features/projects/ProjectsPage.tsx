import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { FolderKanban, Plus } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import {
  Button,
  Chips,
  cx,
  EmptyState,
  ErrorNote,
  enumOptions,
  PageHeader,
  SearchInput,
  Select,
  StatusBadge,
} from '@/components/ui';
import { type Column, DataTable, Pagination } from '@/components/ui/DataTable';
import { api, type Page } from '@/lib/api';
import { hasPerm, useSession } from '@/lib/auth';
import { date, daysFromToday } from '@/lib/format';
import { useListParams, useSearchParamInput } from '@/lib/hooks';
import { ProjectFormSheet } from './ProjectForm';
import { type ProjectListItem, qk, STAGES, StageIndicator, useClientOrgs } from './shared';

const DEFAULTS = { stage: '', status: 'open', assignee: '', q: '', sort: '-updatedAt', limit: '50' };

/** "open" is a UI convenience for the statuses a PM works in day to day. */
const STATUS_QUERY: Record<string, string | undefined> = {
  open: 'active,on_hold,won',
  all: undefined,
  active: 'active',
  on_hold: 'on_hold',
  closed: 'closed,lost',
  cancelled: 'cancelled',
};

export function Component() {
  const s = useSession();
  const nav = useNavigate();
  const [p, set] = useListParams(DEFAULTS);
  const [text, setText] = useSearchParamInput(p.q, (q) => set({ q }));
  const [creating, setCreating] = useState(false);
  const clients = useClientOrgs();
  const clientName = new Map(clients.data?.map((o) => [o.id, o.name]));
  const query = {
    stage: p.stage || undefined,
    status: STATUS_QUERY[p.status],
    assignee: p.assignee || undefined,
    q: p.q || undefined,
    sort: p.sort,
    limit: Number(p.limit),
    offset: Number(p.offset),
  };
  const list = useQuery({
    queryKey: qk.projects(query),
    queryFn: () => api.get<Page<ProjectListItem>>('projects', '/projects', query),
    placeholderData: keepPreviousData,
  });
  const filtered = !!(p.stage || p.assignee || p.q || p.status !== 'open');
  const canWrite = hasPerm(s, 'projects:write');

  const columns: Column<ProjectListItem>[] = [
    {
      key: 'number',
      header: 'Number',
      sort: 'number',
      width: 96,
      cell: (r) => <span className="num whitespace-nowrap text-ink-2">{r.number}</span>,
    },
    {
      key: 'name',
      header: 'Project',
      sort: 'name',
      cell: (r) => (
        <div className="min-w-[220px]">
          <div className="font-[560]">{r.name}</div>
          {r.propertyName && r.propertyName !== r.name && (
            <div className="text-[12px] text-ink-3">{r.propertyName}</div>
          )}
        </div>
      ),
    },
    {
      key: 'client',
      header: 'Owner',
      cell: (r) =>
        r.clientOrgId ? (
          <span className="whitespace-nowrap">{clientName.get(r.clientOrgId) ?? '—'}</span>
        ) : (
          <span className="text-ink-4">—</span>
        ),
    },
    {
      key: 'stage',
      header: 'Stage',
      sort: 'stage',
      cell: (r) =>
        r.status === 'active' ? (
          <StageIndicator stage={r.stage} status={r.status} />
        ) : (
          <span className="inline-flex items-center gap-2">
            <StageIndicator stage={r.stage} status={r.status} />
            <StatusBadge status={r.status} />
          </span>
        ),
    },
    {
      key: 'open',
      header: 'Target open',
      sort: 'targetOpenDate',
      cell: (r) => <span className="num whitespace-nowrap">{date(r.targetOpenDate)}</span>,
    },
    {
      key: 'tasks',
      header: 'Open tasks',
      align: 'right',
      cell: (r) => (
        <span className="whitespace-nowrap">
          {r.openTasks || <span className="text-ink-4">0</span>}
          {r.overdueTasks > 0 && (
            <span className="ml-2 rounded-xs bg-crit-50 px-1 text-[12px] font-[560] text-crit">
              {r.overdueTasks} overdue
            </span>
          )}
        </span>
      ),
    },
    {
      key: 'next',
      header: 'Next milestone',
      cell: (r) => {
        const m = r.nextMilestone;
        if (!m) return <span className="text-ink-4">—</span>;
        const n = daysFromToday(m.due);
        return (
          <div className="min-w-[180px]">
            <div className="truncate">{m.name}</div>
            <div className={cx('num text-[12px]', n !== null && n < 0 ? 'text-crit' : 'text-ink-3')}>
              {date(m.due)}
              {n !== null && n >= 0 && n <= 14 ? ` · in ${n} days` : n !== null && n < 0 ? ' · overdue' : ''}
            </div>
          </div>
        );
      },
    },
  ];

  return (
    <>
      <PageHeader
        title="Projects"
        description="Every hotel project, where it stands, and what’s next."
        actions={
          canWrite && (
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
              New project
            </Button>
          )
        }
      >
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <SearchInput
            value={text}
            onChange={setText}
            placeholder="Search name, property or number"
            className="w-full sm:w-72"
          />
          <Chips
            value={p.assignee === 'me' ? 'me' : 'all'}
            onChange={(v) => set({ assignee: v === 'me' ? 'me' : '' })}
            options={[
              { value: 'all', label: 'All projects' },
              { value: 'me', label: 'My projects' },
            ]}
          />
          <div className="w-[170px]">
            <Select
              aria-label="Stage"
              value={p.stage}
              onChange={(e) => set({ stage: e.target.value })}
              placeholder="Any stage"
              options={enumOptions(STAGES)}
            />
          </div>
          <div className="w-[150px]">
            <Select
              aria-label="Status"
              value={p.status}
              onChange={(e) => set({ status: e.target.value })}
              options={[
                { value: 'open', label: 'Open projects' },
                { value: 'active', label: 'Active' },
                { value: 'on_hold', label: 'On hold' },
                { value: 'closed', label: 'Closed or lost' },
                { value: 'cancelled', label: 'Cancelled' },
                { value: 'all', label: 'Any status' },
              ]}
            />
          </div>
          {filtered && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setText('');
                set({ stage: '', status: 'open', assignee: '', q: '' });
              }}
            >
              Clear filters
            </Button>
          )}
          <span className="num ml-auto text-[13px] text-ink-3">
            {list.data ? `${list.data.total} ${list.data.total === 1 ? 'project' : 'projects'}` : ''}
          </span>
        </div>
      </PageHeader>

      {list.isError ? (
        <ErrorNote error={list.error} />
      ) : (
        <div className="bg-paper [&_td:first-child]:pl-6 [&_td:last-child]:pr-6 [&_th:first-child]:pl-6 [&_th:last-child]:pr-6">
          <DataTable
            columns={columns}
            rows={list.data?.items}
            loading={list.isLoading}
            onRowClick={(r) => nav(`/app/projects/${r.id}`)}
            sort={p.sort}
            onSort={(sort) => set({ sort })}
            empty={
              filtered ? (
                <EmptyState icon={<FolderKanban />} title="No projects match these filters">
                  Try another stage or status, or clear the filters to see every project.
                </EmptyState>
              ) : (
                <EmptyState
                  icon={<FolderKanban />}
                  title="No projects yet"
                  action={
                    canWrite && (
                      <Button variant="primary" onClick={() => setCreating(true)}>
                        New project
                      </Button>
                    )
                  }
                >
                  Create your first project to start its schedule, team and owner portal.
                </EmptyState>
              )
            }
            footer={
              list.data && (
                <Pagination
                  total={list.data.total}
                  limit={list.data.limit}
                  offset={list.data.offset}
                  onChange={(o) => set({ offset: String(o) })}
                />
              )
            }
          />
        </div>
      )}
      <ProjectFormSheet
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(pr) => nav(`/app/projects/${pr.id}`)}
      />
    </>
  );
}
