-- Platform schema: cross-cutting infrastructure shared by every service in the single database.
--   * request-context helpers read by row-level-security policies
--   * field-level activity log (audit) maintained by a generic trigger
--   * transactional outbox + idempotent inbox for integration events
--   * per-tenant document numbering (PO-26-0001, Q-26-0042, ...)

create schema if not exists platform;
grant usage on schema platform to procure_app;

create extension if not exists pgcrypto;
create extension if not exists pg_trgm;

-- ---------------------------------------------------------------------------------------------
-- Request context. Values are set per transaction by @procure/platform (set_config(..., true)).
-- ---------------------------------------------------------------------------------------------
create or replace function platform.tenant_id() returns uuid
  language sql stable as $$ select nullif(current_setting('app.tenant_id', true), '')::uuid $$;
create or replace function platform.user_id() returns uuid
  language sql stable as $$ select nullif(current_setting('app.user_id', true), '')::uuid $$;
create or replace function platform.org_id() returns uuid
  language sql stable as $$ select nullif(current_setting('app.org_id', true), '')::uuid $$;
create or replace function platform.actor_type() returns text
  language sql stable as $$ select coalesce(nullif(current_setting('app.actor_type', true), ''), 'anonymous') $$;
create or replace function platform.is_system() returns boolean
  language sql stable as $$ select platform.actor_type() = 'system' $$;
/** True when the row belongs to the current tenant, or the caller is a background system process. */
create or replace function platform.tenant_ok(t uuid) returns boolean
  language sql stable as $$ select platform.is_system() or t = platform.tenant_id() $$;

-- ---------------------------------------------------------------------------------------------
-- Activity log. Every audited table gets:
--   create trigger audit after insert or update or delete on <t>
--     for each row execute function platform.audit('<entity_type>');
-- Updates record only the fields that changed: {"field": {"from": x, "to": y}}.
-- ---------------------------------------------------------------------------------------------
create table if not exists platform.activity_log (
  id            bigint generated always as identity primary key,
  tenant_id     uuid,
  entity_type   text not null,
  entity_id     uuid not null,
  parent_type   text,
  parent_id     uuid,
  action        text not null check (action in ('insert', 'update', 'delete')),
  changes       jsonb not null default '{}',
  actor_user_id uuid,
  actor_org_id  uuid,
  actor_type    text,
  actor_name    text,
  occurred_at   timestamptz not null default now()
);
create index if not exists activity_entity_idx on platform.activity_log (entity_type, entity_id, occurred_at desc);
create index if not exists activity_parent_idx on platform.activity_log (parent_type, parent_id, occurred_at desc);
create index if not exists activity_tenant_idx on platform.activity_log (tenant_id, occurred_at desc);

alter table platform.activity_log enable row level security;
alter table platform.activity_log force row level security;
drop policy if exists tenant_isolation on platform.activity_log;
create policy tenant_isolation on platform.activity_log
  using (platform.tenant_ok(tenant_id))
  with check (tenant_id is null or platform.tenant_ok(tenant_id));
grant select, insert on platform.activity_log to procure_app;

create or replace function platform.audit() returns trigger
  language plpgsql security invoker as $$
declare
  entity  text := tg_argv[0];
  -- Optional second/third args name the column holding the parent entity id and its type.
  parent_col  text := case when tg_nargs > 1 then tg_argv[1] else null end;
  parent_type text := case when tg_nargs > 2 then tg_argv[2] else null end;
  old_j   jsonb;
  new_j   jsonb;
  diff    jsonb := '{}';
  k       text;
  row_j   jsonb;
  ignored text[] := array['updated_at', 'created_at', 'search', 'sort'];
begin
  if tg_op = 'INSERT' then
    new_j := to_jsonb(new); row_j := new_j;
    diff := new_j - ignored;
  elsif tg_op = 'DELETE' then
    old_j := to_jsonb(old); row_j := old_j;
    diff := old_j - ignored;
  else
    old_j := to_jsonb(old); new_j := to_jsonb(new); row_j := new_j;
    for k in select jsonb_object_keys(new_j) loop
      if k = any(ignored) then continue; end if;
      if (old_j -> k) is distinct from (new_j -> k) then
        diff := diff || jsonb_build_object(k, jsonb_build_object('from', old_j -> k, 'to', new_j -> k));
      end if;
    end loop;
    if diff = '{}'::jsonb then return null; end if;
  end if;

  insert into platform.activity_log
    (tenant_id, entity_type, entity_id, parent_type, parent_id, action, changes,
     actor_user_id, actor_org_id, actor_type, actor_name)
  values (
    nullif(row_j ->> 'tenant_id', '')::uuid,
    entity,
    (row_j ->> 'id')::uuid,
    parent_type,
    case when parent_col is not null then nullif(row_j ->> parent_col, '')::uuid end,
    lower(tg_op),
    diff,
    platform.user_id(),
    platform.org_id(),
    platform.actor_type(),
    nullif(current_setting('app.user_name', true), '')
  );
  return null;
end $$;

-- Generic updated_at maintenance.
create or replace function platform.touch_updated_at() returns trigger
  language plpgsql as $$ begin new.updated_at := now(); return new; end $$;

-- ---------------------------------------------------------------------------------------------
-- Transactional outbox & idempotent inbox.
-- ---------------------------------------------------------------------------------------------
create table if not exists platform.outbox (
  id            uuid primary key,
  source        text not null,
  type          text not null,
  version       int  not null default 1,
  tenant_id     uuid,
  actor         jsonb,
  data          jsonb not null,
  occurred_at   timestamptz not null default now(),
  published_at  timestamptz,
  attempts      int not null default 0,
  last_error    text
);
create index if not exists outbox_pending_idx on platform.outbox (source, occurred_at) where published_at is null;
grant select, insert, update on platform.outbox to procure_app;

create table if not exists platform.inbox (
  consumer    text not null,
  event_id    uuid not null,
  event_type  text not null,
  processed_at timestamptz not null default now(),
  primary key (consumer, event_id)
);
grant select, insert, delete on platform.inbox to procure_app;

-- Local transport only: which service wants which event types (AWS uses EventBridge rules).
create table if not exists platform.event_subscriptions (
  consumer    text not null,
  event_type  text not null,
  endpoint    text not null,
  updated_at  timestamptz not null default now(),
  primary key (consumer, event_type)
);
grant select, insert, update, delete on platform.event_subscriptions to procure_app;

-- Delivery log for the local HTTP transport (also handy for the admin "event log" view).
create table if not exists platform.event_deliveries (
  id          bigint generated always as identity primary key,
  event_id    uuid not null,
  consumer    text not null,
  status      text not null,
  error       text,
  delivered_at timestamptz not null default now()
);
grant select, insert on platform.event_deliveries to procure_app;

-- ---------------------------------------------------------------------------------------------
-- Document numbering: next_number(tenant, 'PO', 'PO-{yy}-{seq:4}') -> 'PO-26-0007'
-- ---------------------------------------------------------------------------------------------
create table if not exists platform.number_sequences (
  tenant_id uuid not null,
  kind      text not null,
  period    text not null,
  value     int  not null default 0,
  primary key (tenant_id, kind, period)
);
grant select, insert, update on platform.number_sequences to procure_app;

create or replace function platform.next_number(p_tenant uuid, p_kind text, p_format text default null)
  returns text language plpgsql as $$
declare
  yy   text := to_char(now(), 'YY');
  v    int;
  fmt  text := coalesce(p_format, p_kind || '-{yy}-{seq:4}');
  pad  int;
begin
  insert into platform.number_sequences (tenant_id, kind, period, value)
    values (p_tenant, p_kind, yy, 1)
    on conflict (tenant_id, kind, period) do update set value = platform.number_sequences.value + 1
    returning value into v;
  pad := coalesce(substring(fmt from '\{seq:(\d+)\}')::int, 4);
  return regexp_replace(replace(fmt, '{yy}', yy), '\{seq(:\d+)?\}', lpad(v::text, pad, '0'));
end $$;

-- ---------------------------------------------------------------------------------------------
-- Scheduled-job bookkeeping (jobs run in-process under pg_try_advisory_lock).
-- ---------------------------------------------------------------------------------------------
create table if not exists platform.job_runs (
  id          bigint generated always as identity primary key,
  service     text not null,
  job         text not null,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  status      text not null default 'running',
  detail      jsonb,
  error       text
);
create index if not exists job_runs_idx on platform.job_runs (service, job, started_at desc);
grant select, insert, update on platform.job_runs to procure_app;
