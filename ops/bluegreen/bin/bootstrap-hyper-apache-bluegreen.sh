#!/usr/bin/env bash
# One-time, reversible installation of the Apache include hooks used by the
# HYPER blue/green switcher.  It intentionally keeps routing on port 8080.
set -euo pipefail

local_vhost=${1:?usage: bootstrap-hyper-apache-bluegreen.sh <live-local-vhost> <local-vhost-candidate> <live-ged-vhost> <api-active-fragment> <ged-active-fragment> <backup-directory> <apache-configtest-command>}
local_candidate=${2:?}
ged_vhost=${3:?}
api_active=${4:?}
ged_active=${5:?}
backup_directory=${6:?}
configtest=${7:?}
root=$(cd "$(dirname "$0")/.." && pwd)

[[ $(id -u) == 0 ]] || { echo "must run as root on HYPERBOX2" >&2; exit 64; }
[[ -r "$local_vhost" && -r "$local_candidate" && -r "$ged_vhost" ]] || { echo "Apache source configuration unavailable" >&2; exit 65; }
[[ -d "$backup_directory" && ! -L "$backup_directory" ]] || { echo "backup directory must already exist and not be a symlink" >&2; exit 66; }
grep -Fqx '    IncludeOptional /etc/apache2/conf-enabled/cerp-api-bluegreen-active.conf' "$local_candidate" || { echo "local candidate lacks managed API include" >&2; exit 67; }

stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup_local="$backup_directory/cerp-local.conf.$stamp"
backup_ged="$backup_directory/cerp-ged-wireguard.conf.$stamp"
backup_api="$backup_directory/cerp-api-bluegreen-active.conf.$stamp"
backup_ged_active="$backup_directory/cerp-ged-bluegreen-active.conf.$stamp"
tmp_local=$(mktemp "${local_vhost}.bluegreen.XXXXXX")
tmp_ged=$(mktemp "${ged_vhost}.bluegreen.XXXXXX")
tmp_api=$(mktemp "${api_active}.bluegreen.XXXXXX")
tmp_ged_active=$(mktemp "${ged_active}.bluegreen.XXXXXX")
cleanup() { rm -f "$tmp_local" "$tmp_ged" "$tmp_api" "$tmp_ged_active"; }
trap cleanup EXIT

cp --preserve=mode,ownership,timestamps "$local_vhost" "$backup_local"
cp --preserve=mode,ownership,timestamps "$ged_vhost" "$backup_ged"
[[ ! -e "$api_active" ]] || cp --preserve=mode,ownership,timestamps "$api_active" "$backup_api"
[[ ! -e "$ged_active" ]] || cp --preserve=mode,ownership,timestamps "$ged_active" "$backup_ged_active"

# Preserve all current GED authorisation, listener and request-size controls.
# Only the exactly one API GED proxy pair is replaced. A drifted vhost fails
# closed for manual review rather than receiving a broad textual rewrite.
python3 - "$ged_vhost" "$tmp_ged" <<'PY'
import re, sys
source, target = sys.argv[1:]
text = open(source, encoding='utf-8').read()
forward = r'^\s*ProxyPass\s+/api/v1/ged/\s+http://127\.0\.0\.1:8080/api/v1/ged/.*$'
reverse = r'^\s*ProxyPassReverse\s+/api/v1/ged/\s+http://127\.0\.0\.1:8080/api/v1/ged/.*$'
if len(re.findall(forward, text, flags=re.M)) != 1 or len(re.findall(reverse, text, flags=re.M)) != 1:
    raise SystemExit('GED proxy shape changed; refuse bootstrap')
text = re.sub(forward, '    IncludeOptional /etc/apache2/conf-enabled/cerp-ged-bluegreen-active.conf', text, flags=re.M)
text = re.sub(reverse, '', text, flags=re.M)
open(target, 'w', encoding='utf-8').write(text)
PY
sed 's/__PORT__/8080/g' "$root/apache/cerp-api-upstream.conf.template" > "$tmp_api"
sed 's/__PORT__/8080/g' "$root/apache/cerp-ged-upstream.conf.template" > "$tmp_ged_active"

rollback() {
  install -o root -g root -m 0640 "$backup_local" "$local_vhost"
  install -o root -g root -m 0640 "$backup_ged" "$ged_vhost"
  if [[ -e "$backup_api" ]]; then install -o root -g root -m 0640 "$backup_api" "$api_active"; else rm -f "$api_active"; fi
  if [[ -e "$backup_ged_active" ]]; then install -o root -g root -m 0640 "$backup_ged_active" "$ged_active"; else rm -f "$ged_active"; fi
  eval "$configtest" && apache2ctl graceful || true
  echo "BLUEGREEN_BOOTSTRAP_ROLLBACK_RESTORED" >&2
}

install -o root -g root -m 0640 "$local_candidate" "$local_vhost"
install -o root -g root -m 0640 "$tmp_ged" "$ged_vhost"
install -o root -g root -m 0640 "$tmp_api" "$api_active"
install -o root -g root -m 0640 "$tmp_ged_active" "$ged_active"
if ! eval "$configtest"; then rollback; exit 68; fi
apache2ctl graceful
deadline=$((SECONDS + 30))
while (( SECONDS < deadline )); do
  if ! curl --fail --silent --show-error --max-time 3 http://127.0.0.1:8080/health/ready | grep -q '"status":"ready"'; then
    rollback; exit 69
  fi
  sleep 1
done
printf 'BLUEGREEN_BOOTSTRAP_OK backup_local=%s backup_ged=%s observed_seconds=30\n' "$backup_local" "$backup_ged"
