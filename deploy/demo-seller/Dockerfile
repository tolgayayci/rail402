# Standalone container for the Rail402 demo seller. Self-contained: it installs only its own stock
# @x402 dependencies, so it builds without the monorepo and stays out of the license gate (like
# deploy/apex-redirect). Railway builds this with the service root set to deploy/demo-seller.
FROM node:24-slim

WORKDIR /app

# Install deps first for layer caching. No lockfile is committed (a tiny stock-only dep set), so
# npm install resolves the pinned @x402 versions at build time.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server.mjs ./

ENV PORT=8080
EXPOSE 8080

# The app reads process.env.PORT; Railway sets it. /health answers without a payment.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
