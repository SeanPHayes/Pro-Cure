-- Catalog: the shared intelligence layer (brands, brand-standard packages and items, the network vendor
-- directory, the product catalog) plus tenant-private vendor relationships (terms, lead times, ratings).
--
-- Global tables have no tenant_id and are readable by every authenticated actor; writes are limited to
-- contributors (the API checks catalog:contribute / catalog:curate) and, at the row level, to the
-- contributing tenant or a platform curator. Commercial data (vendor_profiles) is tenant-scoped and
-- never visible to vendor or client actors, even within their token's tenant.

create schema if not exists catalog;

-- Helper: actor is a Pro-Cure operator (catalog curation) or a background process.
create or replace function catalog.is_curator() returns boolean
  language sql stable as $$ select platform.is_system() or platform.actor_type() = 'platform' $$;

-- Helper: actor works for a procurement firm (or is a service / system / platform operator), i.e. not
-- an external vendor or client portal user.
create or replace function catalog.is_internal_actor() returns boolean
  language sql stable as $$ select platform.actor_type() not in ('vendor', 'client', 'anonymous') $$;

-- ---------------------------------------------------------------------------------------------
-- Brands
-- ---------------------------------------------------------------------------------------------
create table catalog.brands (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  parent_company text,
  segment        text,
  logo_url       text,
  created_by_tenant_id uuid, -- identity.organizations (procurement firm); null = platform
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create unique index brands_name_uq on catalog.brands (lower(name));
create index brands_name_trgm on catalog.brands using gin (name gin_trgm_ops);

alter table catalog.brands enable row level security;
alter table catalog.brands force row level security;
create policy brands_read on catalog.brands for select using (true);
create policy brands_insert on catalog.brands for insert
  with check (catalog.is_curator() or (catalog.is_internal_actor() and created_by_tenant_id = platform.tenant_id()));
create policy brands_update on catalog.brands for update
  using (catalog.is_curator() or (catalog.is_internal_actor() and created_by_tenant_id = platform.tenant_id()))
  with check (true);
create policy brands_delete on catalog.brands for delete using (catalog.is_curator());

create trigger brands_touch before update on catalog.brands for each row execute function platform.touch_updated_at();
create trigger audit after insert or update or delete on catalog.brands
  for each row execute function platform.audit('brand');

-- ---------------------------------------------------------------------------------------------
-- Brand standards (FF&E standard packages) and their items
-- ---------------------------------------------------------------------------------------------
create table catalog.brand_standards (
  id                 uuid primary key default gen_random_uuid(),
  brand_id           uuid not null references catalog.brands(id) on delete cascade,
  name               text not null,
  version            text not null default '1',
  effective_date     date,
  source_document_id uuid, -- documents.documents (documents service)
  status             text not null default 'draft'
                       check (status in ('draft', 'submitted', 'published', 'superseded')),
  contributed_by_tenant_id uuid, -- identity.organizations; null = authored by a platform curator
  notes              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  submitted_at       timestamptz,
  published_at       timestamptz,
  published_by       uuid -- identity.users
);
create unique index brand_standards_version_uq on catalog.brand_standards (brand_id, lower(name), version);
create index brand_standards_brand_idx on catalog.brand_standards (brand_id, status);
create index brand_standards_name_trgm on catalog.brand_standards using gin (name gin_trgm_ops);

alter table catalog.brand_standards enable row level security;
alter table catalog.brand_standards force row level security;
-- Published (and superseded) packages are shared intelligence; drafts belong to their contributor.
create policy standards_read on catalog.brand_standards for select
  using (status in ('published', 'superseded')
         or catalog.is_curator()
         or (catalog.is_internal_actor() and contributed_by_tenant_id = platform.tenant_id()));
create policy standards_insert on catalog.brand_standards for insert
  with check (catalog.is_curator()
              or (catalog.is_internal_actor() and contributed_by_tenant_id = platform.tenant_id()));
create policy standards_update on catalog.brand_standards for update
  using (catalog.is_curator()
         or (catalog.is_internal_actor() and contributed_by_tenant_id = platform.tenant_id()))
  with check (catalog.is_curator()
              or (catalog.is_internal_actor() and contributed_by_tenant_id = platform.tenant_id()));
create policy standards_delete on catalog.brand_standards for delete
  using (catalog.is_curator()
         or (catalog.is_internal_actor() and contributed_by_tenant_id = platform.tenant_id() and status = 'draft'));

create trigger brand_standards_touch before update on catalog.brand_standards
  for each row execute function platform.touch_updated_at();
create trigger audit after insert or update or delete on catalog.brand_standards
  for each row execute function platform.audit('brand_standard', 'brand_id', 'brand');

create table catalog.brand_standard_items (
  id              uuid primary key default gen_random_uuid(),
  standard_id     uuid not null references catalog.brand_standards(id) on delete cascade,
  code            text not null,
  area            text not null default 'General',
  category        text not null default 'other' check (category in (
                    'casegoods', 'seating', 'soft_seating', 'tables', 'bedding', 'lighting', 'mirrors',
                    'artwork', 'window_treatments', 'carpet', 'flooring', 'wallcovering', 'millwork',
                    'plumbing', 'electronics', 'signage', 'outdoor', 'ose', 'other')),
  name            text not null,
  description     text,
  dimensions      text,
  finish          text,
  materials       text,
  attributes      jsonb not null default '{}',
  approved_vendors jsonb not null default '[]', -- [{vendorId?, name, model?}]
  quantity_basis  text,
  sort            int not null default 0,
  search          tsvector generated always as (
                    setweight(to_tsvector('english', coalesce(code, '') || ' ' || coalesce(name, '')), 'A') ||
                    setweight(to_tsvector('english', coalesce(area, '') || ' ' || coalesce(category, '')), 'B') ||
                    setweight(to_tsvector('english', coalesce(description, '') || ' ' || coalesce(finish, '') || ' ' ||
                                                     coalesce(materials, '') || ' ' || coalesce(dimensions, '')), 'C')
                  ) stored,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (standard_id, code)
);
create index brand_standard_items_std_idx on catalog.brand_standard_items (standard_id, sort, code);
create index brand_standard_items_search_idx on catalog.brand_standard_items using gin (search);
create index brand_standard_items_name_trgm on catalog.brand_standard_items using gin (name gin_trgm_ops);

alter table catalog.brand_standard_items enable row level security;
alter table catalog.brand_standard_items force row level security;
-- Items inherit visibility and writability from their package (the subquery is itself RLS-filtered).
create policy items_read on catalog.brand_standard_items for select
  using (exists (select 1 from catalog.brand_standards s where s.id = standard_id));
create policy items_write on catalog.brand_standard_items for all
  using (exists (select 1 from catalog.brand_standards s where s.id = standard_id
                   and (catalog.is_curator()
                        or (catalog.is_internal_actor() and s.contributed_by_tenant_id = platform.tenant_id()))))
  with check (exists (select 1 from catalog.brand_standards s where s.id = standard_id
                   and (catalog.is_curator()
                        or (catalog.is_internal_actor() and s.contributed_by_tenant_id = platform.tenant_id()))));

create trigger brand_standard_items_touch before update on catalog.brand_standard_items
  for each row execute function platform.touch_updated_at();
create trigger audit after insert or update or delete on catalog.brand_standard_items
  for each row execute function platform.audit('brand_standard_item', 'standard_id', 'brand_standard');

-- ---------------------------------------------------------------------------------------------
-- Network vendor directory
-- ---------------------------------------------------------------------------------------------
create table catalog.vendors (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid unique, -- identity.organizations (type vendor) when the vendor has portal users
  name           text not null,
  website        text,
  email_domains  text[] not null default '{}',
  categories     text[] not null default '{}',
  hq_city        text,
  hq_region      text,
  hq_country     text,
  description    text,
  verified       boolean not null default false,
  created_by_tenant_id uuid, -- identity.organizations; null = platform
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index vendors_name_trgm on catalog.vendors using gin (name gin_trgm_ops);
create index vendors_categories_idx on catalog.vendors using gin (categories);
create index vendors_domains_idx on catalog.vendors using gin (email_domains);

alter table catalog.vendors enable row level security;
alter table catalog.vendors force row level security;
create policy vendors_read on catalog.vendors for select using (true);
create policy vendors_insert on catalog.vendors for insert
  with check (catalog.is_curator() or (catalog.is_internal_actor() and created_by_tenant_id = platform.tenant_id()));
-- Network data can be edited by the creating tenant, a curator, or the vendor itself (its portal org).
create policy vendors_update on catalog.vendors for update
  using (catalog.is_curator()
         or (catalog.is_internal_actor() and created_by_tenant_id = platform.tenant_id())
         or (platform.actor_type() = 'vendor' and org_id = platform.org_id()))
  with check (catalog.is_curator()
              or catalog.is_internal_actor()
              or (platform.actor_type() = 'vendor' and org_id = platform.org_id()));
create policy vendors_delete on catalog.vendors for delete using (catalog.is_curator());

create trigger vendors_touch before update on catalog.vendors for each row execute function platform.touch_updated_at();
create trigger audit after insert or update or delete on catalog.vendors
  for each row execute function platform.audit('vendor');

-- ---------------------------------------------------------------------------------------------
-- Product catalog
-- ---------------------------------------------------------------------------------------------
create table catalog.products (
  id              uuid primary key default gen_random_uuid(),
  vendor_id       uuid not null references catalog.vendors(id) on delete cascade,
  sku             text not null,
  name            text not null,
  category        text not null default 'other' check (category in (
                    'casegoods', 'seating', 'soft_seating', 'tables', 'bedding', 'lighting', 'mirrors',
                    'artwork', 'window_treatments', 'carpet', 'flooring', 'wallcovering', 'millwork',
                    'plumbing', 'electronics', 'signage', 'outdoor', 'ose', 'other')),
  description     text,
  dimensions      text,
  materials       text,
  finishes        text[] not null default '{}',
  image_urls      text[] not null default '{}',
  attributes      jsonb not null default '{}',
  typical_lead_time_weeks int check (typical_lead_time_weeks is null or typical_lead_time_weeks >= 0),
  brand_standard_item_ids uuid[] not null default '{}', -- catalog.brand_standard_items this product satisfies
  status          text not null default 'active' check (status in ('active', 'discontinued')),
  created_by_tenant_id uuid,
  search          tsvector generated always as (
                    setweight(to_tsvector('english', coalesce(sku, '') || ' ' || coalesce(name, '')), 'A') ||
                    setweight(to_tsvector('english', coalesce(description, '') || ' ' || coalesce(materials, '')), 'C')
                  ) stored,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (vendor_id, sku)
);
create index products_vendor_idx on catalog.products (vendor_id);
create index products_category_idx on catalog.products (category);
create index products_bsi_idx on catalog.products using gin (brand_standard_item_ids);
create index products_search_idx on catalog.products using gin (search);
create index products_name_trgm on catalog.products using gin (name gin_trgm_ops);

alter table catalog.products enable row level security;
alter table catalog.products force row level security;
create policy products_read on catalog.products for select using (true);
create policy products_write on catalog.products for all
  using (catalog.is_internal_actor()) with check (catalog.is_internal_actor());

create trigger products_touch before update on catalog.products for each row execute function platform.touch_updated_at();
create trigger audit after insert or update or delete on catalog.products
  for each row execute function platform.audit('product', 'vendor_id', 'vendor');

-- ---------------------------------------------------------------------------------------------
-- Tenant-private vendor relationship
-- ---------------------------------------------------------------------------------------------
create table catalog.vendor_profiles (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null,
  vendor_id       uuid not null references catalog.vendors(id) on delete cascade,
  account_number  text,
  payment_terms   text,
  deposit_pct     numeric(7,3) check (deposit_pct is null or (deposit_pct >= 0 and deposit_pct <= 100)),
  lead_time_weeks int check (lead_time_weeks is null or lead_time_weeks >= 0),
  ship_method     text,
  freight_terms   text,
  origin          text check (origin is null or origin in ('domestic', 'international')),
  transit_days    int check (transit_days is null or transit_days >= 0),
  primary_contact jsonb,          -- {name, email, phone}
  contacts        jsonb not null default '[]',  -- [{name, email, phone, role}]
  rating          numeric(3,2) check (rating is null or (rating >= 0 and rating <= 5)),
  on_time_rate    numeric(5,4) check (on_time_rate is null or (on_time_rate >= 0 and on_time_rate <= 1)),
  preferred       boolean not null default false,
  notes           text,
  tags            text[] not null default '{}',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (tenant_id, vendor_id)
);
create index vendor_profiles_vendor_idx on catalog.vendor_profiles (vendor_id);

alter table catalog.vendor_profiles enable row level security;
alter table catalog.vendor_profiles force row level security;
create policy tenant_isolation on catalog.vendor_profiles for all
  using (platform.tenant_ok(tenant_id)) with check (platform.tenant_ok(tenant_id));
-- platform.tenant_ok() already excludes vendor/client actors; this restrictive policy keeps commercial
-- terms hidden from portal users even if a permissive policy is added later.
create policy internal_only on catalog.vendor_profiles as restrictive for all
  using (not platform.is_external()) with check (not platform.is_external());

create trigger vendor_profiles_touch before update on catalog.vendor_profiles
  for each row execute function platform.touch_updated_at();
create trigger audit after insert or update or delete on catalog.vendor_profiles
  for each row execute function platform.audit('vendor_profile', 'vendor_id', 'vendor');
