#!/bin/sh
set -eu

CLAMD_CONFIG=/etc/clamav/clamd.conf
FRESHCLAM_CONFIG=/etc/clamav/freshclam.conf

export CERP_APP_UID="$(id -u node)"
export CERP_APP_GID="$(id -g node)"
node /usr/local/lib/cerp-storage-preflight.mjs

if [ "${CERP_STORAGE_PREFLIGHT_ONLY:-0}" = "1" ]; then
  exit 0
fi

if [ "${CERP_STORAGE_SECURITY_SMOKE:-0}" = "1" ]; then
  /usr/local/bin/cerp-upload-storage-security-smoke.sh
  exit $?
fi

mkdir -p /run/clamav /var/lib/clamav /var/log/clamav
chown -R clamav:clamav /run/clamav /var/lib/clamav /var/log/clamav

# Refresh on every boot. The immutable image deliberately contains no mutable
# signature snapshot; an existing signatures volume may bridge an outage, but
# first boot requires update egress and FailIfCvdOlderThan rejects stale data.
if ! freshclam --config-file="$FRESHCLAM_CONFIG" --stdout; then
  if ! find /var/lib/clamav -maxdepth 1 -type f \( -name '*.cvd' -o -name '*.cld' \) -print -quit | grep -q .; then
    echo "[upload_scan] no usable ClamAV signature database" >&2
    exit 1
  fi
  echo "[upload_scan] signature refresh failed; validating persisted database" >&2
fi

clamd --config-file="$CLAMD_CONFIG" --foreground &
clamd_pid=$!

process_is_running() {
  pid=$1
  [ -r "/proc/$pid/stat" ] || return 1

  # kill -0 remains true for an unreaped zombie. Read procfs so a child that
  # exits before the supervisor starts polling is still detected reliably.
  process_stat=$(cat "/proc/$pid/stat" 2>/dev/null) || return 1
  process_stat=${process_stat##*) }
  process_state=${process_stat%% *}
  [ "$process_state" != "Z" ] && [ "$process_state" != "X" ]
}

shutdown() {
  trap - TERM INT EXIT

  for pid in ${app_pid:-} ${freshclam_pid:-} "$clamd_pid"; do
    if [ -n "$pid" ]; then kill -TERM "$pid" 2>/dev/null || true; fi
  done

  attempt=0
  while [ "$attempt" -lt 50 ]; do
    any_running=0
    for pid in ${app_pid:-} ${freshclam_pid:-} "$clamd_pid"; do
      if [ -n "$pid" ] && process_is_running "$pid"; then
        any_running=1
      fi
    done
    if [ "$any_running" -eq 0 ]; then break; fi
    sleep 0.1
    attempt=$((attempt + 1))
  done

  for pid in ${app_pid:-} ${freshclam_pid:-} "$clamd_pid"; do
    if [ -n "$pid" ] && process_is_running "$pid"; then
      kill -KILL "$pid" 2>/dev/null || true
    fi
  done
  for pid in ${app_pid:-} ${freshclam_pid:-} "$clamd_pid"; do
    if [ -n "$pid" ]; then wait "$pid" 2>/dev/null || true; fi
  done
}
trap shutdown TERM INT EXIT

# Ping succeeds only after clamd has loaded a valid signature database.
if ! clamdscan --config-file="$CLAMD_CONFIG" --ping=60:1 >/dev/null 2>&1; then
  echo "[upload_scan] clamd failed readiness probe" >&2
  exit 1
fi

if [ "${CERP_SCANNER_SMOKE:-0}" = "1" ]; then
  su-exec node node /usr/local/lib/cerp-scanner-smoke.mjs
  exit $?
fi

# ClamAV 1.4 accepts the cadence only as a CLI option; 12 checks/day keeps the
# explicit policy without an invalid freshclam.conf directive.
freshclam --config-file="$FRESHCLAM_CONFIG" --checks=12 --daemon --foreground --stdout &
freshclam_pid=$!

if [ "$#" -eq 0 ]; then
  set -- node dist/index.js
fi
su-exec node "$@" &
app_pid=$!

# The API is the container lifecycle process. A scanner/update failure must not
# make the whole ERP disappear: readiness becomes degraded and every new GED
# upload fails closed into quarantine until the orchestrator/operator restores
# ClamAV. Log and reap those children once, while keeping the API available.
clamd_exit_reported=0
freshclam_exit_reported=0
while process_is_running "$app_pid"; do
  if [ "$clamd_exit_reported" -eq 0 ] && ! process_is_running "$clamd_pid"; then
    if wait "$clamd_pid"; then scanner_status=0; else scanner_status=$?; fi
    echo "[upload_scan] clamd unavailable status=$scanner_status; API remains fail-closed" >&2
    clamd_exit_reported=1
  fi
  if [ "$freshclam_exit_reported" -eq 0 ] && ! process_is_running "$freshclam_pid"; then
    if wait "$freshclam_pid"; then updater_status=0; else updater_status=$?; fi
    echo "[upload_scan] freshclam unavailable status=$updater_status; signature freshness is degraded" >&2
    freshclam_exit_reported=1
  fi
  sleep 0.1
done

if wait "$app_pid"; then status=0; else status=$?; fi
exit "$status"
