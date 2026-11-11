# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS frontend-build
WORKDIR /app
COPY package.json package-lock.json ./
# Optional CA support for managed build proxies; no certificate remains in a layer.
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then \
      NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca npm ci --strict-ssl=true; \
    else npm ci --strict-ssl=true; fi
COPY index.html vite.config.js ./
COPY src ./src
COPY public ./public
COPY shared ./shared
RUN npm run build

FROM node:24-bookworm-slim AS server-dependencies
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then \
      NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca npm ci --omit=dev --strict-ssl=true; \
    else npm ci --omit=dev --strict-ssl=true; fi

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3001 \
    SERVE_FRONTEND=true
WORKDIR /app
# Copy executable sources explicitly; private runtime files and test fixtures
# must not enter the final image when they are present in a local checkout.
COPY --chown=node:node server/*.js server/package.json server/package-lock.json ./server/
COPY --from=server-dependencies --chown=node:node /app/server/node_modules ./server/node_modules
COPY --chown=node:node shared ./shared
# Existing server email templates also use this browser-independent formatter.
COPY --chown=node:node src/utils/bookingDates.js ./src/utils/bookingDates.js
COPY --chown=node:node package.json ./package.json
COPY --chown=node:node scripts/check-launch.js ./scripts/check-launch.js
COPY --from=frontend-build --chown=node:node /app/dist ./dist
USER node
EXPOSE 3001
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["node", "--input-type=module", "-e", "try { const response = await fetch('http://127.0.0.1:' + (process.env.PORT || '3001') + '/api/health', {signal: AbortSignal.timeout(4000), redirect: 'error'}); process.exit(response.ok ? 0 : 1); } catch { process.exit(1); }"]
CMD ["node", "server/index.js"]
