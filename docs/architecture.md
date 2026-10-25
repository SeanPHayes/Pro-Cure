# Pro-Cure architecture

## What it is

Pro-Cure runs the full life of a hospitality FF&E project for a procurement firm and gives the two
outside parties — vendors and hotel owners — their own front doors into the same data:

```
Lead → Project → Specs (brand standards + private library) → Quote (locations × room types)
     → Cost requests to vendors → Merchandise & approve → Client approval
     → Purchase orders → Pre-order requirements → Production → Shipments → Receiving / storage
     → Install → Claims → Invoicing / QuickBooks → Closeout
```

Three surfaces, one platform:

| Surface       | Users                                                                                 | Purpose                                                                                                             |
| ------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Workspace     | JMHS staff (PM, design, procurement, order mgmt, logistics, accounting, sales, execs) | Run every project across the portfolio                                                                              |
| Vendor portal | Manufacturers / suppliers                                                             | Respond to cost requests, acknowledge POs, confirm ship dates, upload drawings & tracking                           |
| Owner portal  | Hotel owners, management companies, GMs, site managers                                | Approve quotes & submittals, see live order/shipment status, report claims, track on-site storage, message the team |

## Services

| Service   | Schema      | Owns                                                                                                                                                                                              |
| --------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| identity  | `identity`  | Organizations (procurement firm = tenant, vendors, clients), users, memberships/roles, SSO token exchange, access tokens                                                                          |
| catalog   | `catalog`   | **Shared intelligence**: brands, brand-standard packages & items, network vendor directory, product catalog. Tenant-private vendor profiles (terms, lead times, ratings)                          |
| documents | `documents` | File metadata & storage (S3), downloads, PDF report rendering (quotes, POs, revisions, spec books, schedules)                                                                                     |
| projects  | `projects`  | Projects, teams, contacts, task templates, tasks/Gantt, milestones, notes, schedule reports                                                                                                       |
| quoting   | `quoting`   | Private spec library, master specs (competing vendors), quotes by location × room type, cost requests, cost comparison/apply, expiry, merchandising, approval rules engine, client quote approval |
| orders    | `orders`    | Purchase orders & revisions, pre-order requirements, split shipments, ship-date confirmations, tracking, risk/escalation, receiving, storage locations, claims, submittals                        |
| finance   | `finance`   | Native AR (deposit/progress/final invoices, payments) & AP (vendor bills), project financials, QuickBooks Online sync + export                                                                    |
| comms     | `comms`     | Threads & messages on any entity (incl. email in/out), inbound email routing, notifications, outbound email                                                                                       |
| ai        | `ai`        | AI jobs: brand-spec PDF extraction, vendor-quote PDF extraction, drawing-packet splitting, inbox routing, lead-time/ship-date risk prediction                                                     |
| gateway   | —           | Local only. AWS API Gateway provides `/api/<service>/*` routing in the cloud                                                                                                                      |

Every service is independently deployable (its own container, OpenAPI contract, migrations and test
suite) but they share one PostgreSQL cluster.

## Key decisions

**ADR-1 TypeScript end to end.** One typed domain package shared by services and the web app; Fastify +
zod gives validation and OpenAPI from the same schema (API-first: the zod schema _is_ the contract).

**ADR-2 Single database, schema per service, row-level security per tenant.** One Aurora PostgreSQL
cluster (chosen over database-per-tenant for cost and operational simplicity). Each service owns one
schema; no cross-schema foreign keys, so a service can later move to its own cluster without code
changes. Tenant isolation is enforced by Postgres RLS on every tenant table, driven by transaction-local
settings (`app.tenant_id`, `app.org_id`, `app.actor_type`, `app.user_id`) that the platform sets from the
verified access token. Services connect as `procure_app`, which has no `BYPASSRLS`. A query that forgets
its `where tenant_id = …` still cannot leak data.

**ADR-3 Shared intelligence lives outside tenant scope.** Brand standards, the vendor directory and the
product catalog are global tables in `catalog`; anything commercial (costs, prices, margins, vendor terms,
ratings) is tenant-scoped. Tenants can contribute to the shared catalog; curators publish.

**ADR-4 Events via transactional outbox.** State change and its event are written in one transaction
(`platform.outbox`); a relay publishes to EventBridge (AWS) or HTTP fan-out (local). Consumers are
idempotent through `platform.inbox`. Synchronous calls are used only for reads.

**ADR-5 Tokens.** Cognito authenticates (Entra ID / Google federation, or password). Identity exchanges
the Cognito ID token for a short-lived Pro-Cure RS256 JWT carrying user, active org, tenant, actor type,
roles and permissions. Services verify it offline against identity's JWKS. Vendor and client users can
belong to organizations connected to several tenants; a token is scoped to one.

**ADR-6 Field-level audit everywhere.** A generic trigger writes the changed fields, actor and time of
every audited row to `platform.activity_log`. This is the "who changed the ship date" record.

**ADR-7 AI is reviewable, provider-agnostic, and works offline.** Bedrock (Claude) in AWS, the Anthropic
API if configured, otherwise deterministic heuristics. Results are stored as jobs a human reviews and
applies; nothing writes over business data on its own.

## Tenancy and roles

- Tenant = procurement firm (JMHS). `tenant_id` = its organization id.
- Actor types: `internal`, `vendor`, `client`, `platform`, plus `system` for background work.
- Roles → permissions are defined once in `packages/domain/src/auth.ts` and embedded in the token.
- Column-level protection for portals is done in the API with portal-specific response schemas:
  vendors never see sell price/margin; clients never see cost/margin/vendor pricing.

## Events (selected)

`quoting.cost_request.sent` → comms emails the vendor a portal link.
`quoting.quote.client_decided` → projects completes the client-approval milestone.
`orders.po.issued` → comms opens a PO thread with the vendor; finance creates the deposit bill when terms require it.
`orders.shipment.tracking_added` → comms notifies delivery recipients.
`comms.inbound_email.received` → ai routes it to the right PO thread.
`ai.job.completed` → notifications to the requester.

The full contract is `packages/domain/src/events.ts`.

## AWS deployment

```
CloudFront ─┬─ S3 (web app)
            └─ API Gateway (HTTP API, WAF) ── VPC Link ── ALB ── ECS Fargate services (one per service)
                                                               │
       Cognito (Entra ID / Google SSO)        Aurora PostgreSQL Serverless v2 (Multi-AZ)
       EventBridge bus ── rules ── SQS (+DLQ) per service     S3 documents (KMS)
       SES (outbound + inbound receipt → S3 → comms)          Bedrock + Textract (ai)
       Secrets Manager, CloudWatch logs/metrics/alarms, X-Ray
```

Infrastructure is code in `infra/cdk`; CI runs lint, typecheck, tests and `cdk synth` on every PR.
