#!/usr/bin/env bash
set -euo pipefail
# Stop only this disposable rehearsal; keep its synthetic data and reports for inspection.
root=/tmp/cerp-planning-perf-970
if [ -f "$root/performance-runtime/api.pid" ]; then
  api_pid=$(cat "$root/performance-runtime/api.pid")
  if [ -d "/proc/$api_pid" ]; then
    test "$(readlink "/proc/$api_pid/cwd")" = "$root/api"
    kill -TERM "$api_pid"
  fi
fi
pg=/usr/lib/postgresql/17/bin
if sudo -n -u postgres "$pg/pg_ctl" -D "$root/pg" status >/dev/null; then
  test "$(sudo -n -u postgres "$pg/psql" -h 127.0.0.1 -p 55970 -XAt -d cerp_test -c 'SHOW data_directory')" = "$root/pg"
  sudo -n -u postgres "$pg/pg_ctl" -D "$root/pg" stop -m fast
fi
