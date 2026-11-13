#!/usr/bin/env bash
set -euo pipefail
slot=${1:?usage: switch-traefik.sh <blue|green> <active-file> <legacy-backup-file>}
active=${2:?}
backup=${3:?}
root=$(cd "$(dirname "$0")/../.." && pwd)
case "$slot" in blue|green) ;; *) exit 64;; esac
[[ $(id -u) == 0 ]] || { echo "must run as root on VPS" >&2; exit 65; }
had_active=false
if [[ -r "$active" ]]; then cp --preserve=mode,ownership,timestamps "$active" "$backup"; had_active=true; fi
tmp=$(mktemp "${active}.new.XXXXXX")
trap 'rm -f "$tmp"' EXIT
sed "s/__SLOT__/${slot}/g" "$root/vps/traefik-active.yaml.template" > "$tmp"
grep -q "service: cerp-api-${slot}" "$tmp"
grep -q "priority: 100" "$tmp"
install -o coolify -g coolify -m 0640 "$tmp" "$active"
rollback(){ if [[ $had_active == true ]]; then install -o coolify -g coolify -m 0640 "$backup" "$active"; else rm -f "$active"; fi; echo "VPS_BLUEGREEN_ROLLBACK_RESTORED slot=${slot}" >&2; }
started=$SECONDS
deadline=$((started+30))
while (( SECONDS < deadline )); do
  if ! docker exec coolify-proxy wget -T 3 -qO- "http://cerp-api-${slot}:5000/health/ready" | grep -q '"status":"ready"'; then rollback; exit 68; fi
  if ! curl -fsS --max-time 3 --resolve erp-backend.croix-rousse-precision.fr:443:127.0.0.1 https://erp-backend.croix-rousse-precision.fr/health/ready | grep -q '"status":"ready"'; then rollback; exit 68; fi
  sleep 1
done
echo "VPS_BLUEGREEN_SWITCH_OK slot=${slot} observed_seconds=$((SECONDS-started))"
