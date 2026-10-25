-- Identity: organizations, users, memberships and how organizations relate to tenants.
--
-- A tenant is a procurement firm (organizations.type = 'procurement_firm'); tenant_id == that org's id.
-- Vendor and client organizations are global (a vendor can serve many procurement firms — the HubSups
-- network) and are connected to a tenant through org_relationships.

create schema if not exists identity;

create table identity.organizations (
  id          uuid primary key default gen_random_uuid(),
  type        text not null check (type in ('procurement_firm', 'vendor', 'client', 'platform')),
  name        text not null,
  legal_name  text,
  slug        text not null unique,
  website     text,
  phone       text,
  email       text,
  address     jsonb not null default '{}',
  logo_url    text,
  settings    jsonb not null default '{}',
  status      text not null default 'active' check (status in ('active', 'suspended', 'archived')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index organizations_type_idx on identity.organizations (type);
create index organizations_name_trgm on identity.organizations using gin (name gin_trgm_ops);

create table identity.org_relationships (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references identity.organizations(id) on delete cascade,
  org_id      uuid not null references identity.organizations(id) on delete cascade,
  kind        text not null check (kind in ('vendor', 'client')),
  status      text not null default 'active' check (status in ('invited', 'active', 'inactive')),
  external_ref text,
  created_at  timestamptz not null default now(),
  unique (tenant_id, org_id, kind)
);
create index org_rel_org_idx on identity.org_relationships (org_id);

create table identity.users (
  id           uuid primary key default gen_random_uuid(),
  email        text not null,
  name         text not null,
  title        text,
  phone        text,
  avatar_url   text,
  cognito_sub  text unique,
  status       text not null default 'active' check (status in ('invited', 'active', 'disabled')),
  last_login_at timestamptz,
  preferences  jsonb not null default '{}',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create unique index users_email_uq on identity.users (lower(email));

create table identity.memberships (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references identity.users(id) on delete cascade,
  org_id     uuid not null references identity.organizations(id) on delete cascade,
  roles      text[] not null default '{}',
  is_default boolean not null default false,
  status     text not null default 'active' check (status in ('invited', 'active', 'disabled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, org_id)
);
create index memberships_org_idx on identity.memberships (org_id);

create table identity.refresh_tokens (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references identity.users(id) on delete cascade,
  org_id      uuid not null,
  tenant_id   uuid not null,
  token_hash  text not null unique,
  expires_at  timestamptz not null,
  revoked_at  timestamptz,
  created_at  timestamptz not null default now(),
  user_agent  text
);

create table identity.invitations (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  org_id      uuid not null references identity.organizations(id) on delete cascade,
  email       text not null,
  name        text,
  roles       text[] not null default '{}',
  token_hash  text not null unique,
  invited_by  uuid,
  expires_at  timestamptz not null,
  accepted_at timestamptz,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------------------------
-- Row-level security. Login/token issuance runs as `system`; request handlers run as the caller.
-- An org is visible to a tenant if it IS the tenant, is related to it, or is the caller's own org.
-- ---------------------------------------------------------------------------------------------
create or replace function identity.org_visible(o uuid) returns boolean
  language sql stable security definer set search_path = identity, platform as $$
  select platform.is_system()
      or o = platform.tenant_id()
      or o = platform.org_id()
      or exists (select 1 from identity.org_relationships r
                 where r.tenant_id = platform.tenant_id() and r.org_id = o)
$$;

alter table identity.organizations enable row level security;
alter table identity.organizations force row level security;
create policy org_read on identity.organizations for select using (identity.org_visible(id));
create policy org_write on identity.organizations for all
  using (platform.is_system() or id = platform.tenant_id() or id = platform.org_id()
         or exists (select 1 from identity.org_relationships r where r.tenant_id = platform.tenant_id() and r.org_id = id))
  with check (true);

alter table identity.org_relationships enable row level security;
alter table identity.org_relationships force row level security;
create policy rel_tenant on identity.org_relationships for all
  using (platform.tenant_ok(tenant_id) or org_id = platform.org_id())
  with check (platform.tenant_ok(tenant_id));

alter table identity.memberships enable row level security;
alter table identity.memberships force row level security;
create policy mem_visible on identity.memberships for all
  using (identity.org_visible(org_id))
  with check (identity.org_visible(org_id));

alter table identity.users enable row level security;
alter table identity.users force row level security;
create policy users_visible on identity.users for select
  using (platform.is_system() or id = platform.user_id()
         or exists (select 1 from identity.memberships m where m.user_id = users.id and identity.org_visible(m.org_id)));
create policy users_write on identity.users for all
  using (platform.is_system() or id = platform.user_id()
         or exists (select 1 from identity.memberships m where m.user_id = users.id and identity.org_visible(m.org_id)))
  with check (true);

alter table identity.refresh_tokens enable row level security;
alter table identity.refresh_tokens force row level security;
create policy rt_system on identity.refresh_tokens for all using (platform.is_system() or user_id = platform.user_id());

alter table identity.invitations enable row level security;
alter table identity.invitations force row level security;
create policy inv_tenant on identity.invitations for all using (platform.tenant_ok(tenant_id)) with check (platform.tenant_ok(tenant_id));

create trigger organizations_touch before update on identity.organizations for each row execute function platform.touch_updated_at();
create trigger users_touch before update on identity.users for each row execute function platform.touch_updated_at();
create trigger memberships_touch before update on identity.memberships for each row execute function platform.touch_updated_at();

create trigger audit after insert or update or delete on identity.memberships
  for each row execute function platform.audit('membership', 'org_id', 'organization');
