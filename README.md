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
pnpm db:reset                           # create, migrate, seed the JMHS demo data
pnpm dev                                # services + gateway + web
```

Open http://localhost:5173 and pick a demo user (JMHS staff, a vendor, or a hotel owner).
API index: http://localhost:8080/api · each service's OpenAPI docs: `/api/<service>/docs`.

## Documentation

- [Architecture](docs/architecture.md)
- [Engineering conventions](CLAUDE.md)
- [Demo script](docs/demo-script.md)
- [Deploying to AWS](infra/cdk/README.md)
