#!/usr/bin/env bash
set -euo pipefail
compose=${1:?usage: run-rehearsal.sh <compose-file>}
env_file=${CERP_REHEARSAL_ENV_FILE:-/etc/cerp/rehearsal/rehearsal.env}
proxy=cerp-rehearsal-proxy-1710
api=cerp-api-rehearsal-1710
directory=cerp-directory-rehearsal-1710
ready='{"status":"ready"}'
probe() {
  docker exec "$proxy" wget -qO- --header='Host: cerp-rehearsal.internal' http://127.0.0.1:8080/health/ready | grep -q '"status":"ready"'
}
probe_rejected() {
  code=$(docker exec "$proxy" sh -c "wget -S -O /dev/null --header='Host: cerp-rehearsal.internal' http://127.0.0.1:8080/api/v1/auth/me 2>&1 || true" | sed -n 's/.*HTTP\/.* \([0-9][0-9][0-9]\).*/\1/p' | tail -1)
  [[ "$code" == 401 || "$code" == 403 ]]
}
docker inspect "$api" "$proxy" "$directory" >/dev/null
probe || { echo "private readiness failed" >&2; exit 80; }
probe_rejected || { echo "anonymous authentication was not rejected" >&2; exit 81; }
deadline=$((SECONDS + 30))
while (( SECONDS < deadline )); do
  probe || { echo "readiness unstable" >&2; exit 82; }
  sleep 2
done
echo "REHEARSAL_STABLE_30S"
