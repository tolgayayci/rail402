# syntax=docker/dockerfile:1.7
# The clean-environment docs check: a fresh Node.js image with no checkout of the repository, only this
# script. It follows the published quickstarts on the Stellar testnet and prints a JSON record.
#   docker build -t rail402-docs-check tools/docs-check
#   docker run --rm rail402-docs-check                                  # payment only
#   docker run --rm --network host rail402-docs-check --public-url https://docs-check.example.com
# With --public-url, that host must forward to port 4021 of the container (a TLS proxy or tunnel you run).
ARG NODE_IMAGE=node:24.19.0-trixie-slim
FROM ${NODE_IMAGE}
WORKDIR /check
COPY src ./
USER node
ENTRYPOINT ["node", "main.ts"]
