# The hosted MCP discovery server, as its own Node process.
#
# Separate from the facilitator image on purpose: this is a stateless agent-facing surface (search +
# a budget-capped paid-call proxy over MCP Streamable HTTP). It holds no settlement keys and mounts no
# volume, so — unlike the facilitator — it runs as the unprivileged `node` user directly, with no
# gosu privilege-drop dance. It reaches the Bazaar over HTTP via BAZAAR_URL (the live facilitator).
#
# Build context is the REPO ROOT (pnpm workspace), not this directory, so the Dockerfile path is
# passed to the builder while the context stays `.`.
FROM node:24-slim AS build
WORKDIR /app
RUN corepack enable
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json turbo.json ./
COPY packages ./packages
COPY apps ./apps
COPY scripts ./scripts
# `--frozen-lockfile` so the image can never resolve a different dependency tree than the one the
# licence gate scanned.
RUN pnpm install --frozen-lockfile --ignore-scripts
# `...` builds this package's workspace dependencies too (@rail402.dev/agent-helpers, errors,
# scheme-upto-stellar). No copy-weights step here — the search embedding blob lives in the Bazaar, not
# in this server.
RUN pnpm --filter @rail402.dev/mcp-discovery... build

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
# Stateless and keyless: no volume to chown, no privilege to drop. Run as the base image's
# unprivileged user rather than root.
USER node
EXPOSE 8080
ENV PORT=8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/mcp-discovery/dist/serve-http.js"]
