# syntax=docker/dockerfile:1.7
# The demo seller image. Build from the repository root:
#   docker build -f apps/demo-seller/Dockerfile -t rail402-demo-seller .
ARG NODE_IMAGE=node:24.19.0-trixie-slim

FROM ${NODE_IMAGE} AS build
RUN npm install --global pnpm@11.22.0 && npm cache clean --force
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --filter "@rail402.dev/demo-seller..."
# A self-contained copy of the seller with production dependencies only. Node runs its TypeScript directly.
RUN pnpm --filter @rail402.dev/demo-seller deploy --prod --legacy /out

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    PORT=8080
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
EXPOSE 8080
CMD ["node", "src/main.ts"]
