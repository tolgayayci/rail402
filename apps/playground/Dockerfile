# The Rail402 playground API: session bootstrap, USDC dispenser, demo sellers, the upto meter, the
# Agents scene orchestrator, the publish wizard, and facilitator proxies — one Node process.
#
# Deployed as its own Railway service alongside the facilitator (they are separate services in the
# same project). No volume: the playground keeps no durable state of its own — its catalog reads
# proxy the facilitator's Bazaar, and sessions/runs/shares are in-memory by design.
#
# Node 24-slim to match the facilitator image (glibc for @stellar/stellar-sdk). Build context is the
# repo root, so the Railway service's Dockerfile path is apps/playground/Dockerfile.
FROM node:24-slim AS build
WORKDIR /app
RUN corepack enable
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json turbo.json ./
COPY packages ./packages
COPY apps ./apps
COPY scripts ./scripts
# The conformance panel (/conformance) serves the repo's measured status artifacts as evidence.
COPY docs/status ./docs/status
RUN pnpm install --frozen-lockfile --ignore-scripts
# `...` builds the playground's workspace dependencies too (facilitator, bazaar, scheme-upto, etc.).
RUN pnpm --filter @rail402.dev/playground... build
# The self-contained browser bundle served at /lib/browser.js (esbuild, platform=browser). Built
# after tsc so the frontend can import the payment engine from a URL with no build step of its own.
RUN node apps/playground/bundle/build-browser-bundle.mjs

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
EXPOSE 8090
ENV PORT=8090
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8090)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/playground/dist/server/index.js"]
