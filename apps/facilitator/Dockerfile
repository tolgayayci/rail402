# Multi-stage build for the x402 Stellar facilitator.
# Self-hosting is a first-class path, so this image is the same artifact we deploy.

FROM node:22-alpine AS build
WORKDIR /repo
RUN corepack enable

# Copy manifests first so dependency installation caches independently of source changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/errors/package.json packages/errors/
COPY apps/facilitator/package.json apps/facilitator/
RUN pnpm install --frozen-lockfile

COPY packages/errors packages/errors
COPY apps/facilitator apps/facilitator
RUN pnpm --filter @rail402/errors build \
 && pnpm --filter @rail402/facilitator build \
 && pnpm deploy --filter @rail402/facilitator --prod /out

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Run unprivileged: this process holds settlement keys.
USER node
COPY --from=build --chown=node:node /out /app
EXPOSE 4022
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4022)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
