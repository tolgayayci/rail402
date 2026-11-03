# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
# The hosted, discovery-only MCP endpoint (rail402-mcp --hosted). Build from the repository root:
#   docker build -f packages/mcp/Dockerfile -t rail402-mcp-hosted .
# It holds no key: it refuses to start when RAIL402_SECRET_KEY, RAIL402_SECRET_KEY_FILE or
# RAIL402_MCP_TOKEN is set. Configure RAIL402_MCP_UPSTREAM (the Bazaar) and PUBLIC_HOSTS.
ARG NODE_IMAGE=node:24.19.0-trixie-slim@sha256:ab3eebe934147fee049b5eb83c570f68c849a13c930bdfa482de99fcdfa3b3de

FROM ${NODE_IMAGE} AS build
RUN npm install --global pnpm@11.22.0 && npm cache clean --force
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --filter "@rail402.dev/mcp..."
RUN pnpm --filter "@rail402.dev/mcp..." run build
# A self-contained copy of the server with production dependencies only.
RUN pnpm --filter @rail402.dev/mcp deploy --prod --legacy /out

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    PORT=8080 \
    METRICS_PORT=9464
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
# 8080: the MCP endpoint (/mcp/testnet, /mcp/pubnet). 9464: /metrics, for the internal network only.
EXPOSE 8080 9464
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.METRICS_PORT+'/metrics').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "dist/bin.js", "--hosted"]
