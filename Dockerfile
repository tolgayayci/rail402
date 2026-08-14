# The full service: facilitator + Bazaar + discovery, in one Node process.
#
# Why the whole thing rather than a Bazaar-only image: cataloging is not a separate write path. A
# listing enters the catalog from inside the facilitator's own /verify and /settle handlers
# (`catalogProvisionalPayment` / `catalogSettledPayment`), and there is no ingest endpoint. A
# standalone Bazaar can therefore only ever serve an empty catalog — so settlement and discovery ship
# together or discovery ships empty.
#
# Node 24: `node:sqlite` (catalog durability) needs >= 22.5, and the repo's engines field says
# >= 22.12. Slim rather than alpine because @stellar/stellar-sdk pulls native-ish deps that expect
# glibc.
FROM node:24-slim AS build
WORKDIR /app
RUN corepack enable
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json turbo.json ./
COPY packages ./packages
COPY apps ./apps
COPY scripts ./scripts
# `--frozen-lockfile` so the image can never silently resolve a different dependency tree than the
# one the licence gate scanned.
RUN pnpm install --frozen-lockfile --ignore-scripts
# Turbo builds the facilitator's workspace dependencies too. This also runs copy-weights.mjs, which
# is what puts the search embedding blob into dist — `tsc` does not copy a .bin.
RUN pnpm --filter @rail402/facilitator... build

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
# gosu lets the entrypoint drop privileges cleanly (re-exec, correct signal handling as PID 1).
RUN apt-get update && apt-get install -y --no-install-recommends gosu && rm -rf /var/lib/apt/lists/*
# Catalog durability lives here. Mount a volume at /data on any host that offers one; without it the
# catalog rebuilds from settlement history after an instance is replaced. The `node` base image ships
# an unprivileged `node` user; the entrypoint chowns /data to it and drops to it (F9), so the process
# holding settlement keys never runs as root. Managed hosts (Railway, Fly) mount the volume
# root-owned, which is why the chown-then-drop happens at runtime rather than here at build.
RUN mkdir -p /data && chown node:node /data
COPY --from=build /app /app
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
EXPOSE 8080
ENV PORT=8080 HOST=0.0.0.0 CATALOG_DB_PATH=/data/catalog.db
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "apps/facilitator/dist/index.js"]
