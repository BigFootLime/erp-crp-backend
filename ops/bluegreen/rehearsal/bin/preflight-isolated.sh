#!/usr/bin/env bash
set -euo pipefail
compose=${1:?usage: preflight-isolated.sh <compose-file>}
env_file=${CERP_REHEARSAL_ENV_FILE:-/etc/cerp/rehearsal/rehearsal.env}
[[ -f "$compose" && -f "$env_file" ]] || { echo "missing rehearsal input" >&2; exit 64; }
case "$(stat -c '%a' "$env_file")" in 400|600) ;; *) echo "rehearsal env permissions must be 0400 or 0600" >&2; exit 65;; esac
[[ $(stat -c '%u' "$env_file") -eq 0 ]] || { echo "rehearsal env must be owned by root" >&2; exit 65; }
[[ $(id -u) -eq 0 ]] || { echo "must run as root" >&2; exit 66; }
# Shellcheck-safe: input is a root-owned env file and values are never printed.
set -a; source "$env_file"; set +a
for key in CERP_REHEARSAL_IMAGE CERP_REHEARSAL_DIRECTORY_IMAGE CERP_REHEARSAL_TRAEFIK_IMAGE DATABASE_URL CERP_REHEARSAL_DIRECTORY_DATABASE_URL CERP_REHEARSAL_DB_MARKER CERP_GED_VAULT_ROOT CERP_GED_SENTINEL CERP_REHEARSAL_VAULT_MARKER CERP_REHEARSAL_VAULT_ROOT CERP_IMAGES_ROOT CERP_REHEARSAL_IMAGES_ROOT CERP_REHEARSAL_DIRECTORY_CALLERS_FILE CERP_REHEARSAL_DIRECTORY_STORAGE_ROOT CERP_DIRECTORY_ENDPOINT CERP_SHARED_DIRECTORY_ID CERP_SHARED_DIRECTORY_SITE CERP_DIRECTORY_SITE_CALL_KEY JWT_SECRET AUTH_RATE_LIMIT_HASH_KEY MFA_ROOT_KEY MFA_KEY_ID; do
  [[ -n "${!key:-}" ]] || { echo "missing rehearsal setting: $key" >&2; exit 67; }
done
[[ "$CERP_REHEARSAL_IMAGE" == *@sha256:* ]] || { echo "backend image must be pinned by digest" >&2; exit 68; }
[[ "$CERP_REHEARSAL_DIRECTORY_IMAGE" == *@sha256:* ]] || { echo "directory image must be pinned by digest" >&2; exit 68; }
[[ "$CERP_REHEARSAL_TRAEFIK_IMAGE" == *@sha256:* ]] || { echo "proxy image must be pinned by digest" >&2; exit 69; }
python3 - <<'PY'
import os, re, sys, uuid
from urllib.parse import unquote, urlsplit
database = urlsplit(os.environ['DATABASE_URL'])
marker = os.environ['CERP_REHEARSAL_DB_MARKER']
site = unquote(database.path.lstrip('/'))
directory_db = urlsplit(os.environ['CERP_REHEARSAL_DIRECTORY_DATABASE_URL'])
directory_name = unquote(directory_db.path.lstrip('/'))
expected_site = f'cerp_test_{marker}'
expected_directory = f'cerp_directory_{marker}'
if not re.fullmatch(r'[a-f0-9]{32}', marker):
    sys.exit('rehearsal database marker must be exactly 32 lowercase hexadecimal characters')
if database.scheme not in {'postgres', 'postgresql'} or database.hostname not in {'127.0.0.1', 'localhost'} or site != expected_site:
    sys.exit('site database must be the generated isolated cerp_test target')
if directory_db.scheme not in {'postgres', 'postgresql'} or directory_db.hostname not in {'127.0.0.1', 'localhost'} or directory_name != expected_directory or directory_name == site:
    sys.exit('directory database must be a separate generated isolated authority')
if os.environ['CERP_SHARED_DIRECTORY_SITE'] != site:
    sys.exit('shared directory site must exactly match the isolated site database')
try:
    uuid.UUID(os.environ['CERP_SHARED_DIRECTORY_ID'])
except ValueError:
    sys.exit('directory authority identifier must be a UUID')
if os.environ['CERP_DIRECTORY_ENDPOINT'] != 'http://127.0.0.1:8085/internal/directory':
    sys.exit('directory endpoint must use the canonical isolated loopback endpoint')
PY
[[ "$CERP_GED_VAULT_ROOT" == *"$CERP_REHEARSAL_VAULT_MARKER"* && "$CERP_GED_SENTINEL" == *"$CERP_REHEARSAL_VAULT_MARKER"* ]] || { echo "GED paths lack rehearsal marker" >&2; exit 72; }
[[ "$CERP_REHEARSAL_VAULT_ROOT" == *"$CERP_REHEARSAL_VAULT_MARKER"* && "$CERP_REHEARSAL_IMAGES_ROOT" == *"$CERP_REHEARSAL_VAULT_MARKER"* && "$CERP_IMAGES_ROOT" == *"$CERP_REHEARSAL_VAULT_MARKER"* ]] || { echo "media paths lack rehearsal marker" >&2; exit 72; }
[[ "$CERP_SHARED_DIRECTORY_ENABLED" == true ]] || { echo "shared directory must be enabled for the isolated site" >&2; exit 76; }
[[ "$CERP_UPLOAD_SCAN_MODE" == enforce && -n "$CERP_UPLOAD_SCANNER_COMMAND" ]] || { echo "upload scanning must be enforced" >&2; exit 77; }
[[ "$CERP_STANDBY" == true && "$CERP_BACKGROUND_WORKERS" == off ]] || { echo "workers must be disabled" >&2; exit 73; }
[[ "$CERP_WEBHOOK_DELIVERY_ENABLED" == 0 && "$EINVOICE_EREPORTING_ENABLED" == false ]] || { echo "outbound services must be disabled" >&2; exit 74; }
[[ -z "${RESEND_API_KEY:-}" && -z "${RESEND_FROM:-}" && -z "${RESEND_API_BASE_URL:-}" ]] || { echo "email credentials must be blank" >&2; exit 75; }
for root in "$CERP_REHEARSAL_VAULT_ROOT" "$CERP_REHEARSAL_IMAGES_ROOT" "$CERP_REHEARSAL_DIRECTORY_STORAGE_ROOT"; do
  [[ -d "$root" && ! -L "$root" && $(stat -c '%u' "$root") -eq 0 && $((8#$(stat -c '%a' "$root") & 8#022)) -eq 0 ]] || { echo "rehearsal root is not private" >&2; exit 78; }
done
[[ -f "$CERP_REHEARSAL_DIRECTORY_CALLERS_FILE" && ! -L "$CERP_REHEARSAL_DIRECTORY_CALLERS_FILE" && $(stat -c '%u' "$CERP_REHEARSAL_DIRECTORY_CALLERS_FILE") -eq 0 ]] || { echo "directory caller file must be a root-owned regular file" >&2; exit 79; }
# The entrypoint drops the directory process to the image's `node` account.
# The caller file remains root-owned but must be readable by that account; no
# other group/world access is accepted.
[[ $(stat -c '%g' "$CERP_REHEARSAL_DIRECTORY_CALLERS_FILE") -eq 1000 && $(stat -c '%a' "$CERP_REHEARSAL_DIRECTORY_CALLERS_FILE") == 640 ]] || { echo "directory caller file must be root:1000 mode 0640" >&2; exit 79; }
python3 - <<'PY'
import json, os, re, sys
with open(os.environ['CERP_REHEARSAL_DIRECTORY_CALLERS_FILE'], encoding='utf-8') as handle:
    rows = json.load(handle)
site = os.environ['CERP_SHARED_DIRECTORY_SITE']
matches = [row for row in rows if isinstance(row, dict) and row.get('site') == site]
if len(matches) != 1 or not isinstance(matches[0].get('key'), str) or not re.fullmatch(r'[a-f0-9]{64}', matches[0]['key']) or matches[0]['key'] != os.environ['CERP_DIRECTORY_SITE_CALL_KEY']:
    sys.exit('directory caller file does not contain the exact isolated site caller')
PY
rendered=$(docker compose --env-file "$env_file" -f "$compose" config)
[[ "$rendered" == *'network_mode: service:cerp-api-rehearsal-1710'* && "$rendered" == *'http://127.0.0.1:8085/internal/directory'* ]] || { echo "compose must keep the directory as the API loopback sidecar" >&2; exit 80; }
docker network inspect coolify >/dev/null
docker compose --env-file "$env_file" -f "$compose" config --quiet
echo "REHEARSAL_PREFLIGHT_OK"
