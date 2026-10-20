#!/usr/bin/env bash
set -euo pipefail
slot=${1:?usage: preflight-vps.sh <blue|green>}
case "$slot" in blue|green) ;; *) exit 64;; esac
container="cerp-api-${slot}"
docker network inspect coolify >/dev/null
docker inspect "$container" >/dev/null
[[ $(df --output=avail -BG /data | tail -1 | tr -dc '0-9') -ge 8 ]] || { echo "insufficient disk reserve" >&2; exit 65; }
[[ $(awk '/MemAvailable:/{print int($2/1024/1024)}' /proc/meminfo) -ge 6 ]] || { echo "insufficient memory reserve" >&2; exit 66; }
# Do not print environment. This asserts all shared safety inputs are present.
for key in JWT_SECRET AUTH_RATE_LIMIT_HASH_KEY DATABASE_URL MFA_ROOT_KEY MFA_KEY_ID CERP_DIRECTORY_ENDPOINT CERP_SHARED_DIRECTORY_SITE CERP_SHARED_DIRECTORY_ID CERP_DIRECTORY_SITE_CALL_KEY CERP_GED_VAULT_ROOT CERP_GED_SENTINEL CERP_IMAGES_ROOT; do
  docker inspect "$container" --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -Eq "^${key}=.+" || { echo "missing required shared setting: $key" >&2; exit 67; }
done
docker inspect "$container" --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -qx 'CERP_SHARED_DIRECTORY_ENABLED=true' || { echo "shared directory must be enabled" >&2; exit 67; }
docker inspect "$container" --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -qx 'CERP_STANDBY=true' || { echo "candidate must remain in standby during preflight" >&2; exit 67; }
docker inspect "$container" --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -qx 'CERP_BACKGROUND_WORKERS=off' || { echo "candidate must disable background workers during preflight" >&2; exit 67; }
docker exec coolify-proxy wget -qO- "http://${container}:5000/health/ready" | grep -q '"status":"ready"'
echo "VPS_BLUEGREEN_PREFLIGHT_OK slot=${slot}"
