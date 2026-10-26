# syntax=docker/dockerfile:1.7
#
# One image recipe for every backend service, plus the migration runner.
#
#   docker buildx build --platform linux/arm64 -f services/Dockerfile --build-arg SERVICE=identity -t … .
#   docker buildx build --platform linux/arm64 -f services/Dockerfile --build-arg SERVICE=tools    -t … .
#
# Build context is the repo root (see /.dockerignore).
#
# SERVICE=<name>  → CMD node dist/main.js  (listens on its port from packages/domain/src/services.ts)
# SERVICE=tools   → CMD node dist-tools/migrate.mjs (applies packages/platform + services/*/migrations)
#
# Bundling: infra/cdk/scripts/bundle-service.mjs inlines the workspace TypeScript packages
# (@procure/domain, @procure/platform) and leaves third-party packages external; those come from
# `pnpm deploy --prod`. (The services' own `build` script keeps workspace packages external, which
# plain `node` cannot load because they ship .ts sources.)
#
# DATABASE_URL / MIGRATION_DATABASE_URL are assembled at start by the entrypoint from DB_HOST,
# DB_PORT, DB_NAME, DB_SSLMODE and DB_USER/DB_PASSWORD (MIGRATION_DB_USER/…_PASSWORD) injected by ECS
# from Secrets Manager. A DATABASE_URL already in the environment wins.

ARG NODE_VERSION=22

# ---------------------------------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS builder
ARG SERVICE
RUN test -n "$SERVICE" || (echo "build arg SERVICE is required" && exit 1)
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /repo

# Manifests first for layer caching. Every workspace manifest is copied so the frozen lockfile matches.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/domain/package.json packages/domain/
COPY packages/platform/package.json packages/platform/
COPY tools/package.json tools/
COPY apps/web/package.json apps/web/
COPY infra/cdk/package.json infra/cdk/
COPY services/ai/package.json services/ai/
COPY services/catalog/package.json services/catalog/
COPY services/comms/package.json services/comms/
COPY services/documents/package.json services/documents/
COPY services/finance/package.json services/finance/
COPY services/gateway/package.json services/gateway/
COPY services/identity/package.json services/identity/
COPY services/orders/package.json services/orders/
COPY services/projects/package.json services/projects/
COPY services/quoting/package.json services/quoting/

# Install only what this image needs: the target package + its workspace deps, and the root (tsx →
# esbuild for bundling).
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    PKG=$([ "$SERVICE" = "tools" ] && echo "@procure/tools" || echo "@procure/$SERVICE") && \
    pnpm install --frozen-lockfile --filter "$PKG..." --filter "pro-cure"

COPY packages packages
COPY services services
COPY tools tools
COPY infra/cdk/scripts/bundle-service.mjs infra/cdk/scripts/bundle-service.mjs

RUN node infra/cdk/scripts/bundle-service.mjs "$SERVICE"

# Production node_modules for the target (flat layout so bundled imports resolve from /app/node_modules).
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    PKG=$([ "$SERVICE" = "tools" ] && echo "@procure/tools" || echo "@procure/$SERVICE") && \
    pnpm --filter "$PKG" deploy --prod --legacy --config.node-linker=hoisted /out && \
    rm -rf /out/src /out/test /out/tsconfig.json /out/vitest.config.ts

# Lay out /out as the runtime /app.
RUN set -e; \
    if [ "$SERVICE" = "tools" ]; then \
      mkdir -p /out/dist-tools /out/packages/platform && \
      cp dist-tools/* /out/dist-tools/ && \
      cp -r packages/platform/migrations /out/packages/platform/migrations && \
      for d in services/*/; do \
        name=$(basename "$d"); \
        if [ -d "$d/migrations" ]; then mkdir -p "/out/services/$name" && cp -r "$d/migrations" "/out/services/$name/migrations"; fi; \
      done; \
    else \
      mkdir -p /out/dist && cp services/$SERVICE/dist/* /out/dist/; \
    fi

# ---------------------------------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS runtime
ARG SERVICE
RUN apk add --no-cache tini
# RDS CA bundle: DB_SSLMODE=verify-full verifies Aurora's certificate against it.
ADD --chmod=644 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /etc/ssl/certs/rds-global-bundle.pem

COPY <<'EOF' /usr/local/bin/docker-entrypoint.sh
#!/bin/sh
set -e
pg_url() {
  printf 'postgres://%s:%s@%s:%s/%s?sslmode=%s' "$1" "$2" "$DB_HOST" "${DB_PORT:-5432}" "${DB_NAME:-procure}" "${DB_SSLMODE:-verify-full}"
}
if [ -z "$DATABASE_URL" ] && [ -n "$DB_USER" ] && [ -n "$DB_HOST" ]; then
  DATABASE_URL="$(pg_url "$DB_USER" "$DB_PASSWORD")"; export DATABASE_URL
fi
if [ -z "$MIGRATION_DATABASE_URL" ] && [ -n "$MIGRATION_DB_USER" ] && [ -n "$DB_HOST" ]; then
  MIGRATION_DATABASE_URL="$(pg_url "$MIGRATION_DB_USER" "$MIGRATION_DB_PASSWORD")"; export MIGRATION_DATABASE_URL
fi
unset DB_PASSWORD MIGRATION_DB_PASSWORD
exec "$@"
EOF
RUN chmod 755 /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production \
    NODE_EXTRA_CA_CERTS=/etc/ssl/certs/rds-global-bundle.pem \
    SERVICE=${SERVICE}
WORKDIR /app
COPY --from=builder --chown=node:node /out /app
USER node

# Informational for `docker run`; ECS uses the task definition health check. Each service's port comes
# from PORT (set by the task definition) — fall back to the identity port.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD [ "$SERVICE" = "tools" ] || wget -q -O /dev/null "http://127.0.0.1:${PORT:-4001}/health" || exit 1

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["/bin/sh", "-c", "if [ \"$SERVICE\" = tools ]; then exec node dist-tools/migrate.mjs; else exec node dist/main.js; fi"]
