-- Finance: native AR (client invoices + payments), AP (vendor bills + bill payments), and the
-- QuickBooks Online integration (connection, entity map, sync log).
--
-- Cross-service references (no foreign keys across schemas):
--   project_id      -> projects.projects (projects service)
--   client_org_id   -> identity.organizations (identity service)
--   quote_id        -> quoting.quotes (quoting service)
--   quote_line_id   -> quoting.quote_lines (quoting service)
--   po_id           -> orders.purchase_orders (orders service)
--   vendor_id       -> catalog.vendors (catalog service)
--   document_id     -> documents.documents (documents service)
--
-- Row-level security:
--   * platform.tenant_ok(tenant_id): the tenant's own staff, services acting for the tenant, and system
--     jobs — never vendor or client actors.
--   * Client (owner) actors read their own organization's non-draft invoices, those invoices' lines and
--     payments. They never see vendor bills or anything QuickBooks-related.

create schema if not exists finance;

-- ---------------------------------------------------------------------------------------------
-- Invoices (AR)
-- ---------------------------------------------------------------------------------------------
create table finance.invoices (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null,
  project_id       uuid not null,
  project_number   text not null default '',
  project_name     text not null default '',
  client_org_id    uuid not null,
  client_name      text not null,
  quote_id         uuid,
  quote_number     text,
  number           text not null,
  kind             text not null check (kind in ('deposit', 'progress', 'final', 'credit_memo')),
  status           text not null default 'draft'
                   check (status in ('draft', 'sent', 'partially_paid', 'paid', 'overdue', 'void')),
  issue_date       date not null default current_date,
  due_date         date not null default current_date,
  terms            text not null default 'Due on receipt',
  po_reference     text,
  notes            text,
  subtotal         numeric(14,2) not null default 0,
  tax_rate         numeric(7,3) not null default 0 check (tax_rate >= 0),
  tax              numeric(14,2) not null default 0,
  total            numeric(14,2) not null default 0,
  amount_paid      numeric(14,2) not null default 0 check (amount_paid >= 0),
  balance          numeric(14,2) not null default 0,
  document_id      uuid,
  sent_at          timestamptz,
  voided_at        timestamptz,
  qbo_id           text,
  qbo_sync_status  text not null default 'pending'
                   check (qbo_sync_status in ('not_synced', 'pending', 'synced', 'error')),
  qbo_synced_at    timestamptz,
  qbo_error        text,
  created_by_name  text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (tenant_id, number),
  check (due_date >= issue_date)
);
create index invoices_project_idx on finance.invoices (tenant_id, project_id);
create index invoices_status_idx on finance.invoices (tenant_id, status, due_date);
create index invoices_client_idx on finance.invoices (tenant_id, client_org_id);
create index invoices_quote_idx on finance.invoices (tenant_id, quote_id) where quote_id is not null;
create index invoices_sync_idx on finance.invoices (tenant_id, qbo_sync_status) where qbo_sync_status in ('pending', 'error');
create index invoices_search_trgm on finance.invoices
  using gin ((number || ' ' || client_name || ' ' || project_name || ' ' || project_number || ' ' || coalesce(po_reference, '')) gin_trgm_ops);

alter table finance.invoices enable row level security;
alter table finance.invoices force row level security;
create policy tenant_isolation on finance.invoices for all
  using (platform.tenant_ok(tenant_id)) with check (platform.tenant_ok(tenant_id));
create policy client_read on finance.invoices for select
  using (platform.client_ok(tenant_id, client_org_id) and status <> 'draft');

create trigger invoices_touch before update on finance.invoices
  for each row execute function platform.touch_updated_at();
create trigger audit after insert or update or delete on finance.invoices
  for each row execute function platform.audit('invoice', 'project_id', 'project');

create table finance.invoice_lines (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null,
  invoice_id     uuid not null references finance.invoices(id) on delete cascade,
  description    text not null,
  quantity       numeric(14,4) not null default 1,
  unit_price     numeric(14,4) not null default 0,
  amount         numeric(14,2) not null default 0,
  quote_line_id  uuid,
  sort           int not null default 0
);
create index invoice_lines_invoice_idx on finance.invoice_lines (invoice_id, sort);

alter table finance.invoice_lines enable row level security;
alter table finance.invoice_lines force row level security;
create policy tenant_isolation on finance.invoice_lines for all
  using (platform.tenant_ok(tenant_id)) with check (platform.tenant_ok(tenant_id));
create policy client_read on finance.invoice_lines for select
  using (exists (
    select 1 from finance.invoices i
    where i.id = invoice_id and platform.client_ok(i.tenant_id, i.client_org_id) and i.status <> 'draft'));

create trigger audit after insert or update or delete on finance.invoice_lines
  for each row execute function platform.audit('invoice_line', 'invoice_id', 'invoice');

create table finance.payments (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null,
  invoice_id   uuid not null references finance.invoices(id) on delete restrict,
  received_at  date not null,
  amount       numeric(14,2) not null check (amount > 0),
  method       text not null check (method in ('ach', 'wire', 'check', 'card', 'other')),
  reference    text,
  notes        text,
  source       text not null default 'manual' check (source in ('manual', 'qbo')),
  qbo_id       text,
  qbo_error    text,
  created_by_name text,
  created_at   timestamptz not null default now()
);
create index payments_invoice_idx on finance.payments (invoice_id);
create index payments_tenant_date_idx on finance.payments (tenant_id, received_at);
-- One local payment per QBO payment applied to an invoice (pull is idempotent).
create unique index payments_qbo_uq on finance.payments (tenant_id, invoice_id, qbo_id) where qbo_id is not null;

alter table finance.payments enable row level security;
alter table finance.payments force row level security;
create policy tenant_isolation on finance.payments for all
  using (platform.tenant_ok(tenant_id)) with check (platform.tenant_ok(tenant_id));
create policy client_read on finance.payments for select
  using (exists (
    select 1 from finance.invoices i
    where i.id = invoice_id and platform.client_ok(i.tenant_id, i.client_org_id) and i.status <> 'draft'));

create trigger audit after insert or update or delete on finance.payments
  for each row execute function platform.audit('payment', 'invoice_id', 'invoice');

-- ---------------------------------------------------------------------------------------------
-- Vendor bills (AP)
-- ---------------------------------------------------------------------------------------------
create table finance.vendor_bills (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null,
  project_id       uuid not null,
  po_id            uuid,
  po_number        text,
  vendor_id        uuid not null,
  vendor_name      text not null,
  number           text not null,
  kind             text not null check (kind in ('deposit', 'balance', 'freight', 'other')),
  status           text not null default 'open'
                   check (status in ('open', 'scheduled', 'partially_paid', 'paid', 'void')),
  bill_date        date not null default current_date,
  due_date         date not null default current_date,
  amount           numeric(14,2) not null check (amount >= 0),
  amount_paid      numeric(14,2) not null default 0 check (amount_paid >= 0),
  balance          numeric(14,2) not null default 0,
  document_id      uuid,
  notes            text,
  qbo_id           text,
  qbo_sync_status  text not null default 'pending'
                   check (qbo_sync_status in ('not_synced', 'pending', 'synced', 'error')),
  qbo_synced_at    timestamptz,
  qbo_error        text,
  created_by_name  text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index vendor_bills_project_idx on finance.vendor_bills (tenant_id, project_id);
create index vendor_bills_vendor_idx on finance.vendor_bills (tenant_id, vendor_id);
create index vendor_bills_po_idx on finance.vendor_bills (tenant_id, po_id) where po_id is not null;
create index vendor_bills_due_idx on finance.vendor_bills (tenant_id, status, due_date);
create index vendor_bills_sync_idx on finance.vendor_bills (tenant_id, qbo_sync_status) where qbo_sync_status in ('pending', 'error');
-- The automatic PO deposit bill is created at most once per PO.
create unique index vendor_bills_po_deposit_uq on finance.vendor_bills (tenant_id, po_id)
  where kind = 'deposit' and po_id is not null and status <> 'void';

alter table finance.vendor_bills enable row level security;
alter table finance.vendor_bills force row level security;
create policy tenant_isolation on finance.vendor_bills for all
  using (platform.tenant_ok(tenant_id)) with check (platform.tenant_ok(tenant_id));

create trigger vendor_bills_touch before update on finance.vendor_bills
  for each row execute function platform.touch_updated_at();
create trigger audit after insert or update or delete on finance.vendor_bills
  for each row execute function platform.audit('vendor_bill', 'project_id', 'project');

create table finance.bill_payments (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  bill_id     uuid not null references finance.vendor_bills(id) on delete restrict,
  paid_at     date not null,
  amount      numeric(14,2) not null check (amount > 0),
  method      text not null check (method in ('ach', 'wire', 'check', 'card', 'other')),
  reference   text,
  qbo_id      text,
  qbo_error   text,
  created_by_name text,
  created_at  timestamptz not null default now()
);
create index bill_payments_bill_idx on finance.bill_payments (bill_id);
create index bill_payments_tenant_date_idx on finance.bill_payments (tenant_id, paid_at);

alter table finance.bill_payments enable row level security;
alter table finance.bill_payments force row level security;
create policy tenant_isolation on finance.bill_payments for all
  using (platform.tenant_ok(tenant_id)) with check (platform.tenant_ok(tenant_id));

create trigger audit after insert or update or delete on finance.bill_payments
  for each row execute function platform.audit('bill_payment', 'bill_id', 'vendor_bill');

-- ---------------------------------------------------------------------------------------------
-- QuickBooks Online
-- ---------------------------------------------------------------------------------------------
create table finance.qbo_connections (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null unique,
  realm_id            text not null,
  environment         text not null check (environment in ('sandbox', 'production', 'simulated')),
  -- AES-256-GCM ciphertext (iv.tag.data, base64url) — never store tokens in clear text.
  access_token_enc    text,
  refresh_token_enc   text,
  access_expires_at   timestamptz,
  refresh_expires_at  timestamptz,
  status              text not null default 'connected' check (status in ('connected', 'expired', 'disconnected')),
  connected_by_name   text,
  connected_at        timestamptz not null default now(),
  last_sync_at        timestamptz,
  last_error          text,
  sync_lock_until     timestamptz,
  settings            jsonb not null default '{"syncPayments": true}',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

alter table finance.qbo_connections enable row level security;
alter table finance.qbo_connections force row level security;
create policy tenant_isolation on finance.qbo_connections for all
  using (platform.tenant_ok(tenant_id)) with check (platform.tenant_ok(tenant_id));

create trigger qbo_connections_touch before update on finance.qbo_connections
  for each row execute function platform.touch_updated_at();

create table finance.qbo_entity_map (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null,
  entity_type  text not null check (entity_type in ('customer', 'vendor', 'invoice', 'bill', 'payment', 'bill_payment')),
  local_id     uuid not null,
  qbo_id       text not null,
  sync_token   text,
  updated_at   timestamptz not null default now(),
  unique (tenant_id, entity_type, local_id)
);
create index qbo_entity_map_qbo_idx on finance.qbo_entity_map (tenant_id, entity_type, qbo_id);

alter table finance.qbo_entity_map enable row level security;
alter table finance.qbo_entity_map force row level security;
create policy tenant_isolation on finance.qbo_entity_map for all
  using (platform.tenant_ok(tenant_id)) with check (platform.tenant_ok(tenant_id));

create table finance.qbo_sync_log (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null,
  entity_type  text not null,
  local_id     uuid,
  direction    text not null check (direction in ('push', 'pull')),
  status       text not null check (status in ('success', 'error')),
  qbo_id       text,
  message      text,
  created_at   timestamptz not null default now()
);
create index qbo_sync_log_tenant_idx on finance.qbo_sync_log (tenant_id, created_at desc);

alter table finance.qbo_sync_log enable row level security;
alter table finance.qbo_sync_log force row level security;
create policy tenant_isolation on finance.qbo_sync_log for all
  using (platform.tenant_ok(tenant_id)) with check (platform.tenant_ok(tenant_id));
