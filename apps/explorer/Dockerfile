# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
# The Explorer image: one image for both roles, chosen by EXPLORER_ROLE (or the first argument).
#   web       public pages and the read API, as the database reader role (port 8080)
#   indexer   registry-scope indexing and live tail, as the writer role (health and metrics on 9464)
# Build from the repository root:
#   docker build -f apps/explorer/Dockerfile -t rail402-explorer .
ARG NODE_IMAGE=node:24.19.0-trixie-slim@sha256:ab3eebe934147fee049b5eb83c570f68c849a13c930bdfa482de99fcdfa3b3de

FROM ${NODE_IMAGE} AS build
RUN npm install --global pnpm@11.22.0 && npm cache clean --force
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --filter "@rail402.dev/explorer..."
# The workspace packages the Explorer imports are built to dist; the Explorer runs its own TypeScript.
RUN pnpm --filter "@rail402.dev/explorer^..." run build
# A self-contained copy with production dependencies only: the Explorer's src, migrations and SQL
# templates and its dependencies' published files. No tests, fixtures or other workspace files.
RUN pnpm --filter @rail402.dev/explorer deploy --prod --legacy /out \
  && test -f /out/src/main.ts && test ! -e /out/test

FROM ${NODE_IMAGE} AS runtime
ARG RAIL402_COMMIT=""
ENV NODE_ENV=production \
    EXPLORER_PORT=8080 \
    EXPLORER_HOST=0.0.0.0 \
    EXPLORER_HEALTH_HOST=0.0.0.0 \
    RAIL402_COMMIT=${RAIL402_COMMIT}
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
EXPOSE 8080 9464
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=3 \
  CMD ["node", "-e", "const p=process.env.EXPLORER_ROLE==='indexer'?(process.env.EXPLORER_HEALTH_PORT||9464):process.env.EXPLORER_PORT;fetch('http://127.0.0.1:'+p+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["node", "src/main.ts"]
