-- Projects: projects, teams, contacts, task templates, tasks (Gantt / milestones) and notes.
--
-- Cross-service references (no foreign keys across schemas):
--   projects.brand_id        -> catalog.brands
--   projects.client_org_id   -> identity.organizations (type = 'client')
--   *.user_id / created_by / author_id / assignee_user_id -> identity.users
--
-- Row-level security
--   * staff_ok(tenant_id): the tenant's own staff, services acting for the tenant, and system jobs.
--     External actors (vendors, clients) carry the procurement firm's tenant id in their token, so the
--     plain tenant check is NOT enough for them; they only get the explicit client_* policies below.
--   * Client (owner) actors see their own projects (client_org_id = org_id()), milestones and client-party
--     tasks of those projects, team members, contacts flagged visible_to_client and client-visible notes.
--     Column-level stripping is done by the API's /client response schemas.

create schema if not exists projects;

create or replace function projects.staff_ok(t uuid) returns boolean
  language sql stable as $$
  select platform.tenant_ok(t) and platform.actor_type() not in ('vendor', 'client', 'anonymous')
$$;

create or replace function projects.client_ok(t uuid) returns boolean
  language sql stable as $$
  select platform.actor_type() = 'client' and t = platform.tenant_id()
$$;

-- ---------------------------------------------------------------------------------------------
-- projects
-- ---------------------------------------------------------------------------------------------
create table projects.projects (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null,
  number           text not null,
  name             text not null,
  property_name    text,
  brand_id         uuid,           -- catalog.brands
  client_org_id    uuid,           -- identity.organizations
  type             text not null default 'renovation'
                   check (type in ('renovation', 'new_construction', 'conversion', 'refresh', 'opening')),
  stage            text not null default 'lead'
                   check (stage in ('lead', 'proposal', 'design', 'quoting', 'client_approval', 'procurement',
                                    'production', 'logistics', 'installation', 'closeout', 'complete')),
  status           text not null default 'active'
                   check (status in ('active', 'on_hold', 'won', 'lost', 'closed', 'cancelled')),
  keys             int check (keys is null or keys >= 0),
  floors           int check (floors is null or floors >= 0),
  address          jsonb not null default '{}',
  ship_to_address  jsonb not null default '{}',
  target_open_date date,
  start_date       date,
  budget           numeric(14,2),
  credit_terms     text,
  tags             text[] not null default '{}',
  description      text,
  created_by       uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (tenant_id, number)
);
create index projects_tenant_stage_idx on projects.projects (tenant_id, status, stage);
create index projects_client_idx on projects.projects (tenant_id, client_org_id);
create index projects_name_trgm on projects.projects using gin ((name || ' ' || coalesce(property_name, '') || ' ' || number) gin_trgm_ops);

alter table projects.projects enable row level security;
alter table projects.projects force row level security;
create policy tenant_isolation on projects.projects for all
  using (projects.staff_ok(tenant_id)) with check (projects.staff_ok(tenant_id));
create policy client_read on projects.projects for select
  using (projects.client_ok(tenant_id) and client_org_id = platform.org_id());

create trigger projects_touch before update on projects.projects
  for each row execute function platform.touch_updated_at();
create trigger audit after insert or update or delete on projects.projects
  for each row execute function platform.audit('project');

-- Client access helper used by child-table policies (invoker rights: relies on client_read above).
create or replace function projects.client_project(p uuid) returns boolean
  language sql stable as $$
  select platform.actor_type() = 'client'
     and exists (select 1 from projects.projects pr
                 where pr.id = p and pr.tenant_id = platform.tenant_id() and pr.client_org_id = platform.org_id())
$$;

-- ---------------------------------------------------------------------------------------------
-- project_team
-- ---------------------------------------------------------------------------------------------
create table projects.project_team (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references projects.projects(id) on delete cascade,
  tenant_id   uuid not null,
  user_id     uuid not null,     -- identity.users
  name        text not null,
  email       text,
  role        text not null check (role in ('project_manager', 'designer', 'procurement', 'order_manager',
                                            'logistics', 'sales', 'accounting')),
  is_lead     boolean not null default false,
  created_at  timestamptz not null default now(),
  unique (project_id, user_id, role)
);
create index project_team_user_idx on projects.project_team (tenant_id, user_id);

alter table projects.project_team enable row level security;
alter table projects.project_team force row level security;
create policy tenant_isolation on projects.project_team for all
  using (projects.staff_ok(tenant_id)) with check (projects.staff_ok(tenant_id));
create policy client_read on projects.project_team for select
  using (projects.client_ok(tenant_id) and projects.client_project(project_id));

create trigger audit after insert or update or delete on projects.project_team
  for each row execute function platform.audit('project_team_member', 'project_id', 'project');

-- ---------------------------------------------------------------------------------------------
-- project_contacts
-- ---------------------------------------------------------------------------------------------
create table projects.project_contacts (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null,
  project_id            uuid not null references projects.projects(id) on delete cascade,
  name                  text not null,
  company               text,
  role                  text not null default 'other'
                        check (role in ('owner_rep', 'gm', 'site_manager', 'gc', 'installer', 'warehouse',
                                        'architect', 'designer', 'other')),
  email                 text,
  phone                 text,
  is_delivery_recipient boolean not null default false,
  visible_to_client     boolean not null default false,
  notes                 text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index project_contacts_project_idx on projects.project_contacts (project_id);

alter table projects.project_contacts enable row level security;
alter table projects.project_contacts force row level security;
create policy tenant_isolation on projects.project_contacts for all
  using (projects.staff_ok(tenant_id)) with check (projects.staff_ok(tenant_id));
create policy client_read on projects.project_contacts for select
  using (projects.client_ok(tenant_id) and visible_to_client and projects.client_project(project_id));

create trigger project_contacts_touch before update on projects.project_contacts
  for each row execute function platform.touch_updated_at();
create trigger audit after insert or update or delete on projects.project_contacts
  for each row execute function platform.audit('project_contact', 'project_id', 'project');

-- ---------------------------------------------------------------------------------------------
-- task templates
-- ---------------------------------------------------------------------------------------------
create table projects.task_templates (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null,
  name          text not null,
  description   text,
  project_type  text check (project_type is null or project_type in
                  ('renovation', 'new_construction', 'conversion', 'refresh', 'opening')),
  is_default    boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index task_templates_tenant_idx on projects.task_templates (tenant_id);
create unique index task_templates_one_default on projects.task_templates (tenant_id) where is_default;

alter table projects.task_templates enable row level security;
alter table projects.task_templates force row level security;
create policy tenant_isolation on projects.task_templates for all
  using (projects.staff_ok(tenant_id)) with check (projects.staff_ok(tenant_id));

create trigger task_templates_touch before update on projects.task_templates
  for each row execute function platform.touch_updated_at();
create trigger audit after insert or update or delete on projects.task_templates
  for each row execute function platform.audit('task_template');

create table projects.template_tasks (
  id               uuid primary key default gen_random_uuid(),
  template_id      uuid not null references projects.task_templates(id) on delete cascade,
  tenant_id        uuid not null,
  key              text not null check (key ~ '^[a-z0-9][a-z0-9_-]*$'),
  name             text not null,
  phase            text,
  kind             text not null default 'task'
                   check (kind in ('task', 'approval', 'payment', 'milestone', 'document')),
  party            text not null default 'internal' check (party in ('internal', 'client', 'vendor')),
  assignee_role    text check (assignee_role is null or assignee_role in
                     ('project_manager', 'designer', 'procurement', 'order_manager', 'logistics', 'sales',
                      'accounting')),
  work_hours       numeric(8,2),
  duration_days    int not null default 1 check (duration_days >= 0),
  depends_on       text[] not null default '{}',
  offset_days      int not null default 0,
  is_milestone     boolean not null default false,
  auto_complete_on text,
  description      text,
  sort             int not null default 0,
  unique (template_id, key)
);
create index template_tasks_template_idx on projects.template_tasks (template_id, sort);

alter table projects.template_tasks enable row level security;
alter table projects.template_tasks force row level security;
create policy tenant_isolation on projects.template_tasks for all
  using (projects.staff_ok(tenant_id)) with check (projects.staff_ok(tenant_id));

-- ---------------------------------------------------------------------------------------------
-- tasks
-- ---------------------------------------------------------------------------------------------
create table projects.tasks (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null,
  project_id        uuid not null references projects.projects(id) on delete cascade,
  template_task_id  uuid,          -- informational; template may be edited/deleted later
  key               text,
  name              text not null,
  description       text,
  phase             text,
  kind              text not null default 'task'
                    check (kind in ('task', 'approval', 'payment', 'milestone', 'document')),
  party             text not null default 'internal' check (party in ('internal', 'client', 'vendor')),
  status            text not null default 'todo'
                    check (status in ('todo', 'in_progress', 'blocked', 'done', 'skipped')),
  assignee_user_id  uuid,          -- identity.users
  assignee_name     text,
  assignee_role     text check (assignee_role is null or assignee_role in
                      ('project_manager', 'designer', 'procurement', 'order_manager', 'logistics', 'sales',
                       'accounting')),
  work_hours        numeric(8,2),
  duration_days     int not null default 1 check (duration_days >= 0),
  start_date        date,
  due_date          date,
  completed_at      timestamptz,
  completed_by_name text,
  depends_on        uuid[] not null default '{}',
  is_milestone      boolean not null default false,
  auto_complete_on  text,
  ready             boolean not null default true,
  sort              int not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  check (start_date is null or due_date is null or due_date >= start_date)
);
create index tasks_portfolio_idx on projects.tasks (tenant_id, status, due_date);
create index tasks_assignee_idx on projects.tasks (assignee_user_id, status);
create index tasks_project_idx on projects.tasks (project_id, sort);
create index tasks_depends_idx on projects.tasks using gin (depends_on);
create index tasks_autocomplete_idx on projects.tasks (project_id, auto_complete_on)
  where auto_complete_on is not null and status not in ('done', 'skipped');

alter table projects.tasks enable row level security;
alter table projects.tasks force row level security;
create policy tenant_isolation on projects.tasks for all
  using (projects.staff_ok(tenant_id)) with check (projects.staff_ok(tenant_id));
create policy client_read on projects.tasks for select
  using (projects.client_ok(tenant_id) and (party = 'client' or is_milestone)
         and projects.client_project(project_id));

-- Client task completion runs on the server with service context after the API has verified the
-- task belongs to the client's project (dependents are internal rows clients cannot update).

create trigger tasks_touch before update on projects.tasks
  for each row execute function platform.touch_updated_at();
create trigger audit after insert or update or delete on projects.tasks
  for each row execute function platform.audit('task', 'project_id', 'project');

-- ---------------------------------------------------------------------------------------------
-- notes
-- ---------------------------------------------------------------------------------------------
create table projects.notes (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  project_id  uuid not null references projects.projects(id) on delete cascade,
  author_id   uuid,               -- identity.users
  author_name text not null,
  body        text not null check (length(body) > 0),
  visibility  text not null default 'internal' check (visibility in ('internal', 'client')),
  pinned      boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index notes_project_idx on projects.notes (project_id, pinned desc, created_at desc);

alter table projects.notes enable row level security;
alter table projects.notes force row level security;
create policy tenant_isolation on projects.notes for all
  using (projects.staff_ok(tenant_id)) with check (projects.staff_ok(tenant_id));
create policy client_read on projects.notes for select
  using (projects.client_ok(tenant_id) and visibility = 'client' and projects.client_project(project_id));

create trigger notes_touch before update on projects.notes
  for each row execute function platform.touch_updated_at();
create trigger audit after insert or update or delete on projects.notes
  for each row execute function platform.audit('note', 'project_id', 'project');
