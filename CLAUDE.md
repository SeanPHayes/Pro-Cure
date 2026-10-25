# Pro-Cure — engineering conventions

Pro-Cure is an enterprise FF&E procurement platform for hospitality: projects → specs & quotes →
vendor costing → purchase orders → shipments → delivery, with a vendor portal and an owner/client
portal. First customer: JM Hospitality Solutions (JMHS). Read `docs/architecture.md` first.

## Repository layout

```
packages/domain     Shared contracts: enums, roles/permissions, event catalog, money helpers. No I/O.
packages/platform   Service kit: Fastify bootstrap, auth, DB + RLS context, outbox/events, jobs,
                    storage, LLM providers, migrations, test helpers.
services/<name>     One microservice per bounded context. Owns exactly one Postgres schema (<name>).
services/gateway    Local stand-in for AWS API Gateway (/api/<service>/* → service).
apps/web            React app: internal workspace, vendor portal, client (owner) portal.
infra/cdk           AWS CDK app.
tools/              dev runner, migrations, seed data, test setup.
```

## Commands

```
pnpm db:create        # roles + database on local Postgres (PG_SUPERUSER_URL)
pnpm db:migrate       # apply all migrations
pnpm db:seed          # load the JMHS demo dataset
pnpm db:reset         # drop, create, migrate, seed
pnpm dev              # all services + gateway + web (http://localhost:5173, API :8080)
pnpm test             # integration tests (real Postgres, database procure_test)
pnpm typecheck
pnpm lint
```

## Service anatomy (follow `services/identity` as the reference)

```
services/<name>/
  package.json            name @procure/<name>; scripts dev/start/build/typecheck/test
  tsconfig.json, vitest.config.ts
  migrations/NNNN_*.sql   forward-only; never edit an applied file
  src/main.ts             await runService(<name>Service)
  src/service.ts          export const <name>Service: ServiceDefinition (routes, subscriptions, jobs)
  src/routes/<resource>.ts  one file per resource; export async function xRoutes(app: App)
  src/schemas.ts          zod request/response schemas (API contract → OpenAPI)
  src/subscriptions.ts    event handlers (on('type', handler))
  src/jobs.ts             scheduled jobs
  test/*.test.ts          buildService(svc) + app.inject; createWorld() fixtures
```

## Database rules

- One schema per service, named after it. **No foreign keys across schemas** — reference another
  service's entity by `uuid` and comment which service owns it.
- Every tenant-owned table has `tenant_id uuid not null` and:

  ```sql
  alter table s.t enable row level security;
  alter table s.t force row level security;
  create policy tenant_isolation on s.t for all
    using (platform.tenant_ok(tenant_id)) with check (platform.tenant_ok(tenant_id));
  ```
- `platform.tenant_ok()` admits staff, services and system jobs only — **never vendor or client
  actors**, even though their tokens carry the tenant id. Rows shared with external actors need their
  own explicit policies, e.g.:
  ```sql
  create policy vendor_read on s.t for select using (platform.vendor_ok(tenant_id, vendor_org_id));
  create policy client_read on s.t for select using (platform.client_ok(tenant_id, client_org_id));
  ```
  Child tables use `exists (select 1 from s.parent p where p.id = parent_id and platform.vendor_ok(...))`.
  If an external actor must write (e.g. a vendor entering a price), either add a narrow
  `for update/insert` policy with the same predicate, or validate in the API under the caller's RLS and
  then perform the write with `withTenant(...)` (attributing the user in the audit log).
  RLS limits **rows**; the API limits **columns** (see "External actors").
- Audited tables: `create trigger audit after insert or update or delete on s.t for each row execute
  function platform.audit('<entity_type>'[, '<parent_id_column>', '<parent_entity_type>']);`
  This powers the field-level activity log (`listActivity`).
- `updated_at` tables: `before update ... execute function platform.touch_updated_at()`.
- Types: ids `uuid default gen_random_uuid()`; unit costs/prices `numeric(14,4)`; totals `numeric(14,2)`;
  percentages `numeric(7,3)`; dates `date`; instants `timestamptz`; enums as `text` + `check`.
- Human numbers via `platform.next_number(tenant_id, 'PO')` → `PO-26-0001`.
- postgres.js is configured with camelCase transform: write SQL in snake_case, get camelCase objects.
  Insert objects with `tx(obj)`; JSON with `tx.json(v)`. Numerics come back as numbers, dates as
  `YYYY-MM-DD`, timestamps as ISO strings.

## API rules

- REST, plural nouns, camelCase JSON. Every route declares zod `params/querystring/body/response`,
  `tags` and a `summary` — that _is_ the OpenAPI contract (`/docs`, `/openapi.json` per service).
- Lists return `{ items, total, limit, offset }` (`page(Item)` from domain) unless tiny and bounded.
- Authorization: `req.principal.require('<permission>')` at the top of every handler. Permissions are in
  `packages/domain/src/auth.ts`. Never accept `tenantId` from the client — it comes from the token.
- All DB work inside `req.tx(async (tx) => …)` (applies tenant + actor for RLS and the audit log).
- Side effects for other services: `await req.emit(tx, 'event.type', data)` in the same transaction.
  Event payloads are defined in `packages/domain/src/events.ts`; add new ones there.
- Synchronous reads from another service: `callService('quoting', '/quotes/123', { principal: req.principal })`.
- Errors: throw `notFound()`, `badRequest()`, `forbidden()`, `conflict()`, `unprocessable()` from
  platform. Responses are RFC 9457 problem+json.
- Money: use `round2/round4/priceFromMarkup/marginPct` from domain. Never float-sum totals by hand.

## External actors (vendors, hotel owners)

- Vendors must never see sell prices, markup, margin, or other vendors. Clients must never see cost,
  markup, margin, vendor pricing or internal notes. Use **separate response schemas** for portal routes
  (`/vendor/...`, `/client/...`) so serialization strips fields even if a query over-selects.
- Portal routes check `principal.isVendor` / `principal.isClient` and the portal permission
  (`vendor:respond`, `client:view`, `client:approve`, …).

## AI features

- Use `llm()` from platform. When `llm().available` is false (local default), fall back to the
  deterministic heuristic implementation so every feature still demos offline. Always persist an AI
  result as a reviewable job (`ai` service) — a human applies it; nothing silently overwrites data.

## Tests

- Vitest integration tests against real Postgres (`procure_test`, recreated per run). Use
  `createWorld()` for an isolated tenant + vendor + client and their tokens. Test tenant isolation
  and portal field-stripping for every new resource.

## Commits

Conventional commits (`feat(quoting): …`, `fix(orders): …`). Keep migrations, code and tests together.
