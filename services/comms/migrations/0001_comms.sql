-- Comms: threads & messages on any entity (in-app and email), inbound email routing, notifications,
-- notification preferences, and the outbound email log.
--
-- Row-level security model (platform.tenant_ok admits staff, services and system only):
--   * `tenant_isolation` — staff / service / system access within the tenant.
--   * vendor/client — explicit policies via platform.vendor_ok / client_ok: only threads whose
--     visibility matches their kind and whose org is theirs, plus messages and read markers of
--     those threads. They can never see internal threads, triage data, mailboxes or emails.
--   * notifications / preferences — the recipient user only (plus service/system), for any actor.
--
-- Cross-service references (no FKs): tenant_id, *_org_id → identity.organizations; *_user_id →
-- identity.users; entity_id → the service owning entity_type; *_document_id(s) → documents.documents.

create schema if not exists comms;

/** Background/service work on behalf of the tenant (fan-out of notifications, digests). */
create or replace function comms.is_service(t uuid) returns boolean
  language sql stable as $$
  select platform.is_system() or (platform.actor_type() = 'service' and t = platform.tenant_id())
$$;
/** External actor may see a thread: vendor thread of their org, or client thread of their org. */
create or replace function comms.thread_shared(t uuid, vis text, vendor_org uuid, client_org uuid) returns boolean
  language sql stable as $$
  select (vis = 'vendor' and platform.vendor_ok(t, vendor_org))
      or (vis = 'client' and platform.client_ok(t, client_org))
$$;

-- ---------------------------------------------------------------------------------------------
-- Threads
-- ---------------------------------------------------------------------------------------------
create table comms.threads (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null,
  entity_type      text not null,
  entity_id        uuid not null,
  subject          text not null,
  visibility       text not null check (visibility in ('internal', 'vendor', 'client')),
  vendor_org_id    uuid,
  client_org_id    uuid,
  -- Reply-to address is t-<alias>@<INBOUND_EMAIL_DOMAIN>; globally unique so inbound mail resolves
  -- the tenant from the alias alone.
  email_alias      text not null unique check (email_alias ~ '^[a-z2-7]{8}$'),
  last_message_at  timestamptz,
  message_count    int not null default 0,
  created_by_user_id uuid,
  created_at       timestamptz not null default now(),
  check (
    (visibility = 'internal' and vendor_org_id is null and client_org_id is null) or
    (visibility = 'vendor' and vendor_org_id is not null and client_org_id is null) or
    (visibility = 'client' and client_org_id is not null and vendor_org_id is null)
  )
);
create unique index threads_entity_uq on comms.threads
  (tenant_id, entity_type, entity_id, visibility,
   (coalesce(vendor_org_id, client_org_id, '00000000-0000-0000-0000-000000000000'::uuid)));
create index threads_recent_idx on comms.threads (tenant_id, last_message_at desc nulls last);
create index threads_vendor_idx on comms.threads (vendor_org_id) where vendor_org_id is not null;
create index threads_client_idx on comms.threads (client_org_id) where client_org_id is not null;

alter table comms.threads enable row level security;
alter table comms.threads force row level security;
create policy tenant_isolation on comms.threads for all
  using (platform.tenant_ok(tenant_id)) with check (platform.tenant_ok(tenant_id));
create policy external_read on comms.threads for select
  using (comms.thread_shared(tenant_id, visibility, vendor_org_id, client_org_id));
-- External authors bump last_message_at / message_count on their own thread when they post. The API
-- never exposes other thread updates to them, and WITH CHECK pins visibility and org.
create policy external_touch on comms.threads for update
  using (comms.thread_shared(tenant_id, visibility, vendor_org_id, client_org_id))
  with check (comms.thread_shared(tenant_id, visibility, vendor_org_id, client_org_id));

-- ---------------------------------------------------------------------------------------------
-- Messages
-- ---------------------------------------------------------------------------------------------
create table comms.messages (
  id                      uuid primary key default gen_random_uuid(),
  tenant_id               uuid not null,
  thread_id               uuid not null references comms.threads(id) on delete cascade,
  author_user_id          uuid,
  author_name             text not null,
  author_email            text,
  author_org_id           uuid,
  author_actor            text not null check (author_actor in ('internal', 'vendor', 'client', 'system', 'email')),
  direction               text not null check (direction in ('internal', 'outbound', 'inbound')),
  channel                 text not null check (channel in ('app', 'email')),
  body_text               text not null default '',
  body_html               text,
  attachment_document_ids uuid[] not null default '{}',
  mentions                uuid[] not null default '{}',
  email_message_id        text,
  in_reply_to             text,
  inbound_email_id        uuid,
  ai_summary              text,
  created_at              timestamptz not null default now(),
  edited_at               timestamptz
);
create index messages_thread_idx on comms.messages (thread_id, created_at desc);
create index messages_email_id_idx on comms.messages (email_message_id) where email_message_id is not null;
create index messages_mentions_idx on comms.messages using gin (mentions);
create index messages_author_idx on comms.messages (author_user_id, thread_id);

alter table comms.messages enable row level security;
alter table comms.messages force row level security;
create policy tenant_isolation on comms.messages for all
  using (platform.tenant_ok(tenant_id)) with check (platform.tenant_ok(tenant_id));
-- The thread sub-select is itself subject to the threads policies (external_read).
create policy external_read on comms.messages for select
  using (platform.is_external() and tenant_id = platform.tenant_id()
         and exists (select 1 from comms.threads t where t.id = messages.thread_id));
create policy external_insert on comms.messages for insert
  with check (platform.is_external() and tenant_id = platform.tenant_id()
              and author_org_id = platform.org_id() and author_user_id = platform.user_id()
              and author_actor = platform.actor_type() and direction = 'inbound' and channel = 'app'
              and exists (select 1 from comms.threads t where t.id = messages.thread_id));

create trigger audit after insert or update or delete on comms.messages
  for each row execute function platform.audit('message', 'thread_id', 'thread');

-- ---------------------------------------------------------------------------------------------
-- Read markers (unread counts)
-- ---------------------------------------------------------------------------------------------
create table comms.thread_reads (
  tenant_id     uuid not null,
  thread_id     uuid not null references comms.threads(id) on delete cascade,
  user_id       uuid not null,
  last_read_at  timestamptz not null default now(),
  primary key (thread_id, user_id)
);
create index thread_reads_user_idx on comms.thread_reads (user_id);

alter table comms.thread_reads enable row level security;
alter table comms.thread_reads force row level security;
create policy tenant_isolation on comms.thread_reads for all
  using (platform.tenant_ok(tenant_id)) with check (platform.tenant_ok(tenant_id));
create policy external_own on comms.thread_reads for all
  using (platform.is_external() and tenant_id = platform.tenant_id() and user_id = platform.user_id()
         and exists (select 1 from comms.threads t where t.id = thread_reads.thread_id))
  with check (platform.is_external() and tenant_id = platform.tenant_id() and user_id = platform.user_id()
              and exists (select 1 from comms.threads t where t.id = thread_reads.thread_id));

-- ---------------------------------------------------------------------------------------------
-- Inbound email. tenant_id is null until resolved (only system work can see such rows).
-- ---------------------------------------------------------------------------------------------
create table comms.inbound_emails (
  id                      uuid primary key default gen_random_uuid(),
  tenant_id               uuid,
  message_id              text,
  in_reply_to             text,
  from_address            text not null,
  from_name               text,
  to_addresses            text[] not null default '{}',
  cc                      text[] not null default '{}',
  subject                 text not null default '',
  text_body               text,
  html_body               text,
  received_at             timestamptz not null default now(),
  raw_document_id         uuid,
  attachment_document_ids uuid[] not null default '{}',
  attachments             jsonb not null default '[]',
  status                  text not null default 'pending' check (status in ('pending', 'routed', 'needs_review', 'ignored')),
  routed_thread_id        uuid references comms.threads(id) on delete set null,
  routed_entity_type      text,
  routed_entity_id        uuid,
  routing                 jsonb,
  suggestions             jsonb not null default '[]',
  triaged_by_name         text,
  triaged_at              timestamptz,
  source                  text not null default 'raw' check (source in ('ses', 'raw', 'simulate')),
  created_at              timestamptz not null default now()
);
create unique index inbound_message_uq on comms.inbound_emails
  ((coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid)), message_id) where message_id is not null;
create index inbound_status_idx on comms.inbound_emails (tenant_id, status, received_at desc);

alter table comms.inbound_emails enable row level security;
alter table comms.inbound_emails force row level security;
create policy tenant_isolation on comms.inbound_emails for all
  using (platform.tenant_ok(tenant_id)) with check (platform.tenant_ok(tenant_id));

create trigger audit after insert or update or delete on comms.inbound_emails
  for each row execute function platform.audit('inbound_email');

-- ---------------------------------------------------------------------------------------------
-- Tenant mailboxes: addresses forwarded into Pro-Cure (purchasing@jmhs-llc.com) or hosted on the
-- inbound domain (orders@jmhs.inbound…). '@domain' entries are a catch-all for that domain.
-- ---------------------------------------------------------------------------------------------
create table comms.tenant_mailboxes (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  address     text not null check (address = lower(address) and address ~ '^[^@\s]*@[^@\s]+\.[^@\s]+$'),
  created_at  timestamptz not null default now(),
  unique (address)
);
create index tenant_mailboxes_tenant_idx on comms.tenant_mailboxes (tenant_id);

alter table comms.tenant_mailboxes enable row level security;
alter table comms.tenant_mailboxes force row level security;
create policy tenant_isolation on comms.tenant_mailboxes for all
  using (platform.tenant_ok(tenant_id)) with check (platform.tenant_ok(tenant_id));

-- ---------------------------------------------------------------------------------------------
-- Notifications
-- ---------------------------------------------------------------------------------------------
create table comms.notifications (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null,
  user_id      uuid not null,
  type         text not null,
  title        text not null,
  body         text not null default '',
  link         text,
  severity     text not null default 'info' check (severity in ('info', 'success', 'warning', 'critical')),
  entity_type  text,
  entity_id    uuid,
  read_at      timestamptz,
  created_at   timestamptz not null default now()
);
create index notifications_user_idx on comms.notifications (user_id, read_at, created_at desc);

alter table comms.notifications enable row level security;
alter table comms.notifications force row level security;
-- Not tenant-wide even for staff: a user sees only their own notifications.
create policy service_all on comms.notifications for all
  using (comms.is_service(tenant_id)) with check (comms.is_service(tenant_id));
-- Fan-out (e.g. a vendor's message notifying the order managers) runs in service context
-- (src/context.ts asService) so callers never write notifications for other users directly.
create policy recipient_read on comms.notifications for select
  using (tenant_id = platform.tenant_id() and user_id = platform.user_id());
create policy recipient_update on comms.notifications for update
  using (tenant_id = platform.tenant_id() and user_id = platform.user_id())
  with check (tenant_id = platform.tenant_id() and user_id = platform.user_id());

create table comms.notification_preferences (
  tenant_id      uuid not null,
  user_id        uuid not null,
  email_digest   text not null default 'none' check (email_digest in ('none', 'daily', 'immediate_critical')),
  muted_types    text[] not null default '{}',
  last_digest_on date,
  updated_at     timestamptz not null default now(),
  primary key (tenant_id, user_id)
);

alter table comms.notification_preferences enable row level security;
alter table comms.notification_preferences force row level security;
create policy service_all on comms.notification_preferences for all
  using (comms.is_service(tenant_id)) with check (comms.is_service(tenant_id));
create policy own_rows on comms.notification_preferences for all
  using (tenant_id = platform.tenant_id() and user_id = platform.user_id())
  with check (tenant_id = platform.tenant_id() and user_id = platform.user_id());
create trigger notification_preferences_touch before update on comms.notification_preferences
  for each row execute function platform.touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Outbound email log
-- ---------------------------------------------------------------------------------------------
create table comms.emails (
  id                      uuid primary key default gen_random_uuid(),
  tenant_id               uuid not null,
  from_address            text not null,
  "to"                    text[] not null,
  cc                      text[] not null default '{}',
  subject                 text not null,
  text_body               text not null default '',
  html_body               text,
  reply_to                text,
  attachment_document_ids uuid[] not null default '{}',
  attachments             jsonb not null default '[]',
  thread_id               uuid references comms.threads(id) on delete set null,
  message_id              text not null,
  status                  text not null default 'queued' check (status in ('queued', 'sent', 'delivered-local', 'failed')),
  provider_message_id     text,
  error                   text,
  attempts                int not null default 0,
  next_attempt_at         timestamptz,
  created_at              timestamptz not null default now(),
  sent_at                 timestamptz
);
create index emails_tenant_idx on comms.emails (tenant_id, created_at desc);
create index emails_retry_idx on comms.emails (next_attempt_at) where status = 'failed';

alter table comms.emails enable row level security;
alter table comms.emails force row level security;
create policy tenant_isolation on comms.emails for all
  using (platform.tenant_ok(tenant_id)) with check (platform.tenant_ok(tenant_id));
