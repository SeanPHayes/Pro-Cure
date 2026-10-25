-- Quoting: private spec library, master specs (competing vendors), quotes structured by
-- locations × room types, quote lines (spec snapshots with quantity + pricing), merchandising rules,
-- vendor cost requests, approval policies / requests, client quote approval.
--
-- Cross-service references (no FKs, by design):
--   vendor_id            → catalog.vendors
--   brand_standard_*     → catalog brand standards / items
--   project_id           → projects.projects
--   client_org_id        → identity.organizations (the project's client, copied from projects)
--   vendor_org_id        → identity.organizations (vendor's portal org, copied from catalog)
--   *_document_id        → documents.documents
--   po_id                → orders.purchase_orders

create schema if not exists quoting;

-- ---------------------------------------------------------------------------------------------
-- Spec library
-- ---------------------------------------------------------------------------------------------
create table quoting.master_specs (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  name        text not null,
  category    text,
  description text,
  notes       text,
  archived    boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index master_specs_tenant_idx on quoting.master_specs (tenant_id, name);

create table quoting.specs (
  id                     uuid primary key default gen_random_uuid(),
  tenant_id              uuid not null,
  code                   text not null,
  name                   text not null,
  description            text,
  category               text not null default 'other',
  vendor_id              uuid,
  vendor_name            text,
  vendor_sku             text,
  finish                 text,
  dimensions             text,
  materials              text,
  unit                   text not null default 'ea',
  cost                   numeric(14,4) check (cost is null or cost >= 0),
  cost_expires_at        date,
  lead_time_weeks        numeric(7,3),
  freight_unit           numeric(14,4),
  image_document_id      uuid,
  master_spec_id         uuid references quoting.master_specs(id) on delete set null,
  brand_standard_id      uuid,
  brand_standard_item_id uuid,
  notes                  text,
  archived               boolean not null default false,
  created_by             uuid,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (tenant_id, code)
);
create index specs_vendor_idx on quoting.specs (tenant_id, vendor_id);
create index specs_master_idx on quoting.specs (master_spec_id);
create index specs_bsi_idx on quoting.specs (tenant_id, brand_standard_item_id);
create index specs_name_trgm on quoting.specs using gin (name gin_trgm_ops);

create table quoting.spec_cost_history (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null,
  spec_id           uuid not null references quoting.specs(id) on delete cascade,
  cost              numeric(14,4),
  expires_at        date,
  source            text not null check (source in ('manual', 'cost_request', 'ai_pdf', 'import')),
  cost_request_id   uuid,
  recorded_at       timestamptz not null default now(),
  recorded_by_name  text
);
create index spec_cost_history_spec_idx on quoting.spec_cost_history (spec_id, recorded_at desc);

-- ---------------------------------------------------------------------------------------------
-- Quotes
-- ---------------------------------------------------------------------------------------------
create table quoting.quotes (
  id                     uuid primary key default gen_random_uuid(),
  tenant_id              uuid not null,
  project_id             uuid,
  client_org_id          uuid,
  number                 text not null,
  name                   text not null,
  phase                  text,
  status                 text not null default 'draft' check (status in
                           ('draft', 'costing', 'merchandising', 'pending_internal_approval', 'sent',
                            'client_approved', 'client_rejected', 'ordered', 'archived')),
  is_template            boolean not null default false,
  template_name          text,
  source_quote_id        uuid,
  currency               text not null default 'USD',
  tax_rate               numeric(7,3) not null default 0,
  freight_mode           text not null default 'per_line' check (freight_mode in ('per_line', 'percent')),
  freight_pct            numeric(7,3) not null default 0,
  default_markup_pct     numeric(7,3) not null default 0,
  min_margin_pct         numeric(7,3),
  valid_until            date,
  notes                  text,
  client_notes           text,
  submitted_for_approval_at timestamptz,
  internal_approved_at   timestamptz,
  sent_at                timestamptz,
  sent_by_name           text,
  client_document_id     uuid,
  client_decision        text check (client_decision in ('approved', 'rejected')),
  client_decided_at      timestamptz,
  client_decided_by_name text,
  client_signature_name  text,
  client_comment         text,
  created_by             uuid,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  version                int not null default 1,
  unique (tenant_id, number),
  check (is_template or project_id is not null)
);
create index quotes_project_idx on quoting.quotes (tenant_id, project_id);
create index quotes_status_idx on quoting.quotes (tenant_id, status);

create or replace function quoting.bump_version() returns trigger
  language plpgsql as $$ begin new.version := old.version + 1; return new; end $$;

create table quoting.quote_room_types (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null,
  quote_id   uuid not null references quoting.quotes(id) on delete cascade,
  code       text not null,
  name       text not null,
  count      int not null default 0 check (count >= 0),
  sort       int not null default 0,
  unique (quote_id, code)
);

create table quoting.quote_locations (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null,
  quote_id   uuid not null references quoting.quotes(id) on delete cascade,
  parent_id  uuid references quoting.quote_locations(id) on delete cascade,
  name       text not null,
  kind       text not null default 'area' check (kind in ('area', 'room', 'category')),
  sort       int not null default 0
);
create index quote_locations_quote_idx on quoting.quote_locations (quote_id, parent_id, sort);

create table quoting.location_templates (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  name        text not null,
  description text,
  tree        jsonb not null default '[]',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table quoting.quote_lines (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null,
  quote_id          uuid not null references quoting.quotes(id) on delete cascade,
  location_id       uuid references quoting.quote_locations(id) on delete set null,
  spec_id           uuid references quoting.specs(id) on delete set null,
  master_spec_id    uuid references quoting.master_specs(id) on delete set null,
  is_selected       boolean not null default true,
  code              text not null,
  name              text not null,
  description       text,
  category          text not null default 'other',
  vendor_id         uuid,
  vendor_name       text,
  vendor_sku        text,
  finish            text,
  dimensions        text,
  materials         text,
  image_document_id uuid,
  qty_mode          text not null default 'fixed' check (qty_mode in ('fixed', 'per_room')),
  qty_fixed         numeric(14,4) not null default 0 check (qty_fixed >= 0),
  qty_per_room      jsonb not null default '{}',
  handing           jsonb,
  attic_stock_pct   numeric(7,3) not null default 0 check (attic_stock_pct >= 0),
  quantity          numeric(14,4) not null default 0,
  unit              text not null default 'ea',
  unit_cost         numeric(14,4),
  cost_expires_at   date,
  lead_time_weeks   numeric(7,3),
  freight_unit      numeric(14,4),
  markup_pct        numeric(7,3) not null default 0,
  unit_price        numeric(14,4),
  price_override    boolean not null default false,
  extended_cost     numeric(14,2),
  extended_price    numeric(14,2),
  margin_pct        numeric(7,3),
  flags             text[] not null default '{}',
  ready_to_order    boolean not null default false,
  po_id             uuid,
  po_number         text,
  notes             text,
  client_notes      text,
  sort              int not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index quote_lines_quote_idx on quoting.quote_lines (quote_id, location_id, sort);
create index quote_lines_spec_idx on quoting.quote_lines (spec_id);
create index quote_lines_master_idx on quoting.quote_lines (quote_id, master_spec_id);

create table quoting.quote_markup_rules (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  quote_id    uuid not null references quoting.quotes(id) on delete cascade,
  category    text,
  location_id uuid references quoting.quote_locations(id) on delete cascade,
  markup_pct  numeric(7,3) not null,
  created_at  timestamptz not null default now()
);
create index quote_markup_rules_quote_idx on quoting.quote_markup_rules (quote_id);

-- ---------------------------------------------------------------------------------------------
-- Cost requests (vendor costing)
-- ---------------------------------------------------------------------------------------------
create table quoting.cost_requests (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null,
  quote_id         uuid not null references quoting.quotes(id) on delete cascade,
  project_id       uuid,
  vendor_id        uuid not null,
  vendor_name      text,
  vendor_org_id    uuid,
  vendor_email     text,
  project_name     text,
  number           text not null,
  status           text not null default 'draft' check (status in
                     ('draft', 'sent', 'viewed', 'responded', 'partially_applied', 'applied', 'closed')),
  due_date         date,
  message          text,
  sent_at          timestamptz,
  viewed_at        timestamptz,
  responded_at     timestamptz,
  last_reminded_at timestamptz,
  reminder_count   int not null default 0,
  document_id      uuid,
  created_by_name  text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (tenant_id, number)
);
create index cost_requests_quote_idx on quoting.cost_requests (tenant_id, quote_id);
create index cost_requests_vendor_org_idx on quoting.cost_requests (vendor_org_id, status);

create table quoting.cost_request_lines (
  id                       uuid primary key default gen_random_uuid(),
  tenant_id                uuid not null,
  cost_request_id          uuid not null references quoting.cost_requests(id) on delete cascade,
  quote_line_id            uuid references quoting.quote_lines(id) on delete set null,
  spec_id                  uuid references quoting.specs(id) on delete set null,
  code                     text not null,
  name                     text not null,
  description              text,
  vendor_sku               text,
  finish                   text,
  dimensions               text,
  quantity                 numeric(14,4) not null default 0,
  current_cost             numeric(14,4),
  response_cost            numeric(14,4) check (response_cost is null or response_cost >= 0),
  response_expires_at      date,
  response_lead_time_weeks numeric(7,3),
  response_notes           text,
  response_spec_changes    jsonb not null default '{}',
  response_source          text check (response_source in ('portal', 'ai_pdf', 'manual')),
  responded_at             timestamptz,
  applied_at               timestamptz,
  applied_to_spec          boolean not null default false
);
create index cost_request_lines_req_idx on quoting.cost_request_lines (cost_request_id);

-- ---------------------------------------------------------------------------------------------
-- Approval rules engine
-- ---------------------------------------------------------------------------------------------
create table quoting.approval_policies (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null,
  name          text not null,
  active        boolean not null default true,
  applies_to    text not null default 'quote' check (applies_to in ('quote')),
  condition     jsonb not null,
  approver_role text not null,
  description   text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table quoting.approval_requests (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null,
  entity_type       text not null default 'quote' check (entity_type in ('quote')),
  entity_id         uuid not null,
  policy_id         uuid references quoting.approval_policies(id) on delete set null,
  policy_name       text not null,
  reason            text not null,
  details           jsonb not null default '{}',
  approver_role     text not null,
  status            text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  requested_by      uuid,
  requested_by_name text,
  decided_by        uuid,
  decided_by_name   text,
  decided_at        timestamptz,
  comment           text,
  created_at        timestamptz not null default now()
);
create index approval_requests_entity_idx on quoting.approval_requests (tenant_id, entity_type, entity_id, status);
create index approval_requests_role_idx on quoting.approval_requests (tenant_id, approver_role, status);

-- ---------------------------------------------------------------------------------------------
-- Row-level security: tenant isolation on every table.
-- ---------------------------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['master_specs', 'specs', 'spec_cost_history', 'quotes', 'quote_room_types',
    'quote_locations', 'location_templates', 'quote_lines', 'quote_markup_rules', 'cost_requests',
    'cost_request_lines', 'approval_policies', 'approval_requests']
  loop
    execute format('alter table quoting.%I enable row level security', t);
    execute format('alter table quoting.%I force row level security', t);
    execute format('create policy tenant_isolation on quoting.%I for all
      using (platform.tenant_ok(tenant_id)) with check (platform.tenant_ok(tenant_id))', t);
  end loop;
end $$;

-- External actors. platform.tenant_ok() never admits vendors/clients; these narrower policies do.
-- Vendors: their own cost requests (and lines). Writable columns are limited in the API.
create policy vendor_read on quoting.cost_requests for select
  using (platform.vendor_ok(tenant_id, vendor_org_id));
create policy vendor_update on quoting.cost_requests for update
  using (platform.vendor_ok(tenant_id, vendor_org_id))
  with check (platform.vendor_ok(tenant_id, vendor_org_id));

create policy vendor_read on quoting.cost_request_lines for select
  using (exists (select 1 from quoting.cost_requests r
                 where r.id = cost_request_id and platform.vendor_ok(r.tenant_id, r.vendor_org_id)));
create policy vendor_update on quoting.cost_request_lines for update
  using (exists (select 1 from quoting.cost_requests r
                 where r.id = cost_request_id and platform.vendor_ok(r.tenant_id, r.vendor_org_id)
                   and r.status in ('sent', 'viewed', 'responded')))
  with check (exists (select 1 from quoting.cost_requests r
                 where r.id = cost_request_id and platform.vendor_ok(r.tenant_id, r.vendor_org_id)));

-- Clients (hotel owners): quotes sent to their organization, and those quotes' structure and lines.
create policy client_read on quoting.quotes for select
  using (platform.client_ok(tenant_id, client_org_id) and not is_template
         and status in ('sent', 'client_approved', 'client_rejected', 'ordered'));
create policy client_update on quoting.quotes for update
  using (platform.client_ok(tenant_id, client_org_id) and not is_template and status = 'sent')
  with check (platform.client_ok(tenant_id, client_org_id) and status in ('client_approved', 'client_rejected'));

create policy client_read on quoting.quote_lines for select
  using (exists (select 1 from quoting.quotes q where q.id = quote_id and platform.client_ok(q.tenant_id, q.client_org_id)
                 and not q.is_template and q.status in ('sent', 'client_approved', 'client_rejected', 'ordered')));
create policy client_read on quoting.quote_locations for select
  using (exists (select 1 from quoting.quotes q where q.id = quote_id and platform.client_ok(q.tenant_id, q.client_org_id)
                 and not q.is_template and q.status in ('sent', 'client_approved', 'client_rejected', 'ordered')));
create policy client_read on quoting.quote_room_types for select
  using (exists (select 1 from quoting.quotes q where q.id = quote_id and platform.client_ok(q.tenant_id, q.client_org_id)
                 and not q.is_template and q.status in ('sent', 'client_approved', 'client_rejected', 'ordered')));

-- ---------------------------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------------------------
create trigger master_specs_touch before update on quoting.master_specs for each row execute function platform.touch_updated_at();
create trigger specs_touch before update on quoting.specs for each row execute function platform.touch_updated_at();
create trigger quotes_touch before update on quoting.quotes for each row execute function platform.touch_updated_at();
create trigger quotes_version before update on quoting.quotes for each row execute function quoting.bump_version();
create trigger location_templates_touch before update on quoting.location_templates for each row execute function platform.touch_updated_at();
create trigger quote_lines_touch before update on quoting.quote_lines for each row execute function platform.touch_updated_at();
create trigger cost_requests_touch before update on quoting.cost_requests for each row execute function platform.touch_updated_at();
create trigger approval_policies_touch before update on quoting.approval_policies for each row execute function platform.touch_updated_at();

create trigger audit after insert or update or delete on quoting.specs
  for each row execute function platform.audit('spec');
create trigger audit after insert or update or delete on quoting.master_specs
  for each row execute function platform.audit('master_spec');
create trigger audit after insert or update or delete on quoting.quotes
  for each row execute function platform.audit('quote');
create trigger audit after insert or update or delete on quoting.quote_lines
  for each row execute function platform.audit('quote_line', 'quote_id', 'quote');
create trigger audit after insert or update or delete on quoting.cost_requests
  for each row execute function platform.audit('cost_request', 'quote_id', 'quote');
create trigger audit after insert or update or delete on quoting.approval_requests
  for each row execute function platform.audit('approval_request', 'entity_id', 'quote');
create trigger audit after insert or update or delete on quoting.approval_policies
  for each row execute function platform.audit('approval_policy');
