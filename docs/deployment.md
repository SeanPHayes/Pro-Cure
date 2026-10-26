# Pro-Cure on AWS — deployment

Infrastructure is a CDK v2 TypeScript app in `infra/cdk`; images are built from `services/Dockerfile`;
CI/CD is `.github/workflows/{ci,deploy}.yml`. One AWS account per stage is recommended (`dev`,
`staging`, `prod`); all stacks for a stage live in one region (default `us-east-1`).

## Architecture

```
                         Users (staff, vendors, hotel owners)
                                        │ HTTPS
                                        ▼
            ┌──────────── CloudFront (WAFv2: IP reputation, common, bad inputs, 2000 req/5 min/IP) ─────────────┐
            │  default  → S3 web bucket (OAC, SPA fallback function)                                          │
            │  /api/*   → API Gateway HTTP API (no cache, all viewer headers except Host)                      │
            └──────────────────────────────────────────────────────────────────────────────────────────────────┘
                                        │  ANY /api/<prefix>/{proxy+}
                                        │  path := /$request.path.proxy, header x-procure-service := <service>
                                        ▼
   VPC 10.x.0.0/16 (3 AZ)        VPC link ──► internal ALB :80 ──(rule: x-procure-service header)──► target group
   ┌───────────────────────────────────────────────────────────────────────────────────────────────────────┐
   │ private-with-egress                                                                                    │
   │   ECS Fargate (ARM64), one service each:  identity catalog projects quoting orders finance documents   │
   │   ai comms  ── Cloud Map: http://<service>.procure.internal:<port>  (service→service, JWKS, inbound)    │
   │   Lambdas: inbound-email, db-bootstrap, secrets-bootstrap        VPC endpoints: ECR, Secrets Manager,  │
   │                                                                  SQS, EventBridge, Logs, Bedrock,      │
   │ isolated:  Aurora PostgreSQL 16 Serverless v2 (writer [+ reader])  Textract, KMS, SES API, STS; S3 gw  │
   └───────────────────────────────────────────────────────────────────────────────────────────────────────┘
   Events: services ──outbox relay──► EventBridge bus pro-cure-<stage> (30-day archive)
                                     └─ rule per consumer (lib/subscriptions.ts) ──► SQS <svc> (+DLQ ×5) ◄─ long-poll
   Email out: comms ──SESv2──► SES (config set → CloudWatch)
   Email in:  MX inbound.<domain> → SES receipt rule → S3 inbound/raw → Lambda → copy to documents bucket
              → POST comms /inbound/ses {s3Key} (x-procure-internal)
   Auth: Cognito (password + TOTP, Entra ID SAML, Google) → ID token → identity → Pro-Cure RS256 JWT
   AI: ai → Bedrock (Claude) + Textract
```

### Stacks (`ProCure-<stage>-<Name>`)

| Stack | Contents |
| --- | --- |
| Network | VPC (public / private-with-egress / isolated-db), NAT (1 dev/staging, 3 prod), flow logs (REJECT), S3 gateway + 11 interface endpoints, shared security groups |
| Ecr | ECR repo per service + `tools` (`pro-cure-<stage>/<name>`), scan on push, lifecycle |
| Data | KMS keys (data, documents), Aurora PG 16 Serverless v2 (IAM auth, PI, force SSL, backups 7/35 d, deletion protection prod), role secrets `procure_owner` / `procure_app`, DB bootstrap custom resource, generated secrets (RS256 key, finance token key, internal shared secret), documents bucket (KMS, versioned, IA after 90 d, CORS, access logs), inbound-email bucket, access-logs bucket |
| Events | EventBridge bus + archive, SQS queue + DLQ per service, routing rules |
| Platform | ECS cluster (Container Insights v2), Cloud Map `procure.internal`, internal ALB + listener, `migrate` task definition |
| Api | HTTP API, VPC link, one route per service, throttling, JSON access logs, optional custom domain |
| Web | SPA bucket, CloudFront (OAC, security headers, SPA fallback), WAFv2 + logging, optional custom domain, optional BucketDeployment |
| Auth | Cognito user pool, SPA client (code flow, no secret), managed-login domain, optional Entra ID SAML + Google |
| Services | 9 Fargate services: task defs, IAM, Cloud Map, target groups, listener rules, autoscaling |
| Email | SES domain identity (DKIM, MAIL FROM), configuration set, receipt rule set (+activation), inbound Lambda |
| Observability | SNS alarm topic (email), alarms, CloudWatch dashboard `pro-cure-<stage>` |

Everything is tagged `Project=Pro-Cure`, `Stage=<stage>`, `Owner=JMHS`.

### Request path and the `/api/<prefix>` strip

Services mount routes at `/` (`/quotes`, `/health`, …). API Gateway matches `/api/<prefix>/{proxy+}`
and rewrites the path to `/{proxy}`. Because the prefix is gone by the time the request reaches the
ALB, the integration also overwrites header `x-procure-service: <service>`; ALB listener rules match
that header (client-supplied values are replaced). `/api/<prefix>` with no trailing path is not routed.

### Service configuration

Every variable in `packages/platform/src/config.ts` is set by the task definition
(`infra/cdk/lib/stacks/services-stack.ts`):

| Variable | Value |
| --- | --- |
| `APP_ENV` / `LOG_LEVEL` / `PORT` | `dev`·`staging`·`production` / per stage / service port |
| `PUBLIC_WEB_URL` / `PUBLIC_API_URL` | `https://<web domain or CloudFront domain>` / `…/api` |
| `DATABASE_URL` | assembled by the image entrypoint from `DB_HOST/DB_PORT/DB_NAME/DB_SSLMODE` (env) + `DB_USER/DB_PASSWORD` (secret `pro-cure/<stage>/db/procure_app`) |
| `MIGRATION_DATABASE_URL` | migrate task only, from `MIGRATION_DB_USER/PASSWORD` (secret `…/db/procure_owner`) |
| `DB_POOL_MAX` | per stage |
| `AUTH_ISSUER` / `AUTH_AUDIENCE` | `<web>/api/identity` / `pro-cure-api` |
| `AUTH_JWKS_URL` | `http://identity.procure.internal:4001/.well-known/jwks.json` |
| `AUTH_PRIVATE_KEY_PEM` | identity only — secret `pro-cure/<stage>/auth-private-key-pem` |
| `ACCESS_TOKEN_TTL_SECONDS`, `AUTH_DEV_LOGIN` | `3600`, `false` |
| `COGNITO_USER_POOL_ID` / `COGNITO_CLIENT_ID` / `COGNITO_REGION` | from Auth stack |
| `EVENT_TRANSPORT` / `EVENT_BUS_NAME` / `EVENT_QUEUE_URL` | `eventbridge` / `pro-cure-<stage>` / the service's own queue |
| `STORAGE_DRIVER` / `S3_BUCKET` / `AWS_REGION` | `s3` / documents bucket / stack region |
| `AI_PROVIDER` / `AI_MODEL` / `BEDROCK_MODEL_ID` / `OCR_PROVIDER` | `bedrock` / config / config / `textract` |
| `ANTHROPIC_API_KEY` | ai only, when `optionalSecrets.anthropicApiKey` is configured |
| `EMAIL_DRIVER` / `EMAIL_FROM` / `INBOUND_EMAIL_DOMAIN` | `ses` / config / `inbound.<domain>` |
| `JOBS_ENABLED` | `true` (jobs take an advisory lock, so replicas are safe) |
| `INTERNAL_SHARED_SECRET` | secret `pro-cure/<stage>/internal-shared-secret` |
| `SERVICE_URL_<NAME>` | `http://<name>.procure.internal:<port>` for all nine services |
| comms: `SES_CONFIGURATION_SET` | `pro-cure-<stage>` |
| finance: `FINANCE_TOKEN_KEY` | secret `pro-cure/<stage>/finance-token-key` (generated, 32 bytes base64) |
| finance: `QBO_ENVIRONMENT`, `QBO_REDIRECT_URI` | config / `<web>/api/finance/integrations/qbo/callback` |
| finance: `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET` | from JSON secret `optionalSecrets.qbo` (`clientId`, `clientSecret`) when configured |
| orders: `TRACKING_PROVIDER`, `AFTERSHIP_API_KEY` | `aftership` + secret when `optionalSecrets.aftershipApiKey` is configured, else `simulated` |

TLS to Aurora is verified (`sslmode=verify-full`) against the RDS CA bundle baked into the image
(`NODE_EXTRA_CA_CERTS`).

### IAM (task roles)

| Service | Beyond baseline* |
| --- | --- |
| identity | reads the signing-key secret (execution role) |
| documents | documents bucket read/write + documents KMS key |
| ai | documents bucket read/write + KMS, `bedrock:InvokeModel*` (Anthropic models / inference profiles), Textract |
| comms | documents bucket read/write + KMS, `ses:SendEmail`/`SendRawEmail` on the domain identity + config set |
| finance | reads the finance token key (and QBO secret if configured) |
| orders | reads the AfterShip secret if configured |

\* Baseline for all: `events:PutEvents` on the bus, consume its own queue (+ data-key decrypt), DB and
internal-secret injection via the execution role. No service can read another service's queue.

## Prerequisites (once per account)

1. **CDK bootstrap**: `npx cdk bootstrap aws://<account>/us-east-1` (from `infra/cdk`, with admin
   credentials).
2. **Stage config**: edit `infra/cdk/config/<stage>.ts` — account, domains, alarm email, Cognito domain
   prefix (globally unique), SES domains. Or pass `-c account=<id>` at deploy time.
3. **GitHub OIDC deploy role**
   - IAM → Identity providers → add `token.actions.githubusercontent.com` (audience `sts.amazonaws.com`).
   - Role `pro-cure-github-deploy` with trust policy:
     ```json
     { "Effect": "Allow",
       "Principal": { "Federated": "arn:aws:iam::<account>:oidc-provider/token.actions.githubusercontent.com" },
       "Action": "sts:AssumeRoleWithWebIdentity",
       "Condition": {
         "StringEquals": { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
         "StringLike": { "token.actions.githubusercontent.com:sub": "repo:<org>/<repo>:environment:<stage>" } } }
     ```
   - Permissions: `sts:AssumeRole` on `arn:aws:iam::<account>:role/cdk-hnb659fds-*` (CDK roles do the
     deploy), plus `ecr:GetAuthorizationToken` and push to `pro-cure-<stage>/*`, `ecs:RunTask`,
     `ecs:DescribeTasks`, `iam:PassRole` (migrate task + execution roles), `cloudformation:DescribeStacks`,
     `logs:FilterLogEvents` on `/pro-cure/<stage>/migrate`, `s3:PutObject`/`ListBucket` on the web bucket,
     `cloudfront:CreateInvalidation`.
   - GitHub → Settings → Environments: create `dev`, `staging`, `prod`; add **required reviewers** to
     `prod` (and `staging` if wanted). Per environment set variables `AWS_DEPLOY_ROLE_ARN`,
     `AWS_ACCOUNT_ID`, `AWS_REGION`.
4. **Bedrock model access**: in the Bedrock console enable the Anthropic Claude model used by
   `ai.bedrockModelId` (cross-region inference profile `us.anthropic…` by default; verify the exact id).
5. **SES**
   - After the Email stack deploys, publish the three DKIM CNAMEs (`DkimRecord1..3` outputs), the MAIL
     FROM MX/TXT records shown in the SES console, and `InboundMxRecord`
     (`inbound.<domain> MX 10 inbound-smtp.<region>.amazonaws.com`).
   - Request production access (leave the SES sandbox) before emailing real vendors/clients.
   - Only one receipt rule set can be active per account/region; the stack activates its own
     (`email.activateReceiptRuleSet`). Set it to `false` if the account already uses another one.
6. **Entra ID SAML app** (optional)
   - Deploy Auth once; note outputs `SamlEntityId` (`urn:amazon:cognito:sp:<poolId>`) and
     `SamlReplyUrl` (`https://<prefix>.auth.<region>.amazoncognito.com/saml2/idpresponse`).
   - Entra admin center → Enterprise applications → New → Create your own (non-gallery) → Single sign-on
     → SAML. Identifier = `SamlEntityId`, Reply URL = `SamlReplyUrl`.
   - Attributes & claims: keep `emailaddress`, `givenname`, `surname`; Unique User Identifier = `user.mail`.
   - Copy the **App Federation Metadata Url** into `auth.entraSaml.metadataUrl` in the stage config,
     assign users/groups, redeploy.
7. **Google OAuth** (optional)
   - Google Cloud console → APIs & Services → Credentials → OAuth client ID (Web application).
     Authorized JavaScript origin `https://<prefix>.auth.<region>.amazoncognito.com`; redirect URI
     `https://<prefix>.auth.<region>.amazoncognito.com/oauth2/idpresponse`.
   - `aws secretsmanager create-secret --name pro-cure/<stage>/google-client-secret --secret-string '<secret>'`
   - Set `auth.google = { clientId, clientSecretName }`; redeploy.

## First deploy runbook

Secrets are generated by the stacks; nothing has to be created by hand for a working deploy.

| Secret | Created by | Notes |
| --- | --- | --- |
| `pro-cure/<stage>/db/master` | Aurora | admin, used only by the bootstrap Lambda |
| `pro-cure/<stage>/db/procure_owner`, `…/db/procure_app` | Data stack | roles created by `Custom::ProCureDbBootstrap` |
| `pro-cure/<stage>/auth-private-key-pem` | Data stack + custom resource | RS256 PKCS#8 PEM, generated if empty, never overwritten |
| `pro-cure/<stage>/finance-token-key` | Data stack + custom resource | 32 random bytes, base64 |
| `pro-cure/<stage>/internal-shared-secret` | Data stack | 48 chars |

To supply your own instead (e.g. to share a signing key across a blue/green move):

```bash
# RS256 signing key (PKCS#8 PEM — the format identity expects)
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out procure-signing.pem
aws secretsmanager put-secret-value --secret-id pro-cure/<stage>/auth-private-key-pem \
  --secret-string file://procure-signing.pem && shred -u procure-signing.pem

# Internal shared secret / finance token key
aws secretsmanager put-secret-value --secret-id pro-cure/<stage>/internal-shared-secret \
  --secret-string "$(openssl rand -hex 32)"
aws secretsmanager put-secret-value --secret-id pro-cure/<stage>/finance-token-key \
  --secret-string "$(openssl rand -base64 32)"

# Optional integrations (then reference the names in config/<stage>.ts → optionalSecrets)
aws secretsmanager create-secret --name pro-cure/<stage>/anthropic-api-key --secret-string 'sk-ant-…'
aws secretsmanager create-secret --name pro-cure/<stage>/qbo \
  --secret-string '{"clientId":"…","clientSecret":"…"}'
aws secretsmanager create-secret --name pro-cure/<stage>/aftership-api-key --secret-string '…'
```

After changing a secret, force new tasks: `aws ecs update-service --cluster pro-cure-<stage>
--service <svc> --force-new-deployment`.

**Steps**

1. Prerequisites 1–3 (bootstrap, config, OIDC + environments).
2. Push to `main` (dev) or run **Deploy** manually with the stage. The workflow:
   1. deploys `ProCure-<stage>-Ecr`;
   2. builds and pushes 10 ARM64 images tagged with the commit SHA (9 services + `tools`);
   3. deploys Network → Data → Events → Platform (DB bootstrap runs here), runs the **migrate** task and
      waits for exit code 0;
   4. `cdk deploy --all` (services roll; circuit breaker rolls back failed deployments);
   5. builds `apps/web` with `VITE_COGNITO_DOMAIN` / `VITE_COGNITO_CLIENT_ID` from the Auth outputs,
      syncs to the web bucket, invalidates `/index.html`.
3. Prerequisites 4–7 (Bedrock, SES DNS, SSO), then confirm the SNS email subscription.
4. Seed the first tenant/admin (identity) — e.g. run `pnpm db:seed` from a bastion/ECS Exec session
   in dev, or create the tenant org + first admin through identity's API; invite users from the app.
5. Custom domains: request ACM certs (CloudFront: us-east-1), set `domains.webCertificateArn` (and
   optionally `apiCertificateArn`), deploy, point DNS (`app…` → `CloudFrontDomain`), then set
   `domains.useCustomDomains: true` and deploy again so `PUBLIC_WEB_URL`, Cognito callbacks and CORS use it.

Manual deploy from a workstation (same as CI):

```bash
cd infra/cdk
npx cdk deploy ProCure-dev-Platform -c stage=dev -c imageTag=<sha> -c account=<id>
# run the migrate task (see deploy.yml "Run migrations")
npx cdk deploy --all -c stage=dev -c imageTag=<sha> -c account=<id>
```

`cdk synth` works without credentials (`npx cdk synth -c stage=prod`): no lookups, no Docker
(Lambdas bundle with the local esbuild).

## Migrations

- Image `pro-cure-<stage>/tools` contains `dist-tools/migrate.mjs` (bundled `tools/migrate.ts`) and every
  `packages/platform/migrations` + `services/*/migrations` directory in the layout `tools/migrate.ts`
  expects. The `migrate` task (family `pro-cure-<stage>-migrate`) runs it as `procure_owner`.
- Migrations are forward-only and checksummed (`platform.schema_migrations`); after each scope the app
  role is granted DML. They run **before** services roll, so every migration must be compatible with
  the currently running code (expand → deploy → contract in a later release).
- The DB bootstrap (`infra/lambda/db-bootstrap`, equivalent of `tools/db-create.mjs`) creates
  `procure_owner` (owns the `procure` database) and `procure_app` (`NOBYPASSRLS`), installs `pgcrypto`
  and `pg_trgm`, and grants CONNECT. It is idempotent and re-runs when `BootstrapVersion` changes.
- Run manually: `aws ecs run-task --cluster pro-cure-<stage> --task-definition pro-cure-<stage>-migrate
  --launch-type FARGATE --network-configuration 'awsvpcConfiguration={subnets=[…],securityGroups=[…]}'`
  (values in the Platform stack outputs `MigrateSubnets`, `MigrateSecurityGroup`).

## Event routing

`infra/cdk/lib/subscriptions.ts` lists the event types each service consumes; the Events stack turns it
into one EventBridge rule per service → its SQS queue. It is **generated** from each service's
`subscriptions` (`services/<name>/src/service.ts`):

```bash
pnpm --filter @procure/infra-cdk gen:subscriptions          # regenerate, then commit
pnpm --filter @procure/infra-cdk gen:subscriptions -- --check  # CI: fails if stale
```

A service that fails to import keeps its previous list. Failed handlers are retried by SQS (visibility
5 min) and moved to `<queue>-dlq` after 5 receives (alarm fires). Redrive from the SQS console
("Start DLQ redrive") once fixed; consumers are idempotent (`platform.inbox`). The bus archive keeps 30
days of events for replay to a new consumer.

## Rollback

- **Automatic**: ECS deployment circuit breaker rolls a service back to the last healthy task definition
  if new tasks fail health checks.
- **Release rollback**: run **Deploy** manually with `image_tag` = the previous good commit SHA (images
  are kept by ECR lifecycle: last 30 dev / 100 prod) and `skip_migrations` = true. Schema stays as is
  (forward-only), which is why migrations must be backward compatible.
- **Web only**: re-run the previous commit's deploy, or restore `index.html` from the web bucket's
  previous object version and invalidate `/index.html`.
- **Infrastructure**: revert the CDK change and redeploy; CloudFormation rolls back failed stack updates
  on its own.

## Security notes

- **Tenant isolation**: services connect as `procure_app` (no `BYPASSRLS`); Postgres RLS on every tenant
  table is driven by transaction-local settings from the verified token. Only the migrate task holds
  `procure_owner`; only the bootstrap Lambda reads the master secret.
- **Network**: services, Lambdas and Aurora are in private subnets; Aurora in isolated subnets accepts
  5432 only from the DB-client security group. The ALB is internal, reachable only from the VPC link;
  service ports accept traffic only from the ALB, each other and the inbound-email Lambda. `/internal/*`
  routes additionally require the `x-procure-internal` shared secret. AWS API traffic uses VPC
  endpoints.
- **Encryption**: KMS CMKs (rotation on) for Aurora, Performance Insights, Secrets Manager, SQS
  (data key) and documents / inbound email (documents key). TLS everywhere at the edge; verified TLS to
  Aurora (`rds.force_ssl=1`).
- **Least privilege**: per-service task roles (table above); execution roles only read their own
  secrets; Bedrock limited to Anthropic models; SES limited to the domain identity.
- **Edge**: WAFv2 on CloudFront (Amazon IP reputation, Core rule set with body-size rule in count mode for
  uploads, Known bad inputs, 2000 requests / 5 min / IP), WAF logs with `authorization`/`cookie`
  redacted. HTTP API throttling per stage. HSTS (2 y, preload), CSP (`default-src 'self'`, same-origin
  `/api`, Cognito + S3 presigned URLs), `X-Frame-Options: DENY`, nosniff, strict referrer policy.
- **Identity**: Cognito password policy (12+ chars, all classes), optional TOTP MFA, threat protection
  in audit mode (Plus plan), no self sign-up, user-existence errors suppressed.
- **Audit**: VPC flow logs (rejects), ALB/CloudFront/S3 access logs, API access logs, field-level audit
  in `platform.activity_log`.
- cdk-nag is not installed (would need a new dependency); add `cdk-nag` and `AwsSolutionsChecks` if a
  compliance report is required.

## Disaster recovery

| Data | Protection | Recovery |
| --- | --- | --- |
| Aurora | Automated backups 7 d (dev/staging) / 35 d (prod), PITR to any second in the window, snapshot on stack delete (prod), deletion protection (staging/prod), Multi-AZ reader as failover target (prod) | `aws rds restore-db-cluster-to-point-in-time` → new cluster, then point `DB_HOST` (Data stack) at it or rename |
| Documents | S3 versioning (noncurrent kept 365 d prod), KMS key retained | Restore prior object versions; enable cross-region replication if regional DR is required |
| Secrets / KMS keys | Retained on stack delete in prod | — |
| Events | 30-day EventBridge archive, 4-day queues + 14-day DLQs | Replay archive to the bus |
| Infra | Code (this repo) | Redeploy stacks; ECR images retained |

RPO ≈ 5 minutes (PITR), RTO ≈ 1–2 hours for a full cluster restore. Cross-region DR (Aurora Global
Database, S3 CRR) is not provisioned.

## Cost estimate (rough, us-east-1, monthly USD, light load)

| Item | dev | prod |
| --- | --- | --- |
| NAT gateways (1 / 3) + data | 40 | 120 |
| Interface VPC endpoints (11 × 1 AZ / 11 × 3 AZ) | 80 | 240 |
| Aurora Serverless v2 (0.5–4 ACU, 1 instance / 1–16 ACU, writer + reader) + storage, PI | 60 | 450 |
| Fargate ARM64 (9 tasks 0.25 vCPU, mostly Spot / 18+ tasks 0.5–1 vCPU on-demand) | 45 | 450 |
| ALB internal | 20 | 35 |
| API Gateway + CloudFront + S3 | 5 | 40 |
| WAF (ACL + 4 rules + requests) | 10 | 20 |
| CloudWatch (logs, Container Insights, alarms, dashboard), X-Ray | 25 | 120 |
| Secrets Manager, KMS, SQS, EventBridge, SES, Cognito Plus (per MAU) | 10 | 50+ |
| Bedrock / Textract | usage | usage |
| **Total (excl. AI usage)** | **≈ 300** | **≈ 1,500** |

Cheap levers for dev: fewer endpoints (rely on NAT), `xraySidecar: false`, scale services to 0
outside working hours.

## Platform notes / known gaps

- The services' own `build` script (`--packages=external`) leaves `@procure/*` workspace packages
  external; they ship TypeScript, so `node dist/main.js` cannot run it outside the monorepo. The image
  uses `infra/cdk/scripts/bundle-service.mjs` (inlines workspace packages, keeps npm packages external).
- `/ready` checks the database; the ALB checks `/health` so a database blip does not drain every target.
- Distributed tracing: the optional ADOT sidecar is wired, but services do not emit OpenTelemetry yet.
