#!/usr/bin/env bash
set -euo pipefail
# Dedicated cluster, schema only. Never restores business rows or alters the atelier cluster.
root=/tmp/cerp-planning-perf-970
pg=/usr/lib/postgresql/17/bin
if [ ! -e "$root/pg/PG_VERSION" ]; then
  sudo -n install -d -o postgres -g postgres -m 700 "$root/pg" "$root/socket"
  sudo -n -u postgres "$pg/initdb" -D "$root/pg" --auth-local=trust --auth-host=trust --no-locale -E UTF8 >/dev/null
fi
test "$(sudo -n cat "$root/pg/PG_VERSION")" = 17
if ! sudo -n -u postgres "$pg/pg_ctl" -D "$root/pg" status >/dev/null; then
  sudo -n -u postgres "$pg/pg_ctl" -D "$root/pg" -l "$root/pg/server.log" -o "-p 55970 -k $root/socket -h 127.0.0.1 -c shared_buffers=256MB -c max_connections=50" start >/dev/null
fi
test "$(sudo -n -u postgres "$pg/psql" -h 127.0.0.1 -p 55970 -XAt -d postgres -c 'SHOW data_directory')" = "$root/pg"
if ! sudo -n -u postgres "$pg/psql" -h 127.0.0.1 -p 55970 -XAt -d postgres -c "SELECT 1 FROM pg_database WHERE datname='cerp_test'" | grep -q 1; then
  sudo -n -u postgres "$pg/psql" -h 127.0.0.1 -p 55970 -Xv ON_ERROR_STOP=1 -d postgres -c 'CREATE ROLE cerp_app; CREATE ROLE cerp_e2e LOGIN SUPERUSER;' >/dev/null
  sudo -n -u postgres "$pg/createdb" -h 127.0.0.1 -p 55970 -O cerp_e2e cerp_test
  sudo -n -u postgres "$pg/pg_dump" --schema-only --no-owner --no-privileges -d cerp_test |
    sudo -n -u postgres "$pg/psql" -h 127.0.0.1 -p 55970 -Xv ON_ERROR_STOP=1 -d cerp_test >/dev/null
fi
# Runtime grants are restricted to the verified disposable cluster above.
sudo -n -u postgres "$pg/psql" -h 127.0.0.1 -p 55970 -Xv ON_ERROR_STOP=1 -d cerp_test -c 'ALTER ROLE cerp_app WITH LOGIN NOSUPERUSER; GRANT USAGE ON SCHEMA public TO cerp_app; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO cerp_app; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO cerp_app;' >/dev/null
sudo -n -u postgres "$pg/psql" -h 127.0.0.1 -p 55970 -XAt -d cerp_test -c "SELECT current_database(),current_setting('data_directory'),(SELECT count(*) FROM public.ordres_fabrication)"
