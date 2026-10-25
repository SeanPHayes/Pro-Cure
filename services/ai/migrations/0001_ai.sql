-- AI service: reviewable AI jobs (brand-spec extraction, vendor-quote extraction, drawing-packet
-- splitting, inbox routing, risk scoring), per-vendor delivery performance profiles and risk-model runs.
--
-- Cross-service references (no foreign keys across schemas):
--   jobs.entity_id            → owner depends on entity_type (quoting.cost_requests, catalog.brand_standards,
--                               quoting.quotes, comms.inbound_emails, …)
--   jobs.created_by           → identity.users
--   vendor_performance.vendor_id → catalog.vendors

create schema if not exists ai;

create table ai.jobs (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null,
  kind             text not null check (kind in
                     ('brand_spec_extract', 'vendor_quote_extract', 'drawing_split', 'inbox_route', 'risk_score')),
  status           text not null default 'queued' check (status in
                     ('queued', 'running', 'needs_review', 'completed', 'failed', 'applied')),
  title            text not null,
  input            jsonb not null default '{}',
  output           jsonb,
  review           jsonb,
  error            text,
  provider         text,
  model            text,
  input_tokens     int not null default 0,
  output_tokens    int not null default 0,
  pages            int,
  duration_ms      int,
  attempts         int not null default 0,
  idempotency_key  text,
  created_by       uuid,
  created_by_name  text,
  created_at       timestamptz not null default now(),
  started_at       timestamptz,
  completed_at     timestamptz,
  -- Apply bookkeeping: apply_started_at is a short lease that stops two reviewers applying at once.
  apply_started_at timestamptz,
  apply_result     jsonb,
  apply_error      text,
  applied_at       timestamptz,
  applied_by_name  text,
  discarded_at     timestamptz,
  discarded_by_name text,
  entity_type      text,
  entity_id        uuid,
  updated_at       timestamptz not null default now()
);
create index jobs_tenant_created_idx on ai.jobs (tenant_id, created_at desc);
create index jobs_tenant_kind_status_idx on ai.jobs (tenant_id, kind, status);
create index jobs_entity_idx on ai.jobs (tenant_id, entity_type, entity_id);
create index jobs_pending_idx on ai.jobs (status, created_at) where status in ('queued', 'running');
create unique index jobs_idempotency_idx on ai.jobs (tenant_id, idempotency_key) where idempotency_key is not null;

alter table ai.jobs enable row level security;
alter table ai.jobs force row level security;
create policy tenant_isolation on ai.jobs for all
  using (platform.tenant_ok(tenant_id)) with check (platform.tenant_ok(tenant_id));

create trigger jobs_touch before update on ai.jobs for each row execute function platform.touch_updated_at();

create table ai.vendor_performance (
  tenant_id              uuid not null,
  vendor_id              uuid not null,
  sample_size            int not null default 0,
  on_time_rate           numeric(7,3),       -- shrunk toward the tenant prior, 0..1
  mean_slip_days         numeric(9,2),
  p90_slip_days          numeric(9,2),
  std_slip_days          numeric(9,2),
  mean_lead_time_weeks   numeric(9,2),
  ship_date_change_rate  numeric(7,3),
  raw                    jsonb not null default '{}', -- unshrunk observed stats, for transparency
  updated_at             timestamptz not null default now(),
  primary key (tenant_id, vendor_id)
);
alter table ai.vendor_performance enable row level security;
alter table ai.vendor_performance force row level security;
create policy tenant_isolation on ai.vendor_performance for all
  using (platform.tenant_ok(tenant_id)) with check (platform.tenant_ok(tenant_id));

create table ai.risk_model_runs (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null,
  job_id            uuid references ai.jobs(id) on delete set null,
  run_at            timestamptz not null default now(),
  shipments_scored  int not null default 0,
  vendors_profiled  int not null default 0,
  params            jsonb not null default '{}',
  output            jsonb not null default '{}'
);
create index risk_runs_tenant_idx on ai.risk_model_runs (tenant_id, run_at desc);
alter table ai.risk_model_runs enable row level security;
alter table ai.risk_model_runs force row level security;
create policy tenant_isolation on ai.risk_model_runs for all
  using (platform.tenant_ok(tenant_id)) with check (platform.tenant_ok(tenant_id));

-- Tenants the scheduled risk model runs for. Populated from identity.org.created (procurement firms)
-- and whenever a tenant uses the ai service, so the ai service never reads another schema.
create table ai.tenants (
  tenant_id      uuid primary key,
  name           text,
  risk_enabled   boolean not null default true,
  registered_at  timestamptz not null default now()
);
alter table ai.tenants enable row level security;
alter table ai.tenants force row level security;
create policy tenant_isolation on ai.tenants for all
  using (platform.tenant_ok(tenant_id)) with check (platform.tenant_ok(tenant_id));
