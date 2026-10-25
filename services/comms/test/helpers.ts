import { buildService, withOwner } from '@procure/platform';
import { vi } from 'vitest';
import { clients, type DirectoryUser } from '../src/clients.js';
import { commsService } from '../src/service.js';

export type TestApp = Awaited<ReturnType<typeof buildService>>;
export const INTERNAL = {
  'x-procure-internal': process.env.INTERNAL_SHARED_SECRET ?? 'local-internal-secret',
};

export const buildApp = () => buildService(commsService);

/** Documents stored through the (stubbed) documents service, by id. */
export const storedDocs = new Map<
  string,
  {
    tenantId: string;
    filename: string;
    contentType: string;
    base64: string;
    visibility: string;
    vendorOrgId?: string;
  }
>();

/**
 * Stub every cross-service call. identity's /internal/users is emulated against the real identity
 * tables (the test DB has identity migrated) so role fan-out behaves like production.
 */
export function stubClients() {
  vi.spyOn(clients, 'tenantName').mockImplementation(async (tenantId) =>
    withOwner(async (tx) => {
      const [o] = await tx<
        { name: string }[]
      >`select name from identity.organizations where id = ${tenantId}`;
      return o?.name ?? 'Pro-Cure';
    }),
  );
  vi.spyOn(clients, 'listUsers').mockImplementation(async (tenantId, f) =>
    withOwner(
      (tx) => tx<DirectoryUser[]>`
        select u.id, u.email, u.name, o.id as org_id, o.type as org_type, m.roles
        from identity.memberships m
        join identity.users u on u.id = m.user_id
        join identity.organizations o on o.id = m.org_id
        left join identity.org_relationships r on r.org_id = o.id and r.tenant_id = ${tenantId}
        where m.status = 'active' and (o.id = ${tenantId} or r.id is not null)
          ${f.orgId ? tx`and o.id = ${f.orgId}` : tx``}
          ${f.roles?.length ? tx`and m.roles && ${f.roles}` : tx``}
          ${f.ids?.length ? tx`and u.id in ${tx(f.ids)}` : tx``}`,
    ),
  );
  vi.spyOn(clients, 'createDocument').mockImplementation(async (input) => {
    const id = crypto.randomUUID();
    storedDocs.set(id, input);
    return {
      id,
      filename: input.filename,
      contentType: input.contentType,
      size: Buffer.from(input.base64, 'base64').length,
    };
  });
  vi.spyOn(clients, 'getDocumentContent').mockImplementation(async (_tenantId, id) => {
    const d = storedDocs.get(id);
    return d
      ? { filename: d.filename, contentType: d.contentType, base64: d.base64 }
      : {
          filename: 'file.pdf',
          contentType: 'application/pdf',
          base64: Buffer.from('%PDF-1.4 test').toString('base64'),
        };
  });
  vi.spyOn(clients, 'getProject').mockResolvedValue({ id: crypto.randomUUID(), clientOrgId: null });
  vi.spyOn(clients, 'setShipmentTracking').mockResolvedValue({ ok: true });
  vi.spyOn(clients, 'setPoRequirement').mockResolvedValue({ ok: true });
}

/** Add an internal user with roles to a tenant (returns id + email). */
export async function addUser(tenantId: string, name: string, roles: string[]) {
  return withOwner(async (tx) => {
    const email = `${name.toLowerCase().replace(/\W+/g, '.')}.${crypto.randomUUID().slice(0, 6)}@example.com`;
    const [u] = await tx<
      { id: string }[]
    >`insert into identity.users (email, name) values (${email}, ${name}) returning id`;
    await tx`insert into identity.memberships (user_id, org_id, roles, is_default) values (${u!.id}, ${tenantId}, ${roles}, true)`;
    return { id: u!.id, email };
  });
}

/** Events written to the outbox for a tenant, optionally by type. */
export const outbox = (tenantId: string, type?: string) =>
  withOwner(
    (tx) => tx<{ id: string; type: string; data: Record<string, unknown> & Row }[]>`
    select id, type, data from platform.outbox
    where tenant_id = ${tenantId} ${type ? tx`and type = ${type}` : tx``}
    order by occurred_at`,
  );

export const notificationsFor = (userId: string) =>
  withOwner(
    (tx) => tx<{ id: string; type: string; title: string; severity: string; link: string | null }[]>`
    select id, type, title, severity, link from comms.notifications where user_id = ${userId} order by created_at`,
  );

/** Deliver an event to the service as the relay would. */
export async function deliver(
  app: TestApp,
  type: string,
  tenantId: string | null,
  data: Record<string, unknown>,
  actor: { userId: string | null; orgId: string | null; name: string | null } | null = null,
) {
  const res = await app.inject({
    method: 'POST',
    url: '/internal/events',
    headers: INTERNAL,
    payload: {
      id: crypto.randomUUID(),
      type,
      version: 1,
      occurredAt: new Date().toISOString(),
      source: 'test',
      tenantId,
      actor,
      data,
    },
  });
  if (res.statusCode !== 200) throw new Error(`event ${type} failed: ${res.statusCode} ${res.body}`);
  return res.json() as { result: string };
}

/** Build a raw RFC 5322 email for inbound tests. */
export function rawEmail(o: {
  from: string;
  to: string;
  subject: string;
  text: string;
  messageId?: string;
  extraHeaders?: string[];
}) {
  return Buffer.from(
    [
      `From: ${o.from}`,
      `To: ${o.to}`,
      `Subject: ${o.subject}`,
      `Message-ID: ${o.messageId ?? `<${crypto.randomUUID()}@vendor.example>`}`,
      `Date: ${new Date().toUTCString()}`,
      ...(o.extraHeaders ?? []),
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      o.text,
      '',
    ].join('\r\n'),
  ).toString('base64');
}

/** Loose shape for JSON bodies / rows asserted in tests. */
// biome-ignore lint/suspicious/noExplicitAny: test assertions over untyped JSON
export type Row = Record<string, any>;
