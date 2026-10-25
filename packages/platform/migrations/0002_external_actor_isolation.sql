-- Vendor and client tokens carry the procurement firm's tenant id (that is how they reach data shared
-- with them). The generic tenant policy must therefore NOT admit them, or an external actor could read
-- every row of the tenant. External access is granted only by explicit, narrower policies keyed on the
-- actor's own organization (vendor_org_id / client_org_id = platform.org_id()).

create or replace function platform.is_external() returns boolean
  language sql stable as $$ select platform.actor_type() in ('vendor', 'client') $$;

/** Staff / service / system access to a tenant row. External actors never pass this check. */
create or replace function platform.tenant_ok(t uuid) returns boolean
  language sql stable as $$
  select platform.is_system()
      or (t = platform.tenant_id() and platform.actor_type() in ('internal', 'service', 'platform'))
$$;

/** Building block for external-actor policies: same tenant and the row is shared with the caller's org. */
create or replace function platform.vendor_ok(t uuid, vendor_org uuid) returns boolean
  language sql stable as $$
  select platform.actor_type() = 'vendor' and t = platform.tenant_id() and vendor_org = platform.org_id()
$$;
create or replace function platform.client_ok(t uuid, client_org uuid) returns boolean
  language sql stable as $$
  select platform.actor_type() = 'client' and t = platform.tenant_id() and client_org = platform.org_id()
$$;

-- Activity log entries written by external actors (their own actions) must still be insertable.
drop policy if exists tenant_isolation on platform.activity_log;
create policy tenant_isolation on platform.activity_log
  using (platform.tenant_ok(tenant_id))
  with check (tenant_id is null or platform.tenant_ok(tenant_id) or (platform.is_external() and tenant_id = platform.tenant_id()));
