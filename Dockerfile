# syntax=docker/dockerfile:1.7
# Rail402 service image. Debian (glibc) base: the embedding runtime used by search needs glibc.
ARG NODE_IMAGE=node:24.19.0-trixie-slim

FROM ${NODE_IMAGE} AS build
RUN npm install --global pnpm@11.22.0 && npm cache clean --force
WORKDIR /repo
# Resolve dependencies from the lockfile alone, so source edits keep this layer cached.
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch
COPY . .
RUN pnpm install --offline --frozen-lockfile
RUN pnpm --filter "@rail402.dev/service..." run build
# The pinned embedding model, verified against its manifest hashes.
RUN pnpm models:fetch /models
# A self-contained copy of the service with production dependencies only.
RUN pnpm --filter @rail402.dev/service deploy --prod --legacy /out \
  # onnxruntime-node bundles binaries for every platform; the image only runs on Linux.
  && find /out/node_modules -type d -path "*onnxruntime-node/bin/napi-v6/*" \( -name win32 -o -name darwin \) -prune -exec rm -rf {} +

FROM ${NODE_IMAGE} AS runtime
ARG RAIL402_VERSION=dev
ENV NODE_ENV=production \
    RAIL402_VERSION=${RAIL402_VERSION} \
    PORT=8080 \
    SEARCH_MODEL_DIR=/app/models
WORKDIR /app
COPY --from=build --chown=node:node /out ./
COPY --from=build --chown=node:node /models ./models
USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "dist/main.js"]
