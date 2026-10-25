-- History of shared-catalog records (brands, brand standards and their items, the network vendor
-- directory, products) carries no tenant id. Let staff of any firm read it so a published standard's
-- change history is visible. Tenant-private rows (e.g. vendor_profile) always carry tenant_id and stay
-- isolated; identity membership history is not included.
drop policy if exists shared_catalog_history on platform.activity_log;
create policy shared_catalog_history on platform.activity_log for select
  using (
    tenant_id is null
    and entity_type in ('brand', 'brand_standard', 'brand_standard_item', 'vendor', 'product')
    and platform.actor_type() in ('internal', 'platform', 'service')
  );
