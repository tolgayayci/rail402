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
RUN pnpm --filter @x402-stellar/facilitator... build

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
# Catalog durability lives here. Mount a volume at /data on any host that offers one; without it the
# catalog rebuilds from settlement history after an instance is replaced. The container runs as root
# because managed hosts (Railway, Fly) mount the volume root-owned, and a non-root user cannot open a
# database file under it (SQLITE_CANTOPEN). Container isolation is provided by the platform, not the
# uid; a privilege-dropping entrypoint (chown /data then exec as an unprivileged user) is the harden.
RUN mkdir -p /data
COPY --from=build /app /app
EXPOSE 8080
ENV PORT=8080 HOST=0.0.0.0 CATALOG_DB_PATH=/data/catalog.db
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/facilitator/dist/index.js"]
