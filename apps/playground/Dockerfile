# syntax=docker/dockerfile:1.7
# The Playground image: the server and the built page. Build from the repository root:
#   docker build -f apps/playground/Dockerfile -t rail402-playground .
ARG NODE_IMAGE=node:24.19.0-trixie-slim

FROM ${NODE_IMAGE} AS build
RUN npm install --global pnpm@11.22.0 && npm cache clean --force
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --filter "@rail402.dev/playground..."
# The server runs its own TypeScript directly; the workspace packages it imports are built to dist.
RUN pnpm --filter-prod "@rail402.dev/playground^..." run build
# The page, built from the workspace sources into web/dist.
RUN pnpm --filter @rail402.dev/playground run build
# A self-contained copy of the server and the page with production dependencies only.
RUN pnpm --filter @rail402.dev/playground deploy --prod --legacy /out \
  && test -f /out/web/dist/index.html

FROM ${NODE_IMAGE} AS runtime
ARG RAIL402_COMMIT=""
ENV NODE_ENV=production \
    PORT=8080 \
    RAIL402_COMMIT=${RAIL402_COMMIT}
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "src/main.ts"]
