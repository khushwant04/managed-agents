# syntax=docker/dockerfile:1.7
#
# Dashboard image (Next.js standalone output).
#
#   docker build -t managed-agents-dashboard dashboard
#   docker run --rm -p 3000:3000 -e AGENTS_API_URL=http://gateway:8080 managed-agents-dashboard
#
# Environment:
#   AGENTS_API_URL             the Managed Agents API the dashboard proxies to (default http://localhost:8080)
#   AGENTS_API_URL_ALLOWLIST   optional comma-separated extra API URLs users may pick at sign-in
#   DASHBOARD_INSECURE_COOKIES set to 1 only to drop the Secure flag when TLS is terminated elsewhere without X-Forwarded-Proto
#
# lib/api-types.ts is committed (generated from docs/api/openapi.json by `npm run generate`),
# so the build context is just this directory.

ARG NODE_VERSION=22.22.0

FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    AGENTS_API_URL=http://localhost:8080
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/signin').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
