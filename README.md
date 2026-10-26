# Pro-Cure

Enterprise FF&E procurement platform for hospitality — projects, specs, quotes, vendor costing,
purchase orders, logistics, claims and invoicing, with a vendor portal and a hotel-owner portal.

> Working name. Built for JM Hospitality Solutions.

## Quick start (local)

Requirements: Node 22+, pnpm 10+, PostgreSQL 16 (or Docker).

```bash
pnpm install
docker compose up -d postgres          # or use your own Postgres 16
export PG_SUPERUSER_URL=postgres://postgres:postgres@localhost:5432/postgres
pnpm db:reset                           # create, migrate, seed the JMHS demo data (~15 s)
pnpm dev                                # services + gateway + web
```

To restore the demo data later, stop `pnpm dev` first, then `pnpm db:reset` (the reset refuses to run
while services are up, because the running stack would swallow the seed's cross-service events).

Open http://localhost:5173 and pick a demo user (JMHS staff, a vendor, or a hotel owner).
API index: http://localhost:8080/api · each service's OpenAPI docs: `/api/<service>/docs`.

## Documentation

- [Architecture](docs/architecture.md)
- [Engineering conventions](CLAUDE.md)
- [Demo script](docs/demo-script.md)
- [Service contracts](docs/service-contracts.md)
- [UI guidelines](docs/ui-guidelines.md)
- [Deploying to AWS](docs/deployment.md) · [CDK app](infra/cdk/README.md)

## Demo users

| Surface | Who | Email |
| --- | --- | --- |
| Internal | Sean Hayes (admin) | sean@hubsups.com |
| Internal | Marcus Bell (procurement) | marcus@jmhs-demo.com |
| Internal | Dana Whitfield (project manager) | dana@jmhs-demo.com |
| Internal | Priya Raman (designer) | priya@jmhs-demo.com |
| Internal | Tomás Ortega (logistics) | tomas@jmhs-demo.com |
| Internal | Ellen Cho (accounting) | ellen@jmhs-demo.com |
| Vendor portal | Will Harmon, Carolina Casegoods | will.harmon@carolinacasegoods.example |
| Vendor portal | Kara Lindqvist, Northline Seating | kara@northlineseating.example |
| Owner portal | Hannah Moore (Blue Ridge Hospitality) | hannah@blueridgehg.example |
| Owner portal | Beth Ainsley (Coastal Lodging) | beth@coastallodging.example |

Local login is passwordless (dev only); in AWS sign-in goes through Cognito.

