-- Documents: metadata for every stored file (uploads and generated PDF reports). Bytes live in object
-- storage (S3 in AWS, local FS in dev) under a tenant-prefixed key; this table is the access-control
-- point. A file can be attached to several entities through document_links.
--
-- Visibility:
--   * internal actors (and services/system) see their tenant's rows
--   * every authenticated actor can read global rows (tenant_id is null, e.g. a published brand PDF)
--   * vendor actors see rows of their token's tenant shared with the vendor and addressed to their org
--   * client actors likewise for visibility 'client' and their org

create schema if not exists documents;

create table documents.documents (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid,          -- identity.organizations (procurement firm); null = global
  owner_org_id        uuid,          -- identity.organizations: org of the uploader
  filename            text not null,
  content_type        text not null,
  size                bigint not null check (size >= 0),
  sha256              text not null,
  storage_key         text not null unique,
  kind                text not null default 'other' check (kind in (
                        'spec_sheet', 'line_drawing', 'shop_drawing', 'finish_sample', 'cfa', 'approval_form',
                        'image', 'report', 'photo', 'email_attachment', 'invoice', 'contract', 'other')),
  entity_type         text,          -- primary attachment (owning service's entity, e.g. 'purchase_order')
  entity_id           uuid,
  visibility          text not null default 'internal' check (visibility in ('internal', 'vendor', 'client')),
  vendor_org_id       uuid,          -- identity.organizations (vendor) allowed to see it when visibility = 'vendor'
  client_org_id       uuid,          -- identity.organizations (client) allowed to see it when visibility = 'client'
  include_in_spec_book boolean not null default false,
  page_count          int,
  template            text,          -- report template when kind = 'report'
  uploaded_by         uuid,          -- identity.users
  uploaded_by_name    text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz,
  check (entity_id is null or entity_type is not null),
  check (visibility <> 'vendor' or vendor_org_id is not null),
  check (visibility <> 'client' or client_org_id is not null)
);
create index documents_entity_idx on documents.documents (tenant_id, entity_type, entity_id) where deleted_at is null;
create index documents_tenant_kind_idx on documents.documents (tenant_id, kind, created_at desc) where deleted_at is null;
create index documents_vendor_idx on documents.documents (tenant_id, vendor_org_id) where vendor_org_id is not null;
create index documents_client_idx on documents.documents (tenant_id, client_org_id) where client_org_id is not null;
create index documents_sha_idx on documents.documents (tenant_id, sha256);
create index documents_filename_trgm on documents.documents using gin (filename gin_trgm_ops);

alter table documents.documents enable row level security;
alter table documents.documents force row level security;
create policy tenant_isolation on documents.documents for all
  using (platform.tenant_ok(tenant_id)) with check (platform.tenant_ok(tenant_id));
create policy global_read on documents.documents for select
  using (tenant_id is null and platform.actor_type() <> 'anonymous');
create policy global_write on documents.documents for all
  using (tenant_id is null and (platform.is_system() or platform.actor_type() = 'platform'))
  with check (tenant_id is null and (platform.is_system() or platform.actor_type() = 'platform'));
create policy vendor_read on documents.documents for select
  using (visibility = 'vendor' and platform.vendor_ok(tenant_id, vendor_org_id));
create policy vendor_insert on documents.documents for insert
  with check (visibility = 'vendor' and platform.vendor_ok(tenant_id, vendor_org_id));
create policy client_read on documents.documents for select
  using (visibility = 'client' and platform.client_ok(tenant_id, client_org_id));
create policy client_insert on documents.documents for insert
  with check (visibility = 'client' and platform.client_ok(tenant_id, client_org_id));

create trigger documents_touch before update on documents.documents
  for each row execute function platform.touch_updated_at();
create trigger audit after insert or update or delete on documents.documents
  for each row execute function platform.audit('document');

-- The same file attached to further entities (e.g. a vendor drawing on the spec AND on the PO line).
create table documents.document_links (
  id           uuid primary key default gen_random_uuid(),
  document_id  uuid not null references documents.documents(id) on delete cascade,
  tenant_id    uuid not null,
  entity_type  text not null,
  entity_id    uuid not null,
  created_by   uuid,
  created_at   timestamptz not null default now(),
  unique (document_id, entity_type, entity_id)
);
create index document_links_entity_idx on documents.document_links (tenant_id, entity_type, entity_id);

alter table documents.document_links enable row level security;
alter table documents.document_links force row level security;
create policy tenant_isolation on documents.document_links for all
  using (platform.tenant_ok(tenant_id)) with check (platform.tenant_ok(tenant_id));
-- External actors may see a link only when they can see the linked document (subquery is RLS-filtered).
create policy external_read on documents.document_links for select
  using (platform.is_external() and tenant_id = platform.tenant_id()
         and exists (select 1 from documents.documents d where d.id = document_id));

create trigger audit after insert or update or delete on documents.document_links
  for each row execute function platform.audit('document_link', 'document_id', 'document');
