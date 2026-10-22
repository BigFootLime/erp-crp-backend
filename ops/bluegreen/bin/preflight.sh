#!/usr/bin/env bash
set -euo pipefail

slot=${1:?usage: preflight.sh <blue|green> <slot-env-file>}
env_file=${2:?usage: preflight.sh <blue|green> <slot-env-file>}
case "$slot" in blue) expected_port=18080;; green) expected_port=18081;; *) exit 64;; esac
[[ -r "$env_file" ]] || { echo "slot environment unavailable" >&2; exit 65; }

# shellcheck disable=SC1090
set -a; source "$env_file"; set +a
[[ ${PORT:-} == "$expected_port" ]] || { echo "unexpected loopback port" >&2; exit 66; }
[[ ${CERP_STANDBY:-} == true ]] || { echo "standby guard required" >&2; exit 67; }
[[ -n ${CERP_RELEASE_DIR:-} && -r "$CERP_RELEASE_DIR/dist/index.js" ]] || { echo "immutable release missing" >&2; exit 68; }
[[ ${AUTH_RATE_LIMIT_STORE:-postgres} == postgres ]] || { echo "rate-limit store must be postgres" >&2; exit 69; }
[[ -n ${AUTH_RATE_LIMIT_HASH_KEY:-} && -n ${JWT_SECRET:-} ]] || { echo "shared auth configuration missing" >&2; exit 70; }
[[ -n ${CERP_GED_VAULT_ROOT:-} && -n ${CERP_GED_SENTINEL:-} ]] || { echo "GED sentinel configuration missing" >&2; exit 71; }
[[ -n ${MFA_ROOT_KEY:-} && -n ${MFA_KEY_ID:-} ]] || { echo "shared MFA configuration missing" >&2; exit 72; }
[[ ${CERP_SHARED_DIRECTORY_ENABLED:-} == true && -n ${CERP_DIRECTORY_ENDPOINT:-} && -n ${CERP_SHARED_DIRECTORY_SITE:-} && -n ${CERP_SHARED_DIRECTORY_ID:-} && -n ${CERP_DIRECTORY_SITE_CALL_KEY:-} ]] || { echo "shared-directory configuration missing" >&2; exit 72; }
[[ -n ${CERP_IMAGES_ROOT:-} ]] || { echo "operational images configuration missing" >&2; exit 72; }
curl --fail --silent --show-error --max-time 5 "http://127.0.0.1:${PORT}/health/ready" | grep -q '"status":"ready"'
echo "BLUEGREEN_PREFLIGHT_OK slot=${slot} port=${PORT}"
