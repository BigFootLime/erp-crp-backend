#!/usr/bin/env bash
set -euo pipefail

slot=${1:?usage: switch-apache-upstream.sh <blue|green> <previous-api> <managed-api> <previous-ged> <managed-ged> <apache-configtest-command>}
previous_api=${2:?}
managed_api=${3:?}
previous_ged=${4:?}
managed_ged=${5:?}
configtest=${6:?}
root=$(cd "$(dirname "$0")/.." && pwd)
case "$slot" in blue) port=18080;; green) port=18081;; *) exit 64;; esac
[[ -r "$previous_api" && -r "$previous_ged" ]] || { echo "prior Apache fragment unavailable" >&2; exit 65; }
[[ $(id -u) == 0 ]] || { echo "must run as root on HYPERBOX2" >&2; exit 66; }
tmp_api=$(mktemp "${managed_api}.new.XXXXXX")
tmp_ged=$(mktemp "${managed_ged}.new.XXXXXX")
backup_api=$(mktemp "${managed_api}.previous.XXXXXX")
backup_ged=$(mktemp "${managed_ged}.previous.XXXXXX")
cleanup(){ rm -f "$tmp_api" "$tmp_ged"; }
trap cleanup EXIT
cp --preserve=mode,ownership,timestamps "$managed_api" "$backup_api" 2>/dev/null || cp "$previous_api" "$backup_api"
cp --preserve=mode,ownership,timestamps "$managed_ged" "$backup_ged" 2>/dev/null || cp "$previous_ged" "$backup_ged"
sed "s/__PORT__/${port}/g" "$root/apache/cerp-api-upstream.conf.template" > "$tmp_api"
sed "s/__PORT__/${port}/g" "$root/apache/cerp-ged-upstream.conf.template" > "$tmp_ged"
install -o root -g root -m 0640 "$tmp_api" "$managed_api"
install -o root -g root -m 0640 "$tmp_ged" "$managed_ged"

rollback(){
  install -o root -g root -m 0640 "$backup_api" "$managed_api"
  install -o root -g root -m 0640 "$backup_ged" "$managed_ged"
  eval "$configtest" && apache2ctl graceful || true
  echo "BLUEGREEN_ROLLBACK_RESTORED slot=${slot}" >&2
}
if ! eval "$configtest"; then rollback; exit 67; fi
apache2ctl graceful

started=$SECONDS
deadline=$((started + 30))
while (( SECONDS < deadline )); do
  if ! curl --fail --silent --show-error --max-time 3 "http://127.0.0.1:${port}/health/ready" | grep -q '"status":"ready"'; then rollback; exit 68; fi
  sleep 1
done
echo "BLUEGREEN_SWITCH_OK slot=${slot} port=${port} observed_seconds=$((SECONDS-started))"
