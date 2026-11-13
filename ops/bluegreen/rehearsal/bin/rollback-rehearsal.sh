#!/usr/bin/env bash
set -euo pipefail
compose=${1:?usage: rollback-rehearsal.sh <compose-file>}
env_file=${CERP_REHEARSAL_ENV_FILE:-/etc/cerp/rehearsal/rehearsal.env}
# This only removes named rehearsal containers/networks. It never drops the clone.
docker compose --env-file "$env_file" -f "$compose" down --remove-orphans
echo "REHEARSAL_CONTAINERS_REMOVED_CLONE_RETAINED"
