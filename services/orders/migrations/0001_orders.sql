-- Orders: purchase orders & revisions, pre-order requirements, split shipments, ship-date confirmations,
-- carrier tracking, risk/escalation, delivery recipients, receiving, storage and claims.
--
-- Cross-service references (no foreign keys across schemas):
--   *.project_id                    -> projects.projects (projects service)
--   *.client_org_id / vendor_org_id -> identity.organizations (identity service)
--   *.vendor_id                     -> catalog.vendors (catalog service)
--   purchase_orders.quote_id        -> quoting.quotes (quoting service)
--   po_lines.quote_line_id/spec_id  -> quoting.quote_lines / quoting.specs (quoting service)
--   *.document_id / *_document_ids  -> documents.documents (documents service)
--
-- Row-level security
--   * platform.tenant_ok(tenant_id) (platform 0002): staff, services and system jobs only. Vendor and client
--     actors carry the procurement firm's tenant id in their token but never pass it; they only get the explicit
--     vendor_* / client_* policies below (platform.vendor_ok / platform.client_ok on rows keyed by their org,
--     parent-visibility checks on child rows). RLS limits rows; portal response schemas limit columns.
--   * Vendors: non-draft POs where vendor_org_id = their org (and children of those POs), their claims.
--   * Clients: non-draft POs where client_org_id = their org (and children), their storage items and claims.

create schema if not exists orders;

-- Child-row building blocks: same tenant and external actor type; the parent check (po_visible etc.) runs
-- under the caller's own RLS, so it only passes for parents shared with the caller's organization.
create or replace function orders.vendor_ok(t uuid) returns boolean
  language sql stable as $$
  select platform.actor_type() = 'vendor' and t = platform.tenant_id()
$$;
create or replace function orders.client_ok(t uuid) returns boolean
  language sql stable as $$
  select platform.actor_type() = 'client' and t = platform.tenant_id()
$$;

-- ---------------------------------------------------------------------------------------------
-- purchase_orders
-- ---------------------------------------------------------------------------------------------
create table orders.purchase_orders (
  id                      uuid primary key default gen_random_uuid(),
  tenant_id               uuid not null,
  project_id              uuid not null,
  project_number          text,
  project_name            text,
  client_org_id           uuid,
  quote_id                uuid,
  vendor_id               uuid not null,
  vendor_name             text not null,
  vendor_org_id           uuid,
  vendor_contact          jsonb,              -- {name, email, phone}
  number                  text not null,
  revision                int not null default 0,
  status                  text not null default 'draft'
                          check (status in ('draft', 'issued', 'acknowledged', 'in_production', 'partially_shipped',
                                            'shipped', 'partially_delivered', 'delivered', 'closed', 'cancelled')),
  order_date              date,
  issued_at               timestamptz,
  issued_by_name          text,
  acknowledged_at         timestamptz,
  cancelled_at            timestamptz,
  cancel_reason           text,
  ship_to                 jsonb not null default '{}',
  bill_to                 jsonb not null default '{}',
  contact24h              jsonb,          -- {name, email, phone}; no underscore so it round-trips the camelCase transform
  payment_terms           text,
  freight_terms           text,
  ship_method             text,
  deposit_pct             numeric(7,3) not null default 0 check (deposit_pct >= 0 and deposit_pct <= 100),
  notes                   text,               -- internal only
  vendor_notes            text,               -- printed on the PO / shown to the vendor
  subtotal                numeric(14,2) not null default 0,
  freight                 numeric(14,2) not null default 0,
  tax                     numeric(14,2) not null default 0,
  total                   numeric(14,2) not null default 0,
  requested_delivery_date date,
  lead_time_weeks         int check (lead_time_weeks is null or lead_time_weeks >= 0),
  transit_days            int check (transit_days is null or transit_days >= 0),
  origin                  text not null default 'domestic' check (origin in ('domestic', 'international')),
  release_by_date         date,               -- order-by date: requested delivery - lead time - transit
  escalation              text not null default 'none' check (escalation in ('none', 'watch', 'at_risk', 'critical')),
  escalation_reasons      text[] not null default '{}',
  risk_score              int check (risk_score is null or (risk_score >= 0 and risk_score <= 100)),
  risk_level              text check (risk_level is null or risk_level in ('none', 'watch', 'at_risk', 'critical')),
  risk_reasons            text[] not null default '{}',
  risk_scored_at          timestamptz,
  has_unissued_changes    boolean not null default false,
  last_issued_snapshot    jsonb,
  order_manager_ids       uuid[] not null default '{}',  -- identity.users on the project team (role order_manager)
  -- Optimistic concurrency (If-Match): bumped by user edits only, not by background recomputation.
  version                 int not null default 1,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  unique (tenant_id, number)
);
create index po_tenant_status_idx on orders.purchase_orders (tenant_id, status);
create index po_project_idx on orders.purchase_orders (tenant_id, project_id);
create index po_vendor_idx on orders.purchase_orders (tenant_id, vendor_id);
create index po_vendor_org_idx on orders.purchase_orders (vendor_org_id);
create index po_client_org_idx on orders.purchase_orders (client_org_id);
create index po_release_by_idx on orders.purchase_orders (tenant_id, release_by_date);
create index po_search_trgm on orders.purchase_orders
  using gin ((number || ' ' || vendor_name || ' ' || coalesce(project_name, '') || ' ' || coalesce(project_number, '')) gin_trgm_ops);

-- ---------------------------------------------------------------------------------------------
-- po_lines
-- ---------------------------------------------------------------------------------------------
create table orders.po_lines (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null,
  po_id          uuid not null references orders.purchase_orders(id) on delete cascade,
  quote_line_id  uuid,
  spec_id        uuid,
  code           text not null,
  name           text not null,
  description    text,
  category       text,
  vendor_sku     text,
  finish         text,
  dimensions     text,
  location_name  text,
  quantity       numeric(14,4) not null check (quantity > 0),
  unit_cost      numeric(14,4) not null default 0 check (unit_cost >= 0),
  extended       numeric(14,2) not null default 0,
  received_qty   numeric(14,4) not null default 0 check (received_qty >= 0),
  sort           int not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index po_lines_po_idx on orders.po_lines (po_id, sort);
create index po_lines_quote_line_idx on orders.po_lines (tenant_id, quote_line_id);

-- ---------------------------------------------------------------------------------------------
-- po_revisions (revision 0 = the original issue)
-- ---------------------------------------------------------------------------------------------
create table orders.po_revisions (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null,
  po_id           uuid not null references orders.purchase_orders(id) on delete cascade,
  revision        int not null,
  changes         jsonb not null default '[]',   -- [{field, lineCode?, from, to}]
  document_id     uuid,
  message         text,
  issued_at       timestamptz not null default now(),
  issued_by_name  text,
  unique (po_id, revision)
);

-- ---------------------------------------------------------------------------------------------
-- pre_order_requirements
-- ---------------------------------------------------------------------------------------------
create table orders.pre_order_requirements (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null,
  po_id            uuid not null references orders.purchase_orders(id) on delete cascade,
  kind             text not null check (kind in ('order_acknowledgement', 'deposit', 'shop_drawing_approval',
                                                 'finish_sample_approval', 'cfa', 'credit_approval', 'other')),
  label            text not null,
  status           text not null default 'pending' check (status in ('pending', 'submitted', 'approved', 'rejected', 'waived')),
  party            text not null check (party in ('internal', 'vendor', 'client')),
  due_date         date,
  document_id      uuid,
  submitted_at     timestamptz,
  decided_at       timestamptz,
  decided_by_name  text,
  note             text,
  sort             int not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index req_po_idx on orders.pre_order_requirements (po_id, sort);
create index req_tenant_status_idx on orders.pre_order_requirements (tenant_id, status, kind);

-- ---------------------------------------------------------------------------------------------
-- shipments & allocations
-- ---------------------------------------------------------------------------------------------
create table orders.shipments (
  id                              uuid primary key default gen_random_uuid(),
  tenant_id                       uuid not null,
  po_id                           uuid not null references orders.purchase_orders(id) on delete cascade,
  project_id                      uuid not null,
  label                           text not null,
  note                            text,
  status                          text not null default 'planned'
                                  check (status in ('planned', 'confirmed', 'in_production', 'ready', 'shipped',
                                                    'in_transit', 'delivered', 'exception')),
  requested_delivery_date         date,
  estimated_ship_date             date,
  original_ship_date              date,
  actual_ship_date                date,
  estimated_delivery_date         date,
  delivered_at                    timestamptz,
  origin                          text check (origin is null or origin in ('domestic', 'international')),
  origin_location                 text,
  carrier                         text,
  tracking_number                 text,
  tracking_url                    text,
  tracking_status                 text,
  tracking_events                 jsonb not null default '[]',
  tracking_checked_at             timestamptz,
  ship_method                     text,
  destination                     text not null default 'site' check (destination in ('site', 'warehouse')),
  storage_location_id             uuid,
  ship_date_changes               int not null default 0,
  ship_date_slips                 int not null default 0,   -- changes that moved the ship date later
  last_confirmed_at               timestamptz,
  last_confirmation_requested_at  timestamptz,
  last_tracking_requested_at      timestamptz,
  escalation                      text not null default 'none' check (escalation in ('none', 'watch', 'at_risk', 'critical')),
  escalation_reasons              text[] not null default '{}',
  risk_score                      int check (risk_score is null or (risk_score >= 0 and risk_score <= 100)),
  risk_level                      text check (risk_level is null or risk_level in ('none', 'watch', 'at_risk', 'critical')),
  risk_reasons                    text[] not null default '{}',
  risk_scored_at                  timestamptz,
  created_at                      timestamptz not null default now(),
  updated_at                      timestamptz not null default now(),
  unique (po_id, label)
);
create index shipments_tenant_status_idx on orders.shipments (tenant_id, status);
create index shipments_ship_date_idx on orders.shipments (tenant_id, estimated_ship_date);
create index shipments_project_idx on orders.shipments (tenant_id, project_id);

create table orders.shipment_lines (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null,
  shipment_id  uuid not null references orders.shipments(id) on delete cascade,
  po_line_id   uuid not null references orders.po_lines(id) on delete cascade,
  quantity     numeric(14,4) not null check (quantity > 0),
  unique (shipment_id, po_line_id)
);
create index shipment_lines_line_idx on orders.shipment_lines (po_line_id);

create table orders.ship_date_confirmations (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null,
  shipment_id        uuid not null references orders.shipments(id) on delete cascade,
  requested_at       timestamptz not null default now(),
  responded_at       timestamptz,
  response           text check (response is null or response in ('on_track', 'changed')),
  previous_date      date,
  new_date           date,
  note               text,
  channel            text not null default 'portal' check (channel in ('portal', 'email', 'internal')),
  responded_by_name  text
);
create index sdc_shipment_idx on orders.ship_date_confirmations (shipment_id, requested_at desc);

-- ---------------------------------------------------------------------------------------------
-- delivery recipients (po_id null = every PO on the project)
-- ---------------------------------------------------------------------------------------------
create table orders.delivery_recipients (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  project_id  uuid not null,
  po_id       uuid references orders.purchase_orders(id) on delete cascade,
  name        text not null,
  email       text,
  phone       text,
  created_at  timestamptz not null default now()
);
create index recipients_project_idx on orders.delivery_recipients (tenant_id, project_id);

-- ---------------------------------------------------------------------------------------------
-- storage, receiving
-- ---------------------------------------------------------------------------------------------
create table orders.storage_locations (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null,
  project_id     uuid,                -- null = tenant-wide warehouse
  client_org_id  uuid,                -- copied from the project so owners can see on-site locations
  name           text not null,
  kind           text not null check (kind in ('warehouse', 'on_site', 'staging')),
  address        jsonb not null default '{}',
  notes          text,
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index storage_locations_project_idx on orders.storage_locations (tenant_id, project_id);

create table orders.receipts (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null,
  shipment_id          uuid not null references orders.shipments(id) on delete cascade,
  po_id                uuid not null references orders.purchase_orders(id) on delete cascade,
  received_at          timestamptz not null,
  received_by_name     text,
  storage_location_id  uuid references orders.storage_locations(id) on delete set null,
  condition            text not null check (condition in ('good', 'damaged', 'partial')),
  notes                text,
  photo_document_ids   uuid[] not null default '{}',
  created_at           timestamptz not null default now()
);
create index receipts_shipment_idx on orders.receipts (shipment_id);

create table orders.receipt_lines (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null,
  receipt_id         uuid not null references orders.receipts(id) on delete cascade,
  po_line_id         uuid not null references orders.po_lines(id) on delete cascade,
  quantity_received  numeric(14,4) not null check (quantity_received >= 0),
  quantity_damaged   numeric(14,4) not null default 0 check (quantity_damaged >= 0),
  check (quantity_damaged <= quantity_received)
);
create index receipt_lines_receipt_idx on orders.receipt_lines (receipt_id);

create table orders.storage_items (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null,
  project_id           uuid not null,
  client_org_id        uuid,
  po_id                uuid not null references orders.purchase_orders(id) on delete cascade,
  po_line_id           uuid not null references orders.po_lines(id) on delete cascade,
  storage_location_id  uuid references orders.storage_locations(id) on delete set null,
  quantity             numeric(14,4) not null check (quantity > 0),
  status               text not null default 'stored' check (status in ('in_transit', 'stored', 'staged', 'installed', 'damaged')),
  area_note            text,
  updated_by_name      text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index storage_items_project_idx on orders.storage_items (tenant_id, project_id, status);
create index storage_items_location_idx on orders.storage_items (storage_location_id);

-- ---------------------------------------------------------------------------------------------
-- claims
-- ---------------------------------------------------------------------------------------------
create table orders.claims (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null,
  project_id          uuid not null,
  po_id               uuid references orders.purchase_orders(id) on delete set null,
  shipment_id         uuid references orders.shipments(id) on delete set null,
  receipt_id          uuid references orders.receipts(id) on delete set null,
  vendor_id           uuid,
  vendor_org_id       uuid,
  client_org_id       uuid,
  number              text not null,
  type                text not null check (type in ('damage', 'shortage', 'wrong_item', 'defect', 'concealed_damage', 'other')),
  status              text not null default 'open'
                      check (status in ('open', 'submitted_to_vendor', 'vendor_acknowledged', 'replacement_ordered',
                                        'credited', 'resolved', 'rejected')),
  description         text not null,
  resolution          text,
  credit_amount       numeric(14,2),
  reported_by_name    text,
  reported_by_actor   text not null default 'internal' check (reported_by_actor in ('internal', 'client', 'vendor')),
  reported_at         timestamptz not null default now(),
  resolved_at         timestamptz,
  photo_document_ids  uuid[] not null default '{}',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (tenant_id, number)
);
create index claims_tenant_status_idx on orders.claims (tenant_id, status);
create index claims_project_idx on orders.claims (tenant_id, project_id);
create index claims_vendor_org_idx on orders.claims (vendor_org_id);
create index claims_client_org_idx on orders.claims (client_org_id);

create table orders.claim_items (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  claim_id    uuid not null references orders.claims(id) on delete cascade,
  po_line_id  uuid references orders.po_lines(id) on delete set null,
  quantity    numeric(14,4) not null default 1 check (quantity > 0),
  note        text
);
create index claim_items_claim_idx on orders.claim_items (claim_id);

-- ---------------------------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['purchase_orders', 'po_lines', 'po_revisions', 'pre_order_requirements', 'shipments',
    'shipment_lines', 'ship_date_confirmations', 'delivery_recipients', 'storage_locations', 'receipts',
    'receipt_lines', 'storage_items', 'claims', 'claim_items']
  loop
    execute format('alter table orders.%I enable row level security', t);
    execute format('alter table orders.%I force row level security', t);
    execute format('create policy tenant_isolation on orders.%I for all
      using (platform.tenant_ok(tenant_id)) with check (platform.tenant_ok(tenant_id))', t);
  end loop;
end $$;

-- Parent-visibility helpers: security invoker, so the caller's own purchase_orders / shipments / claims
-- policies decide whether the parent is visible.
create or replace function orders.po_visible(p uuid) returns boolean
  language sql stable security invoker as $$ select exists (select 1 from orders.purchase_orders where id = p) $$;
create or replace function orders.shipment_visible(s uuid) returns boolean
  language sql stable security invoker as $$ select exists (select 1 from orders.shipments where id = s) $$;
create or replace function orders.claim_visible(c uuid) returns boolean
  language sql stable security invoker as $$ select exists (select 1 from orders.claims where id = c) $$;

-- Vendors -------------------------------------------------------------------------------------
create policy vendor_read on orders.purchase_orders for select
  using (platform.vendor_ok(tenant_id, vendor_org_id) and status <> 'draft');
-- No vendor/client UPDATE on purchase_orders: status, acknowledgement and escalation are derived by the
-- API (validated under the caller's RLS, then written with a service context in the same transaction).

create policy vendor_read on orders.po_lines for select
  using (orders.vendor_ok(tenant_id) and orders.po_visible(po_id));
create policy vendor_read on orders.po_revisions for select
  using (orders.vendor_ok(tenant_id) and orders.po_visible(po_id));
create policy vendor_read on orders.pre_order_requirements for select
  using (orders.vendor_ok(tenant_id) and orders.po_visible(po_id));
create policy vendor_update on orders.pre_order_requirements for update
  using (orders.vendor_ok(tenant_id) and orders.po_visible(po_id) and party = 'vendor')
  with check (orders.vendor_ok(tenant_id) and orders.po_visible(po_id) and party = 'vendor');
create policy vendor_read on orders.shipments for select
  using (orders.vendor_ok(tenant_id) and orders.po_visible(po_id));
create policy vendor_update on orders.shipments for update
  using (orders.vendor_ok(tenant_id) and orders.po_visible(po_id))
  with check (orders.vendor_ok(tenant_id) and orders.po_visible(po_id));
create policy vendor_read on orders.shipment_lines for select
  using (orders.vendor_ok(tenant_id) and orders.shipment_visible(shipment_id));
create policy vendor_read on orders.ship_date_confirmations for select
  using (orders.vendor_ok(tenant_id) and orders.shipment_visible(shipment_id));
create policy vendor_insert on orders.ship_date_confirmations for insert
  with check (orders.vendor_ok(tenant_id) and orders.shipment_visible(shipment_id));
create policy vendor_update on orders.ship_date_confirmations for update
  using (orders.vendor_ok(tenant_id) and orders.shipment_visible(shipment_id))
  with check (orders.vendor_ok(tenant_id) and orders.shipment_visible(shipment_id));
create policy vendor_read on orders.claims for select
  using (platform.vendor_ok(tenant_id, vendor_org_id)
         and status <> 'open');  -- a claim reaches the vendor once it is submitted to them
create policy vendor_update on orders.claims for update
  using (platform.vendor_ok(tenant_id, vendor_org_id) and status <> 'open')
  with check (platform.vendor_ok(tenant_id, vendor_org_id));
create policy vendor_read on orders.claim_items for select
  using (orders.vendor_ok(tenant_id) and orders.claim_visible(claim_id));

-- Clients (hotel owners) ----------------------------------------------------------------------
create policy client_read on orders.purchase_orders for select
  using (platform.client_ok(tenant_id, client_org_id) and status <> 'draft');
create policy client_read on orders.po_lines for select
  using (orders.client_ok(tenant_id) and orders.po_visible(po_id));
create policy client_read on orders.pre_order_requirements for select
  using (orders.client_ok(tenant_id) and orders.po_visible(po_id));
create policy client_update on orders.pre_order_requirements for update
  using (orders.client_ok(tenant_id) and orders.po_visible(po_id) and party = 'client')
  with check (orders.client_ok(tenant_id) and orders.po_visible(po_id) and party = 'client');
create policy client_read on orders.shipments for select
  using (orders.client_ok(tenant_id) and orders.po_visible(po_id));
create policy client_read on orders.shipment_lines for select
  using (orders.client_ok(tenant_id) and orders.shipment_visible(shipment_id));
create policy client_read on orders.storage_items for select
  using (platform.client_ok(tenant_id, client_org_id));
create policy client_update on orders.storage_items for update
  using (platform.client_ok(tenant_id, client_org_id))
  with check (platform.client_ok(tenant_id, client_org_id));
create or replace function orders.client_has_items_at(l uuid) returns boolean
  language sql stable security invoker as $$
  select exists (select 1 from orders.storage_items where storage_location_id = l) $$;
create policy client_read on orders.storage_locations for select
  using (platform.client_ok(tenant_id, client_org_id) or (orders.client_ok(tenant_id) and orders.client_has_items_at(id)));
create policy client_read on orders.claims for select
  using (platform.client_ok(tenant_id, client_org_id));
create policy client_insert on orders.claims for insert
  with check (platform.client_ok(tenant_id, client_org_id) and reported_by_actor = 'client'
              and status = 'open');
create policy client_read on orders.claim_items for select
  using (orders.client_ok(tenant_id) and orders.claim_visible(claim_id));
create policy client_insert on orders.claim_items for insert
  with check (orders.client_ok(tenant_id) and orders.claim_visible(claim_id));

-- ---------------------------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------------------------
create trigger po_touch before update on orders.purchase_orders for each row execute function platform.touch_updated_at();
create trigger po_lines_touch before update on orders.po_lines for each row execute function platform.touch_updated_at();
create trigger req_touch before update on orders.pre_order_requirements for each row execute function platform.touch_updated_at();
create trigger shipments_touch before update on orders.shipments for each row execute function platform.touch_updated_at();
create trigger storage_locations_touch before update on orders.storage_locations for each row execute function platform.touch_updated_at();
create trigger storage_items_touch before update on orders.storage_items for each row execute function platform.touch_updated_at();
create trigger claims_touch before update on orders.claims for each row execute function platform.touch_updated_at();

create trigger audit after insert or update or delete on orders.purchase_orders
  for each row execute function platform.audit('purchase_order', 'project_id', 'project');
create trigger audit after insert or update or delete on orders.po_lines
  for each row execute function platform.audit('po_line', 'po_id', 'purchase_order');
create trigger audit after insert or update or delete on orders.pre_order_requirements
  for each row execute function platform.audit('pre_order_requirement', 'po_id', 'purchase_order');
create trigger audit after insert or update or delete on orders.shipments
  for each row execute function platform.audit('shipment', 'po_id', 'purchase_order');
create trigger audit after insert or update or delete on orders.claims
  for each row execute function platform.audit('claim', 'po_id', 'purchase_order');
create trigger audit after insert or update or delete on orders.storage_items
  for each row execute function platform.audit('storage_item', 'po_id', 'purchase_order');
