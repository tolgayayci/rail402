# syntax=docker/dockerfile:1.7
# A standalone image of the example seller, installed from the npm registry:
#   docker build -t rail402-seller-http examples/seller-http
#   docker run --rm -p 4021:4021 -e PAY_TO=G... rail402-seller-http
ARG NODE_IMAGE=node:24.19.0-trixie-slim

FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    PORT=4021
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY src ./src
USER node
EXPOSE 4021
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "src/main.ts"]
