# @procure/infra-cdk

AWS CDK v2 app for Pro-Cure. Full guide: [docs/deployment.md](../../docs/deployment.md).

```bash
pnpm install --filter @procure/infra-cdk
cd infra/cdk
npx tsc --noEmit -p .                       # typecheck (also covers infra/lambda/*)
npx cdk synth -c stage=dev                  # all stacks; no AWS credentials or Docker needed
npx cdk deploy --all -c stage=dev -c imageTag=<git-sha> -c account=<id>
pnpm gen:subscriptions                      # regenerate lib/subscriptions.ts from services/*/src/service.ts
```

| Path | |
| --- | --- |
| `bin/app.ts` | entry; wires stacks for the `stage` context |
| `config/<stage>.ts` | per-stage settings (account, domains, sizing, alarms, SSO) |
| `lib/stacks/*` | Network, Ecr, Data, Events, Platform, Api, Web, Auth, Services, Email, Observability |
| `lib/subscriptions.ts` | generated event-type → service map (EventBridge rules) |
| `scripts/bundle-service.mjs` | production bundler used by `services/Dockerfile` |
| `../lambda/*` | db-bootstrap, secrets-bootstrap, inbound-email (bundled locally with esbuild) |

Context: `stage` (dev|staging|prod), `imageTag` (default `latest`), `account`, `region`.
The CDK app runs under tsx with `tsconfig.runtime.json`; `tsconfig.json` is for type-checking only.
