#!/usr/bin/env bash
# Stages exactly one private VPS candidate.  It does not change Traefik,
# Coolify's legacy application, firewall rules, database schema or workers.
set -euo pipefail

compose=${1:?usage: stage-standby.sh <blue|green> <compose-file> <compose-env-file> <expected-release-commit>}
compose_file=${2:?}
compose_env=${3:?}
expected_release=${4:?}
case "$compose" in blue|green) ;; *) echo "slot must be blue or green" >&2; exit 64;; esac
[[ $(id -u) == 0 ]] || { echo "must run as root on VPS" >&2; exit 65; }
[[ -r "$compose_file" && -r "$compose_env" ]] || { echo "compose inputs unavailable" >&2; exit 66; }
[[ "$expected_release" =~ ^[0-9a-f]{40}$ ]] || { echo "expected release must be a full commit SHA" >&2; exit 67; }

container="cerp-api-${compose}"
docker compose --env-file "$compose_env" -f "$compose_file" config --quiet
# The service name is fixed and has no host port. Starting standby code is safe
# only after preflight proves that it cannot start recurring work.
docker compose --env-file "$compose_env" -f "$compose_file" up -d --no-deps "cerp-api-${compose}"
rollback() {
  docker compose --env-file "$compose_env" -f "$compose_file" stop "cerp-api-${compose}" >/dev/null 2>&1 || true
  echo "VPS_BLUEGREEN_STAGE_ROLLBACK_STOPPED slot=${compose}" >&2
}

if ! "$(dirname "$0")/preflight-vps.sh" "$compose"; then rollback; exit 68; fi
docker inspect "$container" --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -qx "CERP_RELEASE_VERSION=${expected_release}" || {
  rollback; echo "candidate release does not match attested commit" >&2; exit 69;
}
docker inspect "$container" --format '{{json .HostConfig.PortBindings}}' | grep -Eq '^(null|\{\})$' || {
  rollback; echo "candidate unexpectedly publishes a host port" >&2; exit 70;
}
echo "VPS_BLUEGREEN_STAGE_OK slot=${compose} release=${expected_release} route=unchanged workers=off"
