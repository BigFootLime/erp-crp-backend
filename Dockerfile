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
COPY scripts/security ./scripts/security
RUN npm run build

# --------- Runtime ------------
FROM node:24.18.0-alpine3.24@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS runtime
WORKDIR /app
RUN printf '%s\n' \
      "https://dl-cdn.alpinelinux.org/alpine/v3.24/main" \
      "https://dl-cdn.alpinelinux.org/alpine/v3.24/community" \
      > /etc/apk/repositories \
  && apk add --no-cache \
    "curl=8.21.0-r0" \
    "tini=0.19.0-r3" \
    "su-exec=0.3-r0" \
    "clamav=1.4.5-r0" \
    "clamav-daemon=1.4.5-r0" \
    "clamav-clamdscan=1.4.5-r0" \
    "freshclam=1.4.5-r0" \
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
