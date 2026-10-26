#!/usr/bin/env sh
set -eu

container='cerp-metrology-md15-rehearsal-20261026'
out='/tmp/cerp-metrology-20261026-isolated'
psql_exec() {
  docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres "$@"
}

psql_exec -f /work/metrology-md15-profile-codes.fixture.sql > "$out/fixture.out"
psql_exec -f /work/20261026_metrology_md15_profile_codes.sql > "$out/patch-first.out"
psql_exec -f /work/20261026_metrology_md15_profile_codes.verify.sql > "$out/verify.out"
psql_exec -f /work/metrology-md15-profile-codes.assertions.sql > "$out/assertions.out"
psql_exec -f /work/20261026_metrology_md15_profile_codes.sql > "$out/patch-second.out"

(docker exec "$container" psql -X -At -v ON_ERROR_STOP=1 -U postgres -d postgres \
  -c "SELECT pg_sleep(0.2), public.fn_next_issued_code_value('MTR:PC');" > "$out/concurrent-a.out") &
a=$!
(docker exec "$container" psql -X -At -v ON_ERROR_STOP=1 -U postgres -d postgres \
  -c "SELECT pg_sleep(0.2), public.fn_next_issued_code_value('MTR:PC');" > "$out/concurrent-b.out") &
b=$!
wait "$a"
wait "$b"

sequence_sql="SELECT sequencename || ':' || last_value FROM pg_sequences WHERE schemaname='public' AND sequencename IN ('cerp_code_issue_' || md5('MTR:PC') || '_seq','cerp_code_issue_' || md5('MTR:TFD') || '_seq') ORDER BY 1;"
psql_exec -Atc "$sequence_sql" > "$out/before-rollback.out"
psql_exec -f /work/20261026_metrology_md15_profile_codes.rollback.sql > "$out/rollback.out"
psql_exec -Atc "$sequence_sql" > "$out/after-rollback.out"
diff -u "$out/before-rollback.out" "$out/after-rollback.out" > "$out/rollback-sequences.diff"
cat "$out/verify.out" "$out/assertions.out" "$out/concurrent-a.out" "$out/concurrent-b.out" "$out/before-rollback.out" > "$out/summary.out"
cat "$out/summary.out"
