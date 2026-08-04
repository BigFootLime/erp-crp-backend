#!/bin/sh
set -eu

adduser -D -G node cerp-attacker
mkdir -p /app/data/third-owner/trusted
chown cerp-attacker:node /app/data/third-owner
chmod 0755 /app/data/third-owner
chown node:node /app/data/third-owner/trusted
chmod 0750 /app/data/third-owner/trusted

su-exec node node /usr/local/lib/cerp-upload-storage-security-smoke.mjs setup

if su-exec cerp-attacker mv /app/data/security-smoke/ancestor/expected /app/data/security-smoke/ancestor/replaced; then
  echo "[upload_storage_smoke] same-group expectedRoot rename unexpectedly succeeded" >&2
  exit 1
fi
if su-exec cerp-attacker mv /app/data/security-smoke/ancestor/expected/.private /app/data/security-smoke/ancestor/expected/replaced-private; then
  echo "[upload_storage_smoke] same-group private directory rename unexpectedly succeeded" >&2
  exit 1
fi
if su-exec cerp-attacker sh -c 'printf mutated >> /app/data/security-smoke/ancestor/expected/.private/owned.bin'; then
  echo "[upload_storage_smoke] same-group 0600 mutation unexpectedly succeeded" >&2
  exit 1
fi

su-exec cerp-attacker ln -s /tmp /app/data/security-smoke/ancestor/expected/attacker-link
su-exec cerp-attacker mkdir /app/data/security-smoke/ancestor/expected/attacker-directory
su-exec node node /usr/local/lib/cerp-upload-storage-security-smoke.mjs verify-attacker

su-exec node node /usr/local/lib/cerp-upload-preflight-security-smoke.mjs prepare
mkdir -p /app/data/preflight-smoke/postgres /app/data/preflight-smoke/inbound/integrations
printf '16' > /app/data/preflight-smoke/postgres/PG_VERSION
printf 'external' > /app/data/preflight-smoke/inbound/integrations/external.csv
chown cerp-attacker:node \
  /app/data/preflight-smoke/postgres \
  /app/data/preflight-smoke/postgres/PG_VERSION \
  /app/data/preflight-smoke/inbound/integrations \
  /app/data/preflight-smoke/inbound/integrations/external.csv
chmod 0750 /app/data/preflight-smoke/postgres /app/data/preflight-smoke/inbound/integrations
chmod 0640 /app/data/preflight-smoke/postgres/PG_VERSION /app/data/preflight-smoke/inbound/integrations/external.csv
su-exec node node /usr/local/lib/cerp-upload-preflight-security-smoke.mjs migrate

# Put the undiscoverable link in the final independent traversal root. Earlier
# roots deliberately need migration: a failed full inventory must leave every
# one of them byte-for-byte and metadata-for-metadata unchanged.
chmod 2770 \
  /app/data/preflight-smoke/documents \
  /app/data/preflight-smoke/generated \
  /app/data/preflight-smoke/tmp
chmod 0660 /app/data/preflight-smoke/documents/document.pdf
printf 'outside-allowlist' > /app/data/preflight-smoke/ged/external-hardlink-source.bin
chown node:node /app/data/preflight-smoke/ged/external-hardlink-source.bin
chmod 0660 /app/data/preflight-smoke/ged/external-hardlink-source.bin
ln /app/data/preflight-smoke/ged/external-hardlink-source.bin /app/data/preflight-smoke/postgres/external-hardlink.bin
su-exec node node /usr/local/lib/cerp-upload-preflight-security-smoke.mjs reject-external-hardlink
