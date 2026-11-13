# --------- Build (TS) ----------
# Node 24 is the current production LTS. The multi-platform OCI index and the
# Alpine release are immutable/coherent across builder and runtime stages.
FROM node:24.18.0-alpine3.24@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS builder
WORKDIR /app
ENV CI=true
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
# `npm run build` executes the production-data boundary before and after tsc.
# Keep that guard inside the container build used by Coolify and HyperBox2.
COPY scripts/openapi ./scripts/openapi
COPY docs/http/openapi-route-coverage.json ./docs/http/openapi-route-coverage.json
COPY scripts/security ./scripts/security
COPY scripts/build ./scripts/build
COPY resources/outillage-catalogue ./resources/outillage-catalogue
RUN npm run build

# --------- Runtime ------------
FROM node:24.18.0-alpine3.24@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS runtime
ARG SOURCE_COMMIT=unknown
WORKDIR /app
# Keep the fixed v3.24 security patches below. The digest-pinned Node base
# still contains the older OpenSSL and zlib builds.
RUN printf '%s\n' \
      "https://dl-cdn.alpinelinux.org/alpine/v3.24/main" \
      "https://dl-cdn.alpinelinux.org/alpine/v3.24/community" \
      > /etc/apk/repositories \
  && apk add --no-cache \
    "libcrypto3=3.5.9-r0" \
    "libssl3=3.5.9-r0" \
    "zlib=1.3.2-r1" \
    "curl=8.23.0-r0" \
    "tini=0.19.0-r3" \
    "su-exec=0.3-r0" \
    "clamav=1.4.6-r0" \
    "clamav-daemon=1.4.6-r0" \
    "clamav-clamdscan=1.4.6-r0" \
    "freshclam=1.4.6-r0" \
  && addgroup node clamav

COPY docker/clamd.conf /etc/clamav/clamd.conf
COPY docker/freshclam.conf /etc/clamav/freshclam.conf
COPY docker/entrypoint.sh /usr/local/bin/cerp-entrypoint.sh
COPY docker/scanner-smoke.mjs /usr/local/lib/cerp-scanner-smoke.mjs
COPY docker/storage-preflight.mjs /usr/local/lib/cerp-storage-preflight.mjs
COPY docker/upload-storage-security-smoke.mjs /usr/local/lib/cerp-upload-storage-security-smoke.mjs
COPY docker/upload-preflight-security-smoke.mjs /usr/local/lib/cerp-upload-preflight-security-smoke.mjs
COPY docker/upload-storage-security-smoke.sh /usr/local/bin/cerp-upload-storage-security-smoke.sh
RUN sed -i 's/\r$//' \
      /etc/clamav/clamd.conf \
      /etc/clamav/freshclam.conf \
      /usr/local/bin/cerp-entrypoint.sh \
      /usr/local/bin/cerp-upload-storage-security-smoke.sh \
  && chmod 0755 /usr/local/bin/cerp-entrypoint.sh /usr/local/bin/cerp-upload-storage-security-smoke.sh

# ne force PAS NODE_ENV ici: laisse Coolify le définir côté runtime
COPY package*.json ./
RUN npm ci --omit=dev

# The final image executes `node dist/index.js`; it never invokes npm or
# Corepack. They remain available in the builder stage for reproducible
# installs, but removing their global dependency graph prevents package-manager
# CVEs from becoming runtime attack surface.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
  && rm -f \
    /usr/local/bin/npm \
    /usr/local/bin/npx \
    /usr/local/bin/corepack \
    /usr/local/bin/pnpm \
    /usr/local/bin/pnpx \
    /usr/local/bin/yarn \
    /usr/local/bin/yarnpkg

# Ship the exact migration inventory and runner with the release image. This
# keeps operator-driven preflight/apply/status commands pinned to SOURCE_COMMIT
# instead of relying on an unrelated host checkout.
COPY scripts/db-patches.js ./scripts/db-patches.js
COPY scripts/migrations/patch-dependencies.js ./scripts/migrations/patch-dependencies.js
COPY db/patches ./db/patches
COPY resources/outillage-catalogue ./resources/outillage-catalogue

# ...
COPY --from=builder /app/dist ./dist
RUN mkdir -p \
    /app/data/documents \
    /app/data/generated \
    /app/data/inbound \
    /app/data/exports \
    /app/data/tmp \
    /app/uploads \
  && chown node:node \
    /app/data \
    /app/data/documents \
    /app/data/generated \
    /app/data/inbound \
    /app/data/exports \
    /app/data/tmp \
    /app/uploads \
  && chmod 0750 /app/data \
  && chmod 0700 \
    /app/data/documents \
    /app/data/generated \
    /app/data/inbound \
    /app/data/exports \
    /app/data/tmp \
    /app/uploads
ENV PORT=5000
ENV CERP_RELEASE_VERSION=${SOURCE_COMMIT}
ENV CERP_DOCUMENTS_ROOT=/app/data/documents
ENV CERP_UPLOAD_SCAN_MODE=enforce
ENV CERP_UPLOAD_SCAN_PROVIDER=clamdscan
ENV CERP_UPLOAD_SCANNER_COMMAND=clamdscan
EXPOSE 5000
# ...


VOLUME ["/app/data", "/app/uploads", "/var/lib/clamav"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||5000)+'/health/ready',r=>{if(r.statusCode===200)process.exit(0);process.exit(1)}).on('error',()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/cerp-entrypoint.sh"]
CMD ["node", "dist/index.js"]
